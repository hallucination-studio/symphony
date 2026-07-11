from __future__ import annotations

from typing import Any


PLAN_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "summary": {"type": "string"},
        "tasks": {"type": "array", "items": {"type": "object"}},
        "risks": {"type": "array", "items": {"type": "string"}},
        "architecture_decisions": {"type": "array", "items": {"type": "string"}},
        "open_questions": {"type": "array", "items": {"type": "string"}},
        "acceptance_catalog": {"type": ["object", "null"]},
        "approval_required": {"type": "boolean"},
    },
    "required": ["summary", "tasks"],
    "additionalProperties": False,
}

EXECUTE_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "status": {"type": "string", "enum": ["ready_for_gate", "blocked", "failed"]},
        "summary": {"type": "string"},
        "changed_files": {"type": "array", "items": {"type": "string"}},
        "acceptance_evidence": {"type": "array", "items": {"type": "object"}},
        "blocked_reason": {"type": ["string", "null"]},
    },
    "required": ["status", "summary", "changed_files", "acceptance_evidence", "blocked_reason"],
    "additionalProperties": False,
}

GATE_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "passed": {"type": "boolean"},
        "score": {"type": "integer"},
        "threshold": {"type": "integer"},
        "rubric": {"type": "object"},
        "provenance": {"type": "array", "items": {"type": "object"}},
        "findings": {"type": "array", "items": {"type": "string"}},
        "artifact_refs": {"type": "array", "items": {"type": "string"}},
    },
    "required": ["passed", "score", "threshold", "rubric", "provenance", "findings", "artifact_refs"],
    "additionalProperties": False,
}


__all__ = ["EXECUTE_SCHEMA", "GATE_SCHEMA", "PLAN_SCHEMA"]
