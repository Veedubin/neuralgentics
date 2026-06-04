"""Embedding wrapper around sentence-transformers with multi-model support.

Supports two embedding models:
  - all-MiniLM-L6-v2 (384-dim, default) — fast, lightweight
  - BAAI/bge-large-en-v1.5 (1024-dim, via model="bge-large") — high quality
"""

from __future__ import annotations

import os
import time
from functools import lru_cache
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    import numpy as np

from sentence_transformers import SentenceTransformer

# ─── Device Configuration ────────────────────────────────────────────────────
# NEURALGENTICS_EMBED_DEVICE controls which device SentenceTransformer uses.
#   "cpu"  → force CPU (safe when GPU is occupied by other processes)
#   "cuda" → force GPU (fast batch inference, needs free VRAM)
#   unset  → auto-detect (SentenceTransformer default: cuda if available)
_EMBED_DEVICE: str | None = os.environ.get("NEURALGENTICS_EMBED_DEVICE") or None

# ─── Model Registry ───────────────────────────────────────────────────────────

MODEL_REGISTRY: dict[str, dict] = {
    "": {
        "hf_name": "all-MiniLM-L6-v2",
        "dimensions": 384,
    },
    "all-MiniLM-L6-v2": {
        "hf_name": "all-MiniLM-L6-v2",
        "dimensions": 384,
    },
    "bge-large": {
        "hf_name": "BAAI/bge-large-en-v1.5",
        "dimensions": 1024,
    },
}

DEFAULT_MODEL = ""
DEFAULT_DIMENSIONS = 384


@lru_cache(maxsize=4)
def _load_model(hf_name: str) -> SentenceTransformer:
    """Lazy-load and cache the embedding model by HuggingFace name.

    Uses NEURALGENTICS_EMBED_DEVICE env var for device selection:
      - "cpu":  force CPU-only (safe when GPU VRAM is contention-prone)
      - "cuda": force GPU (fast batch inference, needs free VRAM)
      - None:  auto-detect (SentenceTransformer default behaviour)
    """
    return SentenceTransformer(hf_name, device=_EMBED_DEVICE)


def _resolve_model(model: str) -> tuple[str, str, int]:
    """Resolve a model shortname to (shortname, hf_name, dimensions).

    Falls back to the default model if the name is not in the registry.
    """
    entry = MODEL_REGISTRY.get(model)
    if entry is None:
        entry = MODEL_REGISTRY[DEFAULT_MODEL]
    return model, entry["hf_name"], entry["dimensions"]


class EmbeddingEngine:
    """Thread-safe embedding engine wrapping sentence-transformers.

    Supports multi-model routing: pass a model shortname (e.g. "bge-large")
    and the engine will load and cache the appropriate HuggingFace model.
    """

    def __init__(self, default_model: str = DEFAULT_MODEL) -> None:
        self.default_model = default_model

    def embed(
        self, text: str, model: str | None = None
    ) -> tuple[list[float], int, str, int]:
        """Generate a single embedding.

        Args:
            text: The text to embed.
            model: Model shortname (e.g. "bge-large"). Falls back to default.

        Returns:
            Tuple of (vector, dimensions, model_name, latency_us).
        """
        shortname = model if model else self.default_model
        _, hf_name, dimensions = _resolve_model(shortname)
        start = time.perf_counter()
        sbert_model = _load_model(hf_name)
        vector = sbert_model.encode(text, convert_to_numpy=True)
        latency_us = int((time.perf_counter() - start) * 1_000_000)
        vec_list = vector.tolist() if hasattr(vector, "tolist") else list(vector)
        return vec_list, dimensions, shortname or "all-MiniLM-L6-v2", latency_us

    def embed_batch(
        self, texts: list[str], model: str | None = None
    ) -> list[tuple[list[float], int, str, int]]:
        """Generate embeddings for a batch of texts.

        Args:
            texts: List of texts to embed.
            model: Model shortname (e.g. "bge-large"). Falls back to default.

        Returns:
            List of (vector, dimensions, model_name, latency_us) tuples.
        """
        shortname = model if model else self.default_model
        _, hf_name, dimensions = _resolve_model(shortname)
        start = time.perf_counter()
        sbert_model = _load_model(hf_name)
        vectors = sbert_model.encode(texts, convert_to_numpy=True, batch_size=32)
        latency_us = int((time.perf_counter() - start) * 1_000_000)
        results = []
        for vec in vectors:
            vec_list = vec.tolist() if hasattr(vec, "tolist") else list(vec)
            results.append(
                (vec_list, dimensions, shortname or "all-MiniLM-L6-v2", latency_us)
            )
        return results
