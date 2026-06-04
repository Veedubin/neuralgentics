"""FastAPI HTTP server for memini-core.

Routes:
    POST /memory/query           — semantic search
    POST /memory/add              — store a new memory
    GET  /memory/{id}            — retrieve a memory
    POST /memory/{id}/trust      — adjust trust score
    GET  /memory/related/{id}    — get relationships
    POST /memory/relationship    — create a relationship
    GET  /project/index          — trigger project indexing
    GET  /health                 — liveness probe
"""

from __future__ import annotations

import os
from typing import Any

from fastapi import FastAPI, HTTPException

from memini_core.database import Database
from memini_core.embeddings import Embedder
from memini_core.graph import MemoryGraph
from memini_core.indexer import ProjectIndexer
from memini_core.models import (
    AddMemoryRequest,
    AddMemoryResponse,
    CreateRelationshipRequest,
    HealthResponse,
    IndexResponse,
    MemoryResponse,
    QueryRequest,
    QueryResponse,
    RelatedResponse,
    RelationshipResponse,
    TrustRequest,
    TrustResponse,
)
from memini_core.trust import TrustEngine

# ---------------------------------------------------------------------------
# Application factory
# ---------------------------------------------------------------------------


def create_app(db_url: str | None = None) -> FastAPI:
    """Build the FastAPI application with all routes.

    Args:
        db_url: PostgreSQL connection URL. Falls back to MEMINI_DB_URL env var.

    Returns:
        Configured FastAPI instance.
    """
    app = FastAPI(title="memini-core", version="0.1.0")

    # Wire up singletons
    embedder = Embedder()
    db = Database(db_url=db_url, embedder=embedder)
    trust_engine = TrustEngine()
    graph = MemoryGraph(db)
    indexer = ProjectIndexer(db)

    @app.on_event("startup")
    def _startup() -> None:
        db.connect()

    @app.on_event("shutdown")
    def _shutdown() -> None:
        db.close()

    # ------------------------------------------------------------------
    # Routes
    # ------------------------------------------------------------------

    @app.get("/health", response_model=HealthResponse)
    def health() -> HealthResponse:
        """Liveness probe."""
        return HealthResponse()

    @app.post("/memory/query", response_model=QueryResponse)
    def query_memories(req: QueryRequest) -> QueryResponse:
        """Semantic search over memories."""
        results = db.query_memories(req.query, limit=req.limit)
        return QueryResponse(results=[_to_memory_resp(r) for r in results])

    @app.post("/memory/add", response_model=AddMemoryResponse)
    def add_memory(req: AddMemoryRequest) -> AddMemoryResponse:
        """Store a new memory with auto-generated embedding."""
        memory_id = db.add_memory(
            content=req.content,
            source_type=req.source_type,
            metadata=req.metadata,
        )
        return AddMemoryResponse(id=memory_id)

    @app.get("/memory/{memory_id}", response_model=MemoryResponse)
    def get_memory(memory_id: str) -> MemoryResponse:
        """Retrieve a single memory by ID."""
        mem = db.get_memory(memory_id)
        if mem is None:
            raise HTTPException(status_code=404, detail="Memory not found")
        return _to_memory_resp(mem)

    @app.post("/memory/{memory_id}/trust", response_model=TrustResponse)
    def adjust_trust(memory_id: str, req: TrustRequest) -> TrustResponse:
        """Adjust the trust score for a memory."""
        mem = db.get_memory(memory_id)
        if mem is None:
            raise HTTPException(status_code=404, detail="Memory not found")

        # Bridge models.TrustSignal → trust.TrustSignal (same values, different classes)
        from memini_core.trust import TrustSignal as CoreTrustSignal

        signal = CoreTrustSignal(req.signal.value)
        new_score = trust_engine.adjust(mem["trustScore"], signal)
        db.update_trust(memory_id, new_score)
        return TrustResponse(newScore=new_score)

    @app.get("/memory/related/{memory_id}", response_model=RelatedResponse)
    def get_related(memory_id: str) -> RelatedResponse:
        """Get all relationships for a memory."""
        rels = graph.get_related(memory_id)
        return RelatedResponse(
            relationships=[
                RelationshipResponse(
                    sourceId=r["sourceId"],
                    targetId=r["targetId"],
                    type=r["type"],
                    confidence=r["confidence"],
                )
                for r in rels
            ]
        )

    @app.post("/memory/relationship")
    def create_relationship(req: CreateRelationshipRequest) -> dict[str, str]:
        """Create a relationship between two memories."""
        graph.create(
            source_id=req.source_id,
            target_id=req.target_id,
            relationship_type=req.type.value,
            confidence=req.confidence,
        )
        return {"status": "ok"}

    @app.get("/project/index", response_model=IndexResponse)
    def index_project() -> IndexResponse:
        """Trigger project indexing in the current working directory."""
        indexer.index_directory()
        return IndexResponse(status="ok")

    return app


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _to_memory_resp(mem: dict[str, Any]) -> MemoryResponse:
    """Convert a raw memory dict from the database layer to a response model."""
    from datetime import datetime

    created_at = mem.get("createdAt")
    if isinstance(created_at, str):
        created_at = datetime.fromisoformat(created_at)
    elif created_at is None:
        created_at = datetime.utcnow()

    return MemoryResponse(
        id=mem["id"],
        content=mem["content"],
        trustScore=mem["trustScore"],
        embedding=mem.get("embedding"),
        sourceType=mem.get("sourceType", "session"),
        metadata=mem.get("metadata"),
        createdAt=created_at,
    )


# ---------------------------------------------------------------------------
# CLI entry point
# ---------------------------------------------------------------------------


def main() -> None:
    """Run the server with uvicorn."""
    import uvicorn

    db_url = os.environ.get("MEMINI_DB_URL", "")
    app = create_app(db_url=db_url)
    uvicorn.run(app, host="0.0.0.0", port=8900)


if __name__ == "__main__":
    main()
