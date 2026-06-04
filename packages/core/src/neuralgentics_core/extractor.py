"""Background Session Log Context Extractor.

Periodically reads a JSONL log file, uses the LLM to extract key facts,
decisions, and action items, and posts them to memini-core's memory API.
Uses content checksums to avoid duplicate inserts.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import logging
from datetime import datetime, timezone
from typing import Any

import httpx

from neuralgentics_core.config import settings
from neuralgentics_core.llm import get_llm_client

logger = logging.getLogger(__name__)

EXTRACTION_PROMPT = """\
You are a context extraction assistant. Given session log entries, extract the most important:
- Key facts
- Decisions made
- Action items

Respond with a JSON array of objects, each with "content" and "type" fields.
Types: "fact", "decision", "action_item".

Example:
[{"content": "User prefers dark mode", "type": "fact"},
 {"content": "Switch to PostgreSQL", "type": "decision"}]

If the logs contain nothing noteworthy, return an empty array: []
Respond ONLY with the JSON array, no other text."""


def _compute_checksum(content: str) -> str:
    """Compute SHA-256 checksum of content for deduplication."""
    return hashlib.sha256(content.encode()).hexdigest()


class SessionExtractor:
    """Background task that extracts insights from session logs."""

    def __init__(
        self,
        log_file_path: str | None = None,
        memini_url: str | None = None,
        interval: int | None = None,
    ) -> None:
        self.log_file_path = log_file_path or settings.log_file_path
        self.memini_url = memini_url or settings.memini_core_url
        self.interval = interval or settings.extractor_interval
        self._seen_checksums: set[str] = set()
        self._task: asyncio.Task[None] | None = None
        self._http_client: httpx.AsyncClient | None = None

    async def _get_http_client(self) -> httpx.AsyncClient:
        """Lazily create the httpx client for memini-core calls."""
        if self._http_client is None or self._http_client.is_closed:
            self._http_client = httpx.AsyncClient(timeout=15.0)
        return self._http_client

    async def start(self) -> None:
        """Start the background extraction loop."""
        if not settings.extractor_enabled:
            logger.info("Session extractor disabled via configuration")
            return
        self._task = asyncio.create_task(self._run_loop())
        logger.info(
            "Session extractor started (interval=%ds, path=%s)", self.interval, self.log_file_path
        )

    async def stop(self) -> None:
        """Stop the background extraction loop and clean up."""
        if self._task and not self._task.done():
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass
        if self._http_client and not self._http_client.is_closed:
            await self._http_client.aclose()
        logger.info("Session extractor stopped")

    async def _run_loop(self) -> None:
        """Main extraction loop that runs every N seconds."""
        while True:
            try:
                await self._extract_cycle()
            except asyncio.CancelledError:
                raise
            except Exception:
                logger.exception("Extraction cycle failed — will retry next interval")
            await asyncio.sleep(self.interval)

    async def _extract_cycle(self) -> None:
        """Read the log file, extract insights, and post to memini-core."""
        # Read log file — gracefully skip if it doesn't exist yet
        log_entries: list[dict[str, Any]] = []
        try:
            with open(self.log_file_path) as f:
                for line in f:
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        log_entries.append(json.loads(line))
                    except json.JSONDecodeError:
                        logger.debug("Skipping malformed JSONL line: %s", line[:80])
        except FileNotFoundError:
            logger.debug("Log file not found: %s — will check next cycle", self.log_file_path)
            return
        except OSError:
            logger.exception("Cannot read log file: %s", self.log_file_path)
            return

        if not log_entries:
            logger.debug("No log entries found in %s", self.log_file_path)
            return

        # Ask the LLM to extract insights
        try:
            llm = get_llm_client()
            log_text = json.dumps(log_entries[-50:], indent=2)  # Keep last 50 entries
            messages = [
                {"role": "system", "content": EXTRACTION_PROMPT},
                {"role": "user", "content": f"Session logs:\n{log_text}"},
            ]
            raw_response = await llm.chat(messages=messages, temperature=0.1, max_tokens=512)
            insights = self._parse_insights(raw_response)
        except Exception:
            logger.exception("LLM extraction call failed")
            return

        if not insights:
            logger.debug("No insights extracted from log entries")
            return

        # Post each insight to memini-core with dedup
        posted = 0
        for insight in insights:
            content = insight.get("content", "")
            insight_type = insight.get("type", "fact")
            if not content:
                continue

            checksum = _compute_checksum(content)
            if checksum in self._seen_checksums:
                logger.debug("Skipping duplicate insight: %s", content[:60])
                continue
            self._seen_checksums.add(checksum)

            success = await self._post_to_memini(content, insight_type)
            if success:
                posted += 1

        if posted:
            logger.info("Posted %d new insights to memini-core", posted)

    def _parse_insights(self, raw: str) -> list[dict[str, str]]:
        """Parse the LLM response into a list of insight dicts."""
        import re

        # Try to find JSON array — could be wrapped in code blocks
        code_match = re.search(r"```(?:json)?\s*(\[.*?\])\s*```", raw, re.DOTALL)
        text = code_match.group(1) if code_match else raw

        # Find the first [ ... ] block
        bracket_match = re.search(r"\[.*\]", text, re.DOTALL)
        if bracket_match:
            text = bracket_match.group(0)

        try:
            parsed = json.loads(text)
            if isinstance(parsed, list):
                return parsed
        except json.JSONDecodeError:
            logger.warning("Failed to parse insights JSON: %s", text[:200])

        return []

    async def _post_to_memini(self, content: str, insight_type: str) -> bool:
        """Post an insight to memini-core's memory/add endpoint.

        Returns:
            True if successfully posted, False otherwise.
        """
        try:
            client = await self._get_http_client()
            url = f"{self.memini_url}/memory/add"
            payload = {
                "content": content,
                "source_type": "session",
                "metadata": {
                    "extracted_by": "neuralgentics-core",
                    "insight_type": insight_type,
                    "extracted_at": datetime.now(timezone.utc).isoformat(),
                },
            }
            response = await client.post(url, json=payload)
            response.raise_for_status()
            return True
        except Exception:
            logger.exception("Failed to post insight to memini-core: %s", content[:80])
            return False
