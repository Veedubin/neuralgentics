# Standalone walkthrough — `neuralgentics-web` without any other neuralgentics product

This guide walks through using `neuralgentics-web` as a standalone product:
install it, write a custom module, and (optionally) add OIDC for real
single-sign-on. You do **not** need `neuralgentics-gateway`,
`neuralgentics-broker`, or `memini-ai` to follow this guide.

## 1. Install

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

Boot the shell in embedded mode (localhost only, no auth, no DB):

```bash
neuralgentics-web --mode=embedded --port=9876
```

Open `http://localhost:9876/` in a browser. You should see the three
shipped modules in the grid. None of them require any external product to
render the grid — they will only show live data when their backing service
is reachable.

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