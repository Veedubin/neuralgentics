"""Configuration via pydantic-settings.

All settings can be overridden with environment variables prefixed with NEURO_.
For example, NEURO_LLM_BASE_URL overrides llm_base_url.
"""

from __future__ import annotations

from pathlib import Path

from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    """Application settings loaded from environment variables or defaults."""

    model_config = {"env_prefix": "NEURO_"}

    # Server
    host: str = "0.0.0.0"
    port: int = 8902

    # LLM (OpenAI-compatible API, e.g. llama-server on port 8903)
    llm_base_url: str = "http://localhost:8903/v1"
    llm_model: str = "qwen3-0.6b"
    llm_timeout: float = 30.0

    # Intent broker
    confidence_threshold: float = 0.7
    capabilities_path: str = str(Path(__file__).parent / "capabilities.json")

    # Session log extractor
    extractor_enabled: bool = True
    log_file_path: str = str(
        Path.home() / ".config" / "neuralgentics" / "sessions" / "latest.jsonl"
    )
    extractor_interval: int = 60  # seconds between extraction cycles
    memini_core_url: str = "http://localhost:8900"


settings = Settings()
