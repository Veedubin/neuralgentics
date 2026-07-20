# Standalone walkthrough — `neuralgentics-web` without any other neuralgentics product

This guide walks through using `neuralgentics-web` as a standalone product:
install it, write a custom module, and (optionally) add OIDC for real
single-sign-on. You do **not** need `neuralgentics-gateway`,
`neuralgentics-broker`, or `memini-ai` to follow this guide.

## 1. Install

**Prerequisite:** Python 3.12 or newer. Most Linux distros ship an older
Python — install via your package manager or [pyenv](https://github.com/pyenv/pyenv).

```bash
# Verify Python version
python3 --version  # should print 3.12 or higher
```

**Install the package:**

```bash
pip install neuralgentics-web
```

For development tooling (pytest, ruff, mypy):

```bash
pip install neuralgentics-web[dev]
```

For Postgres-backed team-server mode (only needed if you want persistence
across restarts or multi-user auth):

```bash
pip install neuralgentics-web[team-server]
```

**If you don't have Python 3.12+:**

```bash
# Ubuntu/Debian — deadsnakes PPA for older releases
sudo apt install -y software-properties-common
sudo add-apt-repository -y ppa:deadsnakes/ppa
sudo apt install -y python3.12 python3.12-venv

# Or use pyenv (works on macOS too)
curl https://pyenv.run | bash
pyenv install 3.12
pyenv global 3.12
```

**Boot the shell in embedded mode** (localhost only, no auth, no DB):

```bash
neuralgentics-web --mode=embedded --port=9876
```

Open `http://localhost:9876/` in a browser. You should see the three
shipped modules in the grid. None of them require any external product to
render the grid — they will only show live data when their backing service
is reachable.

### Troubleshooting the install

- **`pip: command not found`** — install with `sudo apt install -y python3-pip` (Debian/Ubuntu) or `brew install python` (macOS).
- **`error: Microsoft Visual C++ 14.0 or greater is required`** (Windows) — install [Build Tools for Visual Studio](https://visualstudio.microsoft.com/downloads/#build-tools-for-visual-studio) or use the pre-built wheels (the package ships wheels for Linux, macOS, and Windows).
- **`Permission denied` on `pip install`** — use a virtual environment: `python3 -m venv .venv && source .venv/bin/activate && pip install neuralgentics-web`. Never `sudo pip install`.
- **`neuralgentics-web: command not found`** after install — your `pip` installs to `~/.local/bin` (PEP 668) or `%APPDATA%\Python\Scripts` (Windows). Add that to PATH:
  - Linux/macOS: `echo 'export PATH=$PATH:$HOME/.local/bin' >> ~/.bashrc && source ~/.bashrc`
  - Windows: search "Environment Variables" in Settings, add `%APPDATA%\Python\Scripts` to PATH.

## 2. Write a custom module

Create a directory anywhere on disk with a `module.yaml` and a `module.py`:

```bash
mkdir -p ./modules/hello
```

```yaml
# ./modules/hello/module.yaml
name: hello
version: 0.1.0
description: A hello-world module
```

```python
# ./modules/hello/module.py
from fastapi import APIRouter

def build_router() -> APIRouter:
    router = APIRouter()

    @router.get("/hello")
    async def hello() -> dict:
        return {"hello": "world"}

    return router
```

Boot the shell pointing at your modules directory:

```bash
neuralgentics-web --mode=embedded --port=9876 --modules-path=./modules
```

Your `hello` module now appears in the grid. Its `/hello` endpoint is
served under `/modules/hello/hello`.

### Per-module RBAC (optional)

In team-server mode you can restrict which roles can read or write a
module by adding an `rbac:` block to its manifest:

```yaml
name: hello
version: 0.1.0
description: A hello-world module
rbac:
  actions:
    read: [viewer, operator, admin]
    write: [operator, admin]
    delete: [admin]
```

## 3. (Optional) Add OIDC

OIDC is the recommended way to handle real authentication. The shell
supports GitHub, Google, and any generic OIDC provider (Okta, Auth0,
Keycloak, etc.).

### GitHub

```bash
neuralgentics-web --mode=team-server \
    --host=0.0.0.0 --port=9877 \
    --auth=oauth2 \
    --oidc-github-client-id=$GITHUB_CLIENT_ID \
    --oidc-github-client-secret=$GITHUB_CLIENT_SECRET \
    --oidc-redirect-base=https://your-host
```

### Google

```bash
neuralgentics-web --mode=team-server \
    --host=0.0.0.0 --port=9877 \
    --auth=oauth2 \
    --oidc-google-client-id=$GOOGLE_CLIENT_ID \
    --oidc-google-client-secret=$GOOGLE_CLIENT_SECRET
```

### Generic (Okta, Auth0, Keycloak, …)

```bash
neuralgentics-web --mode=team-server \
    --host=0.0.0.0 --port=9877 \
    --auth=oauth2 \
    --oidc-generic-discovery-url=okta=https://your-tenant.okta.com/.well-known/openid-configuration \
    --oidc-generic-client-id=okta=$CLIENT_ID \
    --oidc-generic-client-secret=okta=$CLIENT_SECRET
```

New OIDC users are assigned the role named by `--oidc-default-role`
(default `viewer`). Promote them to `operator` or `admin` via the
user-management API.

---

That's the whole standalone story. If you later want to plug in
`neuralgentics-gateway` or `neuralgentics-broker` audit data, see the
[README](../README.md) section "Optional integration with the neuralgentics
ecosystem" — but you never have to.

---

## Troubleshooting

### `/auth/me` returns 500 in `--auth=off` mode

The `/auth/me` endpoint calls `Depends(require_role(...))` which expects
`request.state.user` to be set by the auth middleware. In `--auth=off` mode
the user is `None` and the dependency raises an unhandled exception → 500.

**Workaround:** use `/api/v1/health` to verify the server is up. It returns
`{"auth_mode": "off"}` so you can detect this state.

**Fix:** the auth dependency should check the mode first and return 401 with
a clear message. Tracked in **T-INSTALL-005** (follow-up card).

### Startup warning: "seeding 3 default users (admin/admin, ...)"

This warning fires in **embedded mode** too, where there's no `/auth/login`
page to actually use those users. The warning is misleading.

**Workaround:** ignore the warning in embedded mode (the users are seeded
but unreachable — that's fine, embedded mode doesn't have a login form).

**Fix:** suppress the warning when `auth_mode == "off"`. Tracked in
**T-INSTALL-005**.

### The HTML dashboard loads htmx/tailwind from a CDN (no SRI)

The shell's `index.html` includes:

```html
<script src="https://unpkg.com/htmx.org@1.9.12" defer></script>
<script src="https://cdn.tailwindcss.com" defer></script>
```

These are **CDN-loaded with no Subresource Integrity hash**. If unpkg or
Cloudflare is compromised, malicious JS could be served to your browser.
The same risk class that **T-120** closed for Chart.js (which is now
self-hosted with SRI).

**Workaround for paranoid users:** block `unpkg.com` and `cdn.tailwindcss.com`
in your hosts file, then self-host the two scripts.

**Fix:** self-host htmx + tailwind, with SRI. Tracked in **T-INSTALL-006**.

### `/auth/providers` returns 404 when no OIDC providers configured

If you didn't pass any `--oidc-*` flags, the OIDC router is empty and
`/auth/providers` returns `{"detail":"Not Found"}`. That's by design — there
are no providers to list. To get a useful response, configure at least one
OIDC provider (see the GitHub / Google / Generic examples above) or use
`--auth=jwt` (username + password) instead.