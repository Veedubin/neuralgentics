"""Pydantic request/response models for the memini-core HTTP API."""

from __future__ import annotations

import uuid
from datetime import datetime
from enum import Enum
from typing import Any

from pydantic import BaseModel, Field


# ---------------------------------------------------------------------------
# Enums
# ---------------------------------------------------------------------------


class TrustSignal(str, Enum):
    """Feedback signals for trust adjustment."""

    AGENT_USED = "agent_used"
    AGENT_IGNORED = "agent_ignored"
    USER_CORRECTED = "user_corrected"
    USER_CONFIRMED = "user_confirmed"


class RelationshipType(str, Enum):
    """Types of relationships between memories."""

    SUPERSEDES = "SUPERSEDES"
    RELATED_TO = "RELATED_TO"
    CONTRADICTS = "CONTRADICTS"
    DERIVED_FROM = "DERIVED_FROM"


# ---------------------------------------------------------------------------
# Request models
# ---------------------------------------------------------------------------


class QueryRequest(BaseModel):
    """POST /memory/query body."""

    query: str
    limit: int = Field(default=10, ge=1, le=100)


class AddMemoryRequest(BaseModel):
    """POST /memory/add body."""

    content: str
    source_type: str = Field(default="session", alias="sourceType")
    metadata: dict[str, Any] | None = None


class TrustRequest(BaseModel):
    """POST /memory/{id}/trust body."""

    signal: TrustSignal


class CreateRelationshipRequest(BaseModel):
    """POST /memory/relationship body."""

    source_id: str = Field(alias="sourceId")
    target_id: str = Field(alias="targetId")
    type: RelationshipType
    confidence: float = Field(default=1.0, ge=0.0, le=1.0)


# ---------------------------------------------------------------------------
# Response models
# ---------------------------------------------------------------------------


class MemoryResponse(BaseModel):
    """Single memory entry returned by the API."""

    id: str
    content: str
    trust_score: float = Field(alias="trustScore")
    embedding: list[float] | None = None
    source_type: str = Field(alias="sourceType")
    metadata: dict[str, Any] | None = None
    created_at: datetime = Field(alias="createdAt")


class AddMemoryResponse(BaseModel):
    """Response after adding a memory."""

    id: str


class TrustResponse(BaseModel):
    """Response after adjusting trust."""

    new_score: float = Field(alias="newScore")


class RelationshipResponse(BaseModel):
    """A single relationship edge."""

    source_id: str = Field(alias="sourceId")
    target_id: str = Field(alias="targetId")
    type: str
    confidence: float


class RelatedResponse(BaseModel):
    """Response for GET /memory/related/{id}."""

    relationships: list[RelationshipResponse]


class QueryResponse(BaseModel):
    """Response for POST /memory/query."""

    results: list[MemoryResponse]


class HealthResponse(BaseModel):
    """Response for GET /health."""

    status: str = "ok"


class IndexResponse(BaseModel):
    """Response for GET /project/index."""

    status: str = "ok"
