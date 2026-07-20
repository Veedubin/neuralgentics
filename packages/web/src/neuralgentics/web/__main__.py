"""Entry point: ``python -m neuralgentics.web``.

Dispatches to embedded or team-server mode based on --mode flag.
"""

from __future__ import annotations

import argparse
import logging
import sys
from collections.abc import Sequence

from neuralgentics.web.app import build_app, run_app
from neuralgentics.web.config import WebConfig

log = logging.getLogger("neuralgentics.web")


def _parse_args(argv: Sequence[str] | None) -> argparse.Namespace:
    p = argparse.ArgumentParser(
        prog="python -m neuralgentics.web",
        description="neuralgentics-web — modular web UI shell",
    )
    p.add_argument(
        "--mode",
        choices=("embedded", "team-server"),
        default="embedded",
        help="Run mode (default: embedded)",
    )
    p.add_argument("--port", type=int, default=None, help="Override listen port")
    p.add_argument("--host", type=str, default=None, help="Override bind host")
    p.add_argument(
        "--db-url",
        type=str,
        default=None,
        help="PostgreSQL DSN (team-server mode only)",
    )
    p.add_argument(
        "--modules-path",
        type=str,
        default=None,
        help="Override modules directory (default: built-in modules)",
    )
    p.add_argument(
        "--auth",
        choices=("off", "jwt", "oauth2"),
        default="jwt",
        help="Team-server auth mode (default: jwt). 'off' disables auth entirely.",
    )
    p.add_argument(
        "--jwt-secret",
        type=str,
        default=None,
        help="JWT HS256 secret (default: $WEB_JWT_SECRET or a random per-process value)",
    )
    p.add_argument(
        "--auth-db-path",
        type=str,
        default=None,
        help="SQLite user-store path (default: ~/.neuralgentics/web-users.db)",
    )
    p.add_argument(
        "--rbac-mode",
        choices=("permissive", "strict"),
        default="permissive",
        help=(
            "Per-module RBAC strictness (T-111, default: permissive). "
            "'permissive' falls back to the global role table when a module's "
            "module.yaml doesn't declare an action in rbac.actions. "
            "'strict' denies the request with 403 — the manifest is the single "
            "source of truth."
        ),
    )
    # --- T-112: OIDC provider flags ---
    p.add_argument(
        "--oidc-github-client-id",
        type=str,
        default=None,
        help="GitHub OAuth2 client ID. Both ID + secret required to enable GitHub.",
    )
    p.add_argument(
        "--oidc-github-client-secret",
        type=str,
        default=None,
        help="GitHub OAuth2 client secret.",
    )
    p.add_argument(
        "--oidc-google-client-id",
        type=str,
        default=None,
        help="Google OIDC client ID. Both ID + secret required to enable Google.",
    )
    p.add_argument(
        "--oidc-google-client-secret",
        type=str,
        default=None,
        help="Google OIDC client secret.",
    )
    p.add_argument(
        "--oidc-redirect-base",
        type=str,
        default=None,
        help="Base URL for OIDC callbacks (e.g. https://neuralgentics.example.com).",
    )
    p.add_argument(
        "--oidc-default-role",
        choices=("admin", "operator", "viewer"),
        default="viewer",
        help="Role assigned to new OIDC users on first login (default: viewer).",
    )
    p.add_argument(
        "--oidc-generic-discovery-url",
        type=str,
        action="append",
        default=[],
        metavar="NAME=URL",
        help=(
            "Generic OIDC provider discovery URL. Format: "
            "--oidc-generic-discovery-url=okta=https://idp.example/.well-known/"
            "openid-configuration. "
            "Repeatable for multiple providers. Also requires "
            "--oidc-generic-client-id=<NAME> and --oidc-generic-client-secret=<NAME>."
        ),
    )
    p.add_argument(
        "--oidc-generic-client-id",
        type=str,
        action="append",
        default=[],
        metavar="NAME=ID",
        help="Client ID for a generic OIDC provider (paired by NAME with the discovery URL).",
    )
    p.add_argument(
        "--oidc-generic-client-secret",
        type=str,
        action="append",
        default=[],
        metavar="NAME=SECRET",
        help="Client secret for a generic OIDC provider (paired by NAME).",
    )
    p.add_argument("-v", "--verbose", action="store_true", help="Enable debug logging")
    return p.parse_args(argv)


def _parse_generic_oidc(
    discovery_pairs: list[str],
    id_pairs: list[str],
    secret_pairs: list[str],
) -> dict[str, dict[str, str]]:
    """Parse ``NAME=VALUE`` OIDC generic-provider flags into a dict.

    Returns ``{name: {discovery_url, client_id, client_secret}}``. A
    provider is included only if all three are present.
    """

    def _to_map(pairs: list[str]) -> dict[str, str]:
        out: dict[str, str] = {}
        for pair in pairs:
            if "=" not in pair:
                continue
            k, v = pair.split("=", 1)
            out[k.strip()] = v.strip()
        return out

    discovery = _to_map(discovery_pairs)
    ids = _to_map(id_pairs)
    secrets_map = _to_map(secret_pairs)
    result: dict[str, dict[str, str]] = {}
    for name, du in discovery.items():
        cid = ids.get(name)
        csec = secrets_map.get(name)
        if du and cid and csec:
            result[name] = {"discovery_url": du, "client_id": cid, "client_secret": csec}
    return result


def main(argv: Sequence[str] | None = None) -> int:
    args = _parse_args(argv)
    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(asctime)s %(name)s %(levelname)s %(message)s",
    )
    config = WebConfig.from_args(
        mode=args.mode,
        port=args.port,
        host=args.host,
        db_url=args.db_url,
        modules_path=args.modules_path,
        auth_mode=args.auth,
        jwt_secret=args.jwt_secret,
        auth_db_path=args.auth_db_path,
        rbac_mode=args.rbac_mode,
        oidc_github_client_id=args.oidc_github_client_id,
        oidc_github_client_secret=args.oidc_github_client_secret,
        oidc_google_client_id=args.oidc_google_client_id,
        oidc_google_client_secret=args.oidc_google_client_secret,
        oidc_redirect_base=args.oidc_redirect_base,
        oidc_default_role=args.oidc_default_role,
        oidc_generic_providers=_parse_generic_oidc(
            args.oidc_generic_discovery_url,
            args.oidc_generic_client_id,
            args.oidc_generic_client_secret,
        ),
    )
    log.info(
        "starting neuralgentics-web %s in %s mode",
        __import__("neuralgentics.web", fromlist=["__version__"]).__version__,
        config.mode,
    )
    app = build_app(config)
    run_app(app, config)
    return 0


if __name__ == "__main__":
    sys.exit(main())
