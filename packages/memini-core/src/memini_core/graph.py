"""Memory relationship graph — CRUD and simple traversal.

Delegates all persistence to the Database layer. This module provides
higher-level graph operations on top of the raw memory_relationships table.
"""

from __future__ import annotations

from collections import deque
from typing import Any

from memini_core.database import Database


class MemoryGraph:
    """Directed graph over memory relationships.

    Supports CRUD on edges and BFS traversal to find related memories
    within a given depth.
    """

    def __init__(self, db: Database) -> None:
        self._db = db

    def create(
        self,
        source_id: str,
        target_id: str,
        relationship_type: str,
        confidence: float = 1.0,
    ) -> None:
        """Create or upsert a relationship edge.

        Args:
            source_id: Source memory UUID.
            target_id: Target memory UUID.
            relationship_type: SUPERSEDES | RELATED_TO | CONTRADICTS | DERIVED_FROM.
            confidence: Edge confidence (0.0–1.0).
        """
        self._db.add_relationship(source_id, target_id, relationship_type, confidence)

    def get_related(self, memory_id: str) -> list[dict[str, Any]]:
        """Get all relationships where memory_id is source or target.

        Args:
            memory_id: UUID to look up.

        Returns:
            List of dicts with sourceId, targetId, type, confidence.
        """
        return self._db.get_relationships(memory_id)

    def traverse(self, start_id: str, max_depth: int = 3) -> list[str]:
        """BFS traversal returning reachable memory IDs from start_id.

        Args:
            start_id: Starting memory UUID.
            max_depth: Maximum hops.

        Returns:
            List of reachable memory UUID strings (excluding start_id).
        """
        visited: set[str] = {start_id}
        queue: deque[tuple[str, int]] = deque([(start_id, 0)])
        results: list[str] = []

        while queue:
            current_id, depth = queue.popleft()
            if depth >= max_depth:
                continue

            rels = self._db.get_relationships(current_id)
            for rel in rels:
                neighbor = rel["sourceId"] if rel["targetId"] == current_id else rel["targetId"]
                if neighbor not in visited:
                    visited.add(neighbor)
                    results.append(neighbor)
                    queue.append((neighbor, depth + 1))

        return results
