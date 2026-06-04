"""Pydantic request/response models for the broker and extractor APIs."""

from __future__ import annotations

from typing import Any

from pydantic import BaseModel, Field

# ---------------------------------------------------------------------------
# Intent Broker Models
# ---------------------------------------------------------------------------


class Capability(BaseModel):
    """A lightweight capability descriptor (name + description only)."""

    name: str = Field(..., description="Capability name, e.g. 'github_search_issues'")
    description: str = Field(
        ..., description="Short human-readable description of what this capability does"
    )


class ResolveIntentRequest(BaseModel):
    """Incoming intent resolution request."""

    intent: str = Field(..., description="Natural-language description of what the user wants")
    session_id: str = Field(..., description="Session identifier for context tracking")
    context: str | None = Field(
        default=None, description="Optional additional context to help resolution"
    )


class ResolveIntentResponse(BaseModel):
    """Result of intent resolution."""

    server: str = Field(..., description="Target server name")
    tool: str = Field(..., description="Target tool/capability name")
    args: dict[str, Any] = Field(
        default_factory=dict, description="Extracted arguments for the tool"
    )
    confidence: float = Field(
        ..., ge=0.0, le=1.0, description="Confidence score for this resolution"
    )
    requires_clarification: bool = Field(
        default=False,
        description="True if confidence is below threshold and more info is needed",
    )


class RegisterCapabilityRequest(BaseModel):
    """Request to dynamically register a capability."""

    name: str
    description: str


class RegisterCapabilityResponse(BaseModel):
    """Confirmation of capability registration."""

    name: str
    status: str = "registered"


# ---------------------------------------------------------------------------
# Health Models
# ---------------------------------------------------------------------------


class HealthResponse(BaseModel):
    """Health check response."""

    status: str = "ok"
    version: str = "0.1.0"
    llm_connected: bool = False
