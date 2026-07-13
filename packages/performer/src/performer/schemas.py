from __future__ import annotations

from typing import Any


_STRING_ARRAY: dict[str, Any] = {"type": "array", "items": {"type": "string"}}
_TASK_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "id": {"type": "string"},
        "title": {"type": "string"},
        "objective": {"type": "string"},
        "acceptance_criteria": _STRING_ARRAY,
        "verification_commands": _STRING_ARRAY,
        "files_likely_touched": _STRING_ARRAY,
    },
    "required": [
        "id",
        "title",
        "objective",
        "acceptance_criteria",
        "verification_commands",
        "files_likely_touched",
    ],
    "additionalProperties": False,
}

PLAN_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "summary": {"type": "string"},
        "tasks": {"type": "array", "items": _TASK_SCHEMA},
        "risks": _STRING_ARRAY,
        "architecture_decisions": _STRING_ARRAY,
        "open_questions": _STRING_ARRAY,
        "approval_required": {"type": "boolean"},
    },
    "required": [
        "summary",
        "tasks",
        "risks",
        "architecture_decisions",
        "open_questions",
        "approval_required",
    ],
    "additionalProperties": False,
}

_EVIDENCE_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "criterion": {"type": "string"},
        "evidence": {"type": "string"},
        "passed": {"type": "boolean"},
    },
    "required": ["criterion", "evidence", "passed"],
    "additionalProperties": False,
}

EXECUTE_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "status": {"type": "string", "enum": ["ready_for_gate", "blocked", "failed"]},
        "summary": {"type": "string"},
        "changed_files": _STRING_ARRAY,
        "acceptance_evidence": {"type": "array", "items": _EVIDENCE_SCHEMA},
        "blocked_reason": {"type": ["string", "null"]},
    },
    "required": ["status", "summary", "changed_files", "acceptance_evidence", "blocked_reason"],
    "additionalProperties": False,
}

_PROVENANCE_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "source": {"type": "string"},
        "reference": {"type": "string"},
    },
    "required": ["source", "reference"],
    "additionalProperties": False,
}

GATE_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "passed": {"type": "boolean"},
        "score": {"type": "integer"},
        "threshold": {"type": "integer"},
        "rubric": {"type": "object", "properties": {}, "required": [], "additionalProperties": False},
        "provenance": {"type": "array", "items": _PROVENANCE_SCHEMA},
        "findings": _STRING_ARRAY,
        "artifact_refs": _STRING_ARRAY,
    },
    "required": ["passed", "score", "threshold", "rubric", "provenance", "findings", "artifact_refs"],
    "additionalProperties": False,
}


__all__ = ["EXECUTE_SCHEMA", "GATE_SCHEMA", "PLAN_SCHEMA"]
