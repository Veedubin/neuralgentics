"""Embedding wrapper around sentence-transformers with multi-model support.

Supports four embedding models:
  - BAAI/bge-m3 (1024-dim, default as of v0.11.0) — multilingual, 8K context
  - BAAI/bge-large-en-v1.5 (1024-dim, "bge-large" alias) — English-only, legacy
  - all-MiniLM-L6-v2 (384-dim) — fast, lightweight
  - BAAI/bge-large-en-v1.5 (1024-dim, via model="bge-large") — high quality English

Supports FP16 / INT8 / FP32 inference.

Lazy loading & idle unload:
  - Models are loaded on first use (lazy) and kept in memory.
  - A background thread unloads models idle for more than IDLE_MIN minutes.
  - Set EAGER=true (or --no-lazy-load) to pre-load the default model at startup.
"""

from __future__ import annotations

import gc
import logging
import os
import threading
import time
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
#   "int8" → 8-bit quantization (smallest VRAM; uses bitsandbytes on GPU or
#             PyTorch dynamic quantization on CPU)
#   FP16 is only applied when the effective device is "cuda".
_EMBED_DTYPE: str = os.environ.get("NEURALGENTICS_EMBED_DTYPE", "fp32").lower()
if _EMBED_DTYPE not in {"fp32", "fp16", "int8"}:
    raise ValueError(
        f"NEURALGENTICS_EMBED_DTYPE must be 'fp32', 'fp16', or 'int8', "
        f"got '{_EMBED_DTYPE}'"
    )

# ─── Model Registry ───────────────────────────────────────────────────────────

MODEL_REGISTRY: dict[str, dict] = {
    "": {  # default — alias for bge-m3 (backwards compat for empty string)
        "hf_name": "BAAI/bge-m3",
        "dimensions": 1024,
    },
    "all-MiniLM-L6-v2": {
        "hf_name": "all-MiniLM-L6-v2",
        "dimensions": 384,
    },
    "bge-large": {
        "hf_name": "BAAI/bge-large-en-v1.5",
        "dimensions": 1024,
    },
    "bge-m3": {
        "hf_name": "BAAI/bge-m3",
        "dimensions": 1024,
    },
}

DEFAULT_MODEL = "bge-m3"  # was "" (all-MiniLM-L6-v2 pre-v0.11.0)
DEFAULT_DIMENSIONS = 1024  # was 384


def _load_model_unlocked(hf_name: str) -> SentenceTransformer:
    """Load an embedding model by HuggingFace name (caller holds the lock).

    Uses NEURALGENTICS_EMBED_DEVICE env var for device selection:
      - "cpu":  force CPU-only (safe when GPU VRAM is contention-prone)
      - "cuda": force GPU (fast batch inference, needs free VRAM)
      - None:  auto-detect (SentenceTransformer default behaviour)

    Uses NEURALGENTICS_EMBED_DTYPE env var for precision:
      - "fp32": full precision (default)
      - "fp16": half precision (GPU only, ~50% VRAM savings)
      - "int8": 8-bit quantization (bitsandbytes on GPU, dynamic on CPU)
    FP16 and INT8-via-bitsandbytes are only applied on CUDA.
    """
    import torch

    device = _EMBED_DEVICE
    use_fp16 = _EMBED_DTYPE == "fp16"
    use_int8 = _EMBED_DTYPE == "int8"

    # Determine effective dtype — FP16/INT8-bitsandbytes only meaningful on CUDA
    effective_dtype = "fp32"
    if use_fp16 and (device == "cuda" or device is None):
        effective_dtype = "fp16"
    elif use_int8:
        # INT8 works on both CPU (dynamic) and GPU (bitsandbytes)
        effective_dtype = "int8"

    model_kwargs: dict = {}
    bnb_applied = False

    if effective_dtype == "fp16":
        model_kwargs["dtype"] = torch.float16
    elif effective_dtype == "int8":
        # Try bitsandbytes first (GPU, faster, better quality)
        try:
            from transformers import BitsAndBytesConfig

            bnb_config = BitsAndBytesConfig(load_in_8bit=True, llm_int8_threshold=6.0)
            model_kwargs["quantization_config"] = bnb_config
            bnb_applied = True
            log.info("int8 quantization via bitsandbytes enabled for %s", hf_name)
        except ImportError:
            log.warning(
                "bitsandbytes not installed; will use PyTorch dynamic int8 "
                "quantization after load (slower but CPU-compatible)"
            )

    if effective_dtype == "int8" and not bnb_applied:
        log.warning(
            "INT8 quantization without CUDA/bitsandbytes: using PyTorch dynamic "
            "quantization (works on CPU but slower than bitsandbytes)"
        )

    model = SentenceTransformer(
        hf_name, device=device, model_kwargs=model_kwargs or None
    )

    # Fallback for FP16: explicitly convert to half if torch_dtype didn't
    # propagate (covers sentence-transformers 5.x quirks where model_kwargs
    # is ignored)
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

    # Fallback for INT8 without bitsandbytes: PyTorch dynamic quantization
    if effective_dtype == "int8" and not bnb_applied:
        try:
            first_module = model._first_module()
            if (
                hasattr(first_module, "auto_model")
                and first_module.auto_model is not None
            ):
                import torch.ao.quantization as q

                first_module.auto_model = q.quantize_dynamic(
                    first_module.auto_model, {torch.nn.Linear}, dtype=torch.qint8
                )
                log.info("applied PyTorch dynamic int8 quantization to %s", hf_name)
        except Exception as exc:
            log.warning(
                "PyTorch dynamic int8 quantization failed for %s: %s; "
                "model may remain FP32",
                hf_name,
                exc,
            )

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


class ModelManager:
    """Manages lazy-loaded models with idle-time auto-unload.

    Replaces the previous @lru_cache(maxsize=4) approach. Models are loaded
    on first use and unloaded after IDLE_MIN minutes of inactivity by a
    background daemon thread.
    """

    def __init__(self) -> None:
        self._models: dict[str, SentenceTransformer] = {}
        self._last_used: dict[str, float] = {}
        self._lock = threading.Lock()
        self._eager = os.environ.get("EAGER", "false").lower() == "true"
        self._idle_min = int(os.environ.get("IDLE_MIN", "5"))
        self._shutdown = threading.Event()

        if self._eager:
            # Pre-load the default model
            self.get(MODEL_REGISTRY[DEFAULT_MODEL]["hf_name"])

        # Start idle-unload thread
        self._unload_thread = threading.Thread(
            target=self._unload_loop, daemon=True, name="model-idle-unload"
        )
        self._unload_thread.start()

    def get(self, model_key: str) -> SentenceTransformer:
        """Get a model, loading it if necessary. Bumps last_used."""
        with self._lock:
            now = time.time()
            if model_key in self._models:
                self._last_used[model_key] = now
                return self._models[model_key]
            log.info(
                f"loading model {model_key} (idle_min={self._idle_min}, "
                f"dtype={_EMBED_DTYPE})"
            )
            model = _load_model_unlocked(model_key)
            self._models[model_key] = model
            self._last_used[model_key] = now
            return model

    def status(self) -> dict:
        """Return current state for /status endpoint."""
        with self._lock:
            now = time.time()
            return {
                "default_model": DEFAULT_MODEL,
                "hf_name": MODEL_REGISTRY.get(DEFAULT_MODEL, {}).get(
                    "hf_name", "unknown"
                ),
                "dimensions": MODEL_REGISTRY.get(DEFAULT_MODEL, {}).get(
                    "dimensions", 0
                ),
                "loaded_models": list(self._models.keys()),
                "last_used": {k: now - v for k, v in self._last_used.items()},
                "idle_min": self._idle_min,
                "eager": self._eager,
                "dtype": _EMBED_DTYPE,
                "device": _EMBED_DEVICE or "auto",
            }

    def _unload_loop(self) -> None:
        """Background thread: unload models idle for more than IDLE_MIN minutes."""
        while not self._shutdown.is_set():
            self._shutdown.wait(30)  # check every 30s
            if self._shutdown.is_set():
                break
            with self._lock:
                now = time.time()
                to_unload = [
                    key
                    for key in list(self._models.keys())
                    if now - self._last_used[key] > self._idle_min * 60
                ]
                for key in to_unload:
                    idle_sec = now - self._last_used[key]
                    log.info(
                        f"unloading idle model {key} "
                        f"(idle for {int(idle_sec / 60)} min)"
                    )
                    del self._models[key]
                    del self._last_used[key]

            if to_unload:
                gc.collect()
                if str(_EMBED_DEVICE) == "cuda" or "cuda" in str(_EMBED_DEVICE or ""):
                    try:
                        import torch

                        torch.cuda.empty_cache()
                    except Exception:
                        pass

    def shutdown(self) -> None:
        """Stop the unload thread."""
        self._shutdown.set()
        self._unload_thread.join(timeout=5)


# Singleton
model_manager = ModelManager()


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
        sbert_model = model_manager.get(hf_name)
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
        sbert_model = model_manager.get(hf_name)
        vectors = sbert_model.encode(texts, convert_to_numpy=True, batch_size=32)
        latency_us = int((time.perf_counter() - start) * 1_000_000)
        results = []
        for vec in vectors:
            vec_list = vec.tolist() if hasattr(vec, "tolist") else list(vec)
            results.append(
                (vec_list, dimensions, shortname or "all-MiniLM-L6-v2", latency_us)
            )
        return results
