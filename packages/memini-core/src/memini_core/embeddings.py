"""Embedding generation using sentence-transformers (all-MiniLM-L6-v2, 384-dim)."""

from __future__ import annotations

import os
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    pass

from typing import Any

# Known model→dim pairs for startup validation.
_KNOWN_MODEL_DIMS: dict[str, int] = {
    "all-MiniLM-L6-v2": 384,
    "BAAI/bge-large-en-v1.5": 1024,
}


class Embedder:
    """Encode text into fixed-dimensional vectors using sentence-transformers.

    The model is lazily loaded on first use so the server can start without
    blocking on model download.

    Supported configurations:
      - dim=384 (default) with model ``all-MiniLM-L6-v2`` (default)
      - dim=1024 with model ``BAAI/bge-large-en-v1.5`` (must pass model_name)
    """

    def __init__(self, model_name: str = "all-MiniLM-L6-v2") -> None:
        self._model_name = model_name
        self._model: object | None = None
        self._dimension = int(os.environ.get("MEMINI_EMBEDDING_DIM", "384"))

        # Fix 1: Validate dim↔model compatibility at startup.
        # If the user sets MEMINI_EMBEDDING_DIM to an unsupported value, or
        # sets it to 1024 but leaves the default 384-dim model, raise early.
        valid_dims = sorted(_KNOWN_MODEL_DIMS.values())
        if self._dimension not in valid_dims:
            raise ValueError(
                f"MEMINI_EMBEDDING_DIM={self._dimension} is not supported. "
                f"Valid dimensions: {valid_dims}"
            )
        if self._model_name == "all-MiniLM-L6-v2" and self._dimension != 384:
            raise ValueError(
                f"MEMINI_EMBEDDING_DIM={self._dimension} but the default model "
                f"'all-MiniLM-L6-v2' produces 384-dim vectors. "
                f"Pass model_name='BAAI/bge-large-en-v1.5' for 1024-dim."
            )

    @property
    def dimension(self) -> int:
        """Return the embedding dimension."""
        return self._dimension

    def _ensure_model(self: Embedder) -> Any:
        """Lazily load the sentence-transformers model."""
        if self._model is None:
            from sentence_transformers import SentenceTransformer

            self._model = SentenceTransformer(self._model_name)
            # Fix 2: Assert model's actual dim matches configured dim on first load.
            # This catches hot-swapped models or misconfigured model_name args.
            actual_dim = self._model.get_sentence_embedding_dimension()
            if actual_dim != self._dimension:
                raise RuntimeError(
                    f"Model '{self._model_name}' produces {actual_dim}-dim vectors, "
                    f"but MEMINI_EMBEDDING_DIM={self._dimension}. "
                    f"Switch to a {self._dimension}-dim model or update MEMINI_EMBEDDING_DIM."
                )
        return self._model

    def encode(self, text: str) -> list[float]:
        """Encode a single text string into a vector.

        Args:
            text: Input text.

        Returns:
            List of floats representing the embedding.
        """
        model = self._ensure_model()
        vector = model.encode(text)  # type: ignore[union-attr]
        result = vector.tolist() if hasattr(vector, "tolist") else list(vector)
        # Fix 3: Defense-in-depth — verify output dim matches config even if
        # the model was somehow loaded despite earlier guards.
        if len(result) != self._dimension:
            raise RuntimeError(
                f"encode() returned {len(result)}-dim vector, "
                f"expected {self._dimension}. Model/config mismatch."
            )
        return result

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
        vectors = model.encode(texts)  # type: ignore[union-attr]
        if hasattr(vectors, "tolist"):
            result = vectors.tolist()
        else:
            result = [list(v) for v in vectors]
        # Fix 3: Defense-in-depth — verify output dim matches config.
        if result and len(result[0]) != self._dimension:
            raise RuntimeError(
                f"encode_batch() returned {len(result[0])}-dim vectors, "
                f"expected {self._dimension}. Model/config mismatch."
            )
        return result
