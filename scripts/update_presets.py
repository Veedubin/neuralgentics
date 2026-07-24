#!/usr/bin/env python3
"""Automated model-preset pipeline for neuralgentics.

Fetches LLM benchmark data (BFCL, SWE-bench, LiveCodeBench, Chatbot Arena,
MMLU-Pro) and cross-references it with provider model lists to produce
``presets.json`` — a daily snapshot of the best model per agent role for
each provider.

Design constraints
-------------------
* Front-end optimizer only (install / ``--remodel`` time). NOT a runtime router.
* Provider pricing is the user's personal subscriptions — NOT encoded here.
* Benchmark scraping uses **Playwright** (Chromium, JS-enabled) because
  most leaderboards are JS-rendered pages that urllib cannot parse.
  Falls back to urllib when Playwright is not installed (degrades to
  ``stale: true`` for JS-only benchmarks).
* Network/render failures are logged to stderr and degrade gracefully —
  the pipeline never crashes. Stale benchmarks are marked ``"stale": true``.
* Output is written atomically (temp file + rename) unless ``--dry-run``.

Usage
-----
    python3 scripts/update_presets.py            # write presets.json
    python3 scripts/update_presets.py --dry-run  # print to stdout
    python3 scripts/update_presets.py --verbose  # log to stderr

Playwright setup (one-time, in venv or CI)
------------------------------------------
    python3 -m venv .venv
    source .venv/bin/activate   # or: uv pip install --python .venv playwright
    pip install playwright      # or: uv pip install --python .venv playwright
    playwright install chromium
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from typing import Any

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
REPO_ROOT = os.path.dirname(SCRIPT_DIR)
ALIASES_PATH = os.path.join(SCRIPT_DIR, "model_aliases.json")
PRESETS_PATH = os.path.join(REPO_ROOT, "presets.json")
SCREENSHOTS_DIR = os.path.join(SCRIPT_DIR, "screenshots")

HTTP_TIMEOUT = 30  # seconds per request / per page render
# Realistic desktop Chrome User-Agent string. Most leaderboards block
# requests that announce themselves as bots (the previous
# ``neuralgentics-presets-bot`` UA was getting 403s/empty responses on
# several HF Spaces). Use the latest stable Windows Chrome UA.
USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/131.0.0.0 Safari/537.36"
)
# UA used for the legacy urllib provider-API fetches (JSON endpoints that
# do not care about the UA). Keeping a distinct one for traceability.
BOT_USER_AGENT = (
    "neuralgentics-presets-bot/1.0 (+https://github.com/Veedubin/neuralgentics)"
)

# Provider API endpoints. Keys are the canonical provider IDs used in
# presets.json. Values are (url, auth_env_or_none, requires_bearer).
# ``auth_env`` is read from the environment; if missing the fetch is
# skipped with a warning (never a crash).
PROVIDER_ENDPOINTS: dict[str, tuple[str, str | None, bool]] = {
    "ollama": ("https://ollama.com/api/tags", None, False),
    "openrouter": ("https://openrouter.ai/api/v1/models", None, False),
    "openai": ("https://api.openai.com/v1/models", "OPENAI_API_KEY", True),
    "anthropic": ("https://api.anthropic.com/v1/models", "ANTHROPIC_API_KEY", True),
    "google": (
        "https://generativelanguage.googleapis.com/v1beta/models?key={env:GOOGLE_API_KEY}",
        "GOOGLE_API_KEY",
        False,
    ),
    "groq": ("https://api.groq.com/openai/v1/models", "GROQ_API_KEY", True),
    "kimi": ("https://api.moonshot.ai/v1/models", "MOONSHOT_API_KEY", True),
    "mammoth": ("https://api.mammouth.ai/v1/models", "MAMMOTH_API_KEY", True),
}

# Benchmark source URLs. Each fetcher is a dedicated function below because
# the response shapes vary wildly (HTML scrape, JSON API, HF datasets, JS apps).
# Where multiple URLs are listed, fetchers try them in order.
BENCHMARK_SOURCES = {
    "bfcl": [
        # Primary: direct static leaderboard (renders via JS in an iframe).
        "https://gorilla.cs.berkeley.edu/leaderboard.html",
        # Secondary: HF Space wrapper (iframe-hosted).
        "https://huggingface.co/spaces/gorilla-llm/berkeley-function-calling-leaderboard",
    ],
    "swe_bench": [
        "https://www.swebench.com/",
        "https://huggingface.co/spaces/princeton-nlp/SWE-bench-Leaderboard",
    ],
    "live_code_bench": [
        "https://livecodebench-leaderboard.static.hf.space/index.html",
        "https://livecodebench.github.io/",
        "https://huggingface.co/spaces/livecodebench/leaderboard",
    ],
    "chatbot_arena": [
        "https://lmarena.ai/leaderboard",
        "https://lmarena.ai/",
        "https://huggingface.co/spaces/lmsys/chatbot-arena-leaderboard",
    ],
    "mmlu_pro": [
        # Direct static leaderboard app (iframe-hosted by HF Space).
        "https://open-llm-leaderboard-open-llm-leaderboard.hf.space/",
        "https://huggingface.co/spaces/open-llm-leaderboard/open_llm_leaderboard",
        "https://paperswithcode.com/sota/multi-task-language-understanding-on-mmlu-pro",
    ],
}

# Agent role -> (primary benchmark, secondary benchmark, primary_weight, secondary_weight)
# Single-benchmark roles use primary_weight=1.0 and secondary=None.
AGENT_BENCHMARK_MAP: dict[str, dict[str, Any]] = {
    "orchestrator": {
        "primary": "bfcl",
        "secondary": "chatbot_arena",
        "primary_weight": 0.7,
        "secondary_weight": 0.3,
    },
    "architect": {
        "primary": "swe_bench",
        "secondary": "live_code_bench",
        "primary_weight": 0.6,
        "secondary_weight": 0.4,
    },
    "coder": {
        "primary": "swe_bench",
        "secondary": "live_code_bench",
        "primary_weight": 0.6,
        "secondary_weight": 0.4,
    },
    "explorer": {
        "primary": "chatbot_arena",
        "secondary": "mmlu_pro",
        "primary_weight": 0.6,
        "secondary_weight": 0.4,
    },
    "tester": {
        "primary": "swe_bench",
        "secondary": "live_code_bench",
        "primary_weight": 0.6,
        "secondary_weight": 0.4,
    },
    "reviewer": {
        "primary": "swe_bench",
        "secondary": "mmlu_pro",
        "primary_weight": 0.6,
        "secondary_weight": 0.4,
    },
    "linter": {
        "primary": "chatbot_arena",
        "secondary": None,
        "primary_weight": 1.0,
        "secondary_weight": 0.0,
    },
    "git": {
        "primary": "chatbot_arena",
        "secondary": None,
        "primary_weight": 1.0,
        "secondary_weight": 0.0,
    },
    "writer": {
        "primary": "chatbot_arena",
        "secondary": "mmlu_pro",
        "primary_weight": 0.6,
        "secondary_weight": 0.4,
    },
    "researcher": {
        "primary": "mmlu_pro",
        "secondary": "chatbot_arena",
        "primary_weight": 0.6,
        "secondary_weight": 0.4,
    },
    "release": {
        "primary": "chatbot_arena",
        "secondary": None,
        "primary_weight": 1.0,
        "secondary_weight": 0.0,
    },
    "agent-builder": {
        "primary": "swe_bench",
        "secondary": "live_code_bench",
        "primary_weight": 0.6,
        "secondary_weight": 0.4,
    },
}

# Current fallback model assignments (from neuralgentics agent .md files).
# Used when benchmark data is unavailable for a provider+role so the pipeline
# always emits a usable ranking. Canonical model name -> provider model id.
FALLBACK_ASSIGNMENTS: dict[str, str] = {
    "orchestrator": "kimi-k2.6",
    "architect": "deepseek-v4-pro",
    "coder": "glm-5.2",
    "explorer": "deepseek-v4-flash",
    "tester": "deepseek-v4-flash",
    "reviewer": "deepseek-v4-pro",
    "linter": "qwen3.5",
    "git": "minimax-m3",
    "writer": "mistral-large-3",
    "researcher": "qwen3.5",
    "release": "minimax-m3",
    "agent-builder": "glm-5.2",
}

# ---------------------------------------------------------------------------
# Logging
# ---------------------------------------------------------------------------


def log(msg: str, *, verbose_only: bool = False) -> None:
    """Log to stderr. Always emitted unless ``verbose_only`` and not verbose."""
    if verbose_only and not _VERBOSE:
        return
    print(f"[presets] {msg}", file=sys.stderr)


_VERBOSE = False
_DEBUG = False


def set_verbose(v: bool) -> None:
    global _VERBOSE
    _VERBOSE = v


def set_debug(v: bool) -> None:
    global _DEBUG
    _DEBUG = v


def is_debug() -> bool:
    return _DEBUG


# ---------------------------------------------------------------------------
# HTTP helper
# ---------------------------------------------------------------------------


def http_get(
    url: str, *, headers: dict[str, str] | None = None, timeout: int = HTTP_TIMEOUT
) -> str | None:
    """Fetch a URL and return text, or ``None`` on failure (logs to stderr)."""
    req_headers = {
        "User-Agent": BOT_USER_AGENT,
        "Accept": "application/json, text/html, */*",
    }
    if headers:
        req_headers.update(headers)
    req = urllib.request.Request(url, headers=req_headers)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            data = resp.read()
            # Decode defensively; some servers send latin-1 metadata.
            charset = resp.headers.get_content_charset() or "utf-8"
            try:
                return data.decode(charset, errors="replace")
            except (LookupError, TypeError):
                return data.decode("utf-8", errors="replace")
    except urllib.error.HTTPError as exc:
        log(f"HTTP {exc.code} fetching {url}: {exc.reason}")
        return None
    except urllib.error.URLError as exc:
        log(f"URL error fetching {url}: {exc.reason}")
        return None
    except (TimeoutError, OSError) as exc:
        log(f"Network error fetching {url}: {exc}")
        return None
    except Exception as exc:  # noqa: BLE001 — pipeline must never crash
        log(f"Unexpected error fetching {url}: {exc}")
        return None


def http_get_json(url: str, *, headers: dict[str, str] | None = None) -> Any | None:
    """Fetch a URL and parse as JSON. Returns ``None`` on any failure."""
    text = http_get(url, headers=headers)
    if text is None:
        return None
    try:
        return json.loads(text)
    except json.JSONDecodeError as exc:
        log(f"JSON decode failed for {url}: {exc}")
        return None


# ---------------------------------------------------------------------------
# Alias / canonicalization layer
# ---------------------------------------------------------------------------


def load_aliases() -> dict[str, dict[str, Any]]:
    """Load model_aliases.json. Returns the ``canonical_names`` dict."""
    try:
        with open(ALIASES_PATH, encoding="utf-8") as fh:
            data = json.load(fh)
        return data.get("canonical_names", {})
    except (OSError, json.JSONDecodeError) as exc:
        log(f"Failed to load aliases from {ALIASES_PATH}: {exc}")
        return {}


def build_alias_index(aliases: dict[str, dict[str, Any]]) -> dict[str, str]:
    """Build {lowercased_alias -> canonical_name} for fast lookups."""
    index: dict[str, str] = {}
    for canonical, info in aliases.items():
        index[canonical.lower()] = canonical
        for alias in info.get("aliases", []):
            index[alias.lower()] = canonical
        for pid in info.get("provider_ids", {}).values():
            index[pid.lower()] = canonical
    return index


def canonicalize(model_id: str, alias_index: dict[str, str]) -> str | None:
    """Return the canonical name for a raw model id, or ``None`` if unknown."""
    if not model_id:
        return None
    key = model_id.strip().lower()
    # Exact match first.
    if key in alias_index:
        return alias_index[key]
    # Strip provider prefix (e.g. "openai/gpt-4o" -> "gpt-4o").
    if "/" in key:
        stripped = key.split("/", 1)[1]
        if stripped in alias_index:
            return alias_index[stripped]
    # Strip tag suffix (e.g. "qwen3.5:397b" -> "qwen3.5").
    if ":" in key:
        stripped = key.split(":", 1)[0]
        if stripped in alias_index:
            return alias_index[stripped]
    return None


# ---------------------------------------------------------------------------
# Provider model list fetchers
# ---------------------------------------------------------------------------


def _models_from_json_list(payload: Any, id_keys: tuple[str, ...]) -> list[str]:
    """Extract model ids from a JSON list or a dict containing a list."""
    items: list[Any] = []
    if isinstance(payload, list):
        items = payload
    elif isinstance(payload, dict):
        for key in ("models", "data", "items"):
            if isinstance(payload.get(key), list):
                items = payload[key]
                break
    result: list[str] = []
    for item in items:
        if isinstance(item, dict):
            for k in id_keys:
                if isinstance(item.get(k), str):
                    result.append(item[k])
                    break
        elif isinstance(item, str):
            result.append(item)
    return result


def fetch_provider_models(
    provider: str, alias_index: dict[str, str]
) -> dict[str, list[str]]:
    """Fetch a provider's model list.

    Returns ``{canonical_name: [raw_provider_id, ...]}`` — only models that
    resolve to a known canonical name. On failure returns an empty dict and
    logs a warning.
    """
    if provider not in PROVIDER_ENDPOINTS:
        log(f"Unknown provider: {provider}")
        return {}

    url, auth_env, use_bearer = PROVIDER_ENDPOINTS[provider]

    # Resolve auth.
    headers: dict[str, str] = {}
    if auth_env:
        token = os.environ.get(auth_env, "")
        if not token:
            log(
                f"Provider {provider}: env {auth_env} not set — skipping",
                verbose_only=True,
            )
            return {}
        # Google uses query param ?key=..., others use Bearer.
        if "{env:" in url:
            url = url.replace(
                "{env:" + auth_env + "}", urllib.parse.quote(token, safe="")
            )
        elif use_bearer:
            headers["Authorization"] = f"Bearer {token}"
        else:
            headers["Authorization"] = f"Bearer {token}"

    payload = http_get_json(url, headers=headers or None)
    if payload is None:
        log(f"Provider {provider}: no data fetched (stale or unauthenticated)")
        return {}

    id_keys: tuple[str, ...]
    if provider == "ollama":
        id_keys = ("name", "model", "id")
    elif provider == "google":
        id_keys = ("name", "displayName", "id")
    else:
        id_keys = ("id", "name", "model")

    raw_ids = _models_from_json_list(payload, id_keys)
    if not raw_ids:
        log(f"Provider {provider}: fetched payload but found 0 model ids")
        return {}

    mapping: dict[str, list[str]] = {}
    for raw in raw_ids:
        canon = canonicalize(raw, alias_index)
        if canon:
            mapping.setdefault(canon, []).append(raw)
    log(
        f"Provider {provider}: {len(raw_ids)} raw ids, {len(mapping)} matched canonical",
        verbose_only=True,
    )
    return mapping


# ---------------------------------------------------------------------------
# Benchmark fetchers
# ---------------------------------------------------------------------------
#
# Strategy: try a known JSON API endpoint first (fast, reliable). If that
# fails, fall back to Playwright (Chromium, JS-enabled) to render the
# leaderboard page and scrape the rendered DOM. If Playwright is not
# installed, mark the benchmark stale (with a one-time warning).
#
# All fetchers MUST return a benchmark dict via ``_empty_benchmark()`` or a
# populated variant — they must NEVER raise.


def _now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _empty_benchmark(stale: bool = True) -> dict[str, Any]:
    return {
        "fetched_at": _now_iso() if not stale else None,
        "stale": stale,
        "source_url": None,
        "top_models": [],
    }


# ---------------------------------------------------------------------------
# Playwright bootstrap (lazy import so the script still runs without it)
# ---------------------------------------------------------------------------

_PLAYWRIGHT_AVAILABLE: bool | None = None


def _check_playwright() -> bool:
    """Return True if the ``playwright`` Python package is importable.

    Cached after the first check. Logs a one-time warning on first miss.
    """
    global _PLAYWRIGHT_AVAILABLE
    if _PLAYWRIGHT_AVAILABLE is not None:
        return _PLAYWRIGHT_AVAILABLE
    try:
        import playwright  # type: ignore  # noqa: F401

        _PLAYWRIGHT_AVAILABLE = True
    except ImportError:
        _PLAYWRIGHT_AVAILABLE = False
        log(
            "playwright is not installed — JS-rendered benchmarks will be "
            "marked stale. Install with: pip install playwright && "
            "playwright install chromium"
        )
    return _PLAYWRIGHT_AVAILABLE


class _Browser:
    """Context manager that lazily launches a single Chromium browser.

    Reused across all benchmark fetchers in one pipeline run to avoid the
    ~1s startup cost per page. If Playwright is unavailable, entering the
    context manager is a no-op and ``page`` is None — callers must check.
    """

    def __init__(self) -> None:
        self._pw = None
        self._browser = None
        self._ctx = None

    def __enter__(self) -> "_Browser":
        if not _check_playwright():
            return self
        try:
            from playwright.sync_api import sync_playwright
        except ImportError:
            return self
        try:
            self._pw = sync_playwright().start()
            self._browser = self._pw.chromium.launch(
                headless=True,
                args=[
                    "--disable-blink-features=AutomationControlled",
                    "--no-sandbox",
                    "--disable-dev-shm-usage",
                ],
            )
            self._ctx = self._browser.new_context(
                user_agent=USER_AGENT,
                viewport={"width": 1920, "height": 1080},
                locale="en-US",
                java_script_enabled=True,
            )
            # Stealth: mask the navigator.webdriver property to reduce the
            # chance of bot-detection walls (HF Spaces, lmarena).
            self._ctx.add_init_script(
                "Object.defineProperty(navigator, 'webdriver', {get: () => undefined});"
            )
        except Exception as exc:  # noqa: BLE001 — never crash the pipeline
            log(f"Playwright launch failed: {exc} — falling back to stale")
            self._close()
            self._pw = None
            self._browser = None
            self._ctx = None
        return self

    @property
    def page(self):
        """Return a fresh page on the active context, or None if unavailable."""
        if self._ctx is None:
            return None
        try:
            return self._ctx.new_page()
        except Exception as exc:  # noqa: BLE001
            log(f"Playwright new_page failed: {exc}")
            return None

    def _close(self) -> None:
        for attr in ("_ctx", "_browser"):
            obj = getattr(self, attr, None)
            if obj is not None:
                try:
                    obj.close()
                except Exception:  # noqa: BLE001
                    pass
        if self._pw is not None:
            try:
                self._pw.stop()
            except Exception:  # noqa: BLE001
                pass

    def __exit__(self, *exc: object) -> None:
        self._close()
        self._pw = None
        self._browser = None
        self._ctx = None


def _render(
    browser: _Browser,
    url: str,
    *,
    wait_until: str = "networkidle",
    settle_ms: int = 6000,
    timeout_ms: int = HTTP_TIMEOUT * 1000,
) -> tuple[Any, str] | None:
    """Render ``url`` and return ``(page, html)``. Returns None on failure.

    Caller is responsible for closing the page (``page.close()``).
    On failure logs the error and (if the page launched) saves a screenshot
    to ``scripts/screenshots/`` for debugging.
    """
    page = browser.page
    if page is None:
        return None
    name = re.sub(r"[^a-zA-Z0-9_.-]+", "_", url.split("/")[-1] or "root")[:60]
    try:
        resp = page.goto(url, wait_until=wait_until, timeout=timeout_ms)
        if resp is not None and resp.status >= 400:
            log(f"HTTP {resp.status} rendering {url}")
            # Short-circuit on auth/forbidden errors: these pages will never
            # render useful content and waiting for settle just burns the time
            # budget (the cause of the SWE-bench HF-secondary timeout).
            if resp.status in (401, 403):
                try:
                    page.close()
                except Exception:  # noqa: BLE001
                    pass
                return None
        page.wait_for_timeout(settle_ms)
        html = page.content()
        if is_debug():
            try:
                os.makedirs(SCREENSHOTS_DIR, exist_ok=True)
                ts = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S")
                shot = os.path.join(SCREENSHOTS_DIR, f"{name}_{ts}.png")
                page.screenshot(path=shot, full_page=True)
                html_path = os.path.join(SCREENSHOTS_DIR, f"{name}_{ts}.html")
                with open(html_path, "w", encoding="utf-8") as fh:
                    fh.write(html)
                log(f"  debug screenshot+html saved to {shot}")
            except Exception as exc:  # noqa: BLE001
                log(f"  debug artifact save failed: {exc}")
        return page, html
    except Exception as exc:  # noqa: BLE001
        log(f"Render failed for {url}: {exc}")
        try:
            os.makedirs(SCREENSHOTS_DIR, exist_ok=True)
            ts = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S")
            path = os.path.join(SCREENSHOTS_DIR, f"{name}_{ts}.png")
            page.screenshot(path=path, full_page=True)
            log(f"  screenshot saved to {path}")
        except Exception:  # noqa: BLE001
            pass
        try:
            page.close()
        except Exception:  # noqa: BLE001
            pass
        return None


def _follow_iframe(
    browser: _Browser,
    page: Any,
    settle_ms: int = 6000,
) -> tuple[Any, str] | None:
    """Some HF Spaces embed the real app in an ``<iframe>``.

    If ``page`` contains an iframe whose ``src`` looks like the leaderboard
    app (``*.hf.space``), navigate the same page there and re-render. Returns
    ``(page, html)`` after the iframe content loads, or None.
    """
    try:
        iframes = page.evaluate(
            "() => Array.from(document.querySelectorAll('iframe'))"
            ".map(f => f.src).filter(s => s && s.indexOf('stripe') === -1)"
        )
    except Exception:  # noqa: BLE001
        iframes = []
    if not iframes:
        return None
    target = iframes[0]
    log(f"  following iframe to {target}", verbose_only=True)
    try:
        page.goto(target, wait_until="networkidle", timeout=HTTP_TIMEOUT * 1000)
        page.wait_for_timeout(settle_ms)
        return page, page.content()
    except Exception as exc:  # noqa: BLE001
        log(f"  iframe navigation failed: {exc}")
        return None


def _extract_dom_table(page: Any, max_rows: int = 80) -> list[list[str]]:
    """Extract the first non-empty ``<table>`` from the rendered DOM.

    Returns a list of rows, each row a list of stripped cell text values.
    Returns ``[]`` if no table has any data rows.
    """
    try:
        tables = page.evaluate(
            """() => {
                const out = [];
                document.querySelectorAll('table').forEach((t) => {
                    const trs = t.querySelectorAll('tr');
                    const rows = [];
                    trs.forEach(tr => {
                        const cells = Array.from(tr.querySelectorAll('th,td'))
                            .map(c => c.innerText.trim().replace(/\\n/g, ' '));
                        if (cells.some(c => c.length)) rows.push(cells);
                    });
                    if (rows.length) out.push(rows);
                });
                return out;
            }"""
        )
    except Exception as exc:  # noqa: BLE001
        log(f"DOM table extract failed: {exc}")
        return []
    if not tables:
        # Fallback: AG-Grid (div-based grid with role="gridcell").
        ag = _extract_ag_grid(page, max_rows=max_rows)
        if ag:
            return ag
        return []
    # Pick the largest table.
    tables.sort(key=len, reverse=True)
    return tables[0][:max_rows]


def _extract_ag_grid(page: Any, max_rows: int = 80) -> list[list[str]]:
    """Extract rows from an AG-Grid (div-based, role='gridcell' + col-id).

    AG-Grid does not use <table>; each row is a div[role='row'] containing
    div[role='gridcell'][col-id='ColumnName'] cells. This groups cells by
    their containing row div and returns header + data rows.
    """
    try:
        rows = page.evaluate(
            """(maxRows) => {
                const rowEls = document.querySelectorAll('div[role="row"]');
                if (!rowEls.length) return [];
                const out = [];
                for (const r of rowEls) {
                    const cells = r.querySelectorAll(':scope > div[role="gridcell"]');
                    if (!cells.length) continue;
                    const vals = [];
                    for (const c of cells) {
                        const colId = c.getAttribute('col-id') || '';
                        let txt = c.innerText.trim().replace(/\\n/g, ' ');
                        vals.push(txt);
                    }
                    if (vals.some(v => v.length)) out.push(vals);
                    if (out.length >= maxRows + 1) break;
                }
                return out;
            }""",
            max_rows,
        )
    except Exception as exc:  # noqa: BLE001
        log(f"AG-Grid extract failed: {exc}")
        return []
    if not rows:
        return []
    # AG-Grid renders a header row (role="row" with col-id) + data rows.
    # The first row with col-id values matching column names is the header.
    # Heuristic: if the first row's cells are all non-numeric and short,
    # treat it as a header.
    return rows[: max_rows + 1]


def _row_score(row: list[str], col: int) -> float:
    """Parse a numeric score out of ``row[col]`` (strip %, commas, $)."""
    if col < 0 or col >= len(row):
        return 0.0
    text = re.sub(r"[^0-9.\-]", "", row[col])
    try:
        return float(text) if text else 0.0
    except ValueError:
        return 0.0


def _row_model(row: list[str], col: int) -> str:
    if col < 0 or col >= len(row):
        return ""
    # Strip leading emoji/markers like "🆕", "🔥", ranking numbers.
    txt = row[col].strip()
    # Remove leading non-alphanumeric tokens (emojis, symbols) up to the
    # first letter — keeps "Claude 4.5 Opus" from "🆕 Claude 4.5 Opus".
    m = re.search(r"[A-Za-z0-9].*", txt)
    if m:
        txt = m.group(0)
    # Strip trailing BFCL mode markers appended in parentheses, e.g.
    # "Claude-Opus-4-5-20251101 (FC)", "GPT-4.1 (Prompt)",
    # "GLM-4.6 (FC thinking)", "DeepSeek-V3.2-Exp (Prompt + Thinking)".
    # These are function-calling-mode tags, not part of the model name.
    txt = re.sub(r"\s*\((?:FC|Prompt|FC thinking|Prompt \+ Thinking)\)\s*$", "", txt)
    return txt.strip()


def _entries_from_rows(
    rows: list[list[str]],
    model_col: int,
    score_col: int,
    alias_index: dict[str, str],
    *,
    invert_rank: bool = False,
    rank_max: int = 0,
    max_rows: int = 50,
) -> list[dict[str, Any]]:
    """Build top_models entries from a parsed table.

    ``invert_rank``: if True, the score column is a 1-based rank (lower is
    better); convert to a score where higher is better via
    ``rank_max - rank + 1``. ``rank_max`` defaults to the number of rows.
    """
    if not rows:
        return []
    # Skip header rows (those with no parseable score in score_col).
    entries: list[dict[str, Any]] = []
    if invert_rank and not rank_max:
        rank_max = len(rows)
    seen: set[str] = set()
    for row in rows:
        if not row:
            continue
        raw = _row_model(row, model_col)
        if not raw:
            continue
        canon = canonicalize(raw, alias_index)
        if not canon or canon in seen:
            continue
        score = _row_score(row, score_col)
        if invert_rank and score > 0:
            score = float(rank_max - int(score) + 1)
        seen.add(canon)
        entries.append({"model": canon, "raw_name": raw, "score": round(score, 4)})
        if len(entries) >= max_rows:
            break
    return entries


def _entries_from_text(
    text: str,
    alias_index: dict[str, str],
    *,
    header_prefix: str | None = None,
    model_regex: str | None = None,
    score_regex: str | None = None,
    max_rows: int = 50,
) -> list[dict[str, Any]]:
    """Parse a leaderboard that renders as plain text (no <table>).

    Looks for lines matching ``<model> <score>`` after a header marker. The
    fallback regex finds tokens near numbers if no header is matched.
    """
    entries: list[dict[str, Any]] = []
    lines = text.splitlines()
    start = 0
    if header_prefix:
        for i, ln in enumerate(lines):
            if header_prefix.lower() in ln.lower():
                start = i + 1
                break
    seen: set[str] = set()
    # Default: each line is "ModelName score [score score ...]".
    line_re = re.compile(r"^(.+?)\s+(\d{1,3}(?:\.\d+)?)\s*(.*)$")
    for ln in lines[start:]:
        s = ln.strip()
        if not s:
            continue
        m = line_re.match(s)
        if not m:
            continue
        raw = m.group(1).strip()
        canon = canonicalize(raw, alias_index)
        if not canon or canon in seen:
            continue
        try:
            score = float(m.group(2))
        except ValueError:
            continue
        seen.add(canon)
        entries.append({"model": canon, "raw_name": raw, "score": round(score, 4)})
        if len(entries) >= max_rows:
            break
    return entries


# ---------------------------------------------------------------------------
# Per-benchmark fetchers
# ---------------------------------------------------------------------------


def fetch_bfcl(
    alias_index: dict[str, str], browser: _Browser | None = None
) -> dict[str, Any]:
    """Berkeley Function Calling Leaderboard — JS-rendered, Playwright scrape."""
    urls = BENCHMARK_SOURCES["bfcl"]
    if not _check_playwright() or browser is None or browser.page is None:
        log("BFCL: Playwright unavailable — marking stale")
        return _empty_benchmark(stale=True) | {"source_url": urls[0]}
    for url in urls:
        page = browser.page
        if page is None:
            continue
        rendered = _render(browser, url, settle_ms=10000)
        if rendered is None:
            continue
        pg, _html = rendered
        rows = _extract_dom_table(pg, max_rows=120)
        pg.close()
        if not rows:
            log(f"BFCL: no table found at {url}", verbose_only=True)
            continue
        # Header is multi-row; find the data row by locating "Overall Acc".
        # Columns (V4): Rank | Overall Acc | Model | Cost | ... (model_col=2).
        # But the exact layout shifts between BFCL versions; locate by header.
        model_col, score_col = 2, 1
        for i, row in enumerate(rows[:4]):
            cells = [c.lower() for c in row]
            if "model" in cells:
                model_col = cells.index("model")
            if "overall acc" in " ".join(cells) or any(
                "overall acc" in c for c in cells
            ):
                score_col = next(
                    (j for j, c in enumerate(cells) if "overall acc" in c), 1
                )
        entries = _entries_from_rows(
            rows[2:], model_col, score_col, alias_index, max_rows=50
        )
        if entries:
            return {
                "fetched_at": _now_iso(),
                "stale": False,
                "source_url": url,
                "top_models": entries,
            }
        log(f"BFCL: 0 canonical entries from {url}", verbose_only=True)
    log("BFCL: all sources exhausted — marking stale")
    return _empty_benchmark(stale=True) | {"source_url": urls[0]}


def fetch_swe_bench(
    alias_index: dict[str, str], browser: _Browser | None = None
) -> dict[str, Any]:
    """SWE-bench — swebench.com renders a single large table."""
    urls = BENCHMARK_SOURCES["swe_bench"]
    if not _check_playwright() or browser is None or browser.page is None:
        log("SWE-bench: Playwright unavailable — marking stale")
        return _empty_benchmark(stale=True) | {"source_url": urls[0]}
    for url in urls:
        page = browser.page
        if page is None:
            continue
        rendered = _render(browser, url, wait_until="domcontentloaded", settle_ms=6000)
        if rendered is None:
            continue
        pg, _html = rendered
        rows = _extract_dom_table(pg, max_rows=120)
        pg.close()
        if not rows:
            log(f"SWE-bench: no table at {url}", verbose_only=True)
            continue
        # Header: "" | Model | % Resolved | Avg $ | Trajs | Org | Date | Agent
        # model_col=1, score_col=2 (the "% Resolved" column).
        entries = _entries_from_rows(
            rows[1:],
            model_col=1,
            score_col=2,
            alias_index=alias_index,
            max_rows=50,
        )
        if entries:
            return {
                "fetched_at": _now_iso(),
                "stale": False,
                "source_url": url,
                "top_models": entries,
            }
    log("SWE-bench: all sources exhausted — marking stale")
    return _empty_benchmark(stale=True) | {"source_url": urls[0]}


def fetch_live_code_bench(
    alias_index: dict[str, str], browser: _Browser | None = None
) -> dict[str, Any]:
    """LiveCodeBench — leaderboard renders as an AG-Grid (div-based grid).

    The static HF Space app renders rows with columns:
        Rank | Model | Pass@1 | Easy-Pass@1 | Medium-Pass@1 | Hard-Pass@1
    The default time window (Sep 2023 – Jun 2024) shows older models; the
    extraction still works, we just match whatever canonical models appear.
    Falls back to text parsing if the grid is not found.
    """
    urls = BENCHMARK_SOURCES["live_code_bench"]
    if not _check_playwright() or browser is None or browser.page is None:
        log("LiveCodeBench: Playwright unavailable — marking stale")
        return _empty_benchmark(stale=True) | {"source_url": urls[0]}
    for url in urls:
        page = browser.page
        if page is None:
            continue
        rendered = _render(browser, url, settle_ms=12000)
        if rendered is None:
            continue
        pg, _html = rendered
        rows = _extract_dom_table(pg, max_rows=120)
        if rows:
            pg.close()
            # Locate Model and Pass@1 columns by header (if present).
            model_col, score_col = 1, 2
            start = 0
            if rows:
                header = rows[0]
                # Detect header row: model cell contains "model" literally.
                is_header = any(h.lower().strip() == "model" for h in header)
                if is_header:
                    for j, h in enumerate(header):
                        hl = h.lower().strip()
                        if hl == "model":
                            model_col = j
                        elif hl == "pass@1" or hl.startswith("pass@1"):
                            score_col = j
                    start = 1
                else:
                    # AG-Grid: no explicit header row; col-id order is
                    # Rank, Model, Pass@1, ... so model_col=1, score_col=2.
                    start = 0
            entries = _entries_from_rows(
                rows[start:], model_col, score_col, alias_index, max_rows=50
            )
            if entries:
                return {
                    "fetched_at": _now_iso(),
                    "stale": False,
                    "source_url": url,
                    "top_models": entries,
                }
            log(f"LiveCodeBench: 0 entries from grid at {url}", verbose_only=True)
        else:
            # Fallback: text parsing (older app versions).
            text = pg.evaluate("() => document.body ? document.body.innerText : ''")
            pg.close()
            if not text:
                continue
            entries = _entries_from_text(
                text, alias_index, header_prefix="Pass@1", max_rows=50
            )
            if entries:
                return {
                    "fetched_at": _now_iso(),
                    "stale": False,
                    "source_url": url,
                    "top_models": entries,
                }
            log(f"LiveCodeBench: 0 entries from text at {url}", verbose_only=True)
    log("LiveCodeBench: all sources exhausted — marking stale")
    return _empty_benchmark(stale=True) | {"source_url": urls[0]}


def fetch_chatbot_arena(
    alias_index: dict[str, str], browser: _Browser | None = None
) -> dict[str, Any]:
    """Chatbot Arena (lmarena.ai) — JS-rendered table. The "Overall" column
    is a 1-based rank (lower is better), so we invert it into a score."""
    urls = BENCHMARK_SOURCES["chatbot_arena"]
    if not _check_playwright() or browser is None or browser.page is None:
        log("Chatbot Arena: Playwright unavailable — marking stale")
        return _empty_benchmark(stale=True) | {"source_url": urls[0]}
    for url in urls:
        page = browser.page
        if page is None:
            continue
        rendered = _render(browser, url, settle_ms=8000)
        if rendered is None:
            continue
        pg, _html = rendered
        rows = _extract_dom_table(pg, max_rows=700)
        pg.close()
        if not rows:
            log(f"Chatbot Arena: no table at {url}", verbose_only=True)
            continue
        # Header: Model | Overall | Expert | Hard Prompts | Coding | ...
        # "Overall" is the rank (1 = best). Invert to a score.
        rank_max = len(rows) - 1
        entries = _entries_from_rows(
            rows[1:],
            model_col=0,
            score_col=1,
            alias_index=alias_index,
            invert_rank=True,
            rank_max=rank_max,
            max_rows=50,
        )
        if entries:
            return {
                "fetched_at": _now_iso(),
                "stale": False,
                "source_url": url,
                "top_models": entries,
            }
        log(f"Chatbot Arena: 0 entries from {url}", verbose_only=True)
    log("Chatbot Arena: all sources exhausted — marking stale")
    return _empty_benchmark(stale=True) | {"source_url": urls[0]}


def fetch_mmlu_pro(
    alias_index: dict[str, str], browser: _Browser | None = None
) -> dict[str, Any]:
    """MMLU-Pro — Open LLM Leaderboard (HF Space). The static app renders a
    table with an "MMLU-PRO" column (column index 10 in the default view).

    NOTE (2026-07): The Open LLM Leaderboard is **archived** — it no longer
    accepts new submissions and only lists open-weight community models
    (fine-tunes of Qwen/Llama/Mistral), NOT the frontier proprietary models
    in our canonical set (Claude, GPT, Gemini, etc.). The extraction logic
    below works correctly (table parses, MMLU-PRO column detected), but
    0 canonical matches is expected because none of the leaderboard's
    ``org/model-name`` entries resolve to our canonical names. This
    benchmark is left stale until a replacement MMLU-Pro source is found.
    """
    urls = BENCHMARK_SOURCES["mmlu_pro"]
    if not _check_playwright() or browser is None or browser.page is None:
        log("MMLU-Pro: Playwright unavailable — marking stale")
        return _empty_benchmark(stale=True) | {"source_url": urls[0]}
    for url in urls:
        page = browser.page
        if page is None:
            continue
        # The Open LLM Leaderboard HF Space keeps a websocket open so
        # ``networkidle`` never fires and the 30s goto timeout expires.
        # Use ``domcontentloaded`` + a generous settle so the JS app has
        # time to render the table before we scrape it.
        rendered = _render(browser, url, wait_until="domcontentloaded", settle_ms=12000)
        if rendered is None:
            continue
        pg, _html = rendered
        rows = _extract_dom_table(pg, max_rows=80)
        pg.close()
        if not rows:
            log(f"MMLU-Pro: no table at {url}", verbose_only=True)
            continue
        # Header: "" | Rank | Type | Model | Average | IFEval | BBH | MATH |
        #         GPQA | MUSR | MMLU-PRO | CO₂ Cost
        # model_col=3, score_col = index of "MMLU-PRO" (default 10).
        header = rows[0] if rows else []
        score_col = 10
        for j, h in enumerate(header):
            if "mmlu-pro" in h.lower().replace(" ", ""):
                score_col = j
                break
        entries = _entries_from_rows(
            rows[1:],
            model_col=3,
            score_col=score_col,
            alias_index=alias_index,
            max_rows=50,
        )
        if entries:
            return {
                "fetched_at": _now_iso(),
                "stale": False,
                "source_url": url,
                "top_models": entries,
            }
        log(f"MMLU-Pro: 0 entries from {url}", verbose_only=True)
    log("MMLU-Pro: all sources exhausted — marking stale")
    return _empty_benchmark(stale=True) | {"source_url": urls[0]}


# ---------------------------------------------------------------------------
# Ranking engine
# ---------------------------------------------------------------------------


def _score_for_benchmark(benchmark: dict[str, Any], canonical: str) -> float:
    """Look up a model's score in a benchmark's top_models list.

    Returns 0.0 if the model is absent or the benchmark is stale.
    """
    if benchmark.get("stale"):
        return 0.0
    for entry in benchmark.get("top_models", []):
        if entry.get("model") == canonical:
            return float(entry.get("score", 0.0))
    return 0.0


def _rank_for_benchmark(benchmark: dict[str, Any], canonical: str) -> int:
    """Return the 1-based rank of a model in a benchmark (0 if absent)."""
    if benchmark.get("stale"):
        return 0
    for idx, entry in enumerate(benchmark.get("top_models", []), start=1):
        if entry.get("model") == canonical:
            return idx
    return 0


def compute_role_score(
    canonical: str,
    role_map: dict[str, Any],
    benchmarks: dict[str, dict[str, Any]],
) -> tuple[float, str, int]:
    """Compute the weighted score for a model in a given role.

    Returns ``(score, primary_benchmark_key, rank_in_primary)``.
    """
    primary_key = role_map["primary"]
    secondary_key = role_map.get("secondary")
    pw = float(role_map.get("primary_weight", 1.0))
    sw = float(role_map.get("secondary_weight", 0.0))

    primary = benchmarks.get(primary_key, _empty_benchmark())
    p_score = _score_for_benchmark(primary, canonical)
    p_rank = _rank_for_benchmark(primary, canonical)

    if secondary_key and sw > 0:
        secondary = benchmarks.get(secondary_key, _empty_benchmark())
        s_score = _score_for_benchmark(secondary, canonical)
        total = pw * p_score + sw * s_score
    else:
        total = pw * p_score

    return total, primary_key, p_rank


def generate_rankings(
    benchmarks: dict[str, dict[str, Any]],
    provider_models: dict[str, dict[str, list[str]]],
    alias_index: dict[str, str],
) -> dict[str, dict[str, dict[str, Any]]]:
    """Generate the ``rankings`` section of presets.json.

    For each provider, for each agent role, pick the best available model
    (highest weighted benchmark score). Falls back to FALLBACK_ASSIGNMENTS
    when no benchmark data covers any of the provider's models for that role.
    """
    rankings: dict[str, dict[str, dict[str, Any]]] = {}

    for provider, models in provider_models.items():
        rankings[provider] = {}
        available_canonicals = list(models.keys())
        for role, role_map in AGENT_BENCHMARK_MAP.items():
            best = _pick_best_model(
                role, role_map, benchmarks, available_canonicals, alias_index
            )
            if best is None:
                # Fallback: use the static assignment if the provider has it.
                fallback_canon = FALLBACK_ASSIGNMENTS.get(role)
                if fallback_canon and fallback_canon in available_canonicals:
                    score, primary_key, rank = compute_role_score(
                        fallback_canon, role_map, benchmarks
                    )
                    best = {
                        "model": fallback_canon,
                        "provider_model_id": models[fallback_canon][0],
                        "score": round(score, 4),
                        "benchmark": primary_key,
                        "rank": rank,
                        "fallback": True,
                    }
                else:
                    # No suitable model on this provider at all.
                    best = {
                        "model": None,
                        "provider_model_id": None,
                        "score": 0.0,
                        "benchmark": role_map["primary"],
                        "rank": 0,
                        "fallback": True,
                    }
            rankings[provider][role] = best
    return rankings


def _pick_best_model(
    role: str,  # noqa: ARG001 — kept for clarity / future use
    role_map: dict[str, Any],
    benchmarks: dict[str, dict[str, Any]],
    available: list[str],
    alias_index: dict[str, str],  # noqa: ARG001
) -> dict[str, Any] | None:
    """Pick the highest-scoring available model for a role."""
    best_model: str | None = None
    best_score = -1.0
    best_rank = 0
    best_primary = role_map["primary"]
    for canon in available:
        score, primary_key, rank = compute_role_score(canon, role_map, benchmarks)
        if score > best_score:
            best_score = score
            best_model = canon
            best_rank = rank
            best_primary = primary_key
    if best_model is None or best_score <= 0.0:
        return None
    return {
        "model": best_model,
        "provider_model_id": None,  # filled in by caller if needed
        "score": round(best_score, 4),
        "benchmark": best_primary,
        "rank": best_rank,
        "fallback": False,
    }


# ---------------------------------------------------------------------------
# Atomic write
# ---------------------------------------------------------------------------


def atomic_write_json(path: str, data: Any) -> None:
    """Write JSON atomically: temp file in same dir + os.rename."""
    dirname = os.path.dirname(path) or "."
    fd, tmp = tempfile.mkstemp(prefix=".presets-", suffix=".json", dir=dirname)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            json.dump(data, fh, indent=2, sort_keys=False)
            fh.write("\n")
        # mkstemp creates 0600; normalize to 0644 so CI/clone can read it.
        os.chmod(tmp, 0o644)
        os.replace(tmp, path)
    except Exception:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


# ---------------------------------------------------------------------------
# Main pipeline
# ---------------------------------------------------------------------------


def run_pipeline(dry_run: bool = False) -> dict[str, Any]:
    """Run the full pipeline and return the presets dict."""
    aliases = load_aliases()
    alias_index = build_alias_index(aliases)

    # 1. Fetch benchmarks (in sequence — stdlib only, no asyncio).
    #    A single Chromium browser is launched for the whole run and reused
    #    across all benchmark fetchers to amortize the ~1s startup cost.
    log("Fetching benchmarks...")
    benchmarks: dict[str, dict[str, Any]] = {}
    fetchers = {
        "bfcl": fetch_bfcl,
        "swe_bench": fetch_swe_bench,
        "live_code_bench": fetch_live_code_bench,
        "chatbot_arena": fetch_chatbot_arena,
        "mmlu_pro": fetch_mmlu_pro,
    }
    with _Browser() as browser:
        for key, fn in fetchers.items():
            t0 = time.monotonic()
            try:
                benchmarks[key] = fn(alias_index, browser=browser)
            except Exception as exc:  # noqa: BLE001 — never crash
                log(f"Benchmark {key}: unexpected error {exc} — marking stale")
                benchmarks[key] = _empty_benchmark(stale=True)
                benchmarks[key]["source_url"] = (
                    BENCHMARK_SOURCES[key][0] if key in BENCHMARK_SOURCES else None
                )
            dt = time.monotonic() - t0
            n = len(benchmarks[key].get("top_models", []))
            stale = benchmarks[key].get("stale")
            log(f"  {key}: {n} models, stale={stale} ({dt:.1f}s)")

    # 2. Fetch provider model lists.
    log("Fetching provider model lists...")
    provider_models: dict[str, dict[str, list[str]]] = {}
    for provider in PROVIDER_ENDPOINTS:
        provider_models[provider] = fetch_provider_models(provider, alias_index)

    # 3. Generate rankings.
    log("Generating rankings...")
    rankings = generate_rankings(benchmarks, provider_models, alias_index)

    # 4. Fill in provider_model_id for chosen models.
    for provider, role_map in rankings.items():
        models = provider_models.get(provider, {})
        for role, entry in role_map.items():
            canon = entry.get("model")
            if canon and canon in models:
                entry["provider_model_id"] = models[canon][0]

    # 5. Assemble final presets object.
    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    presets = {
        "version": today,
        "generated_at": _now_iso(),
        "benchmarks": benchmarks,
        "rankings": rankings,
        "agent_benchmark_map": AGENT_BENCHMARK_MAP,
        "metadata": {
            "pipeline": "scripts/update_presets.py",
            "providers_queried": list(PROVIDER_ENDPOINTS.keys()),
            "benchmarks_queried": list(fetchers.keys()),
            "aliases_version": "1.0.0",
            "fetcher": "playwright" if _check_playwright() else "urllib-fallback",
            "user_agent": USER_AGENT,
        },
    }
    return presets


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Generate neuralgentics model presets.json from benchmark + provider data.",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Print the generated presets.json to stdout instead of writing the file.",
    )
    parser.add_argument(
        "-v",
        "--verbose",
        action="store_true",
        help="Log progress detail to stderr.",
    )
    parser.add_argument(
        "--debug",
        action="store_true",
        help="Verbose + save screenshots/HTML for every rendered page to scripts/screenshots/.",
    )
    parser.add_argument(
        "--only",
        type=str,
        default=None,
        help="Run only the named benchmark fetcher (bfcl, swe_bench, "
        "live_code_bench, chatbot_arena, mmlu_pro) and print its result as JSON. "
        "Skips provider fetches and ranking generation.",
    )
    parser.add_argument(
        "--dump-names",
        action="store_true",
        help="With --only: print the raw model names seen in the leaderboard "
        "table (one per line) instead of the canonicalized benchmark dict. "
        "Use to discover aliases that need adding to model_aliases.json.",
    )
    args = parser.parse_args(argv)
    set_verbose(args.verbose or args.debug)
    set_debug(args.debug)

    aliases = load_aliases()
    alias_index = build_alias_index(aliases)

    if args.only:
        return _run_single(
            args.only,
            alias_index,
            dump_names=args.dump_names,
        )

    log("Starting presets pipeline...")
    presets = run_pipeline(dry_run=args.dry_run)

    if args.dry_run:
        json.dump(presets, sys.stdout, indent=2)
        sys.stdout.write("\n")
        log("Dry run complete — no file written.")
    else:
        atomic_write_json(PRESETS_PATH, presets)
        log(f"Wrote {PRESETS_PATH}")
    return 0


def _run_single(name: str, alias_index: dict[str, str], *, dump_names: bool) -> int:
    """Run one benchmark fetcher and print its result (for debugging/alias discovery)."""
    fetchers = {
        "bfcl": fetch_bfcl,
        "swe_bench": fetch_swe_bench,
        "live_code_bench": fetch_live_code_bench,
        "chatbot_arena": fetch_chatbot_arena,
        "mmlu_pro": fetch_mmlu_pro,
    }
    if name not in fetchers:
        log(f"Unknown benchmark '{name}'. Choices: {', '.join(fetchers)}")
        return 2
    log(f"Running single fetcher: {name}")
    t0 = time.monotonic()
    with _Browser() as browser:
        try:
            result = fetchers[name](alias_index, browser=browser)
        except Exception as exc:  # noqa: BLE001
            log(f"Benchmark {name}: error {exc}")
            result = _empty_benchmark(stale=True)
    dt = time.monotonic() - t0
    n = len(result.get("top_models", []))
    log(f"  {name}: {n} models, stale={result.get('stale')} ({dt:.1f}s)")
    if dump_names:
        # Re-extract raw names by re-rendering and dumping table cells.
        raws = _dump_raw_names(name, alias_index)
        for r in raws:
            sys.stdout.write(r + "\n")
    else:
        json.dump(result, sys.stdout, indent=2)
        sys.stdout.write("\n")
    return 0


def _dump_raw_names(name: str, alias_index: dict[str, str]) -> list[str]:
    """Re-render the primary source and return raw model-name strings.

    Best-effort: returns the model column from the first non-empty table
    (or text lines for text-mode benchmarks). Used by ``--only X --dump-names``.
    """
    urls = BENCHMARK_SOURCES.get(name, [])
    out: list[str] = []
    with _Browser() as browser:
        for url in urls:
            page = browser.page
            if page is None:
                continue
            rendered = _render(browser, url, settle_ms=10000)
            if rendered is None:
                continue
            pg, _html = rendered
            if name == "live_code_bench":
                text = pg.evaluate("() => document.body ? document.body.innerText : ''")
                pg.close()
                for ln in (text or "").splitlines():
                    s = ln.strip()
                    if s:
                        out.append(s)
                if out:
                    return out[:120]
                continue
            rows = _extract_dom_table(pg, max_rows=120)
            pg.close()
            if not rows:
                continue
            # Guess model column by header.
            model_col = 2 if name == "bfcl" else (1 if name == "swe_bench" else 0)
            if name == "mmlu_pro":
                model_col = 3
            if name == "chatbot_arena":
                model_col = 0
            for i, row in enumerate(rows[:4]):
                cells = [c.lower() for c in row]
                if "model" in cells:
                    model_col = cells.index("model")
                    break
            for row in rows:
                raw = _row_model(row, model_col)
                if raw:
                    out.append(raw)
            if out:
                return out[:120]
    return out


if __name__ == "__main__":
    sys.exit(main())
