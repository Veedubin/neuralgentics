"""In-memory registry of MCP servers and their tools."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from broker.models import ServerConfig, ToolSummary


@dataclass
class _ServerEntry:
    config: ServerConfig
    process: Any  # subprocess.Popen
    tools: list[ToolSummary] = field(default_factory=list)


class Registry:
    """In-memory registry mapping server names to their configs, processes, and tool lists."""

    def __init__(self) -> None:
        self._servers: dict[str, _ServerEntry] = {}

    def register(self, name: str, config: ServerConfig, process: Any) -> None:
        """Register a server. Overwrites existing entry with same name."""
        self._servers[name] = _ServerEntry(config=config, process=process)

    def get_tools(self, server: str | None = None) -> list[ToolSummary]:
        """Return tool summaries. If server is None, return from all servers."""
        if server is not None:
            entry = self._servers.get(server)
            if entry is None:
                return []
            return entry.tools

        all_tools: list[ToolSummary] = []
        for entry in self._servers.values():
            all_tools.extend(entry.tools)
        return all_tools

    def update_tools(self, name: str, tools: list[ToolSummary]) -> None:
        """Update cached tool list for a server (e.g. after initialize/list_tools)."""
        entry = self._servers.get(name)
        if entry is not None:
            entry.tools = tools

    def get_entry(self, name: str) -> _ServerEntry | None:
        return self._servers.get(name)

    def get_process(self, name: str) -> Any | None:
        entry = self._servers.get(name)
        return entry.process if entry else None

    def call_tool(self, server: str, tool: str, args: dict) -> dict:
        """Placeholder — actual invocation goes through MCPProxy."""
        raise NotImplementedError("Use MCPProxy.invoke() for tool calls")

    def deregister(self, name: str) -> None:
        """Remove a server entry. Raises KeyError if not found."""
        if name not in self._servers:
            raise KeyError(name)
        del self._servers[name]

    def list_servers(self) -> list[str]:
        return list(self._servers.keys())
