"""OpenAI-compatible LLM client using httpx for lightweight inference.

Designed for Qwen3-0.6B via llama-server (llama.cpp) on CPU.
Uses plain httpx instead of the openai SDK to keep the dependency footprint small.
"""

from __future__ import annotations

import logging
from typing import Any

import httpx

from neuralgentics_core.config import settings

logger = logging.getLogger(__name__)


class LLMClient:
    """Async client for an OpenAI-compatible chat completion endpoint."""

    def __init__(
        self,
        base_url: str | None = None,
        model: str | None = None,
        timeout: float | None = None,
    ) -> None:
        self.base_url = (base_url or settings.llm_base_url).rstrip("/")
        self.model = model or settings.llm_model
        self.timeout = timeout or settings.llm_timeout
        self._client: httpx.AsyncClient | None = None

    async def _get_client(self) -> httpx.AsyncClient:
        """Lazily create the httpx async client."""
        if self._client is None or self._client.is_closed:
            self._client = httpx.AsyncClient(timeout=self.timeout)
        return self._client

    async def close(self) -> None:
        """Close the underlying httpx client."""
        if self._client and not self._client.is_closed:
            await self._client.aclose()
            self._client = None

    async def chat(
        self,
        messages: list[dict[str, str]],
        temperature: float = 0.3,
        max_tokens: int = 512,
        **extra: Any,
    ) -> str:
        """Send a chat completion request and return the assistant message content.

        Args:
            messages: List of chat messages in OpenAI format
                [{"role": "system"|"user"|"assistant", "content": "..."}].
            temperature: Sampling temperature (lower = more deterministic).
            max_tokens: Maximum tokens to generate.
            **extra: Additional parameters passed to the API.

        Returns:
            The assistant's response text.

        Raises:
            httpx.HTTPStatusError: On non-2xx responses.
            httpx.TimeoutException: On request timeout.
        """
        client = await self._get_client()

        payload: dict[str, Any] = {
            "model": self.model,
            "messages": messages,
            "temperature": temperature,
            "max_tokens": max_tokens,
            **extra,
        }

        url = f"{self.base_url}/chat/completions"
        response = await client.post(url, json=payload)
        response.raise_for_status()

        data = response.json()
        return data["choices"][0]["message"]["content"]

    async def health_check(self) -> bool:
        """Check if the LLM endpoint is reachable and responding.

        Returns:
            True if the endpoint returns a valid response, False otherwise.
        """
        try:
            client = await self._get_client()
            url = f"{self.base_url}/models"
            response = await client.get(url)
            return response.status_code == 200
        except Exception:
            return False


# Module-level singleton, initialized in server lifespan
_llm_client: LLMClient | None = None


def get_llm_client() -> LLMClient:
    """Get the module-level LLM client instance.

    Raises:
        RuntimeError: If the client hasn't been initialized via init_llm_client().
    """
    if _llm_client is None:
        raise RuntimeError("LLM client not initialized. Call init_llm_client() first.")
    return _llm_client


def init_llm_client(
    base_url: str | None = None,
    model: str | None = None,
    timeout: float | None = None,
) -> LLMClient:
    """Initialize the module-level LLM client singleton."""
    global _llm_client  # noqa: PLW0603
    _llm_client = LLMClient(base_url=base_url, model=model, timeout=timeout)
    return _llm_client
