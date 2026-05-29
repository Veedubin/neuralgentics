"""Embedding wrapper around sentence-transformers MiniLM-L6-v2."""

from __future__ import annotations

import time
from functools import lru_cache
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    import numpy as np

from sentence_transformers import SentenceTransformer

DEFAULT_MODEL = "all-MiniLM-L6-v2"
DEFAULT_DIMENSIONS = 384


@lru_cache(maxsize=1)
def _load_model(model_name: str = DEFAULT_MODEL) -> SentenceTransformer:
    """Lazy-load and cache the embedding model."""
    return SentenceTransformer(model_name)


class EmbeddingEngine:
    """Thread-safe embedding engine wrapping sentence-transformers."""

    def __init__(self, model_name: str = DEFAULT_MODEL) -> None:
        self.model_name = model_name
        self._model: SentenceTransformer | None = None

    @property
    def model(self) -> SentenceTransformer:
        """Lazy-load the model on first access."""
        if self._model is None:
            self._model = _load_model(self.model_name)
        return self._model

    @property
    def dimensions(self) -> int:
        """Return the embedding dimension size."""
        return DEFAULT_DIMENSIONS

    def embed(self, text: str) -> tuple[list[float], int, str, int]:
        """Generate a single embedding.

        Returns:
            Tuple of (vector, dimensions, model_name, latency_us).
        """
        start = time.perf_counter()
        vector: np.ndarray = self.model.encode(text, convert_to_numpy=True)
        latency_us = int((time.perf_counter() - start) * 1_000_000)
        return (
            vector.tolist() if hasattr(vector, "tolist") else list(vector),
            self.dimensions,
            self.model_name,
            latency_us,
        )

    def embed_batch(self, texts: list[str]) -> list[tuple[list[float], int, str, int]]:
        """Generate embeddings for a batch of texts.

        Returns:
            List of (vector, dimensions, model_name, latency_us) tuples.
        """
        start = time.perf_counter()
        vectors = self.model.encode(texts, convert_to_numpy=True, batch_size=32)
        latency_us = int((time.perf_counter() - start) * 1_000_000)
        results = []
        for vec in vectors:
            vec_list = vec.tolist() if hasattr(vec, "tolist") else list(vec)
            results.append((vec_list, self.dimensions, self.model_name, latency_us))
        return results
