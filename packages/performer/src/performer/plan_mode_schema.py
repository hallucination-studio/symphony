from __future__ import annotations

from performer_api.pipeline import HumanEscalationReason


PLAN_RESULT_SCHEMA: dict[str, object] = {
    "type": "object",
    "properties": {
        "proposal": {
            "type": "object",
            "properties": {
                "graph_id": {"type": "string"},
                "plan_attempt_id": {"type": "string"},
                "root_node_id": {"type": "string"},
                "nodes": {
                    "type": "array",
                    "minItems": 1,
                    "items": {
                        "type": "object",
                        "properties": {
                            "node_id": {"type": "string"},
                            "title": {"type": "string"},
                            "state": {
                                "type": "string",
                                "enum": [
                                    "planned",
                                    "ready",
                                    "executing",
                                    "verifying",
                                    "verify_passed",
                                    "replanning",
                                    "superseded",
                                    "need_human",
                                    "failed",
                                ],
                            },
                            "issue_id": {"type": "string"},
                            "issue_identifier": {"type": "string"},
                            "parent_node_id": {"type": "string"},
                            "gate_snapshot_hash": {"type": "string"},
                            "verify_score": {"type": "integer"},
                            "rework_count": {"type": "integer"},
                            "human_reason": {
                                "type": "string",
                                "enum": ["", *[reason.value for reason in HumanEscalationReason]],
                            },
                            "superseded_by": {"type": "array", "items": {"type": "string"}},
                        },
                        "required": [
                            "node_id",
                            "title",
                            "state",
                            "issue_id",
                            "issue_identifier",
                            "parent_node_id",
                            "gate_snapshot_hash",
                            "verify_score",
                            "rework_count",
                            "human_reason",
                            "superseded_by",
                        ],
                        "additionalProperties": False,
                    },
                },
                "blocks": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "properties": {"from_node_id": {"type": "string"}, "to_node_id": {"type": "string"}},
                        "required": ["from_node_id", "to_node_id"],
                        "additionalProperties": False,
                    },
                },
                "gates": {
                    "type": "array",
                    "minItems": 1,
                    "items": {
                        "type": "object",
                        "properties": {
                            "gate_id": {"type": "string"},
                            "task_id": {"type": "string"},
                            "created_by": {"type": "string"},
                            "created_at": {"type": "string"},
                            "hash": {"type": "string"},
                            "content": {
                                "type": "object",
                                "properties": {
                                    "acceptance_criteria": {"type": "array", "items": {"type": "string"}},
                                    "verification_procedure": {
                                        "type": "array",
                                        "items": {
                                            "type": "object",
                                            "properties": {
                                                "step": {"type": "string"},
                                                "source": {
                                                    "type": "string",
                                                    "enum": [
                                                        "issue_requirement",
                                                        "appendix_harness",
                                                        "planner_inferred",
                                                        "system_repair",
                                                    ],
                                                },
                                            },
                                            "required": ["step", "source"],
                                            "additionalProperties": False,
                                        },
                                    },
                                    "rubric": {
                                        "type": "object",
                                        "properties": {str(score): {"type": "string"} for score in range(5)},
                                        "required": [str(score) for score in range(5)],
                                        "additionalProperties": False,
                                    },
                                    "pass_threshold": {"type": "integer"},
                                    "required_credentials": {"type": "array", "items": {"type": "string"}},
                                    "artifact_expectations": {"type": "array", "items": {"type": "string"}},
                                },
                                "required": [
                                    "acceptance_criteria",
                                    "verification_procedure",
                                    "rubric",
                                    "pass_threshold",
                                    "required_credentials",
                                    "artifact_expectations",
                                ],
                                "additionalProperties": False,
                            },
                        },
                        "required": ["gate_id", "task_id", "created_by", "created_at", "hash", "content"],
                        "additionalProperties": False,
                    },
                },
                "entry_node_ids": {"type": "array", "minItems": 1, "items": {"type": "string"}},
                "exit_node_ids": {"type": "array", "minItems": 1, "items": {"type": "string"}},
                "max_subtasks": {"type": "integer"},
                "policy": {
                    "type": "object",
                    "properties": {
                        "max_subtasks": {"type": "integer"},
                        "allowed_edge_kinds": {"type": "array", "items": {"type": "string"}},
                    },
                    "required": ["max_subtasks", "allowed_edge_kinds"],
                    "additionalProperties": False,
                },
            },
            "required": [
                "graph_id",
                "plan_attempt_id",
                "root_node_id",
                "nodes",
                "blocks",
                "gates",
                "entry_node_ids",
                "exit_node_ids",
                "max_subtasks",
                "policy",
            ],
            "additionalProperties": False,
        }
    },
    "required": ["proposal"],
    "additionalProperties": False,
}
