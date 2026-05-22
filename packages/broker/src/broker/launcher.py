"""Launch external MCP server processes (Docker, NPX, direct)."""

from __future__ import annotations

import asyncio
import json
import logging
import subprocess
from typing import Any

from broker.models import ServerConfig

logger = logging.getLogger(__name__)


class LauncherError(Exception):
    """Raised when a server process cannot be started or is unhealthy."""


class Launcher:
    """Manages MCP server subprocess lifecycles."""

    def __init__(self) -> None:
        # name -> subprocess.Popen
        self._procs: dict[str, subprocess.Popen] = {}

    def start(self, config: ServerConfig) -> subprocess.Popen:
        """Start an MCP server process based on its type.

        Supports:
          - "docker": runs `docker run ...`
          - "npx": runs `npx <command>`
          - "direct": runs the command directly
        """
        cmd = self._build_command(config)

        logger.info(
            "Starting MCP server '%s' (type=%s): %s", config.name, config.type, cmd
        )

        try:
            proc = subprocess.Popen(
                cmd,
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
            )
        except FileNotFoundError as exc:
            raise LauncherError(
                f"Command not found for server '{config.name}': {cmd[0]}"
            ) from exc

        self._procs[config.name] = proc
        return proc

    def stop(self, name: str) -> None:
        """Terminate a server process."""
        proc = self._procs.pop(name, None)
        if proc is None:
            return

        logger.info("Stopping MCP server '%s' (pid=%d)", name, proc.pid)
        proc.terminate()

        try:
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            logger.warning("Server '%s' did not exit gracefully, killing", name)
            proc.kill()

    def get_process(self, name: str) -> subprocess.Popen | None:
        return self._procs.get(name)

    def health_check(self, name: str) -> bool:
        """Check if a server process is still running."""
        proc = self._procs.get(name)
        if proc is None:
            return False
        return proc.poll() is None

    def _build_command(self, config: ServerConfig) -> list[str]:
        """Build the command list from a ServerConfig."""
        if config.type == "docker":
            # Split the command string into args for Popen
            return config.command.split()
        elif config.type == "npx":
            return ["npx"] + config.command.split()
        elif config.type == "direct":
            return config.command.split()
        else:
            raise LauncherError(f"Unknown server type: {config.type}")
