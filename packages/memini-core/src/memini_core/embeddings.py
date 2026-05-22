"""Embedding generation using sentence-transformers (all-MiniLM-L6-v2, 384-dim)."""

from __future__ import annotations

import os
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    import numpy as np


class Embedder:
    """Encode text into 384-dimensional vectors using all-MiniLM-L6-v2.

    The model is lazily loaded on first use so the server can start without
    blocking on model download.
    """

    def __init__(self, model_name: str = "all-MiniLM-L6-v2") -> None:
        self._model_name = model_name
        self._model: object | None = None
        self._dimension = int(os.environ.get("MEMINI_EMBEDDING_DIM", "384"))

    @property
    def dimension(self) -> int:
        """Return the embedding dimension."""
        return self._dimension

    def _ensure_model(self) -> object:
        """Lazily load the sentence-transformers model."""
        if self._model is None:
            from sentence_transformers import SentenceTransformer

            self._model = SentenceTransformer(self._model_name)
        return self._model

    def encode(self, text: str) -> list[float]:
        """Encode a single text string into a vector.

        Args:
            text: Input text.

        Returns:
            List of floats representing the embedding.
        """
        model = self._ensure_model()
        vector = model.encode(text)
        if hasattr(vector, "tolist"):
            return vector.tolist()
        return list(vector)

    def encode_batch(self, texts: list[str]) -> list[list[float]]:
        """Encode multiple texts into vectors.

        Args:
            texts: List of input texts.

        Returns:
            List of embedding vectors.
        """
        if not texts:
            return []
        model = self._ensure_model()
        vectors = model.encode(texts)
        if hasattr(vectors, "tolist"):
            return vectors.tolist()
        return [list(v) for v in vectors]
