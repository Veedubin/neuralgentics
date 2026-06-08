"""Tests for embedding dimension validation (Fixes 1–3)."""

from __future__ import annotations

import os
from unittest.mock import MagicMock, patch

import pytest

from memini_core.embeddings import Embedder

# ---------------------------------------------------------------------------
# Fix 1: Init-time dim/model validation
# ---------------------------------------------------------------------------


class TestInitDimModelValidation:
    """Fix 1: MEMINI_EMBEDDING_DIM must be authoritative at __init__ time."""

    def test_init_with_384_dim_and_default_model_succeeds(self) -> None:
        """Default config (384-dim + all-MiniLM-L6-v2) should work."""
        with patch.dict(os.environ, {"MEMINI_EMBEDDING_DIM": "384"}):
            emb = Embedder()  # should not raise
            assert emb.dimension == 384
            assert emb._model_name == "all-MiniLM-L6-v2"

    def test_init_with_1024_dim_and_default_model_raises(self) -> None:
        """Regression test: 1024 dim + default model must raise ValueError."""
        with patch.dict(os.environ, {"MEMINI_EMBEDDING_DIM": "1024"}):
            with pytest.raises(ValueError, match="all-MiniLM-L6-v2.*384-dim"):
                Embedder()

    def test_init_with_invalid_dim_raises(self) -> None:
        """Unsupported dim value (e.g. 512) must raise ValueError."""
        with patch.dict(os.environ, {"MEMINI_EMBEDDING_DIM": "512"}):
            with pytest.raises(ValueError, match="not supported"):
                Embedder()

    def test_init_with_1024_dim_and_bge_model_succeeds(self) -> None:
        """Explicitly passing the 1024-dim model should work."""
        with patch.dict(os.environ, {"MEMINI_EMBEDDING_DIM": "1024"}):
            emb = Embedder(model_name="BAAI/bge-large-en-v1.5")
            assert emb.dimension == 1024
            assert emb._model_name == "BAAI/bge-large-en-v1.5"


# ---------------------------------------------------------------------------
# Fix 2: Assert model dimension on first load
# ---------------------------------------------------------------------------


class TestModelLoadDimAssertion:
    """Fix 2: _ensure_model must assert model's actual dim matches config."""

    def test_encode_after_dim_mismatch_model_load_raises(self) -> None:
        """Regression test: loading a model whose actual dim != config must raise."""
        with patch.dict(os.environ, {"MEMINI_EMBEDDING_DIM": "384"}):
            emb = Embedder()

        # Mock SentenceTransformer to return a model with wrong dim.
        mock_model = MagicMock()
        mock_model.get_sentence_embedding_dimension.return_value = 1024  # mismatch!
        mock_model.encode.return_value = MagicMock(tolist=lambda: [0.1] * 1024)

        # Patch the lazy import target: sentence_transformers.SentenceTransformer
        with patch("sentence_transformers.SentenceTransformer", return_value=mock_model):
            with pytest.raises(RuntimeError, match="produces 1024-dim.*384"):
                emb.encode("hello")


# ---------------------------------------------------------------------------
# Fix 3: Assert output vector length in encode / encode_batch
# ---------------------------------------------------------------------------


class TestOutputDimAssertion:
    """Fix 3: encode/encode_batch must verify output vector length."""

    def test_encode_returns_vector_of_configured_dim(self) -> None:
        """encode() should return a vector of exactly self._dimension length."""
        with patch.dict(os.environ, {"MEMINI_EMBEDDING_DIM": "384"}):
            emb = Embedder()

        mock_model = MagicMock()
        mock_model.get_sentence_embedding_dimension.return_value = 384
        # Simulate a correct-dim numpy-like array.
        mock_model.encode.return_value = MagicMock(tolist=lambda: [0.1] * 384)

        with patch("sentence_transformers.SentenceTransformer", return_value=mock_model):
            result = emb.encode("test input")
            assert len(result) == 384

    def test_encode_batch_returns_vectors_of_configured_dim(self) -> None:
        """encode_batch() should return vectors of exactly self._dimension length."""
        with patch.dict(os.environ, {"MEMINI_EMBEDDING_DIM": "384"}):
            emb = Embedder()

        mock_model = MagicMock()
        mock_model.get_sentence_embedding_dimension.return_value = 384
        batch_result = MagicMock()
        batch_result.tolist.return_value = [[0.1] * 384, [0.2] * 384]
        mock_model.encode.return_value = batch_result

        with patch("sentence_transformers.SentenceTransformer", return_value=mock_model):
            result = emb.encode_batch(["hello", "world"])
            assert len(result) == 2
            assert len(result[0]) == 384

    def test_encode_detects_wrong_output_dim(self) -> None:
        """encode() must raise RuntimeError if output dim doesn't match config."""
        with patch.dict(os.environ, {"MEMINI_EMBEDDING_DIM": "384"}):
            emb = Embedder()

        mock_model = MagicMock()
        mock_model.get_sentence_embedding_dimension.return_value = 384
        # Model claims 384 but actually returns 512 (hot-swap scenario).
        mock_model.encode.return_value = MagicMock(tolist=lambda: [0.1] * 512)

        with patch("sentence_transformers.SentenceTransformer", return_value=mock_model):
            with pytest.raises(RuntimeError, match="encode.*512.*expected 384"):
                emb.encode("test input")

    def test_encode_batch_detects_wrong_output_dim(self) -> None:
        """encode_batch() must raise RuntimeError if output dim doesn't match config."""
        with patch.dict(os.environ, {"MEMINI_EMBEDDING_DIM": "384"}):
            emb = Embedder()

        mock_model = MagicMock()
        mock_model.get_sentence_embedding_dimension.return_value = 384
        batch_result = MagicMock()
        # Model claims 384 but actually returns 512-length vectors.
        batch_result.tolist.return_value = [[0.1] * 512, [0.2] * 512]
        mock_model.encode.return_value = batch_result

        with patch("sentence_transformers.SentenceTransformer", return_value=mock_model):
            with pytest.raises(RuntimeError, match="encode_batch.*512.*expected 384"):
                emb.encode_batch(["hello", "world"])
