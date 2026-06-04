"""Intent-to-Tool Broker.

Sends the user's intent and a capability registry to the LLM,
parses the structured response, and returns a resolution with confidence.
"""

from __future__ import annotations

import json
import logging
import re
from typing import Any

from neuralgentics_core.config import settings
from neuralgentics_core.llm import get_llm_client
from neuralgentics_core.models import (
    Capability,
    ResolveIntentRequest,
    ResolveIntentResponse,
)

logger = logging.getLogger(__name__)

SYSTEM_PROMPT = """\
You are a tool-matching assistant. Given a list of capabilities and a user intent,
select the SINGLE BEST capability and extract any arguments.

Respond ONLY with valid JSON in this exact format:
{"server": "<server>", "tool": "<capability>", "args": {<key:val>}, "confidence": <0.0-1.0>}

Rules:
- Pick exactly one capability from the list that best matches the intent.
- Extract relevant args from the intent text.
- Set confidence high (0.8-1.0) for clear matches, medium (0.5-0.7) for partial.
- If no capability matches, set tool to "none", server to "none", confidence to 0.1.
- Do NOT include any text outside the JSON object."""


class CapabilityRegistry:
    """Lightweight capability registry loaded from JSON + dynamic registration."""

    def __init__(self, capabilities_path: str | None = None) -> None:
        self._capabilities: dict[str, Capability] = {}
        self._path = capabilities_path or settings.capabilities_path

    def load_from_file(self) -> None:
        """Load capabilities from the JSON config file."""
        try:
            with open(self._path) as f:
                data = json.load(f)

            for entry in data:
                cap = Capability(**entry)
                self._capabilities[cap.name] = cap

            logger.info("Loaded %d capabilities from %s", len(data), self._path)
        except FileNotFoundError:
            logger.warning("Capabilities file not found: %s", self._path)
        except json.JSONDecodeError:
            logger.error("Invalid JSON in capabilities file: %s", self._path)

    def register(self, name: str, description: str) -> Capability:
        """Dynamically register a new capability."""
        cap = Capability(name=name, description=description)
        self._capabilities[cap.name] = cap
        logger.info("Registered capability: %s", name)
        return cap

    def list_capabilities(self) -> list[Capability]:
        """Return all registered capabilities."""
        return list(self._capabilities.values())

    def get_capability(self, name: str) -> Capability | None:
        """Look up a capability by name."""
        return self._capabilities.get(name)

    def format_for_prompt(self) -> str:
        """Format capabilities as a numbered list for the LLM prompt."""
        caps = self.list_capabilities()
        if not caps:
            return "No capabilities registered."
        lines = []
        for i, cap in enumerate(caps, 1):
            lines.append(f"{i}. {cap.name}: {cap.description}")
        return "\n".join(lines)


# Module-level singleton
_registry: CapabilityRegistry | None = None


def get_registry() -> CapabilityRegistry:
    """Get the module-level capability registry."""
    global _registry  # noqa: PLW0603
    if _registry is None:
        _registry = CapabilityRegistry()
        _registry.load_from_file()
    return _registry


def _parse_llm_response(text: str) -> dict[str, Any]:
    """Extract JSON from the LLM response text.

    The LLM may wrap the JSON in markdown code blocks or add extra text.
    We use a regex to find the first JSON object.
    """
    # Try to find JSON within code blocks first
    code_block_match = re.search(r"```(?:json)?\s*(\{.*?\})\s*```", text, re.DOTALL)
    if code_block_match:
        text = code_block_match.group(1)
    else:
        # Find the first { ... } block
        brace_match = re.search(r"\{.*\}", text, re.DOTALL)
        if brace_match:
            text = brace_match.group(0)

    try:
        return json.loads(text)  # type: ignore[no-any-return]
    except json.JSONDecodeError:
        logger.warning("Failed to parse LLM response as JSON: %s", text[:200])
        return {
            "server": "none",
            "tool": "none",
            "args": {},
            "confidence": 0.0,
        }


async def resolve_intent(request: ResolveIntentRequest) -> ResolveIntentResponse:
    """Resolve a user intent to a specific server + tool + args.

    Args:
        request: The intent resolution request.

    Returns:
        Structured resolution with confidence and clarification flag.
    """
    registry = get_registry()
    llm = get_llm_client()

    cap_list = registry.format_for_prompt()

    user_content = f"Intent: {request.intent}"
    if request.context:
        user_content += f"\nContext: {request.context}"

    messages = [
        {"role": "system", "content": SYSTEM_PROMPT},
        {"role": "user", "content": f"Capabilities:\n{cap_list}\n\n{user_content}"},
    ]

    try:
        raw_response = await llm.chat(messages=messages, temperature=0.2, max_tokens=256)
        parsed = _parse_llm_response(raw_response)

        server = str(parsed.get("server", "none"))
        tool = str(parsed.get("tool", "none"))
        args = parsed.get("args", {}) if isinstance(parsed.get("args"), dict) else {}
        confidence = float(parsed.get("confidence", 0.0))

        # Clamp confidence
        confidence = max(0.0, min(1.0, confidence))

        requires_clarification = confidence < settings.confidence_threshold

        return ResolveIntentResponse(
            server=server,
            tool=tool,
            args=args,
            confidence=confidence,
            requires_clarification=requires_clarification,
        )

    except Exception:
        logger.exception("LLM call failed during intent resolution")
        return ResolveIntentResponse(
            server="none",
            tool="none",
            args={},
            confidence=0.0,
            requires_clarification=True,
        )
