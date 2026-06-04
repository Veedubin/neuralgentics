"""MCP Proxy — communicates with external MCP servers over stdio JSON-RPC."""

from __future__ import annotations

import json
import logging
from typing import Any

from broker.launcher import Launcher
from broker.models import ToolSummary
from broker.registry import Registry

logger = logging.getLogger(__name__)

# JSON-RPC request ID counter
_next_id: int = 1


def _next_request_id() -> int:
    global _next_id
    req_id = _next_id
    _next_id += 1
    return req_id


class MCPProxyError(Exception):
    """Raised when an MCP proxy call fails."""


class MCPProxy:
    """Proxy layer for talking to MCP servers over stdio (subprocess.Popen).

    Protocol: JSON-RPC 2.0 over stdio.
    Each request is a single JSON line on stdin.
    Each response is a single JSON line on stdout.
    """

    def __init__(self, launcher: Launcher, registry: Registry) -> None:
        self._launcher = launcher
        self._registry = registry

    def initialize(self, server_name: str) -> dict:
        """Send MCP initialize handshake to a server.

        After initialization, discovers tools and caches summaries in the registry.
        """
        result = self._send_rpc(
            server_name,
            "initialize",
            {
                "protocolVersion": "2024-11-05",
                "capabilities": {},
                "clientInfo": {"name": "mcp-broker", "version": "0.1.0"},
            },
        )

        # Discover tools after init
        try:
            tools_result = self._send_rpc(server_name, "tools/list", {})
            tools_data = tools_result.get("tools", [])
            summaries = [
                ToolSummary(
                    server=server_name,
                    name=t.get("name", "unknown"),
                    description=t.get("description", ""),
                )
                for t in tools_data
            ]
            self._registry.update_tools(server_name, summaries)
            logger.info("Discovered %d tools from server '%s'", len(summaries), server_name)
        except Exception as exc:
            logger.warning("Failed to discover tools from '%s': %s", server_name, exc)

        return result

    def invoke(self, server_name: str, method: str, params: dict) -> dict:
        """Invoke a tool on an MCP server.

        For tool calls, uses the `tools/call` MCP method with the tool name
        and arguments.
        """
        entry = self._registry.get_entry(server_name)
        if entry is None:
            raise MCPProxyError(f"Server '{server_name}' not registered")

        if not entry.tools:
            # Lazily initialize on first call
            self.initialize(server_name)

        rpc_params: dict[str, Any] = {
            "name": method,
            "arguments": params,
        }

        result = self._send_rpc(server_name, "tools/call", rpc_params)
        return result

    def _send_rpc(self, server_name: str, method: str, params: dict) -> dict:
        """Send a JSON-RPC request to an MCP server process via stdin."""
        proc = self._launcher.get_process(server_name)
        if proc is None:
            raise MCPProxyError(f"No process for server '{server_name}'")

        if proc.poll() is not None:
            raise MCPProxyError(
                f"Server '{server_name}' process has exited (code={proc.returncode})"
            )

        request = {
            "jsonrpc": "2.0",
            "id": _next_request_id(),
            "method": method,
            "params": params,
        }

        request_line = json.dumps(request) + "\n"
        logger.debug("Sending to '%s': %s", server_name, request_line.strip())

        try:
            proc.stdin.write(request_line)
            proc.stdin.flush()
        except BrokenPipeError as exc:
            raise MCPProxyError(f"Broken pipe writing to server '{server_name}'") from exc

        # Read response line from stdout
        try:
            response_line = proc.stdout.readline()
        except Exception as exc:
            raise MCPProxyError(f"Error reading from server '{server_name}': {exc}") from exc

        if not response_line:
            raise MCPProxyError(f"Empty response from server '{server_name}'")

        response = json.loads(response_line.strip())
        logger.debug("Response from '%s': %s", server_name, response)

        if "error" in response:
            error = response["error"]
            raise MCPProxyError(f"MCP error from '{server_name}': {error.get('message', error)}")

        return response.get("result", {})
