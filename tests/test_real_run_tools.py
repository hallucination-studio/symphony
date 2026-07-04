from __future__ import annotations

import importlib.util
import sys
from pathlib import Path

import pytest


ROOT = Path(__file__).resolve().parents[1]
TOOLS = ROOT / "tools"
if str(TOOLS) not in sys.path:
    sys.path.insert(0, str(TOOLS))


def load_tool(name: str):
    spec = importlib.util.spec_from_file_location(name, ROOT / "tools" / f"{name}.py")
    module = importlib.util.module_from_spec(spec)
    assert spec and spec.loader
    sys.modules[name] = module
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
                    "status_label": "performer:phase/done",
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
                    "status_label": "performer:phase/blocked",
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


def test_real_symphony_e2e_patches_smoke_gate_mode() -> None:
    tool = load_tool("real_symphony_e2e")
    workflow = "acceptance:\n  enabled: true\n  mode: block_done\n\ncodex:\n  command: codex app-server\n"

    patched = tool.patch_e2e_gate_mode(workflow, gate_mode="smoke")

    assert "acceptance:\n  enabled: true\n  mode: block_done\n  gate_planner_mode: smoke\n\ncodex:" in patched


def test_real_symphony_e2e_replaces_existing_gate_mode() -> None:
    tool = load_tool("real_symphony_e2e")
    workflow = "acceptance:\n  enabled: true\n  gate_planner_mode: strict\ncodex:\n  command: codex app-server\n"

    patched = tool.patch_e2e_gate_mode(workflow, gate_mode="smoke")

    assert "gate_planner_mode: smoke" in patched
    assert "gate_planner_mode: strict" not in patched


def test_real_symphony_e2e_detects_conductor_phase_human_action() -> None:
    tool = load_tool("real_symphony_e2e")

    actions = tool.conductor_human_actions(
        {
            "runs": [
                {
                    "run_id": "run-1",
                    "issue_id": "issue-1",
                    "issue_identifier": "HELL-1",
                    "phase": "awaiting_human",
                    "status": "waiting",
                    "last_reason": "codex needs local state repair",
                    "human_action": {
                        "child_issue_id": "child-1",
                        "child_identifier": "HELL-2",
                        "child_url": "https://linear.test/HELL-2",
                        "kind": "runtime_error",
                    },
                },
                {"run_id": "run-2", "phase": "done"},
            ]
        }
    )

    assert actions == [
        {
            "run_id": "run-1",
            "issue_id": "issue-1",
            "issue_identifier": "HELL-1",
            "phase": "awaiting_human",
            "status": "waiting",
            "last_reason": "codex needs local state repair",
            "child_issue_id": "child-1",
            "child_identifier": "HELL-2",
            "child_url": "https://linear.test/HELL-2",
            "kind": "runtime_error",
        }
    ]


def test_real_symphony_e2e_tracks_one_automatic_human_action_per_run() -> None:
    tool = load_tool("real_symphony_e2e")
    completed: set[str] = set()
    first = {"run_id": "run-1", "child_issue_id": "child-1"}
    second = {"run_id": "run-1", "child_issue_id": "child-2"}

    assert tool.should_complete_conductor_human_action(first, completed) is True
    completed.add("run-1")
    assert tool.should_complete_conductor_human_action(second, completed) is False


def test_real_symphony_e2e_writes_human_response_into_child_description() -> None:
    tool = load_tool("real_symphony_e2e")

    updated = tool.human_action_description_with_response(
        "Runtime error.\n\nHuman response:\n\n(Add the answer or decision here when information is required.)\n\nWhen finished, move this child issue to Done.",
        "Reviewed by the E2E harness; retry the managed run.",
    )

    assert "Human response:\nReviewed by the E2E harness; retry the managed run.\n\nWhen finished" in updated
    assert "(Add the answer or decision here when information is required.)" not in updated


@pytest.mark.asyncio
async def test_real_symphony_e2e_completes_conductor_human_action_child(monkeypatch) -> None:
    tool = load_tool("real_symphony_e2e")
    calls: list[tuple[str, dict[str, object]]] = []

    async def fake_linear_graphql(token, query, variables):
        del token
        calls.append((query, variables))
        if "query HumanActionIssue" in query:
            return {
                "issue": {
                    "id": "child-1",
                    "identifier": "HELL-2",
                    "description": "Human response:\n\nWhen finished, move this child issue to Done.",
                    "state": {"name": "Todo", "type": "unstarted"},
                    "team": {
                        "states": {
                            "nodes": [
                                {"id": "state-todo", "name": "Todo", "type": "unstarted"},
                                {"id": "state-done", "name": "Done", "type": "completed"},
                            ]
                        }
                    },
                }
            }
        if "mutation UpdateHumanActionDescription" in query:
            return {"issueUpdate": {"success": True, "issue": {"id": "child-1", "identifier": "HELL-2"}}}
        if "mutation MoveHumanActionIssue" in query:
            return {
                "issueUpdate": {
                    "success": True,
                    "issue": {"id": "child-1", "identifier": "HELL-2", "state": {"name": "Done", "type": "completed"}},
                }
            }
        raise AssertionError(query)

    monkeypatch.setattr(tool, "linear_graphql", fake_linear_graphql)

    result = await tool.complete_conductor_human_action(
        "linear-token",
        {
            "run_id": "run-1",
            "issue_identifier": "HELL-1",
            "child_issue_id": "child-1",
            "child_identifier": "HELL-2",
            "kind": "runtime_error",
        },
        response="Reviewed by the E2E harness; retry the managed run.",
    )

    assert result["status"] == "completed"
    assert calls[1][1]["description"].startswith("Human response:\nReviewed by the E2E harness")
    assert calls[2][1] == {"issueId": "child-1", "stateId": "state-done"}


def test_real_symphony_e2e_wait_artifacts_are_written_on_early_exit(tmp_path: Path) -> None:
    tool = load_tool("real_symphony_e2e")
    evidence = tool.Evidence(tmp_path / "report.json")
    result_path = tmp_path / "missing-result.md"
    state_path = tmp_path / "performer.json"
    ops_path = tmp_path / "ops.json"
    state_path.write_text('{"sessions": []}', encoding="utf-8")
    ops_path.write_text('{"runs": {}}', encoding="utf-8")

    result = tool.write_wait_artifacts(
        evidence=evidence,
        samples=[{"at": "2026-07-04T00:00:00Z", "phase": "awaiting_human"}],
        result_path=result_path,
        final_issue={"id": "issue-1", "identifier": "HELL-1", "state": {"name": "In Progress"}},
        state_path=state_path,
        last_state={},
        ops_path=ops_path,
        last_ops={},
        log_path=tmp_path / "performer.log",
        stages={"webhook_queued": "2026-07-04T00:00:00Z"},
        stage_timeout_seconds=60,
    )

    assert Path(evidence.data["artifacts"]["runtime_samples"]).exists()
    assert Path(evidence.data["artifacts"]["stage_snapshot"]).exists()
    assert Path(evidence.data["artifacts"]["final_issue"]).exists()
    assert result["state"] == {"sessions": []}
    assert result["ops"] == {"runs": {}}
