"""Embedding wrapper around sentence-transformers with multi-model support.

Supports two embedding models:
  - all-MiniLM-L6-v2 (384-dim, default) — fast, lightweight
  - BAAI/bge-large-en-v1.5 (1024-dim, via model="bge-large") — high quality

Supports FP16 inference on GPU via NEURALGENTICS_EMBED_DTYPE=fp16 to halve
VRAM usage (e.g. BGE-Large: 1280 MiB FP32 → ~640 MiB FP16).
"""

from __future__ import annotations

import logging
import os
import time
from functools import lru_cache
from sentence_transformers import SentenceTransformer

log = logging.getLogger(__name__)

# ─── Device Configuration ────────────────────────────────────────────────────
# NEURALGENTICS_EMBED_DEVICE controls which device SentenceTransformer uses.
#   "cpu"  → force CPU (safe when GPU is occupied by other processes)
#   "cuda" → force GPU (fast batch inference, needs free VRAM)
#   unset  → auto-detect (SentenceTransformer default: cuda if available)
_EMBED_DEVICE: str | None = os.environ.get("NEURALGENTICS_EMBED_DEVICE") or None

# ─── Dtype Configuration ─────────────────────────────────────────────────────
# NEURALGENTICS_EMBED_DTYPE controls the floating-point precision for inference.
#   "fp32" → full precision (default, identical to v0.7.x behavior)
#   "fp16" → half precision (GPU only, reduces VRAM ~50% with negligible
#             accuracy loss for cosine similarity)
#   FP16 is only applied when the effective device is "cuda".
_EMBED_DTYPE: str = os.environ.get("NEURALGENTICS_EMBED_DTYPE", "fp32").lower()
if _EMBED_DTYPE not in {"fp32", "fp16"}:
    raise ValueError(
        f"NEURALGENTICS_EMBED_DTYPE must be 'fp32' or 'fp16', got '{_EMBED_DTYPE}'"
    )

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

    Uses NEURALGENTICS_EMBED_DTYPE env var for precision:
      - "fp32": full precision (default)
      - "fp16": half precision (GPU only, ~50% VRAM savings)
    FP16 is only applied when the effective device resolves to CUDA.
    """
    import torch

    device = _EMBED_DEVICE
    use_fp16 = _EMBED_DTYPE == "fp16"

    # Determine effective dtype — FP16 only meaningful on CUDA
    effective_dtype = (
        "fp16" if use_fp16 and (device == "cuda" or device is None) else "fp32"
    )

    model_kwargs: dict = {}
    if effective_dtype == "fp16":
        model_kwargs["dtype"] = torch.float16

    model = SentenceTransformer(
        hf_name, device=device, model_kwargs=model_kwargs or None
    )

    # Fallback: explicitly convert to half if torch_dtype didn't propagate
    # (covers sentence-transformers 5.x quirks where model_kwargs is ignored)
    if effective_dtype == "fp16":
        resolved_device = str(
            model.device.type if hasattr(model, "device") else (device or "cpu")
        )
        if resolved_device == "cuda" or resolved_device.startswith("cuda:"):
            try:
                first_module = model._first_module()
                if (
                    hasattr(first_module, "auto_model")
                    and first_module.auto_model is not None
                ):
                    first_module.auto_model = first_module.auto_model.half()
            except Exception:
                log.warning("FP16 .half() fallback failed; model may remain FP32")

    # Resolve dimensions for logging
    dimensions = model.get_sentence_embedding_dimension()
    resolved_device = str(getattr(model, "device", device or "auto"))
    log.info(
        f"loaded {hf_name} on {resolved_device} dtype={effective_dtype}, dims={dimensions}"
    )

    return model


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
