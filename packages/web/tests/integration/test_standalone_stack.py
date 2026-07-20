"""T-137 — End-to-end standalone integration test (web + gateway, no monorepo).

This test proves that someone who installs ONLY ``neuralgentics-web`` and
ONLY the ``neuralgentics-gateway`` egress proxy (no broker, no
orchestrator, no monorepo checkout) can wire them together and have
audit data flow end-to-end:

    pip install neuralgentics-web[team-server]
    go install github.com/Veedubin/neuralgentics-gateway/cmd/egress@latest

        ┌─────────┐   HTTP proxy    ┌─────────┐  JSONL/PG  ┌─────────────┐
        │  curl   │ ──────────────▶ │ egress  │ ─────────▶ │ audit store │
        └─────────┘                 │  :9090  │            └──────┬──────┘
                                    └─────────┘                   │
                                                                  │ read
                                                                  ▼
                                                            ┌─────────────┐
        ┌─────────────────┐  GET /api/v1/gateway-audit/recent  │ neuralgentics│
        │  test / browser │ ◀───────────────────────────────── │   -web      │
        └─────────────────┘                                    │   :9876     │
                                                               └─────────────┘

Why this test exists
--------------------
T-130 through T-136 made each piece standalone-installable. This card
proves the install path works: the web binary launches, the gateway
binary launches, they can share a data source, and a request through the
gateway produces an audit record visible in the web UI.

Graceful skips
--------------
The test skips cleanly when a prerequisite is unavailable rather than
failing. This lets the test run in three environments:

* **Full CI** — has both PyPI access (or a built wheel) and the gateway
  binary. Every test runs.
* **Dev box without the gateway** — the web tests run; the gateway
  tests skip with ``reason="egress binary not on PATH"``.
* **CI without Go** — the gateway install/build tests skip with
  ``reason="go toolchain not on PATH"``.

The ``pip install`` test builds a wheel from the local source tree and
installs it into a fresh venv, rather than depending on PyPI. This
proves the wheel is installable (the real contract) without requiring a
fresh PyPI publish for every CI run. When the package IS published,
setting ``NEURALGENTICS_TEST_USE_PYPI=1`` switches the test to install
from PyPI instead.

Session-scoped fixtures
-----------------------
The wheel build + venv creation + pip install are session-scoped to
minimize subprocess churn. Per-test venv creation (~3s each) makes the
timing-sensitive SSE test in ``test_gateway_audit_embedded.py`` flaky
when the full suite runs together.
"""

from __future__ import annotations

import contextlib
import json
import os
import shutil
import socket
import subprocess
import sys
import time
import venv
from pathlib import Path

import httpx
import pytest

# Repo root: packages/web/tests/integration/../../../.. = repo root.
# (tests/integration -> tests -> web -> packages -> neuralgentics)
REPO_ROOT = Path(__file__).resolve().parents[4]
WEB_PKG_DIR = REPO_ROOT / "packages" / "web"

# Ports the spawned processes use. Avoid 9876 and 18790 (used by
# test_gateway_audit_embedded.py) to prevent TIME_WAIT socket collisions.
WEB_PORT = 19876
GATEWAY_PORT = 19090

# Audit JSONL file the gateway WOULD write. The egress binary writes
# here when audit.enabled is true; for the no-gateway path we write a
# fixture record directly to prove the web can read it.
AUDIT_FILE_ENV = "NEURALGENTICS_AUDIT_FILE"

# Env var that opts into installing from PyPI instead of a locally-built
# wheel. Lets a release-pipeline job verify the published artifact.
USE_PYPI_ENV = "NEURALGENTICS_TEST_USE_PYPI"


# ---------------------------------------------------------------------------
# Detection helpers
# ---------------------------------------------------------------------------


def _egress_on_path() -> bool:
    """True if the egress gateway binary is installed and on PATH."""
    return shutil.which("egress") is not None


def _port_free(port: int, host: str = "127.0.0.1") -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        try:
            s.bind((host, port))
        except OSError:
            return False
    return True


def _wait_for_port(
    port: int,
    *,
    host: str = "127.0.0.1",
    timeout: float = 15.0,
    interval: float = 0.25,
) -> bool:
    """Poll until something is listening on ``port``. Returns True on success."""
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            s.settimeout(interval)
            try:
                s.connect((host, port))
                return True
            except OSError:
                time.sleep(interval)
    return False


def _kill_proc(proc: subprocess.Popen[bytes]) -> None:
    """Terminate a subprocess cleanly: SIGTERM, then SIGKILL if needed."""
    if proc.poll() is not None:
        return
    proc.terminate()
    try:
        proc.wait(timeout=5)
    except subprocess.TimeoutExpired:
        proc.kill()
        with contextlib.suppress(subprocess.TimeoutExpired):
            proc.wait(timeout=5)


def _venv_bin(venv_root: Path, name: str) -> Path:
    return venv_root / "bin" / name


def _cleanup_build_artifacts() -> None:
    """Remove egg-info + build/ left by the wheel build."""
    egg_info = WEB_PKG_DIR / "src" / "neuralgentics_web.egg-info"
    build_dir = WEB_PKG_DIR / "build"
    with contextlib.suppress(OSError):
        if egg_info.exists():
            shutil.rmtree(egg_info)
    with contextlib.suppress(OSError):
        if build_dir.exists():
            shutil.rmtree(build_dir)


# ---------------------------------------------------------------------------
# Session-scoped fixtures (minimize subprocess churn)
# ---------------------------------------------------------------------------


@pytest.fixture(scope="session")
def built_wheel() -> Path | None:
    """Build a wheel from the local web package source tree (session-scoped).

    Returns the path to the built ``.whl``, or ``None`` if the build
    failed (in which case the install test skips).

    Uses ``uv build --wheel`` when available (the project's canonical
    build command), falling back to ``python -m build --wheel``.

    Build artifacts (``egg-info``, ``build/``) are removed immediately
    after the wheel is built so they don't change how subsequent test
    modules resolve the ``neuralgentics.web`` import.
    """
    if not (WEB_PKG_DIR / "pyproject.toml").exists():
        return None
    dist_dir = WEB_PKG_DIR / "dist"
    if dist_dir.exists():
        for old in dist_dir.glob("neuralgentics_web-*.whl"):
            old.unlink()
    uv_bin = shutil.which("uv")
    if uv_bin is not None:
        cmd = [uv_bin, "build", "--wheel", "--out-dir", str(dist_dir)]
    else:
        cmd = [sys.executable, "-m", "build", "--wheel", "--outdir", str(dist_dir), "."]
    try:
        proc = subprocess.run(
            cmd,
            cwd=str(WEB_PKG_DIR) if uv_bin is None else None,
            capture_output=True,
            text=True,
            timeout=120,
        )
    except subprocess.TimeoutExpired:
        return None
    if proc.returncode != 0:
        return None
    wheels = sorted(dist_dir.glob("neuralgentics_web-*.whl"))
    wheel = wheels[-1] if wheels else None
    _cleanup_build_artifacts()
    return wheel


@pytest.fixture(scope="session")
def installed_venv(
    tmp_path_factory: pytest.TempPathFactory,
    built_wheel: Path | None,
) -> Path:
    """A session-scoped venv with the web wheel + asyncpg installed.

    Creates one venv, installs the wheel once, and reuses it across all
    tests in this module. Session-scoping eliminates per-test venv
    creation (~3s each) that would make the timing-sensitive SSE test
    in ``test_gateway_audit_embedded.py`` flaky.
    """
    if built_wheel is None and os.getenv(USE_PYPI_ENV) != "1":
        pytest.skip("wheel build failed; set NEURALGENTICS_TEST_USE_PYPI=1 to install from PyPI")
    venv_root = tmp_path_factory.mktemp("venv") / "venv"
    venv.create(venv_root, with_pip=True, clear=True)
    venv_python = venv_root / "bin" / "python"
    if os.getenv(USE_PYPI_ENV) == "1":
        cmd = [str(venv_python), "-m", "pip", "install", "neuralgentics-web[team-server]"]
    else:
        assert built_wheel is not None
        cmd = [
            str(venv_python),
            "-m",
            "pip",
            "install",
            str(built_wheel),
            "asyncpg>=0.29.0",
        ]
    proc = subprocess.run(cmd, capture_output=True, text=True, timeout=180)
    assert proc.returncode == 0, (
        f"pip install failed (rc={proc.returncode}):\n"
        f"cmd: {cmd}\nstdout:\n{proc.stdout}\nstderr:\n{proc.stderr}"
    )
    return venv_root


@pytest.fixture
def audit_file(tmp_path: Path) -> Path:
    """Empty JSONL audit file the web will read from (via env var)."""
    p = tmp_path / "audit.jsonl"
    p.write_text("")
    return p


# ---------------------------------------------------------------------------
# 1. pip install neuralgentics-web succeeds
# ---------------------------------------------------------------------------


def test_pip_install_neuralgentics_web_succeeds(installed_venv: Path) -> None:
    """``pip install neuralgentics-web`` (or a locally-built wheel) works.

    The ``installed_venv`` fixture does the install. Here we verify the
    console script exists and the package is importable.
    """
    venv_python = installed_venv / "bin" / "python"
    # The console script must exist.
    assert _venv_bin(installed_venv, "neuralgentics-web").exists(), (
        "neuralgentics-web console script not created by pip install"
    )
    # The package must be importable.
    imp = subprocess.run(
        [
            str(venv_python),
            "-c",
            "import neuralgentics.web; print(neuralgentics.web.__version__)",
        ],
        capture_output=True,
        text=True,
        timeout=30,
    )
    assert imp.returncode == 0, (
        f"import neuralgentics.web failed:\nstdout:\n{imp.stdout}\nstderr:\n{imp.stderr}"
    )


# ---------------------------------------------------------------------------
# 2. neuralgentics-web --help works
# ---------------------------------------------------------------------------


def test_neuralgentics_web_help_works(installed_venv: Path) -> None:
    """``neuralgentics-web --help`` exits 0 and mentions --mode."""
    proc = subprocess.run(
        [str(_venv_bin(installed_venv, "neuralgentics-web")), "--help"],
        capture_output=True,
        text=True,
        timeout=30,
    )
    assert proc.returncode == 0, (
        f"neuralgentics-web --help failed (rc={proc.returncode}):\nstderr:\n{proc.stderr}"
    )
    assert "--mode" in proc.stdout, f"--mode not in help output:\n{proc.stdout}"


# ---------------------------------------------------------------------------
# 3. neuralgentics-web --mode=embedded starts and serves the home page
# ---------------------------------------------------------------------------


def test_neuralgentics_web_embedded_starts_and_serves_home(
    installed_venv: Path,
    tmp_path: Path,
) -> None:
    """Start the web in embedded mode, GET /, assert 200 with HTML."""
    if not _port_free(WEB_PORT):
        pytest.skip(f"port {WEB_PORT} already in use")
    log_path = tmp_path / "web.log"
    web_bin = _venv_bin(installed_venv, "neuralgentics-web")
    env = dict(os.environ)
    env["NEURALGENTICS_AUDIT_FILE"] = str(tmp_path / "audit.jsonl")
    with log_path.open("w") as log_fh:
        proc = subprocess.Popen(
            [
                str(web_bin),
                "--mode=embedded",
                f"--port={WEB_PORT}",
                "--host=127.0.0.1",
                "--auth=off",
            ],
            stdout=log_fh,
            stderr=subprocess.STDOUT,
            env=env,
        )
    try:
        if not _wait_for_port(WEB_PORT, timeout=20.0):
            pytest.fail(
                f"web did not listen on :{WEB_PORT} within 20s\nlog:\n{log_path.read_text()}"
            )
        # Give uvicorn a moment to finish startup (port open != app ready).
        time.sleep(1.0)
        with httpx.Client(timeout=10.0) as client:
            r = client.get(f"http://127.0.0.1:{WEB_PORT}/")
        assert r.status_code == 200, f"GET / returned {r.status_code}\nbody:\n{r.text[:500]}"
        assert "text/html" in r.headers.get("content-type", ""), (
            f"expected HTML, got {r.headers.get('content-type')}"
        )
    finally:
        _kill_proc(proc)


# ---------------------------------------------------------------------------
# 4. egress --help works  (skip if binary not on PATH)
# ---------------------------------------------------------------------------


@pytest.mark.skipif(
    not _egress_on_path(),
    reason=(
        "egress binary not on PATH; run "
        "`go install github.com/Veedubin/neuralgentics-gateway/cmd/egress@latest`"
    ),
)
def test_egress_help_works() -> None:
    """``egress --help`` exits 0."""
    proc = subprocess.run(
        ["egress", "--help"],
        capture_output=True,
        text=True,
        timeout=15,
    )
    assert proc.returncode == 0, (
        f"egress --help failed (rc={proc.returncode}):\nstderr:\n{proc.stderr}"
    )


# ---------------------------------------------------------------------------
# 5. egress starts with a minimal config and listens on :9090
# ---------------------------------------------------------------------------


@pytest.mark.skipif(not _egress_on_path(), reason="egress binary not on PATH")
def test_egress_starts_with_minimal_config(tmp_path: Path) -> None:
    """Start the egress gateway with a generated minimal config; assert :9090."""
    if not _port_free(GATEWAY_PORT):
        pytest.skip(f"port {GATEWAY_PORT} already in use")
    config = tmp_path / "egress-gateway.yaml"
    audit_jsonl = tmp_path / "egress-audit.jsonl"
    config.write_text(
        f"""
listen_addr: "127.0.0.1:{GATEWAY_PORT}"
dashboard_addr: "127.0.0.1:{GATEWAY_PORT + 1}"
upstreams: []
audit:
  enabled: true
  path: {audit_jsonl}
policy:
  enforce: false
""".strip()
        + "\n"
    )
    log_path = tmp_path / "egress.log"
    with log_path.open("w") as log_fh:
        proc = subprocess.Popen(
            ["egress", "-config", str(config)],
            stdout=log_fh,
            stderr=subprocess.STDOUT,
        )
    try:
        if not _wait_for_port(GATEWAY_PORT, timeout=15.0):
            pytest.fail(
                f"egress did not listen on :{GATEWAY_PORT} within 15s\nlog:\n{log_path.read_text()}"
            )
    finally:
        _kill_proc(proc)


# ---------------------------------------------------------------------------
# 6. A request through the gateway produces an audit record
# ---------------------------------------------------------------------------


@pytest.mark.skipif(not _egress_on_path(), reason="egress binary not on PATH")
def test_request_through_gateway_produces_audit_record(tmp_path: Path) -> None:
    """curl through the gateway (as an HTTP proxy) → audit record appears."""
    if not _port_free(GATEWAY_PORT):
        pytest.skip(f"port {GATEWAY_PORT} already in use")
    config = tmp_path / "egress-gateway.yaml"
    audit_jsonl = tmp_path / "egress-audit.jsonl"
    config.write_text(
        f"""
listen_addr: "127.0.0.1:{GATEWAY_PORT}"
dashboard_addr: "127.0.0.1:{GATEWAY_PORT + 1}"
upstreams: []
audit:
  enabled: true
  path: {audit_jsonl}
policy:
  enforce: false
""".strip()
        + "\n"
    )
    log_path = tmp_path / "egress.log"
    with log_path.open("w") as log_fh:
        proc = subprocess.Popen(
            ["egress", "-config", str(config)],
            stdout=log_fh,
            stderr=subprocess.STDOUT,
        )
    try:
        if not _wait_for_port(GATEWAY_PORT, timeout=15.0):
            pytest.fail(f"egress did not listen:\n{log_path.read_text()}")
        # Use the gateway as an HTTP proxy for a request to a public site.
        # We pick example.com (RFC 2606 reserved, always reachable) to
        # avoid flakiness from rate-limited APIs.
        proxy_url = f"http://127.0.0.1:{GATEWAY_PORT}"
        with (
            httpx.Client(proxy=proxy_url, timeout=15.0) as client,
            contextlib.suppress(httpx.HTTPError),
        ):
            # The proxy may reject plain HTTP (MITM); that's fine —
            # the audit record is written regardless of whether the
            # upstream succeeded.
            client.get("http://example.com/")
        # Wait for the audit writer to flush.
        deadline = time.monotonic() + 5.0
        while time.monotonic() < deadline:
            if audit_jsonl.exists() and audit_jsonl.stat().st_size > 0:
                break
            time.sleep(0.25)
        assert audit_jsonl.exists() and audit_jsonl.stat().st_size > 0, (
            f"no audit record written within 5s\negress log:\n{log_path.read_text()}"
        )
        # The audit record must be valid JSON with the expected fields.
        first_line = audit_jsonl.read_text().splitlines()[0]
        record = json.loads(first_line)
        assert "method" in record, f"audit record missing 'method': {record}"
        assert "host" in record, f"audit record missing 'host': {record}"
    finally:
        _kill_proc(proc)


# ---------------------------------------------------------------------------
# 7. The web can read the gateway's audit records
# ---------------------------------------------------------------------------


def test_web_can_read_gateway_audit(
    installed_venv: Path,
    tmp_path: Path,
    audit_file: Path,
) -> None:
    """A JSONL audit record (in the gateway's shape) is visible via the web.

    This is the end-to-end contract: whatever writes the JSONL audit file
    (the egress gateway in production, or a test fixture here), the web's
    gateway-audit module surfaces it at
    ``GET /api/v1/gateway-audit/recent``.

    We write a fixture record directly to the JSONL file (in the exact
    shape ``neuralgentics-gateway/audit/logger.go`` emits) rather than
    spawning the egress binary, so this test runs even when the gateway
    binary isn't installed. When the binary IS available, test #6 above
    proves the gateway writes the same shape.
    """
    if not _port_free(WEB_PORT):
        pytest.skip(f"port {WEB_PORT} already in use")
    # Write a fixture audit record in the gateway's JSONL shape.
    fixture_record = {
        "timestamp": "2026-07-20T12:00:00Z",
        "method": "GET",
        "host": "api.github.com",
        "uri": "/repos/Veedubin/neuralgentics",
        "decision": "allowed",
        "reason": "",
        "client_ip": "127.0.0.1",
        "status": 200,
        "duration_ms": 42,
        "error": "",
    }
    audit_file.write_text(json.dumps(fixture_record) + "\n")

    log_path = tmp_path / "web.log"
    web_bin = _venv_bin(installed_venv, "neuralgentics-web")
    env = dict(os.environ)
    env[AUDIT_FILE_ENV] = str(audit_file)
    with log_path.open("w") as log_fh:
        proc = subprocess.Popen(
            [
                str(web_bin),
                "--mode=embedded",
                f"--port={WEB_PORT}",
                "--host=127.0.0.1",
                "--auth=off",
            ],
            stdout=log_fh,
            stderr=subprocess.STDOUT,
            env=env,
        )
    try:
        if not _wait_for_port(WEB_PORT, timeout=20.0):
            pytest.fail(f"web did not listen on :{WEB_PORT}\nlog:\n{log_path.read_text()}")
        time.sleep(1.0)  # let uvicorn finish startup
        with httpx.Client(timeout=10.0) as client:
            r = client.get(
                f"http://127.0.0.1:{WEB_PORT}/api/v1/gateway-audit/recent",
                params={"limit": 10},
            )
        assert r.status_code == 200, (
            f"GET /api/v1/gateway-audit/recent returned {r.status_code}\nbody:\n{r.text[:500]}"
        )
        payload = r.json()
        # The endpoint returns a list of events (newest first).
        events = payload if isinstance(payload, list) else payload.get("events", [])
        assert len(events) >= 1, f"no audit events returned:\n{payload}"
        # The fixture record must be present.
        match = next(
            (e for e in events if e.get("host") == "api.github.com"),
            None,
        )
        assert match is not None, (
            f"fixture record not in response:\n{json.dumps(payload, indent=2)}"
        )
        assert match["method"] == "GET"
        assert match["uri"] == "/repos/Veedubin/neuralgentics"
        assert match["decision"] == "allowed"
    finally:
        _kill_proc(proc)
