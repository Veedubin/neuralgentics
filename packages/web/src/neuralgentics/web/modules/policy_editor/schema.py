"""Policy YAML schema + validator for the policy_editor module (T-155).

Mirrors the gateway's Go policy types in ``neuralgentics-gateway/policy/``:

  * ``policy.go`` — ``Policy`` (version + statements) and ``Statement``
    (sid, effect, principals/not_principals, actions/not_actions,
    resources/not_resources, condition{rate_limit, audit_level}).
  * ``files.go`` — load-time validation: ``version`` required non-empty,
    ``statements`` key must be present (nil fails; empty list OK), each
    statement's ``effect`` required ("Allow"|"Deny").
  * ``nrn.go`` — NRN grammar: ``nrn:neuralgentics:`` prefix, then a
    resource type (``http``|``tool``|``mcp``), then a type-specific body.

The Go loader uses ``gopkg.in/yaml.v3`` which **silently ignores unknown
fields** by default (Go struct unmarshalling). The web validator mirrors
that: unknown top-level keys and unknown statement keys are **accepted**
(not errors). This keeps the editor in sync with the gateway — if the
gateway grows a new optional field, the editor does not refuse to save
an otherwise-valid policy.

Validation surfaces a structured list of :class:`ValidationError`
objects — one per (statement index, field, message) — so the htmx UI can
render field-level error markers next to the offending YAML lines.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from typing import Any

import yaml

log = logging.getLogger("neuralgentics.web.policy_editor.schema")

# --- Constants (mirrored from policy.go) ---------------------------------

EFFECT_ALLOW = "Allow"
EFFECT_DENY = "Deny"
EFFECTS: tuple[str, ...] = (EFFECT_ALLOW, EFFECT_DENY)

AUDIT_LEVELS: tuple[str, ...] = ("verbose", "normal", "minimal")

VALID_HTTP_METHODS: tuple[str, ...] = (
    "GET",
    "POST",
    "PUT",
    "DELETE",
    "PATCH",
    "HEAD",
    "OPTIONS",
)

NRN_PREFIX = "nrn:neuralgentics:"
NRN_RESOURCE_TYPES: tuple[str, ...] = ("http", "tool", "mcp")


# --- Validation error shape ----------------------------------------------


@dataclass
class ValidationError:
    """One structured validation failure.

    ``statement_index`` is ``-1`` for policy-level errors (missing
    ``version``, missing ``statements`` key, top-level YAML not a
    mapping, etc.). Statement-level errors carry the 0-based index of
    the offending statement so the UI can highlight it.
    """

    statement_index: int
    field: str
    message: str

    def to_dict(self) -> dict[str, Any]:
        return {
            "statement_index": self.statement_index,
            "field": self.field,
            "message": self.message,
        }


@dataclass
class ValidationResult:
    """Outcome of validating a policy YAML string."""

    valid: bool
    errors: list[ValidationError] = field(default_factory=list)
    # The parsed policy as a plain dict (None when YAML is malformed).
    parsed: dict[str, Any] | None = None

    @property
    def error_messages(self) -> list[str]:
        return [e.message for e in self.errors]


# --- Public API ----------------------------------------------------------


def validate_policy_yaml(text: str) -> ValidationResult:
    """Parse + validate a policy YAML string.

    Returns a :class:`ValidationResult` with ``valid=True`` when the
    document parses and matches the gateway's policy schema. Field-level
    errors are returned in ``errors`` so the htmx UI can render them
    inline next to the offending statement.

    Mirrors :go:func:`policy.LoadPoliciesFromFile` (files.go) +
    :go:func:`Policy.Compile` (policy.go) + :go:func:`NRN.Parse`
    (nrn.go). The Go loader is fail-closed (one bad file aborts gateway
    startup); the web editor surfaces the same errors as a save-preview
    block instead so the user can fix them without restarting the
    gateway.
    """
    errors: list[ValidationError] = []

    # 1. Parse YAML.
    try:
        raw: Any = yaml.safe_load(text)
    except yaml.YAMLError as exc:
        return ValidationResult(
            valid=False,
            errors=[ValidationError(-1, "yaml", f"YAML parse error: {exc}")],
            parsed=None,
        )

    if raw is None:
        return ValidationResult(
            valid=False,
            errors=[ValidationError(-1, "yaml", "policy file is empty")],
            parsed=None,
        )

    if not isinstance(raw, dict):
        return ValidationResult(
            valid=False,
            errors=[
                ValidationError(
                    -1, "yaml", f"policy top level must be a mapping (got {type(raw).__name__})"
                )
            ],
            parsed=None,
        )

    # 2. Top-level required fields (mirror files.go).
    version = raw.get("version")
    if version is None or (isinstance(version, str) and version == ""):
        errors.append(ValidationError(-1, "version", "missing required field version"))
    elif not isinstance(version, str):
        errors.append(
            ValidationError(
                -1, "version", f"version must be a string (got {type(version).__name__})"
            )
        )

    if "statements" not in raw:
        # files.go: `statements == nil` (absent) is a hard error.
        errors.append(ValidationError(-1, "statements", "missing required field statements"))
    else:
        statements = raw["statements"]
        if statements is None:
            errors.append(ValidationError(-1, "statements", "missing required field statements"))
        elif not isinstance(statements, list):
            errors.append(
                ValidationError(
                    -1, "statements", f"statements must be a list (got {type(statements).__name__})"
                )
            )
        else:
            for i, stmt in enumerate(statements):
                errors.extend(_validate_statement(i, stmt))

    return ValidationResult(
        valid=len(errors) == 0,
        errors=errors,
        parsed=raw if isinstance(raw, dict) else None,
    )


def _validate_statement(index: int, stmt: Any) -> list[ValidationError]:
    """Validate one statement dict (mirror policy.Compile + files.go)."""
    errs: list[ValidationError] = []
    if not isinstance(stmt, dict):
        errs.append(
            ValidationError(
                index, "statement", f"statement must be a mapping (got {type(stmt).__name__})"
            )
        )
        return errs

    sid = stmt.get("sid", "")
    ctx = f"statement {index} (sid={sid!r})"

    # effect: required (files.go enforces non-empty; policy.go enforces
    # the value is one of Allow/Deny).
    effect = stmt.get("effect")
    if effect is None or effect == "":
        errs.append(ValidationError(index, "effect", f"{ctx}: missing effect"))
    elif not isinstance(effect, str):
        errs.append(ValidationError(index, "effect", f"{ctx}: effect must be a string"))
    elif effect not in EFFECTS:
        errs.append(
            ValidationError(
                index,
                "effect",
                f"{ctx}: invalid effect {effect!r} (want {EFFECT_ALLOW!r} or {EFFECT_DENY!r})",
            )
        )

    # NRN list fields — each entry must be a valid NRN string.
    for fld in (
        "principals",
        "not_principals",
        "actions",
        "not_actions",
        "resources",
        "not_resources",
    ):
        val = stmt.get(fld)
        if val is None:
            continue
        if not isinstance(val, list):
            errs.append(ValidationError(index, fld, f"{ctx}: {fld} must be a list"))
            continue
        for j, item in enumerate(val):
            if not isinstance(item, str):
                errs.append(ValidationError(index, fld, f"{ctx}: {fld}[{j}] must be a string"))
                continue
            nrn_err = _validate_nrn(item)
            if nrn_err is not None:
                errs.append(ValidationError(index, fld, f"{ctx}: {fld}[{j}]: {nrn_err}"))

    # condition: optional mapping with rate_limit (str) and audit_level
    # (one of verbose/normal/minimal).
    cond = stmt.get("condition")
    if cond is not None:
        if not isinstance(cond, dict):
            errs.append(ValidationError(index, "condition", f"{ctx}: condition must be a mapping"))
        else:
            al = cond.get("audit_level")
            if al is not None and al != "" and al not in AUDIT_LEVELS:
                errs.append(
                    ValidationError(
                        index,
                        "condition.audit_level",
                        f"{ctx}: invalid audit_level {al!r} (want one of {AUDIT_LEVELS})",
                    )
                )
            rl = cond.get("rate_limit")
            if rl is not None and not isinstance(rl, str):
                errs.append(
                    ValidationError(
                        index, "condition.rate_limit", f"{ctx}: rate_limit must be a string"
                    )
                )

    return errs


def _validate_nrn(s: str) -> str | None:
    """Validate one NRN string (mirror nrn.go Parse). Returns an error
    message or None when the NRN is well-formed."""
    if not s.startswith(NRN_PREFIX):
        return f"invalid NRN {s!r}: missing prefix {NRN_PREFIX!r}"
    body = s[len(NRN_PREFIX) :]
    if body == "":
        return f"invalid NRN {s!r}: empty after prefix"
    colon = body.find(":")
    if colon < 0:
        return f"invalid NRN {s!r}: missing resource type separator"
    type_str = body[:colon]
    rest = body[colon + 1 :]
    if type_str not in NRN_RESOURCE_TYPES:
        return f"invalid NRN {s!r}: unknown resource type {type_str!r}"

    if type_str == "mcp":
        if rest == "":
            return f"invalid NRN {s!r}: identity NRN has empty MCP name"
        if ":" in rest:
            return f"invalid NRN {s!r}: MCP name {rest!r} contains illegal ':'"
        return None

    if type_str == "http":
        if rest == "**":
            return None
        scheme = rest.find("://")
        if scheme < 0:
            return f'invalid NRN {s!r}: http NRN missing "://" method separator'
        method = rest[:scheme]
        if method == "":
            return f"invalid NRN {s!r}: http NRN has empty method"
        if method != "*" and method.upper() not in VALID_HTTP_METHODS:
            return f"invalid NRN {s!r}: invalid HTTP method {method!r}"
        remainder = rest[scheme + 3 :]
        slash = remainder.find("/")
        host = remainder if slash < 0 else remainder[:slash]
        if host == "":
            return f"invalid NRN {s!r}: http NRN has empty host"
        return None

    # type_str == "tool"
    if rest == "**":
        return None
    c2 = rest.find(":")
    if c2 < 0:
        return f'invalid NRN {s!r}: tool NRN missing ":" between MCP and tool name'
    mcp = rest[:c2]
    tool = rest[c2 + 1 :]
    if mcp == "":
        return f"invalid NRN {s!r}: tool NRN has empty MCP name"
    if tool == "":
        return f"invalid NRN {s!r}: tool NRN has empty tool name"
    return None


__all__ = [
    "AUDIT_LEVELS",
    "EFFECT_ALLOW",
    "EFFECT_DENY",
    "EFFECTS",
    "NRN_PREFIX",
    "NRN_RESOURCE_TYPES",
    "VALID_HTTP_METHODS",
    "ValidationError",
    "ValidationResult",
    "validate_policy_yaml",
]
