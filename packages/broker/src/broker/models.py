"""Data models for the MCP Broker."""

from __future__ import annotations

from pydantic import BaseModel


class ServerConfig(BaseModel):
    """Configuration for registering an external MCP server."""

    name: str
    type: str  # "docker" | "npx" | "direct"
    command: str
    summary: str = ""


class ToolSummary(BaseModel):
    """Minimal tool summary for token-efficient listing.

    Returns NAME + DESCRIPTION only. No full JSON schemas.
    """

    server: str
    name: str
    description: str = ""


class ToolCall(BaseModel):
    """Request body for calling a tool on a registered server."""

    server: str
    tool: str
    arguments: dict = {}


class DeregisterRequest(BaseModel):
    """Request body for deregistering a server."""

    name: str
