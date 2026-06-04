"""MCP Broker server — FastAPI routes for external tool brokerage."""

from __future__ import annotations

from fastapi import FastAPI, HTTPException

from broker.launcher import Launcher
from broker.models import DeregisterRequest, ServerConfig, ToolCall, ToolSummary
from broker.proxy import MCPProxy
from broker.registry import Registry

app = FastAPI(title="MCP Broker", version="0.1.0")

registry = Registry()
launcher = Launcher()
proxy = MCPProxy(launcher=launcher, registry=registry)


@app.post("/register")
def register_server(config: ServerConfig) -> dict:
    """Register an external MCP server and start its process."""
    try:
        proc = launcher.start(config)
        registry.register(config.name, config, proc)
    except Exception as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return {"status": "registered", "name": config.name}


@app.get("/tools")
def get_tools(server: str | None = None) -> list[ToolSummary]:
    """Return tool summaries. Optionally filter by server name.

    Token reduction: returns NAME + DESCRIPTION only (no full JSON schemas).
    """
    return registry.get_tools(server=server)


@app.post("/call")
def call_tool(body: ToolCall) -> dict:
    """Call a tool on a registered MCP server."""
    try:
        result = proxy.invoke(server_name=body.server, method=body.tool, params=body.arguments)
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc
    return result


@app.post("/deregister")
def deregister_server(body: DeregisterRequest) -> dict:
    """Remove a registered server and stop its process."""
    try:
        launcher.stop(body.name)
        registry.deregister(body.name)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=f"Server '{body.name}' not found") from exc
    return {"status": "deregistered", "name": body.name}


@app.get("/health")
def health() -> dict:
    return {"status": "ok"}
