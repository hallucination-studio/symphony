from __future__ import annotations

import importlib.util
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
TOOLS = ROOT / "tools"
if str(TOOLS) not in sys.path:
    sys.path.insert(0, str(TOOLS))


def load_tool(name: str):
    spec = importlib.util.spec_from_file_location(name, ROOT / "tools" / f"{name}.py")
    module = importlib.util.module_from_spec(spec)
    assert spec and spec.loader
    spec.loader.exec_module(module)
    return module


def test_runtime_claims_audit_flags_errorless_retry_and_claim_stall() -> None:
    tool = load_tool("runtime_claims_audit")

    result = tool.audit_runtime_state(
        {
            "sessions": [],
            "retry_attempts": [
                {
                    "issue_id": "issue-1",
                    "identifier": "HELL-1",
                    "attempt": 2,
                    "error": None,
                    "phase": "done",
                    "status_label": "performer:done",
                }
            ],
            "continuations": [],
        },
        "performer_dispatch_summary dispatched=0 skipped=1 running=0 claimed=1",
    )

    assert result["pass"] is False
    assert "retry_without_error:HELL-1" in result["failures"]
    assert "log_repeated_running_0_claimed_positive" in result["failures"]


def test_runtime_claims_audit_allows_blocked_human_approval_state() -> None:
    tool = load_tool("runtime_claims_audit")

    result = tool.audit_runtime_state(
        {
            "sessions": [],
            "retry_attempts": [],
            "continuations": [],
            "blocked": [
                {
                    "issue_id": "issue-1",
                    "identifier": "HELL-1",
                    "attempt": 2,
                    "error": "runtime_permission_blocked: writing outside of the project",
                    "phase": "error",
                    "status_label": "performer:error",
                }
            ],
        },
        "performer_dispatch_summary dispatched=0 skipped=1 running=0 claimed=1",
    )

    assert result["pass"] is True
    assert result["counts"]["blocked"] == 1
    assert result["blocked"][0]["identifier"] == "HELL-1"


def test_linear_tree_audit_requires_gate_and_evidence_parent_links() -> None:
    tool = load_tool("linear_tree_audit")

    result = tool.audit_tree(
        {
            "id": "business-1",
            "identifier": "HELL-1",
            "title": "Business",
            "state": {"name": "In Review", "type": "started"},
            "labels": {"nodes": [{"name": "performer:type/task"}]},
            "children": {
                "nodes": [
                    {
                        "id": "gate-1",
                        "identifier": "HELL-2",
                        "title": "[Gate] HELL-1: Behavior",
                        "parent": {"id": "other", "identifier": "HELL-X"},
                        "state": {"name": "Todo", "type": "unstarted"},
                        "labels": {"nodes": [{"name": "performer:type/gate"}]},
                        "children": {
                            "nodes": [
                                {
                                    "id": "evidence-1",
                                    "identifier": "HELL-3",
                                    "title": "[Evidence] HELL-1",
                                    "parent": {"id": "business-1", "identifier": "HELL-1"},
                                    "state": {"name": "Todo", "type": "unstarted"},
                                    "labels": {"nodes": [{"name": "performer:type/evidence"}]},
                                }
                            ]
                        },
                    },
                    {
                        "id": "acceptance-1",
                        "identifier": "HELL-4",
                        "title": "[Acceptance] HELL-1",
                        "state": {"name": "Todo", "type": "unstarted"},
                        "labels": {"nodes": []},
                        "children": {"nodes": []},
                    },
                ]
            },
            "inverseRelations": {"nodes": [{"id": "rel-1", "type": "blocks"}]},
        }
    )

    assert result["pass"] is False
    assert "gate_parent_mismatch:HELL-2" in result["failures"]
    assert "evidence_parent_mismatch:HELL-3" in result["failures"]
    assert "acceptance_sibling_present" in result["failures"]
    assert "blocks_relation_present" in result["failures"]


def test_real_run_observer_diagnoses_review_phase_state_mismatch() -> None:
    observer = load_tool("real_run_observer")

    findings = observer.diagnose(
        {
            "business_issue": {
                "identifier": "HELL-1",
                "state": "In Progress",
                "labels": ["performer:phase/review"],
            },
            "failures": [],
        },
        {"failures": []},
    )

    assert findings == ["linear_state_phase_mismatch:review_phase_without_in_review_state"]
