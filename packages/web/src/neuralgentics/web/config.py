"""Pydantic settings for neuralgentics-web."""

from __future__ import annotations

import os
from pathlib import Path
from typing import Literal

from pydantic import BaseModel, Field, field_validator

Mode = Literal["embedded", "team-server"]

DEFAULT_EMBEDDED_PORT = 9876
DEFAULT_TEAM_SERVER_PORT = 9877
DEFAULT_EMBEDDED_HOST = "127.0.0.1"
DEFAULT_TEAM_SERVER_HOST = "0.0.0.0"


def _default_modules_path() -> Path:
    """Built-in modules directory: ``neuralgentics/web/modules``."""
    here = Path(__file__).resolve().parent
    return here / "modules"


class WebConfig(BaseModel):
    """Resolved configuration for one server invocation."""

    mode: Mode = "embedded"
    host: str = DEFAULT_EMBEDDED_HOST
    port: int = DEFAULT_EMBEDDED_PORT
    db_url: str | None = None
    modules_path: Path = Field(default_factory=_default_modules_path)

    model_config = {"arbitrary_types_allowed": True}

    @field_validator("modules_path")
    @classmethod
    def _must_exist(cls, v: Path) -> Path:
        if not v.exists():
            raise ValueError(f"modules_path does not exist: {v}")
        if not v.is_dir():
            raise ValueError(f"modules_path is not a directory: {v}")
        return v

    @classmethod
    def from_args(
        cls,
        *,
        mode: str,
        port: int | None,
        host: str | None,
        db_url: str | None,
        modules_path: str | None,
    ) -> WebConfig:
        # Env var fallback so the app factory can also be used without CLI args.
        env_mode = os.environ.get("NEURALGENTICS_WEB_MODE", mode)
        if port is None:
            port = int(os.environ.get("NEURALGENTICS_WEB_PORT", 0)) or None
        if host is None:
            host = os.environ.get("NEURALGENTICS_WEB_HOST")
        if db_url is None:
            db_url = os.environ.get("NEURALGENTICS_WEB_DB_URL")
        if modules_path is None:
            modules_path = os.environ.get("NEURALGENTICS_WEB_MODULES_PATH")

        resolved_mode: Mode = "team-server" if env_mode == "team-server" else "embedded"

        if port is None:
            port = (
                DEFAULT_TEAM_SERVER_PORT
                if resolved_mode == "team-server"
                else DEFAULT_EMBEDDED_PORT
            )
        if host is None:
            host = (
                DEFAULT_TEAM_SERVER_HOST
                if resolved_mode == "team-server"
                else DEFAULT_EMBEDDED_HOST
            )

        if resolved_mode == "team-server" and not db_url:
            log_msg = (
                "team-server mode without --db-url — PG-backed features will be no-ops "
                "until a DSN is provided"
            )
            # Non-fatal: health endpoint still works, /api/v1/modules works (file-based).
            import logging

            logging.getLogger("neuralgentics.web.config").warning(log_msg)

        mp = Path(modules_path) if modules_path else _default_modules_path()

        return cls(
            mode=resolved_mode,
            host=host,
            port=port,
            db_url=db_url,
            modules_path=mp,
        )
