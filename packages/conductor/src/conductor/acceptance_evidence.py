from __future__ import annotations

from itertools import islice
import re
from typing import Any


_MAX_COMMANDS = 10
_MAX_COMMAND_TEXT = 500
_MAX_OUTPUT_TEXT = 2_000
_MAX_FINDINGS = 8
_MAX_FINDING_TEXT = 500
_MAX_RUBRIC_ROWS = 8
_MAX_ARTIFACT_REFS = 16
_MAX_MANIFEST_REFS = 64
_MAX_RAW_TEXT = 8_000
_MAX_COMMAND_TOTAL = 1_000_000
_MAX_GATE_NUMBER = 1_000_000
_IDENTIFIER = re.compile(r"[A-Za-z0-9][A-Za-z0-9._:-]{0,79}\Z")
_ARTIFACT_REF = re.compile(r"artifact://[A-Za-z0-9][A-Za-z0-9._/-]{0,239}\Z")
_MANIFEST_REF = re.compile(r"manifest://[A-Za-z0-9][A-Za-z0-9._/-]{0,239}\Z")
_KNOWN_FAILURE_CODES = frozenset({"", "verification_command_failed", "codex_gate_failed"})
_SENSITIVE_KEY = (
    r"(?:[A-Za-z0-9]+[-_])*?"
    r"(?:access[-_]?token|refresh[-_]?token|api[-_]?key|"
    r"client[-_]?secret|authorization|token|password|cookie|secret)"
    r"(?:[-_][A-Za-z0-9]+)*"
)
_QUOTED_SECRET = re.compile(
    r"""(?i)(?P<quote>[\"'])(?P<key>"""
    + _SENSITIVE_KEY
    + r""")(?P=quote)\s*[:=]\s*(?:\"(?:\\.|[^\"])*\"|'(?:\\.|[^'])*'|[^\s,;}\]]+)"""
)
_AUTHORIZATION_KEY = r"(?:[A-Za-z0-9]+[-_])*?authorization(?:[-_][A-Za-z0-9]+)*"
_AUTHORIZATION_SECRET = re.compile(
    r"(?i)(?<![A-Za-z0-9_-])(" + _AUTHORIZATION_KEY + r")(\s*[:=]\s*)(?!\[REDACTED\])[^\r\n,;}\]]+"
)
_UNQUOTED_SECRET = re.compile(
    r"(?i)(?<![A-Za-z0-9_-])(" + _SENSITIVE_KEY + r")\s*[:=]\s*(?!\[REDACTED\])[^\s,;}\]]+"
)
_HEX_ESCAPE = re.compile(r"\\+(?:u([0-9A-Fa-f]{4})|x([0-9A-Fa-f]{2}))")
_BARE_SECRET = re.compile(
    r"(?i)\b(?:sk-[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b"
)


def canonical_gate_evidence(
    raw: dict[str, Any] | None,
    *,
    passed: bool,
    score: int,
    threshold: int,
    attempt_id: str,
    plan_version: int,
    catalog: dict[str, Any] | None,
    manifest_refs: list[Any],
    command_passed: int,
    command_total: int,
) -> dict[str, Any]:
    source = raw if isinstance(raw, dict) else {}
    codex_gate = source.get("codex_gate") if isinstance(source.get("codex_gate"), dict) else {}
    commands = _commands(source.get("commands"))
    counts = _command_counts(command_passed, command_total)
    if counts is None:
        raise ValueError("invalid_command_counts")
    normalized_score = gate_number(score)
    normalized_threshold = gate_number(threshold)
    normalized_plan_version = gate_number(plan_version)
    if normalized_plan_version <= 0:
        raise ValueError("invalid_gate_plan_version")
    if not isinstance(passed, bool):
        raise ValueError("invalid_gate_verdict")
    effective_passed = passed
    failure_code = _failure_code(effective_passed, counts["passed"], counts["total"])
    if not _consistent_gate(effective_passed, normalized_score, normalized_threshold, counts, failure_code):
        raise ValueError("inconsistent_gate_verdict")
    evidence = {
        "passed": effective_passed,
        "score": normalized_score,
        "threshold": normalized_threshold,
        "plan_version": normalized_plan_version,
        "manifest_refs": _manifest_refs(manifest_refs),
        "command_counts": counts,
        "commands": commands,
        "rubric": _rubric_rows(source.get("rubric") or codex_gate.get("rubric"), fields=("score", "weight", "threshold")),
        "provenance": _codex_provenance(attempt_id),
        "findings": _findings(codex_gate.get("findings")),
        "artifact_refs": _artifact_refs(source.get("artifact_refs")),
        "failure_code": failure_code,
    }
    catalog_summary = _catalog_summary(catalog)
    if catalog_summary:
        evidence["catalog"] = catalog_summary
    return evidence


def gate_evidence_projection(value: dict[str, Any] | None, *, attempt_id: str = "") -> dict[str, Any] | None:
    if not isinstance(value, dict):
        return None
    counts = _stored_command_counts(value.get("command_counts"))
    if counts is None:
        return None
    if not isinstance(value.get("passed"), bool):
        return None
    try:
        score = gate_number(value.get("score"))
        threshold = gate_number(value.get("threshold"))
        plan_version = gate_number(value.get("plan_version"))
    except ValueError:
        return None
    if plan_version <= 0:
        return None
    passed = value["passed"]
    failure_code = _known_failure_code(value.get("failure_code"))
    if not _consistent_gate(passed, score, threshold, counts, failure_code):
        return None
    summary = {
        "passed": passed,
        "score": score,
        "threshold": threshold,
        "plan_version": plan_version,
        "manifest_count": len(_manifest_refs(value.get("manifest_refs"))),
        "commands": counts,
        "rubric": _rubric_rows(value.get("rubric"), fields=("score", "weight", "threshold")),
        "provenance": _codex_provenance(attempt_id),
        "artifact_count": len(_artifact_refs(value.get("artifact_refs"))),
        "failure_code": failure_code,
    }
    catalog_summary = _catalog_summary(value.get("catalog"))
    if catalog_summary:
        summary["catalog"] = catalog_summary
    return summary


def artifact_metadata(evidence: dict[str, Any]) -> dict[str, Any]:
    catalog = _catalog_summary(evidence.get("catalog"))
    return {
        "plan_version": max(0, _number(evidence.get("plan_version"))),
        "catalog_id": catalog["id"] if catalog else "",
        "passed": evidence.get("passed") is True,
        "score": _number(evidence.get("score")),
        "threshold": _number(evidence.get("threshold")),
    }


def _commands(value: Any) -> list[dict[str, Any]]:
    if not isinstance(value, list):
        return []
    commands: list[dict[str, Any]] = []
    for item in value[:_MAX_COMMANDS]:
        if not isinstance(item, dict):
            continue
        exit_code = item.get("exit_code")
        commands.append(
            {
                "command": _text(item.get("command"), _MAX_COMMAND_TEXT),
                "passed": item.get("passed") is True,
                "exit_code": _number(exit_code) if exit_code is not None else None,
                "output": _text(item.get("output"), _MAX_OUTPUT_TEXT),
            }
        )
    return commands


def _rubric_rows(value: Any, *, fields: tuple[str, ...]) -> list[dict[str, Any]]:
    if isinstance(value, list):
        rows = ((row.get("id"), row) for row in value[:_MAX_RUBRIC_ROWS] if isinstance(row, dict))
    elif isinstance(value, dict):
        rows = ((key, row) for key, row in islice(value.items(), _MAX_RUBRIC_ROWS) if isinstance(row, dict))
    else:
        return []
    normalized: list[dict[str, Any]] = []
    for raw_identifier, row in rows:
        identifier = _identifier(raw_identifier)
        if not identifier:
            continue
        normalized_row: dict[str, Any] = {"id": identifier}
        for field in fields:
            if row.get(field) is None:
                continue
            try:
                normalized_row[field] = gate_number(row.get(field))
            except ValueError:
                continue
        normalized.append(normalized_row)
    return normalized


def _codex_provenance(attempt_id: Any) -> list[dict[str, str]]:
    identifier = _identifier(attempt_id)
    return [{"source": "codex", "attempt_id": identifier}] if identifier else []


def _findings(value: Any) -> list[str]:
    if not isinstance(value, list):
        return []
    findings: list[str] = []
    for item in value[:_MAX_FINDINGS]:
        finding = _text(item, _MAX_FINDING_TEXT)
        if finding:
            findings.append(finding)
    return findings


def _artifact_refs(value: Any) -> list[str]:
    return _opaque_refs(value, _ARTIFACT_REF, _MAX_ARTIFACT_REFS)


def _manifest_refs(value: Any) -> list[str]:
    return _opaque_refs(value, _MANIFEST_REF, _MAX_MANIFEST_REFS)


def _opaque_refs(value: Any, pattern: re.Pattern[str], limit: int) -> list[str]:
    if not isinstance(value, list):
        return []
    refs: list[str] = []
    for ref in value[:limit]:
        if (
            not isinstance(ref, str)
            or len(ref) > 250
            or _BARE_SECRET.search(ref) is not None
            or pattern.fullmatch(ref) is None
            or ref in refs
        ):
            continue
        refs.append(ref)
    return refs


def _catalog_id(catalog: dict[str, Any] | None) -> str:
    return _identifier(catalog.get("id")) if isinstance(catalog, dict) else ""


def _catalog_summary(value: Any) -> dict[str, Any]:
    catalog = value if isinstance(value, dict) else None
    catalog_id = _catalog_id(catalog)
    if not catalog_id:
        return {}
    return {
        "id": catalog_id,
        "rubric": _rubric_rows(catalog.get("rubric"), fields=("weight", "threshold")),
    }


def _command_counts(passed: Any, total: Any) -> dict[str, int] | None:
    if isinstance(passed, bool) or isinstance(total, bool) or not isinstance(passed, int) or not isinstance(total, int):
        return None
    if passed < 0 or total < 0 or passed > total or total > _MAX_COMMAND_TOTAL:
        return None
    return {"passed": passed, "total": total}


def _stored_command_counts(value: Any) -> dict[str, int] | None:
    if not isinstance(value, dict):
        return None
    return _command_counts(value.get("passed"), value.get("total"))


def _failure_code(passed: bool, command_passed: int, command_total: int) -> str:
    if passed:
        return ""
    return "verification_command_failed" if command_passed != command_total else "codex_gate_failed"


def _consistent_gate(
    passed: bool,
    score: int,
    threshold: int,
    command_counts: dict[str, int],
    failure_code: str,
) -> bool:
    commands_passed = command_counts["passed"] == command_counts["total"]
    if passed:
        return score >= threshold and commands_passed and not failure_code
    expected_failure = "verification_command_failed" if not commands_passed else "codex_gate_failed"
    return failure_code == expected_failure


def _known_failure_code(value: Any) -> str:
    code = _identifier(value)
    return code if code in _KNOWN_FAILURE_CODES else ""


def _text(value: Any, limit: int) -> str:
    if not isinstance(value, str):
        return ""
    text = value[:_MAX_RAW_TEXT]
    text = _HEX_ESCAPE.sub(_decode_escape, text).replace("\r", " ").replace("\n", " ").replace("\x00", " ").strip()
    text = _QUOTED_SECRET.sub(lambda match: f"{match.group('key')}=[REDACTED]", text)
    text = _AUTHORIZATION_SECRET.sub(lambda match: f"{match.group(1)}{match.group(2)}[REDACTED]", text)
    text = _UNQUOTED_SECRET.sub(lambda match: f"{match.group(1)}=[REDACTED]", text)
    text = re.sub(r"(?i)\b(bearer|basic)\s+[A-Za-z0-9._~+/=-]+", r"\1 [REDACTED]", text)
    return _BARE_SECRET.sub("[REDACTED]", text)[:limit]


def _decode_escape(match: re.Match[str]) -> str:
    return chr(int(match.group(1) or match.group(2), 16))


def _identifier(value: Any) -> str:
    if not isinstance(value, str) or len(value) > 80:
        return ""
    return value if _IDENTIFIER.fullmatch(value) and _BARE_SECRET.search(value) is None else ""


def _number(value: Any) -> int:
    if isinstance(value, bool) or (isinstance(value, str) and len(value) > 20):
        return 0
    try:
        return int(value or 0)
    except (OverflowError, TypeError, ValueError):
        return 0


def gate_number(value: Any) -> int:
    if isinstance(value, bool):
        raise ValueError("invalid_gate_number")
    try:
        number = int(value)
    except (OverflowError, TypeError, ValueError):
        raise ValueError("invalid_gate_number") from None
    if number < 0 or number > _MAX_GATE_NUMBER:
        raise ValueError("invalid_gate_number")
    return number


__all__ = [
    "artifact_metadata",
    "canonical_gate_evidence",
    "gate_number",
    "gate_evidence_projection",
]
