"""Trust engine — adjusts memory trust scores based on feedback signals."""

from __future__ import annotations

from enum import Enum


class TrustSignal(str, Enum):
    """Feedback signals for trust adjustment."""

    AGENT_USED = "agent_used"
    AGENT_IGNORED = "agent_ignored"
    USER_CORRECTED = "user_corrected"
    USER_CONFIRMED = "user_confirmed"


# Delta map: signal → score adjustment
_TRUST_DELTAS: dict[TrustSignal, float] = {
    TrustSignal.AGENT_USED: 0.05,
    TrustSignal.USER_CONFIRMED: 0.10,
    TrustSignal.AGENT_IGNORED: -0.05,
    TrustSignal.USER_CORRECTED: -0.10,
}

_ARCHIVE_THRESHOLD = 0.2
_PROMOTE_THRESHOLD = 0.8


class TrustEngine:
    """Adjusts trust scores for memory entries.

    Every memory starts at trust 0.5. Positive signals increase it,
    negative signals decrease it. Scores are clamped to [0.0, 1.0].
    """

    def adjust(self, current_score: float, signal: TrustSignal) -> float:
        """Return the new trust score after applying a signal.

        Args:
            current_score: Current trust score (0.0–1.0).
            signal: The feedback signal.

        Returns:
            New trust score clamped to [0.0, 1.0].
        """
        delta = _TRUST_DELTAS.get(signal, 0.0)
        return max(0.0, min(1.0, current_score + delta))

    def trust_level(self, score: float) -> str:
        """Classify a trust score into a level name.

        Args:
            score: Trust score (0.0–1.0).

        Returns:
            One of: "archived", "low", "medium", "high", "promoted".
        """
        if score < _ARCHIVE_THRESHOLD:
            return "archived"
        if score < 0.4:
            return "low"
        if score < 0.7:
            return "medium"
        if score < _PROMOTE_THRESHOLD:
            return "high"
        return "promoted"

    def should_archive(self, score: float) -> bool:
        """Return True if the score is below the archive threshold."""
        return score < _ARCHIVE_THRESHOLD

    def should_promote(self, score: float) -> bool:
        """Return True if the score meets the promote threshold."""
        return score >= _PROMOTE_THRESHOLD
