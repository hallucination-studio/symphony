from __future__ import annotations

from typing import Any


MANAGED_RUN_PLAN_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "summary": {"type": "string"},
        "architecture_decisions": {"type": "array", "items": {"type": "string"}},
        "work_items": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "id": {"type": "string"},
                    "title": {"type": "string"},
                    "objective": {"type": "string"},
                    "slice_type": {"type": "string", "enum": ["vertical", "contract-first", "risk-first", "test-only", "docs-only", "research"]},
                    "acceptance_criteria": {"type": "array", "items": {"type": "string"}},
                    "verification": {
                        "type": "object",
                        "properties": {
                            "red_command": {"type": "string"},
                            "green_commands": {"type": "array", "items": {"type": "string"}},
                            "runtime_checks": {"type": "array", "items": {"type": "string"}},
                        },
                        "required": ["red_command", "green_commands", "runtime_checks"],
                        "additionalProperties": False,
                    },
                    "dependencies": {"type": "array", "items": {"type": "string"}},
                    "estimated_scope": {"type": "string"},
                    "files_likely_touched": {"type": "array", "items": {"type": "string"}},
                    "parallelization": {
                        "type": "object",
                        "properties": {
                            "safe_to_parallelize": {"type": "boolean"},
                            "parallel_group": {"type": ["string", "null"]},
                            "reason": {"type": "string"},
                            "shared_contracts": {"type": "array", "items": {"type": "string"}},
                            "merge_strategy": {"type": "string"},
                        },
                        "required": ["safe_to_parallelize", "parallel_group", "reason", "shared_contracts", "merge_strategy"],
                        "additionalProperties": False,
                    },
                    "needs_human_approval": {"type": "boolean"},
                },
                "required": [
                    "id",
                    "title",
                    "objective",
                    "slice_type",
                    "acceptance_criteria",
                    "verification",
                    "dependencies",
                    "estimated_scope",
                    "files_likely_touched",
                    "parallelization",
                    "needs_human_approval",
                ],
                "additionalProperties": False,
            },
        },
        "checkpoints": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "after": {"type": "array", "items": {"type": "string"}},
                    "verify": {"type": "array", "items": {"type": "string"}},
                },
                "required": ["after", "verify"],
                "additionalProperties": False,
            },
        },
        "verification_rubric": {
            "type": "object",
            "properties": {
                "correctness": {"type": "array", "items": {"type": "string"}},
                "quality": {"type": "array", "items": {"type": "string"}},
                "integration": {"type": "array", "items": {"type": "string"}},
                "documentation": {"type": "array", "items": {"type": "string"}},
                "ship_readiness": {"type": "array", "items": {"type": "string"}},
            },
            "required": ["correctness", "quality", "integration", "documentation", "ship_readiness"],
            "additionalProperties": False,
        },
        "risks": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "risk": {"type": "string"},
                    "mitigation": {"type": "string"},
                },
                "required": ["risk", "mitigation"],
                "additionalProperties": False,
            },
        },
        "open_questions": {"type": "array", "items": {"type": "string"}},
        "approval_required": {"type": "boolean"},
    },
    "required": [
        "summary",
        "architecture_decisions",
        "work_items",
        "checkpoints",
        "verification_rubric",
        "risks",
        "open_questions",
        "approval_required",
    ],
    "additionalProperties": False,
}


WORK_ITEM_RESULT_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "work_item_id": {"type": "string"},
        "status_claimed": {"type": "string", "enum": ["ready_for_review", "blocked", "plan_revision_requested"]},
        "changed_files": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "path": {"type": "string"},
                    "action": {"type": "string"},
                    "planned": {"type": "boolean"},
                    "reason": {"type": "string"},
                    "handling": {"type": "string"},
                    "verification": {"type": "array", "items": {"type": "string"}},
                },
                "required": ["path", "action", "planned", "reason", "handling", "verification"],
                "additionalProperties": False,
            },
        },
        "undeclared_files": {"type": "array", "items": {"type": "string"}},
        "tests": {
            "type": "object",
            "properties": {
                "red_command": {"type": "string"},
                "red_observed": {"type": "boolean"},
                "green_commands_run": {"type": "array", "items": {"type": "string"}},
                "secret_scan_passed": {"type": "boolean"},
            },
            "required": ["red_command", "red_observed", "green_commands_run", "secret_scan_passed"],
            "additionalProperties": False,
        },
        "acceptance_results": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "criterion": {"type": "string"},
                    "status": {"type": "string", "enum": ["passed", "failed", "blocked"]},
                    "evidence": {"type": "string"},
                },
                "required": ["criterion", "status", "evidence"],
                "additionalProperties": False,
            },
        },
        "blocked_reason": {"type": ["string", "null"]},
        "plan_revision": {
            "anyOf": [
                {
                    "type": "object",
                    "properties": {
                        "reason": {"type": "string"},
                        "files_likely_touched": {"type": "array", "items": {"type": "string"}},
                    },
                    "required": ["reason", "files_likely_touched"],
                    "additionalProperties": False,
                },
                {"type": "null"},
            ]
        },
        "notes": {"type": "string"},
    },
    "required": [
        "work_item_id",
        "status_claimed",
        "changed_files",
        "undeclared_files",
        "tests",
        "acceptance_results",
        "blocked_reason",
        "plan_revision",
        "notes",
    ],
    "additionalProperties": False,
}

__all__ = ["MANAGED_RUN_PLAN_SCHEMA", "WORK_ITEM_RESULT_SCHEMA"]
