from __future__ import annotations

import hashlib
import json
import subprocess
from types import SimpleNamespace
from pathlib import Path

import pytest
import performer.cli as performer_cli

from performer.cli import parse_args, run_mode_attempt
from performer_api.pipeline import GateSpecContent, GateSpecSnapshot, GraphNode, GraphNodeState, PASS_THRESHOLD, PlanProposal, RuntimeMode


def test_cli_accepts_three_runtime_modes_and_attempt_paths() -> None:
    args = parse_args(
        [
            "--mode",
            "verify",
            "--attempt-request-path",
            "/tmp/request.json",
            "--attempt-result-path",
            "/tmp/result.json",
        ]
    )

    assert args.mode == "verify"
    assert args.attempt_request_path == "/tmp/request.json"
    assert args.attempt_result_path == "/tmp/result.json"


def test_cli_rejects_legacy_managed_phase_flags() -> None:
    with pytest.raises(SystemExit):
        parse_args(
            [
                "WORKFLOW.md",
                "--advance-request-path",
                "/tmp/request.json",
                "--phase-result-path",
                "/tmp/result.json",
            ]
        )


@pytest.mark.asyncio
async def test_plan_mode_writes_structured_result_file(tmp_path: Path) -> None:
    request_path = tmp_path / "plan-request.json"
    result_path = tmp_path / "plan-result.json"
    workspace = tmp_path / "planner-workspace"
    workspace.mkdir()
    request_path.write_text(
        json.dumps(
            {
                "attempt_id": "plan-1",
                "graph_id": "graph-1",
                "root_node_id": "root",
                "issue_id": "issue-1",
                "issue_identifier": "ENG-1",
                "title": "Implement feature",
                "graph_revision": 7,
                "policy_revision": 3,
                "lease_id": "lease-plan",
                "fencing_token": "token-plan",
                "workspace_path": str(workspace),
            }
        ),
        encoding="utf-8",
    )

    gate = GateSpecSnapshot.create(
        gate_id="gate-node-1",
        task_id="issue-1",
        created_by="plan-1",
        created_at="2026-07-06T00:00:00Z",
        content=GateSpecContent(
            acceptance_criteria=["feature works"],
            verification_procedure=["pytest -q"],
            rubric={str(score): f"score {score}" for score in range(5)},
            pass_threshold=3,
        ),
    )
    proposal = PlanProposal(
        graph_id="graph-1",
        plan_attempt_id="plan-1",
        root_node_id="root",
        nodes=[
            GraphNode(
                node_id="issue-1",
                title="Implement feature",
                state=GraphNodeState.PLANNED,
                issue_id="issue-1",
                gate_snapshot_hash=gate.hash,
            )
        ],
        blocks=[],
        gates=[gate],
        entry_node_ids=["issue-1"],
        exit_node_ids=["issue-1"],
    )
    backend = _FakeBackend([{"proposal": proposal.to_dict()}])

    result = await run_mode_attempt(RuntimeMode.PLAN, request_path, result_path, agent_backend=backend)

    payload = json.loads(result_path.read_text(encoding="utf-8"))
    assert result["mode"] == "plan"
    assert payload["status"] == "succeeded"
    assert payload["graph_revision"] == 7
    assert payload["policy_revision"] == 3
    assert payload["lease_id"] == "lease-plan"
    assert payload["fencing_token"] == "token-plan"
    assert payload["proposal"]["graph_id"] == "graph-1"
    assert payload["proposal"]["nodes"][0]["gate_snapshot_hash"] == payload["proposal"]["gates"][0]["hash"]
    assert backend.calls == 1


@pytest.mark.asyncio
async def test_plan_mode_uses_request_workspace_path_for_codex(tmp_path: Path) -> None:
    request_path = tmp_path / "plan-request.json"
    result_path = tmp_path / "plan-result.json"
    workspace = tmp_path / "planner-workspace"
    workspace.mkdir()
    request_path.write_text(
        json.dumps(
            {
                "attempt_id": "plan-1",
                "graph_id": "graph-1",
                "root_node_id": "root",
                "node_id": "root",
                "issue_id": "issue-1",
                "issue_identifier": "ENG-1",
                "title": "Implement feature",
                "graph_revision": 7,
                "policy_revision": 3,
                "lease_id": "lease-plan",
                "fencing_token": "token-plan",
                "workspace_path": str(workspace),
            }
        ),
        encoding="utf-8",
    )

    gate = GateSpecSnapshot.create(
        gate_id="gate-node-1",
        task_id="issue-1",
        created_by="plan-1",
        created_at="2026-07-06T00:00:00Z",
        content=GateSpecContent(
            acceptance_criteria=["feature works"],
            verification_procedure=["pytest -q"],
            rubric={str(score): f"score {score}" for score in range(5)},
            pass_threshold=3,
        ),
    )
    proposal = PlanProposal(
        graph_id="graph-1",
        plan_attempt_id="plan-1",
        root_node_id="root",
        nodes=[
            GraphNode(
                node_id="issue-1",
                title="Implement feature",
                state=GraphNodeState.PLANNED,
                issue_id="issue-1",
                gate_snapshot_hash=gate.hash,
            )
        ],
        blocks=[],
        gates=[gate],
        entry_node_ids=["issue-1"],
        exit_node_ids=["issue-1"],
    )
    backend = _FakeBackend([{"proposal": proposal.to_dict()}])

    await run_mode_attempt(RuntimeMode.PLAN, request_path, result_path, agent_backend=backend)

    assert backend.workspace_paths == [workspace]
    assert str(workspace) not in backend.prompts[0]
    assert '"workspace_path": "<planner-workspace>"' in backend.prompts[0]
    assert "Do not freeze absolute local filesystem paths" in backend.prompts[0]
    assert "verification_procedure entry must be an executable POSIX shell command" in backend.prompts[0]


@pytest.mark.asyncio
async def test_plan_mode_uses_strict_plan_result_schema(tmp_path: Path) -> None:
    request_path = tmp_path / "plan-request.json"
    result_path = tmp_path / "plan-result.json"
    workspace = tmp_path / "planner-workspace"
    workspace.mkdir()
    request_path.write_text(
        json.dumps(
            {
                "attempt_id": "plan-1",
                "graph_id": "graph-1",
                "root_node_id": "root",
                "node_id": "root",
                "issue_id": "issue-1",
                "issue_identifier": "ENG-1",
                "title": "Implement feature",
                "graph_revision": 7,
                "policy_revision": 3,
                "lease_id": "lease-plan",
                "fencing_token": "token-plan",
                "workspace_path": str(workspace),
            }
        ),
        encoding="utf-8",
    )
    gate = GateSpecSnapshot.create(
        gate_id="gate-node-1",
        task_id="issue-1",
        created_by="plan-1",
        created_at="2026-07-06T00:00:00Z",
        content=GateSpecContent(
            acceptance_criteria=["feature works"],
            verification_procedure=["pytest -q"],
            rubric={str(score): f"score {score}" for score in range(5)},
            pass_threshold=3,
        ),
    )
    proposal = PlanProposal(
        graph_id="graph-1",
        plan_attempt_id="plan-1",
        root_node_id="root",
        nodes=[
            GraphNode(
                node_id="issue-1",
                title="Implement feature",
                state=GraphNodeState.PLANNED,
                issue_id="issue-1",
                gate_snapshot_hash=gate.hash,
            )
        ],
        blocks=[],
        gates=[gate],
        entry_node_ids=["issue-1"],
        exit_node_ids=["issue-1"],
    )
    backend = _FakeBackend([{"proposal": proposal.to_dict()}])

    await run_mode_attempt(RuntimeMode.PLAN, request_path, result_path, agent_backend=backend)

    schema = backend.kwargs[0]["output_schema"]
    assert schema["required"] == ["proposal"]
    assert schema["additionalProperties"] is False
    proposal_schema = schema["properties"]["proposal"]
    assert proposal_schema["properties"]["nodes"]["minItems"] == 1
    assert proposal_schema["properties"]["gates"]["minItems"] == 1
    assert proposal_schema["properties"]["entry_node_ids"]["minItems"] == 1
    assert proposal_schema["properties"]["exit_node_ids"]["minItems"] == 1
    assert _contains_open_additional_properties(schema) is False


@pytest.mark.asyncio
async def test_plan_mode_canonicalizes_model_gate_hashes_and_dict_edges(tmp_path: Path) -> None:
    request_path = tmp_path / "plan-request.json"
    result_path = tmp_path / "plan-result.json"
    workspace = tmp_path / "planner-workspace"
    workspace.mkdir()
    request_path.write_text(
        json.dumps(
            {
                "attempt_id": "plan-1",
                "graph_id": "graph-1",
                "root_node_id": "root",
                "node_id": "root",
                "issue_id": "issue-1",
                "issue_identifier": "ENG-1",
                "title": "Implement feature",
                "graph_revision": 7,
                "policy_revision": 3,
                "lease_id": "lease-plan",
                "fencing_token": "token-plan",
                "workspace_path": str(workspace),
            }
        ),
        encoding="utf-8",
    )
    first_gate = _passing_gate().to_dict()
    first_gate["task_id"] = "a"
    first_gate["gate_id"] = "gate-a"
    first_gate["hash"] = "model-guessed-hash"
    second_gate = _passing_gate().to_dict()
    second_gate["task_id"] = "b"
    second_gate["gate_id"] = "gate-b"
    second_gate["hash"] = "also-wrong"
    backend = _FakeBackend(
        [
            {
                "proposal": {
                    "graph_id": "graph-1",
                    "plan_attempt_id": "plan-1",
                    "root_node_id": "root",
                    "nodes": [
                        {
                            "node_id": "a",
                            "title": "A",
                            "state": "PLANNED",
                            "issue_id": "issue-1",
                            "issue_identifier": "ENG-1",
                            "parent_node_id": "root",
                            "gate_snapshot_hash": "model-guessed-hash",
                            "verify_score": 0,
                            "rework_count": 0,
                            "human_reason": "freeform rationale from model",
                            "aggregate_state": "",
                            "superseded_by": [],
                        },
                        {
                            "node_id": "b",
                            "title": "B",
                            "state": "planned",
                            "issue_id": "issue-1",
                            "issue_identifier": "ENG-1",
                            "parent_node_id": "root",
                            "gate_snapshot_hash": "also-wrong",
                            "verify_score": 0,
                            "rework_count": 0,
                            "human_reason": "",
                            "aggregate_state": "",
                            "superseded_by": [],
                        },
                    ],
                    "blocks": [{"from_node_id": "a", "to_node_id": "b"}],
                    "gates": [first_gate, second_gate],
                    "entry_node_ids": ["a"],
                    "exit_node_ids": ["b"],
                }
            }
        ]
    )

    result = await run_mode_attempt(RuntimeMode.PLAN, request_path, result_path, agent_backend=backend)

    proposal = result["proposal"]
    assert isinstance(proposal, dict)
    assert result["status"] == "succeeded"
    assert proposal["blocks"] == [["a", "b"]]
    assert proposal["nodes"][0]["gate_snapshot_hash"] == proposal["gates"][0]["hash"]
    assert proposal["nodes"][1]["gate_snapshot_hash"] == proposal["gates"][1]["hash"]
    assert proposal["gates"][0]["hash"].startswith("sha256:")


@pytest.mark.asyncio
async def test_plan_mode_parses_plan_json_from_final_response(tmp_path: Path) -> None:
    request_path = tmp_path / "plan-request.json"
    result_path = tmp_path / "plan-result.json"
    workspace = tmp_path / "planner-workspace"
    workspace.mkdir()
    request_path.write_text(
        json.dumps(
            {
                "attempt_id": "plan-1",
                "graph_id": "graph-1",
                "root_node_id": "root",
                "node_id": "root",
                "issue_id": "issue-1",
                "issue_identifier": "ENG-1",
                "title": "Implement feature",
                "graph_revision": 7,
                "policy_revision": 3,
                "lease_id": "lease-plan",
                "fencing_token": "token-plan",
                "workspace_path": str(workspace),
            }
        ),
        encoding="utf-8",
    )
    gate = _passing_gate()
    proposal = PlanProposal(
        graph_id="graph-1",
        plan_attempt_id="plan-1",
        root_node_id="root",
        nodes=[
            GraphNode(
                node_id="node-1",
                title="Node",
                state=GraphNodeState.PLANNED,
                issue_id="issue-1",
                gate_snapshot_hash=gate.hash,
            )
        ],
        blocks=[],
        gates=[gate],
        entry_node_ids=["node-1"],
        exit_node_ids=["node-1"],
    )
    backend = _FinalResponseBackend(json.dumps({"proposal": proposal.to_dict()}))

    result = await run_mode_attempt(RuntimeMode.PLAN, request_path, result_path, agent_backend=backend)

    assert result["status"] == "succeeded"
    assert result["proposal"]["nodes"][0]["node_id"] == "node-1"  # type: ignore[index]


@pytest.mark.asyncio
async def test_plan_mode_without_injected_backend_fails_closed_without_codex_home(
    tmp_path: Path, monkeypatch
) -> None:
    request_path = tmp_path / "plan-request.json"
    result_path = tmp_path / "plan-result.json"
    request_path.write_text(
        json.dumps(
            {
                "attempt_id": "plan-1",
                "graph_id": "graph-1",
                "root_node_id": "root",
                "node_id": "root",
                "issue_id": "issue-1",
                "issue_identifier": "ENG-1",
                "title": "Implement feature",
                "graph_revision": 7,
                "policy_revision": 3,
                "lease_id": "lease-plan",
                "fencing_token": "token-plan",
            }
        ),
        encoding="utf-8",
    )
    monkeypatch.delenv("CODEX_HOME", raising=False)

    result = await run_mode_attempt(RuntimeMode.PLAN, request_path, result_path)

    payload = json.loads(result_path.read_text(encoding="utf-8"))
    assert result["status"] == "failed"
    assert payload["error"] == "managed_codex_home_required"
    assert payload["lease_id"] == "lease-plan"


@pytest.mark.asyncio
async def test_plan_mode_retries_invalid_structured_output_then_returns_fenced_failure(tmp_path: Path) -> None:
    request_path = tmp_path / "plan-request.json"
    result_path = tmp_path / "plan-result.json"
    workspace = tmp_path / "planner-workspace"
    workspace.mkdir()
    request_path.write_text(
        json.dumps(
            {
                "attempt_id": "plan-1",
                "graph_id": "graph-1",
                "root_node_id": "root",
                "node_id": "root",
                "issue_id": "issue-1",
                "issue_identifier": "ENG-1",
                "title": "Implement feature",
                "graph_revision": 7,
                "policy_revision": 3,
                "lease_id": "lease-plan",
                "fencing_token": "token-plan",
                "workspace_path": str(workspace),
            }
        ),
        encoding="utf-8",
    )
    backend = _FakeBackend([{"not_a_proposal": {}}, {"proposal": {"nodes": []}}])

    result = await run_mode_attempt(RuntimeMode.PLAN, request_path, result_path, agent_backend=backend)

    payload = json.loads(result_path.read_text(encoding="utf-8"))
    assert backend.calls == 2
    assert "missing_proposal" in backend.prompts[1]
    assert result["mode"] == "plan"
    assert payload["status"] == "failed"
    assert payload["proposal"] is None
    assert payload["graph_revision"] == 7
    assert payload["policy_revision"] == 3
    assert payload["lease_id"] == "lease-plan"
    assert payload["fencing_token"] == "token-plan"
    assert payload["error"].startswith("invalid_plan_proposal:")


@pytest.mark.asyncio
async def test_plan_mode_backend_exception_returns_fenced_failure(tmp_path: Path) -> None:
    request_path = tmp_path / "plan-request.json"
    result_path = tmp_path / "plan-result.json"
    workspace = tmp_path / "planner-workspace"
    workspace.mkdir()
    request_path.write_text(
        json.dumps(
            {
                "attempt_id": "plan-1",
                "graph_id": "graph-1",
                "root_node_id": "root",
                "node_id": "root",
                "issue_id": "issue-1",
                "issue_identifier": "ENG-1",
                "title": "Implement feature",
                "graph_revision": 7,
                "policy_revision": 3,
                "lease_id": "lease-plan",
                "fencing_token": "token-plan",
                "workspace_path": str(workspace),
            }
        ),
        encoding="utf-8",
    )

    await run_mode_attempt(RuntimeMode.PLAN, request_path, result_path, agent_backend=_FailingBackend("planner exploded"))

    payload = json.loads(result_path.read_text(encoding="utf-8"))
    assert payload["status"] == "failed"
    assert payload["mode"] == RuntimeMode.PLAN.value
    assert payload["lease_id"] == "lease-plan"
    assert payload["fencing_token"] == "token-plan"
    assert payload["error"] == "planner exploded"


@pytest.mark.asyncio
async def test_verify_mode_scores_snapshot_against_gate_threshold(tmp_path: Path) -> None:
    gate = GateSpecSnapshot.create(
        gate_id="gate-1",
        task_id="node-1",
        created_by="plan-1",
        created_at="2026-07-06T00:00:00Z",
        content=GateSpecContent(
            acceptance_criteria=["patch applies"],
            verification_procedure=["test -f README.md"],
            rubric={str(score): f"score {score}" for score in range(5)},
            pass_threshold=3,
        ),
    )
    verification_input = _verification_input_with_patch(tmp_path, gate_hash=gate.hash)
    request_path = tmp_path / "verify-request.json"
    result_path = tmp_path / "verify-result.json"
    request_path.write_text(
        json.dumps(
            {
                "attempt_id": "verify-1",
                "node_id": "node-1",
                "graph_revision": 5,
                "policy_revision": 2,
                "lease_id": "lease-verify",
                "fencing_token": "token-verify",
                "gate_snapshot_hash": gate.hash,
                "gate_snapshot": gate.to_dict(),
                "verification_input": verification_input,
            }
        ),
        encoding="utf-8",
    )

    await run_mode_attempt(RuntimeMode.VERIFY, request_path, result_path)

    payload = json.loads(result_path.read_text(encoding="utf-8"))
    assert payload["status"] == "succeeded"
    assert payload["score"] == PASS_THRESHOLD
    assert payload["passed"] is True
    assert payload["graph_revision"] == 5
    assert payload["policy_revision"] == 2
    assert payload["lease_id"] == "lease-verify"
    assert payload["execute_attempt_id"] == "exec-1"


@pytest.mark.asyncio
async def test_verify_mode_fails_closed_without_frozen_gate_snapshot(tmp_path: Path) -> None:
    verification_input = _verification_input_with_patch(tmp_path, gate_hash="sha256:gate")
    request_path = tmp_path / "verify-request.json"
    result_path = tmp_path / "verify-result.json"
    request_path.write_text(
        json.dumps(
            {
                "attempt_id": "verify-no-gate",
                "node_id": "node-1",
                "graph_revision": 5,
                "policy_revision": 2,
                "lease_id": "lease-verify",
                "fencing_token": "token-verify",
                "gate_snapshot_hash": "sha256:gate",
                "verification_input": verification_input,
            }
        ),
        encoding="utf-8",
    )

    await run_mode_attempt(RuntimeMode.VERIFY, request_path, result_path)

    payload = json.loads(result_path.read_text(encoding="utf-8"))
    assert payload["status"] == "failed"
    assert payload["score"] == 0
    assert payload["passed"] is False
    assert payload["reason"] == "frozen_gate_required"
    assert payload["error"] == "frozen_gate_required"
    assert payload["execute_attempt_id"] == "exec-1"


@pytest.mark.asyncio
async def test_verify_mode_runs_frozen_gate_commands_and_fails_on_command_failure(tmp_path: Path) -> None:
    verification_input = _verification_input_with_patch(tmp_path, gate_hash="")
    request_path = tmp_path / "verify-request.json"
    result_path = tmp_path / "verify-result.json"
    gate = GateSpecSnapshot.create(
        gate_id="gate-1",
        task_id="node-1",
        created_by="plan-1",
        created_at="2026-07-06T00:00:00Z",
        content=GateSpecContent(
            acceptance_criteria=["command must pass"],
            verification_procedure=["python -c 'raise SystemExit(7)'"],
            rubric={str(score): f"score {score}" for score in range(5)},
            pass_threshold=3,
        ),
    )
    verification_input["gate_snapshot_hash"] = gate.hash
    request_path.write_text(
        json.dumps(
            {
                "attempt_id": "verify-1",
                "node_id": "node-1",
                "graph_revision": 5,
                "policy_revision": 2,
                "lease_id": "lease-verify",
                "fencing_token": "token-verify",
                "gate_snapshot_hash": gate.hash,
                "gate_snapshot": gate.to_dict(),
                "verification_input": verification_input,
            }
        ),
        encoding="utf-8",
    )

    await run_mode_attempt(RuntimeMode.VERIFY, request_path, result_path)

    payload = json.loads(result_path.read_text(encoding="utf-8"))
    assert payload["status"] == "failed"
    assert payload["score"] == 0
    assert payload["passed"] is False
    assert payload["reason"].startswith("gate_command_failed")
    assert "python -c" in payload["reason"]
    assert "exit_code=" in payload["reason"]
    assert "stdout=''" in payload["reason"]
    assert "stderr=''" in payload["reason"]
    assert payload["error"] == payload["reason"]


@pytest.mark.asyncio
async def test_verify_mode_runs_gate_commands_against_patched_verification_worktree(tmp_path: Path) -> None:
    repo = tmp_path / "repo"
    repo.mkdir()
    subprocess.run(["git", "init"], cwd=repo, check=True, capture_output=True, text=True)
    subprocess.run(["git", "config", "user.email", "test@example.com"], cwd=repo, check=True)
    subprocess.run(["git", "config", "user.name", "Test User"], cwd=repo, check=True)
    (repo / "README.md").write_text("before\n", encoding="utf-8")
    subprocess.run(["git", "add", "README.md"], cwd=repo, check=True)
    subprocess.run(["git", "commit", "-m", "base"], cwd=repo, check=True, capture_output=True, text=True)
    base_revision = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=repo, text=True).strip()
    (repo / "created.txt").write_text("from patch\n", encoding="utf-8")
    subprocess.run(["git", "add", "created.txt"], cwd=repo, check=True)
    patch = subprocess.check_output(["git", "diff", "--binary", "--cached"], cwd=repo, text=True)
    expected_tree = subprocess.check_output(["git", "write-tree"], cwd=repo, text=True).strip()
    subprocess.run(["git", "reset", "--hard", "HEAD"], cwd=repo, check=True, capture_output=True, text=True)
    patch_path = tmp_path / "patch.diff"
    patch_path.write_text(patch, encoding="utf-8")
    gate = GateSpecSnapshot.create(
        gate_id="gate-1",
        task_id="node-1",
        created_by="plan-1",
        created_at="2026-07-06T00:00:00Z",
        content=GateSpecContent(
            acceptance_criteria=["created file exists after patch"],
            verification_procedure=["test \"$(cat created.txt)\" = \"from patch\""],
            rubric={str(score): f"score {score}" for score in range(5)},
            pass_threshold=3,
        ),
    )
    request_path = tmp_path / "verify-request.json"
    result_path = tmp_path / "verify-result.json"
    request_path.write_text(
        json.dumps(
            {
                "attempt_id": "verify-1",
                "node_id": "node-1",
                "graph_revision": 5,
                "policy_revision": 2,
                "lease_id": "lease-verify",
                "fencing_token": "token-verify",
                "gate_snapshot_hash": gate.hash,
                "gate_snapshot": gate.to_dict(),
                "verification_input": {
                    "task_id": "node-1",
                    "execute_attempt_id": "exec-1",
                    "base_revision": base_revision,
                    "repository_path": str(repo),
                    "patch_uri": f"file://{patch_path}",
                    "patch_hash": "sha256:" + hashlib.sha256(patch.encode("utf-8")).hexdigest(),
                    "expected_result_tree": expected_tree,
                    "artifact_uris": [],
                    "declared_commands": [],
                    "evidence_uri": "artifact://evidence",
                    "gate_snapshot_hash": gate.hash,
                },
            }
        ),
        encoding="utf-8",
    )

    await run_mode_attempt(RuntimeMode.VERIFY, request_path, result_path)

    payload = json.loads(result_path.read_text(encoding="utf-8"))
    assert payload["status"] == "succeeded"
    assert payload["passed"] is True
    assert not (repo / "created.txt").exists()


@pytest.mark.asyncio
async def test_verify_mode_rejects_gate_commands_that_mutate_verification_worktree(tmp_path: Path) -> None:
    verification_input = _verification_input_with_patch(tmp_path, gate_hash="")
    gate = GateSpecSnapshot.create(
        gate_id="gate-1",
        task_id="node-1",
        created_by="plan-1",
        created_at="2026-07-06T00:00:00Z",
        content=GateSpecContent(
            acceptance_criteria=["verifier gate must be read-only"],
            verification_procedure=["printf mutated > verifier-output.txt"],
            rubric={str(score): f"score {score}" for score in range(5)},
            pass_threshold=3,
        ),
    )
    verification_input["gate_snapshot_hash"] = gate.hash
    request_path = tmp_path / "verify-request.json"
    result_path = tmp_path / "verify-result.json"
    request_path.write_text(
        json.dumps(
            {
                "attempt_id": "verify-readonly",
                "node_id": "node-1",
                "graph_revision": 5,
                "policy_revision": 2,
                "lease_id": "lease-verify",
                "fencing_token": "token-verify",
                "gate_snapshot_hash": gate.hash,
                "gate_snapshot": gate.to_dict(),
                "verification_input": verification_input,
            }
        ),
        encoding="utf-8",
    )

    await run_mode_attempt(RuntimeMode.VERIFY, request_path, result_path)

    payload = json.loads(result_path.read_text(encoding="utf-8"))
    assert payload["status"] == "failed"
    assert payload["passed"] is False
    assert payload["reason"] == "verifier_workspace_mutated"


@pytest.mark.asyncio
async def test_verify_mode_rejects_gate_commands_that_mutate_tracked_state(tmp_path: Path) -> None:
    verification_input = _verification_input_with_patch(tmp_path, gate_hash="")
    gate = GateSpecSnapshot.create(
        gate_id="gate-1",
        task_id="node-1",
        created_by="plan-1",
        created_at="2026-07-06T00:00:00Z",
        content=GateSpecContent(
            acceptance_criteria=["verifier gate must leave tracked files unchanged"],
            verification_procedure=["printf tampered > README.md"],
            rubric={str(score): f"score {score}" for score in range(5)},
            pass_threshold=3,
        ),
    )
    verification_input["gate_snapshot_hash"] = gate.hash
    request_path = tmp_path / "verify-request.json"
    result_path = tmp_path / "verify-result.json"
    request_path.write_text(
        json.dumps(
            {
                "attempt_id": "verify-tracked-readonly",
                "node_id": "node-1",
                "graph_revision": 5,
                "policy_revision": 2,
                "lease_id": "lease-verify",
                "fencing_token": "token-verify",
                "gate_snapshot_hash": gate.hash,
                "gate_snapshot": gate.to_dict(),
                "verification_input": verification_input,
            }
        ),
        encoding="utf-8",
    )

    await run_mode_attempt(RuntimeMode.VERIFY, request_path, result_path)

    payload = json.loads(result_path.read_text(encoding="utf-8"))
    assert payload["status"] == "failed"
    assert payload["passed"] is False
    assert payload["reason"] == "verifier_workspace_mutated"


@pytest.mark.asyncio
async def test_verify_mode_runs_pytest_without_generated_cache_mutation(tmp_path: Path) -> None:
    repo = tmp_path / "repo"
    repo.mkdir()
    subprocess.run(["git", "init"], cwd=repo, check=True, capture_output=True, text=True)
    subprocess.run(["git", "config", "user.email", "test@example.com"], cwd=repo, check=True)
    subprocess.run(["git", "config", "user.name", "Test User"], cwd=repo, check=True)
    (repo / "tests").mkdir()
    (repo / "tests" / "test_smoke.py").write_text("def test_smoke():\n    assert True\n", encoding="utf-8")
    subprocess.run(["git", "add", "tests/test_smoke.py"], cwd=repo, check=True)
    subprocess.run(["git", "commit", "-m", "base"], cwd=repo, check=True, capture_output=True, text=True)
    base_revision = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=repo, text=True).strip()
    (repo / "RESULT.md").write_text("ok\n", encoding="utf-8")
    subprocess.run(["git", "add", "RESULT.md"], cwd=repo, check=True)
    patch = subprocess.check_output(["git", "diff", "--binary", "--cached"], cwd=repo, text=True)
    expected_tree = subprocess.check_output(["git", "write-tree"], cwd=repo, text=True).strip()
    subprocess.run(["git", "reset", "--hard", "HEAD"], cwd=repo, check=True, capture_output=True, text=True)
    patch_path = tmp_path / "patch.diff"
    patch_path.write_text(patch, encoding="utf-8")
    gate = GateSpecSnapshot.create(
        gate_id="gate-pytest",
        task_id="node-1",
        created_by="plan-1",
        created_at="2026-07-06T00:00:00Z",
        content=GateSpecContent(
            acceptance_criteria=["pytest passes"],
            verification_procedure=["pytest tests/test_smoke.py -q"],
            rubric={str(score): f"score {score}" for score in range(5)},
            pass_threshold=3,
        ),
    )
    request_path = tmp_path / "verify-request.json"
    result_path = tmp_path / "verify-result.json"
    request_path.write_text(
        json.dumps(
            {
                "attempt_id": "verify-pytest",
                "node_id": "node-1",
                "graph_revision": 5,
                "policy_revision": 2,
                "lease_id": "lease-verify",
                "fencing_token": "token-verify",
                "gate_snapshot_hash": gate.hash,
                "gate_snapshot": gate.to_dict(),
                "verification_input": {
                    "task_id": "node-1",
                    "execute_attempt_id": "exec-1",
                    "base_revision": base_revision,
                    "repository_path": str(repo),
                    "patch_uri": f"file://{patch_path}",
                    "patch_hash": "sha256:" + hashlib.sha256(patch.encode("utf-8")).hexdigest(),
                    "expected_result_tree": expected_tree,
                    "artifact_uris": [],
                    "declared_commands": [],
                    "evidence_uri": "artifact://evidence",
                    "gate_snapshot_hash": gate.hash,
                },
            }
        ),
        encoding="utf-8",
    )

    await run_mode_attempt(RuntimeMode.VERIFY, request_path, result_path)

    payload = json.loads(result_path.read_text(encoding="utf-8"))
    assert payload["status"] == "succeeded"
    assert payload["passed"] is True


@pytest.mark.asyncio
async def test_execute_mode_collects_git_patch_and_snapshot(tmp_path: Path) -> None:
    repo = tmp_path / "repo"
    repo.mkdir()
    subprocess.run(["git", "init"], cwd=repo, check=True, capture_output=True, text=True)
    subprocess.run(["git", "config", "user.email", "test@example.com"], cwd=repo, check=True)
    subprocess.run(["git", "config", "user.name", "Test User"], cwd=repo, check=True)
    (repo / "README.md").write_text("before\n", encoding="utf-8")
    subprocess.run(["git", "add", "README.md"], cwd=repo, check=True)
    subprocess.run(["git", "commit", "-m", "base"], cwd=repo, check=True, capture_output=True, text=True)
    base_revision = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=repo, text=True).strip()
    (repo / "README.md").write_text("after\n", encoding="utf-8")
    request_path = tmp_path / "execute-request.json"
    result_path = tmp_path / "execute-result.json"
    request_path.write_text(
        json.dumps(
            {
                "attempt_id": "exec-1",
                "node_id": "node-1",
                "graph_revision": 4,
                "policy_revision": 2,
                "lease_id": "lease-exec",
                "fencing_token": "token-exec",
                "gate_snapshot_hash": "sha256:gate",
                "workspace_path": str(repo),
                "base_revision": base_revision,
            }
        ),
        encoding="utf-8",
    )

    await run_mode_attempt(RuntimeMode.EXECUTE, request_path, result_path, agent_backend=_NoopBackend())

    payload = json.loads(result_path.read_text(encoding="utf-8"))
    snapshot = payload["verification_input"]
    assert payload["status"] == "succeeded"
    assert payload["graph_revision"] == 4
    assert payload["lease_id"] == "lease-exec"
    assert snapshot["base_revision"] == base_revision
    assert snapshot["patch_hash"].startswith("sha256:")
    assert Path(snapshot["patch_uri"].removeprefix("file://")).read_text(encoding="utf-8")
    assert snapshot["expected_result_tree"]


@pytest.mark.asyncio
async def test_execute_mode_without_injected_backend_fails_closed_without_codex_home(
    tmp_path: Path, monkeypatch
) -> None:
    repo = tmp_path / "repo"
    repo.mkdir()
    subprocess.run(["git", "init"], cwd=repo, check=True, capture_output=True, text=True)
    subprocess.run(["git", "config", "user.email", "test@example.com"], cwd=repo, check=True)
    subprocess.run(["git", "config", "user.name", "Test User"], cwd=repo, check=True)
    (repo / "README.md").write_text("before\n", encoding="utf-8")
    subprocess.run(["git", "add", "README.md"], cwd=repo, check=True)
    subprocess.run(["git", "commit", "-m", "base"], cwd=repo, check=True, capture_output=True, text=True)
    request_path = tmp_path / "execute-request.json"
    result_path = tmp_path / "execute-result.json"
    request_path.write_text(
        json.dumps(
            {
                "attempt_id": "exec-1",
                "node_id": "node-1",
                "graph_revision": 4,
                "policy_revision": 2,
                "lease_id": "lease-exec",
                "fencing_token": "token-exec",
                "gate_snapshot_hash": "sha256:gate",
                "workspace_path": str(repo),
            }
        ),
        encoding="utf-8",
    )
    monkeypatch.delenv("CODEX_HOME", raising=False)

    result = await run_mode_attempt(RuntimeMode.EXECUTE, request_path, result_path)

    payload = json.loads(result_path.read_text(encoding="utf-8"))
    assert result["status"] == "failed"
    assert payload["error"] == "managed_codex_home_required"
    assert payload["lease_id"] == "lease-exec"


@pytest.mark.asyncio
async def test_execute_mode_runs_backend_before_collecting_patch(tmp_path: Path) -> None:
    repo = tmp_path / "repo"
    repo.mkdir()
    subprocess.run(["git", "init"], cwd=repo, check=True, capture_output=True, text=True)
    subprocess.run(["git", "config", "user.email", "test@example.com"], cwd=repo, check=True)
    subprocess.run(["git", "config", "user.name", "Test User"], cwd=repo, check=True)
    (repo / "README.md").write_text("before\n", encoding="utf-8")
    subprocess.run(["git", "add", "README.md"], cwd=repo, check=True)
    subprocess.run(["git", "commit", "-m", "base"], cwd=repo, check=True, capture_output=True, text=True)
    base_revision = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=repo, text=True).strip()
    request_path = tmp_path / "execute-request.json"
    result_path = tmp_path / "execute-result.json"
    request_path.write_text(
        json.dumps(
            {
                "attempt_id": "exec-2",
                "node_id": "node-1",
                "graph_revision": 4,
                "policy_revision": 2,
                "lease_id": "lease-exec",
                "fencing_token": "token-exec",
                "gate_snapshot_hash": "sha256:gate",
                "workspace_path": str(repo),
                "base_revision": base_revision,
            }
        ),
        encoding="utf-8",
    )
    backend = _PatchBackend("created by backend\n")

    await run_mode_attempt(RuntimeMode.EXECUTE, request_path, result_path, agent_backend=backend)

    payload = json.loads(result_path.read_text(encoding="utf-8"))
    patch_text = Path(payload["verification_input"]["patch_uri"].removeprefix("file://")).read_text(encoding="utf-8")
    assert backend.calls == 1
    assert "All file writes must happen inside the current execution workspace" in backend.prompts[0]
    assert "BACKEND.txt" in patch_text
    assert "created by backend" in patch_text


@pytest.mark.asyncio
async def test_execute_mode_excludes_generated_python_test_caches_from_patch(tmp_path: Path) -> None:
    repo = tmp_path / "repo"
    repo.mkdir()
    subprocess.run(["git", "init"], cwd=repo, check=True, capture_output=True, text=True)
    subprocess.run(["git", "config", "user.email", "test@example.com"], cwd=repo, check=True)
    subprocess.run(["git", "config", "user.name", "Test User"], cwd=repo, check=True)
    (repo / "README.md").write_text("before\n", encoding="utf-8")
    subprocess.run(["git", "add", "README.md"], cwd=repo, check=True)
    subprocess.run(["git", "commit", "-m", "base"], cwd=repo, check=True, capture_output=True, text=True)
    base_revision = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=repo, text=True).strip()
    request_path = tmp_path / "execute-request.json"
    result_path = tmp_path / "execute-result.json"
    request_path.write_text(
        json.dumps(
            {
                "attempt_id": "exec-cache",
                "node_id": "node-1",
                "graph_revision": 4,
                "policy_revision": 2,
                "lease_id": "lease-exec",
                "fencing_token": "token-exec",
                "gate_snapshot_hash": "sha256:gate",
                "workspace_path": str(repo),
                "base_revision": base_revision,
            }
        ),
        encoding="utf-8",
    )

    await run_mode_attempt(RuntimeMode.EXECUTE, request_path, result_path, agent_backend=_CacheWritingBackend())

    payload = json.loads(result_path.read_text(encoding="utf-8"))
    patch_text = Path(payload["verification_input"]["patch_uri"].removeprefix("file://")).read_text(encoding="utf-8")
    assert "BACKEND.txt" in patch_text
    assert "__pycache__" not in patch_text
    assert ".pytest_cache" not in patch_text
    assert ".pyc" not in patch_text


@pytest.mark.asyncio
async def test_execute_mode_streams_backend_events_to_stdout(tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    repo = tmp_path / "repo"
    repo.mkdir()
    subprocess.run(["git", "init"], cwd=repo, check=True, capture_output=True, text=True)
    subprocess.run(["git", "config", "user.email", "test@example.com"], cwd=repo, check=True)
    subprocess.run(["git", "config", "user.name", "Test User"], cwd=repo, check=True)
    (repo / "README.md").write_text("before\n", encoding="utf-8")
    subprocess.run(["git", "add", "README.md"], cwd=repo, check=True)
    subprocess.run(["git", "commit", "-m", "base"], cwd=repo, check=True, capture_output=True, text=True)
    request_path = tmp_path / "execute-request.json"
    result_path = tmp_path / "execute-result.json"
    request_path.write_text(
        json.dumps(
            {
                "attempt_id": "exec-visible",
                "node_id": "node-1",
                "graph_revision": 4,
                "policy_revision": 2,
                "lease_id": "lease-exec",
                "fencing_token": "token-exec",
                "gate_snapshot_hash": "sha256:gate",
                "workspace_path": str(repo),
            }
        ),
        encoding="utf-8",
    )

    await run_mode_attempt(RuntimeMode.EXECUTE, request_path, result_path, agent_backend=_EventBackend())

    output = capsys.readouterr().out
    assert '"event": "performer_attempt_event"' in output
    assert '"codex_event": "sdk_session_starting"' in output
    assert "secret-token" not in output


@pytest.mark.asyncio
async def test_execute_mode_builds_managed_codex_config_from_environment(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    repo = tmp_path / "repo"
    repo.mkdir()
    subprocess.run(["git", "init"], cwd=repo, check=True, capture_output=True, text=True)
    subprocess.run(["git", "config", "user.email", "test@example.com"], cwd=repo, check=True)
    subprocess.run(["git", "config", "user.name", "Test User"], cwd=repo, check=True)
    (repo / "README.md").write_text("before\n", encoding="utf-8")
    subprocess.run(["git", "add", "README.md"], cwd=repo, check=True)
    subprocess.run(["git", "commit", "-m", "base"], cwd=repo, check=True, capture_output=True, text=True)
    request_path = tmp_path / "execute-request.json"
    result_path = tmp_path / "execute-result.json"
    request_path.write_text(
        json.dumps(
            {
                "attempt_id": "exec-env",
                "node_id": "node-1",
                "graph_revision": 4,
                "policy_revision": 2,
                "lease_id": "lease-exec",
                "fencing_token": "token-exec",
                "gate_snapshot_hash": "sha256:gate",
                "workspace_path": str(repo),
            }
        ),
        encoding="utf-8",
    )
    codex_home = tmp_path / "codex-home"
    codex_home.mkdir()
    captured: dict[str, object] = {}

    class CapturingCodexClient:
        def __init__(self, config):
            captured["config"] = config

        async def run_session(self, workspace_path: Path, prompt: str, title: str, **kwargs: object) -> object:
            _ = workspace_path, prompt, title, kwargs
            (repo / "BACKEND.txt").write_text("created\n", encoding="utf-8")
            return SimpleNamespace(structured_result={"changed_files": ["BACKEND.txt"]})

    monkeypatch.setattr(performer_cli, "CodexSdkClient", CapturingCodexClient)
    monkeypatch.setenv("CODEX_HOME", str(codex_home))
    monkeypatch.setenv("CODEX_MODEL", "gpt-5.3-codex")
    monkeypatch.setenv("CODEX_SANDBOX", "workspace-write")
    monkeypatch.setenv("CODEX_HARD_TURN_TIMEOUT_MS", "120000")
    monkeypatch.setenv("CODEX_CONFIG_OVERRIDES", json.dumps(["model_provider=custom"]))

    await run_mode_attempt(RuntimeMode.EXECUTE, request_path, result_path)

    config = captured["config"]
    assert config.model == "gpt-5.3-codex"
    assert config.sandbox == "workspace_write"
    assert config.config_overrides == ("model_provider=custom",)
    assert config.hard_turn_timeout_ms == 120000


@pytest.mark.asyncio
async def test_execute_mode_backend_exception_returns_fenced_failure(tmp_path: Path) -> None:
    repo = tmp_path / "repo"
    repo.mkdir()
    subprocess.run(["git", "init"], cwd=repo, check=True, capture_output=True, text=True)
    subprocess.run(["git", "config", "user.email", "test@example.com"], cwd=repo, check=True)
    subprocess.run(["git", "config", "user.name", "Test User"], cwd=repo, check=True)
    (repo / "README.md").write_text("before\n", encoding="utf-8")
    subprocess.run(["git", "add", "README.md"], cwd=repo, check=True)
    subprocess.run(["git", "commit", "-m", "base"], cwd=repo, check=True, capture_output=True, text=True)
    base_revision = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=repo, text=True).strip()
    request_path = tmp_path / "execute-request.json"
    result_path = tmp_path / "execute-result.json"
    request_path.write_text(
        json.dumps(
            {
                "attempt_id": "exec-1",
                "node_id": "node-1",
                "graph_revision": 4,
                "policy_revision": 2,
                "lease_id": "lease-exec",
                "fencing_token": "token-exec",
                "gate_snapshot_hash": "sha256:gate",
                "repository": {"resolved_repo_path": str(repo)},
                "base_revision": base_revision,
            }
        ),
        encoding="utf-8",
    )

    await run_mode_attempt(RuntimeMode.EXECUTE, request_path, result_path, agent_backend=_FailingBackend("executor exploded"))

    payload = json.loads(result_path.read_text(encoding="utf-8"))
    assert payload["status"] == "failed"
    assert payload["mode"] == RuntimeMode.EXECUTE.value
    assert payload["node_id"] == "node-1"
    assert payload["gate_snapshot_hash"] == "sha256:gate"
    assert payload["lease_id"] == "lease-exec"
    assert payload["fencing_token"] == "token-exec"
    assert payload["verification_input"] == {}
    assert payload["error"] == "executor exploded"


@pytest.mark.asyncio
async def test_execute_mode_uses_structured_repository_path_from_managed_request(tmp_path: Path) -> None:
    repo = tmp_path / "repo"
    repo.mkdir()
    subprocess.run(["git", "init"], cwd=repo, check=True, capture_output=True, text=True)
    subprocess.run(["git", "config", "user.email", "test@example.com"], cwd=repo, check=True)
    subprocess.run(["git", "config", "user.name", "Test User"], cwd=repo, check=True)
    (repo / "README.md").write_text("before\n", encoding="utf-8")
    subprocess.run(["git", "add", "README.md"], cwd=repo, check=True)
    subprocess.run(["git", "commit", "-m", "base"], cwd=repo, check=True, capture_output=True, text=True)
    base_revision = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=repo, text=True).strip()
    request_path = tmp_path / "execute-request.json"
    result_path = tmp_path / "execute-result.json"
    request_path.write_text(
        json.dumps(
            {
                "attempt_id": "exec-structured",
                "node_id": "node-1",
                "graph_revision": 4,
                "policy_revision": 2,
                "lease_id": "lease-exec",
                "fencing_token": "token-exec",
                "gate_snapshot_hash": "sha256:gate",
                "repository": {"resolved_repo_path": str(repo)},
                "base_revision": base_revision,
            }
        ),
        encoding="utf-8",
    )
    backend = _PatchBackend("created by structured request\n")

    await run_mode_attempt(RuntimeMode.EXECUTE, request_path, result_path, agent_backend=backend)

    payload = json.loads(result_path.read_text(encoding="utf-8"))
    snapshot = payload["verification_input"]
    patch_text = Path(snapshot["patch_uri"].removeprefix("file://")).read_text(encoding="utf-8")
    assert backend.calls == 1
    assert snapshot["repository_path"] == str(repo)
    assert "BACKEND.txt" in patch_text
    assert "created by structured request" in patch_text


@pytest.mark.asyncio
async def test_execute_mode_materializes_attempt_workspace_from_repository_baseline(tmp_path: Path) -> None:
    repo = tmp_path / "repo"
    repo.mkdir()
    subprocess.run(["git", "init"], cwd=repo, check=True, capture_output=True, text=True)
    subprocess.run(["git", "config", "user.email", "test@example.com"], cwd=repo, check=True)
    subprocess.run(["git", "config", "user.name", "Test User"], cwd=repo, check=True)
    (repo / "README.md").write_text("before\n", encoding="utf-8")
    subprocess.run(["git", "add", "README.md"], cwd=repo, check=True)
    subprocess.run(["git", "commit", "-m", "base"], cwd=repo, check=True, capture_output=True, text=True)
    base_revision = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=repo, text=True).strip()
    request_path = tmp_path / "execute-request.json"
    result_path = tmp_path / "execute-result.json"
    attempt_dir = tmp_path / "attempt"
    request_path.write_text(
        json.dumps(
            {
                "attempt_id": "exec-isolated",
                "node_id": "node-1",
                "graph_revision": 4,
                "policy_revision": 2,
                "lease_id": "lease-exec",
                "fencing_token": "token-exec",
                "gate_snapshot_hash": "sha256:gate",
                "repository": {"resolved_repo_path": str(repo)},
                "artifact_paths": {"attempt_dir": str(attempt_dir)},
                "base_revision": base_revision,
            }
        ),
        encoding="utf-8",
    )
    backend = _PatchBackend("created in isolated workspace\n")

    await run_mode_attempt(RuntimeMode.EXECUTE, request_path, result_path, agent_backend=backend)

    payload = json.loads(result_path.read_text(encoding="utf-8"))
    snapshot = payload["verification_input"]
    workspace = attempt_dir / "workspace"
    patch_text = Path(snapshot["patch_uri"].removeprefix("file://")).read_text(encoding="utf-8")
    assert backend.workspace_paths == [workspace]
    assert snapshot["repository_path"] == str(repo)
    assert snapshot["workspace_path"] == str(workspace)
    assert "created in isolated workspace" in patch_text
    assert not (repo / "BACKEND.txt").exists()
    assert subprocess.check_output(["git", "status", "--short"], cwd=repo, text=True) == ""


@pytest.mark.asyncio
async def test_verify_mode_applies_patch_and_rejects_hash_mismatch(tmp_path: Path) -> None:
    repo = tmp_path / "repo"
    repo.mkdir()
    subprocess.run(["git", "init"], cwd=repo, check=True, capture_output=True, text=True)
    subprocess.run(["git", "config", "user.email", "test@example.com"], cwd=repo, check=True)
    subprocess.run(["git", "config", "user.name", "Test User"], cwd=repo, check=True)
    (repo / "README.md").write_text("before\n", encoding="utf-8")
    subprocess.run(["git", "add", "README.md"], cwd=repo, check=True)
    subprocess.run(["git", "commit", "-m", "base"], cwd=repo, check=True, capture_output=True, text=True)
    base_revision = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=repo, text=True).strip()
    (repo / "README.md").write_text("after\n", encoding="utf-8")
    patch = subprocess.check_output(["git", "diff", "--binary"], cwd=repo, text=True)
    expected_tree = subprocess.check_output(["git", "write-tree"], cwd=repo, text=True).strip()
    patch_path = tmp_path / "patch.diff"
    patch_path.write_text(patch, encoding="utf-8")
    gate = _passing_gate()
    request_path = tmp_path / "verify-request.json"
    result_path = tmp_path / "verify-result.json"
    request_path.write_text(
        json.dumps(
            {
                "attempt_id": "verify-2",
                "node_id": "node-1",
                "graph_revision": 4,
                "policy_revision": 2,
                "lease_id": "lease-verify",
                "fencing_token": "token-verify",
                "gate_snapshot_hash": gate.hash,
                "gate_snapshot": gate.to_dict(),
                "workspace_path": str(tmp_path / "verify-workspace"),
                "verification_input": {
                    "task_id": "node-1",
                    "execute_attempt_id": "exec-1",
                    "base_revision": base_revision,
                    "repository_path": str(repo),
                    "patch_uri": f"file://{patch_path}",
                    "patch_hash": "sha256:wrong",
                    "expected_result_tree": expected_tree,
                    "artifact_uris": [],
                    "declared_commands": [],
                    "evidence_uri": f"file://{tmp_path}",
                    "gate_snapshot_hash": gate.hash,
                },
            }
        ),
        encoding="utf-8",
    )

    await run_mode_attempt(RuntimeMode.VERIFY, request_path, result_path)

    payload = json.loads(result_path.read_text(encoding="utf-8"))
    assert payload["status"] == "failed"
    assert payload["score"] == 0
    assert payload["reason"] == "patch_hash_mismatch"


@pytest.mark.asyncio
async def test_verify_mode_returns_fenced_failure_when_patch_apply_fails(tmp_path: Path) -> None:
    repo = tmp_path / "repo"
    repo.mkdir()
    subprocess.run(["git", "init"], cwd=repo, check=True, capture_output=True, text=True)
    subprocess.run(["git", "config", "user.email", "test@example.com"], cwd=repo, check=True)
    subprocess.run(["git", "config", "user.name", "Test User"], cwd=repo, check=True)
    (repo / "README.md").write_text("before\n", encoding="utf-8")
    subprocess.run(["git", "add", "README.md"], cwd=repo, check=True)
    subprocess.run(["git", "commit", "-m", "base"], cwd=repo, check=True, capture_output=True, text=True)
    base_revision = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=repo, text=True).strip()
    invalid_patch = """diff --git a/MISSING.md b/MISSING.md
index 1111111..2222222 100644
--- a/MISSING.md
+++ b/MISSING.md
@@ -1 +1 @@
-before
+after
"""
    patch_path = tmp_path / "invalid-patch.diff"
    patch_path.write_text(invalid_patch, encoding="utf-8")
    gate = _passing_gate()
    request_path = tmp_path / "verify-request.json"
    result_path = tmp_path / "verify-result.json"
    request_path.write_text(
        json.dumps(
            {
                "attempt_id": "verify-apply-failure",
                "node_id": "node-1",
                "graph_revision": 4,
                "policy_revision": 2,
                "lease_id": "lease-verify",
                "fencing_token": "token-verify",
                "gate_snapshot_hash": gate.hash,
                "gate_snapshot": gate.to_dict(),
                "verification_input": {
                    "task_id": "node-1",
                    "execute_attempt_id": "exec-1",
                    "base_revision": base_revision,
                    "repository_path": str(repo),
                    "patch_uri": f"file://{patch_path}",
                    "patch_hash": "sha256:" + hashlib.sha256(invalid_patch.encode("utf-8")).hexdigest(),
                    "expected_result_tree": "tree-that-will-not-be-reached",
                    "artifact_uris": [],
                    "declared_commands": [],
                    "evidence_uri": f"file://{tmp_path}",
                    "gate_snapshot_hash": gate.hash,
                },
            }
        ),
        encoding="utf-8",
    )

    await run_mode_attempt(RuntimeMode.VERIFY, request_path, result_path)

    payload = json.loads(result_path.read_text(encoding="utf-8"))
    assert payload["status"] == "failed"
    assert payload["score"] == 0
    assert payload["passed"] is False
    assert payload["reason"] == "patch_apply_failed"
    assert payload["lease_id"] == "lease-verify"
    assert payload["fencing_token"] == "token-verify"


@pytest.mark.asyncio
async def test_verify_mode_rejects_artifact_hash_mismatch(tmp_path: Path) -> None:
    artifact_path = tmp_path / "evidence.json"
    artifact_path.write_text('{"ok":true}\n', encoding="utf-8")
    gate = _passing_gate()
    verification_input = _verification_input_with_patch(tmp_path, gate_hash=gate.hash)
    verification_input["artifact_uris"] = [
        {
            "uri": f"file://{artifact_path}",
            "sha256": "sha256:wrong",
            "type": "evidence",
        }
    ]
    verification_input["evidence_uri"] = f"file://{artifact_path}"
    request_path = tmp_path / "verify-request.json"
    result_path = tmp_path / "verify-result.json"
    request_path.write_text(
        json.dumps(
            {
                "attempt_id": "verify-artifact",
                "node_id": "node-1",
                "graph_revision": 4,
                "policy_revision": 2,
                "lease_id": "lease-verify",
                "fencing_token": "token-verify",
                "gate_snapshot_hash": gate.hash,
                "gate_snapshot": gate.to_dict(),
                "verification_input": verification_input,
            }
        ),
        encoding="utf-8",
    )

    await run_mode_attempt(RuntimeMode.VERIFY, request_path, result_path)

    payload = json.loads(result_path.read_text(encoding="utf-8"))
    assert payload["status"] == "failed"
    assert payload["score"] == 0
    assert payload["passed"] is False
    assert payload["reason"] == "artifact_hash_mismatch"


@pytest.mark.asyncio
async def test_verify_mode_applies_patch_and_accepts_matching_result_tree(tmp_path: Path) -> None:
    repo = tmp_path / "repo"
    repo.mkdir()
    subprocess.run(["git", "init"], cwd=repo, check=True, capture_output=True, text=True)
    subprocess.run(["git", "config", "user.email", "test@example.com"], cwd=repo, check=True)
    subprocess.run(["git", "config", "user.name", "Test User"], cwd=repo, check=True)
    (repo / "README.md").write_text("before\n", encoding="utf-8")
    subprocess.run(["git", "add", "README.md"], cwd=repo, check=True)
    subprocess.run(["git", "commit", "-m", "base"], cwd=repo, check=True, capture_output=True, text=True)
    base_revision = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=repo, text=True).strip()
    (repo / "README.md").write_text("after\n", encoding="utf-8")
    subprocess.run(["git", "add", "README.md"], cwd=repo, check=True)
    patch = subprocess.check_output(["git", "diff", "--binary", "--cached"], cwd=repo, text=True)
    expected_tree = subprocess.check_output(["git", "write-tree"], cwd=repo, text=True).strip()
    subprocess.run(["git", "reset", "--hard", "HEAD"], cwd=repo, check=True, capture_output=True, text=True)
    patch_path = tmp_path / "patch.diff"
    patch_path.write_text(patch, encoding="utf-8")
    gate = _passing_gate()
    request_path = tmp_path / "verify-request.json"
    result_path = tmp_path / "verify-result.json"
    request_path.write_text(
        json.dumps(
            {
                "attempt_id": "verify-3",
                "node_id": "node-1",
                "graph_revision": 4,
                "policy_revision": 2,
                "lease_id": "lease-verify",
                "fencing_token": "token-verify",
                "gate_snapshot_hash": gate.hash,
                "gate_snapshot": gate.to_dict(),
                "verification_input": {
                    "task_id": "node-1",
                    "execute_attempt_id": "exec-1",
                    "base_revision": base_revision,
                    "repository_path": str(repo),
                    "patch_uri": f"file://{patch_path}",
                    "patch_hash": "sha256:" + hashlib.sha256(patch.encode("utf-8")).hexdigest(),
                    "expected_result_tree": expected_tree,
                    "artifact_uris": [],
                    "declared_commands": [],
                    "evidence_uri": f"file://{tmp_path}",
                    "gate_snapshot_hash": gate.hash,
                },
            }
        ),
        encoding="utf-8",
    )

    await run_mode_attempt(RuntimeMode.VERIFY, request_path, result_path)

    payload = json.loads(result_path.read_text(encoding="utf-8"))
    assert payload["status"] == "succeeded"
    assert payload["passed"] is True


@pytest.mark.asyncio
async def test_verify_mode_rejects_expected_result_tree_mismatch(tmp_path: Path) -> None:
    repo = tmp_path / "repo"
    repo.mkdir()
    subprocess.run(["git", "init"], cwd=repo, check=True, capture_output=True, text=True)
    subprocess.run(["git", "config", "user.email", "test@example.com"], cwd=repo, check=True)
    subprocess.run(["git", "config", "user.name", "Test User"], cwd=repo, check=True)
    (repo / "README.md").write_text("before\n", encoding="utf-8")
    subprocess.run(["git", "add", "README.md"], cwd=repo, check=True)
    subprocess.run(["git", "commit", "-m", "base"], cwd=repo, check=True, capture_output=True, text=True)
    base_revision = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=repo, text=True).strip()
    (repo / "README.md").write_text("after\n", encoding="utf-8")
    subprocess.run(["git", "add", "README.md"], cwd=repo, check=True)
    patch = subprocess.check_output(["git", "diff", "--binary", "--cached"], cwd=repo, text=True)
    subprocess.run(["git", "reset", "--hard", "HEAD"], cwd=repo, check=True, capture_output=True, text=True)
    patch_path = tmp_path / "patch.diff"
    patch_path.write_text(patch, encoding="utf-8")
    gate = _passing_gate()
    request_path = tmp_path / "verify-request.json"
    result_path = tmp_path / "verify-result.json"
    request_path.write_text(
        json.dumps(
            {
                "attempt_id": "verify-result-tree",
                "node_id": "node-1",
                "graph_revision": 4,
                "policy_revision": 2,
                "lease_id": "lease-verify",
                "fencing_token": "token-verify",
                "gate_snapshot_hash": gate.hash,
                "gate_snapshot": gate.to_dict(),
                "verification_input": {
                    "task_id": "node-1",
                    "execute_attempt_id": "exec-1",
                    "base_revision": base_revision,
                    "repository_path": str(repo),
                    "patch_uri": f"file://{patch_path}",
                    "patch_hash": "sha256:" + hashlib.sha256(patch.encode("utf-8")).hexdigest(),
                    "expected_result_tree": "not-the-applied-tree",
                    "artifact_uris": [],
                    "declared_commands": [],
                    "evidence_uri": f"file://{tmp_path}",
                    "gate_snapshot_hash": gate.hash,
                },
            }
        ),
        encoding="utf-8",
    )

    await run_mode_attempt(RuntimeMode.VERIFY, request_path, result_path)

    payload = json.loads(result_path.read_text(encoding="utf-8"))
    assert payload["status"] == "failed"
    assert payload["score"] == 0
    assert payload["passed"] is False
    assert payload["reason"] == "result_tree_mismatch"


@pytest.mark.asyncio
async def test_verify_mode_rejects_result_revision_tree_mismatch(tmp_path: Path) -> None:
    repo = tmp_path / "repo"
    repo.mkdir()
    subprocess.run(["git", "init"], cwd=repo, check=True, capture_output=True, text=True)
    subprocess.run(["git", "config", "user.email", "test@example.com"], cwd=repo, check=True)
    subprocess.run(["git", "config", "user.name", "Test User"], cwd=repo, check=True)
    (repo / "README.md").write_text("before\n", encoding="utf-8")
    subprocess.run(["git", "add", "README.md"], cwd=repo, check=True)
    subprocess.run(["git", "commit", "-m", "base"], cwd=repo, check=True, capture_output=True, text=True)
    base_revision = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=repo, text=True).strip()
    (repo / "README.md").write_text("after\n", encoding="utf-8")
    subprocess.run(["git", "add", "README.md"], cwd=repo, check=True)
    patch = subprocess.check_output(["git", "diff", "--binary", "--cached"], cwd=repo, text=True)
    expected_tree = subprocess.check_output(["git", "write-tree"], cwd=repo, text=True).strip()
    subprocess.run(["git", "commit", "-m", "executor output"], cwd=repo, check=True, capture_output=True, text=True)
    (repo / "README.md").write_text("different result revision\n", encoding="utf-8")
    subprocess.run(["git", "add", "README.md"], cwd=repo, check=True)
    subprocess.run(["git", "commit", "-m", "wrong provenance"], cwd=repo, check=True, capture_output=True, text=True)
    result_revision = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=repo, text=True).strip()
    subprocess.run(["git", "reset", "--hard", base_revision], cwd=repo, check=True, capture_output=True, text=True)
    patch_path = tmp_path / "patch.diff"
    patch_path.write_text(patch, encoding="utf-8")
    gate = _passing_gate()
    request_path = tmp_path / "verify-request.json"
    result_path = tmp_path / "verify-result.json"
    request_path.write_text(
        json.dumps(
            {
                "attempt_id": "verify-result-revision",
                "node_id": "node-1",
                "graph_revision": 4,
                "policy_revision": 2,
                "lease_id": "lease-verify",
                "fencing_token": "token-verify",
                "gate_snapshot_hash": gate.hash,
                "gate_snapshot": gate.to_dict(),
                "verification_input": {
                    "task_id": "node-1",
                    "execute_attempt_id": "exec-1",
                    "base_revision": base_revision,
                    "repository_path": str(repo),
                    "patch_uri": f"file://{patch_path}",
                    "patch_hash": "sha256:" + hashlib.sha256(patch.encode("utf-8")).hexdigest(),
                    "expected_result_tree": expected_tree,
                    "result_revision": result_revision,
                    "artifact_uris": [],
                    "declared_commands": [],
                    "evidence_uri": f"file://{tmp_path}",
                    "gate_snapshot_hash": gate.hash,
                },
            }
        ),
        encoding="utf-8",
    )

    await run_mode_attempt(RuntimeMode.VERIFY, request_path, result_path)

    payload = json.loads(result_path.read_text(encoding="utf-8"))
    assert payload["status"] == "failed"
    assert payload["score"] == 0
    assert payload["passed"] is False
    assert payload["reason"] == "result_revision_tree_mismatch"


class _FakeBackend:
    def __init__(self, structured_results: list[dict[str, object]]):
        self.structured_results = list(structured_results)
        self.calls = 0
        self.workspace_paths: list[Path] = []
        self.kwargs: list[dict[str, object]] = []
        self.prompts: list[str] = []

    async def run_session(self, workspace_path: Path, prompt: str, title: str, **kwargs: object) -> object:
        _ = prompt, title, kwargs
        self.calls += 1
        self.workspace_paths.append(workspace_path)
        self.kwargs.append(dict(kwargs))
        self.prompts.append(prompt)
        structured = self.structured_results.pop(0) if self.structured_results else None
        return SimpleNamespace(structured_result=structured)


class _PatchBackend:
    def __init__(self, content: str):
        self.content = content
        self.calls = 0
        self.workspace_paths: list[Path] = []
        self.prompts: list[str] = []

    async def run_session(self, workspace_path: Path, prompt: str, title: str, **kwargs: object) -> object:
        _ = title, kwargs
        self.calls += 1
        self.workspace_paths.append(workspace_path)
        self.prompts.append(prompt)
        (workspace_path / "BACKEND.txt").write_text(self.content, encoding="utf-8")
        return SimpleNamespace(structured_result={"changed_files": ["BACKEND.txt"]})


class _CacheWritingBackend:
    async def run_session(self, workspace_path: Path, prompt: str, title: str, **kwargs: object) -> object:
        _ = prompt, title, kwargs
        (workspace_path / "BACKEND.txt").write_text("created\n", encoding="utf-8")
        pycache = workspace_path / "tests" / "__pycache__"
        pycache.mkdir(parents=True, exist_ok=True)
        (pycache / "test_smoke.cpython-314-pytest-9.1.1.pyc").write_bytes(b"compiled")
        pytest_cache = workspace_path / ".pytest_cache"
        pytest_cache.mkdir()
        (pytest_cache / "README.md").write_text("cache\n", encoding="utf-8")
        return SimpleNamespace(structured_result={"changed_files": ["BACKEND.txt"]})


class _NoopBackend:
    async def run_session(self, workspace_path: Path, prompt: str, title: str, **kwargs: object) -> object:
        _ = workspace_path, prompt, title, kwargs
        return SimpleNamespace(structured_result={})


class _EventBackend:
    async def run_session(self, workspace_path: Path, prompt: str, title: str, **kwargs: object) -> object:
        _ = prompt, title
        on_event = kwargs.get("on_event")
        if callable(on_event):
            on_event({"event": "sdk_session_starting", "message": "token=secret-token", "thread_id": "thread-1"})
        (workspace_path / "EVENT.txt").write_text("event backend\n", encoding="utf-8")
        return SimpleNamespace(structured_result={})


class _FailingBackend:
    def __init__(self, message: str):
        self.message = message

    async def run_session(self, workspace_path: Path, prompt: str, title: str, **kwargs: object) -> object:
        _ = workspace_path, prompt, title, kwargs
        raise RuntimeError(self.message)


class _FinalResponseBackend:
    def __init__(self, final_response: str):
        self.final_response = final_response

    async def run_session(self, workspace_path: Path, prompt: str, title: str, **kwargs: object) -> object:
        _ = workspace_path, prompt, title, kwargs
        return SimpleNamespace(structured_result=None, final_response=self.final_response)


def _passing_gate() -> GateSpecSnapshot:
    return GateSpecSnapshot.create(
        gate_id="gate-node-1",
        task_id="node-1",
        created_by="plan-1",
        created_at="2026-07-06T00:00:00Z",
        content=GateSpecContent(
            acceptance_criteria=["patch applies"],
            verification_procedure=["test -f README.md"],
            rubric={str(score): f"score {score}" for score in range(5)},
            pass_threshold=3,
        ),
    )


def _contains_open_additional_properties(value: object) -> bool:
    if isinstance(value, dict):
        if value.get("additionalProperties") is True:
            return True
        return any(_contains_open_additional_properties(item) for item in value.values())
    if isinstance(value, list):
        return any(_contains_open_additional_properties(item) for item in value)
    return False


def _verification_input_with_patch(tmp_path: Path, *, gate_hash: str) -> dict[str, object]:
    repo = tmp_path / f"repo-{len(list(tmp_path.glob('repo-*')))}"
    repo.mkdir()
    subprocess.run(["git", "init"], cwd=repo, check=True, capture_output=True, text=True)
    subprocess.run(["git", "config", "user.email", "test@example.com"], cwd=repo, check=True)
    subprocess.run(["git", "config", "user.name", "Test User"], cwd=repo, check=True)
    (repo / "README.md").write_text("before\n", encoding="utf-8")
    subprocess.run(["git", "add", "README.md"], cwd=repo, check=True)
    subprocess.run(["git", "commit", "-m", "base"], cwd=repo, check=True, capture_output=True, text=True)
    base_revision = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=repo, text=True).strip()
    (repo / "README.md").write_text("after\n", encoding="utf-8")
    subprocess.run(["git", "add", "README.md"], cwd=repo, check=True)
    patch = subprocess.check_output(["git", "diff", "--binary", "--cached"], cwd=repo, text=True)
    expected_tree = subprocess.check_output(["git", "write-tree"], cwd=repo, text=True).strip()
    subprocess.run(["git", "reset", "--hard", "HEAD"], cwd=repo, check=True, capture_output=True, text=True)
    patch_path = tmp_path / f"patch-{repo.name}.diff"
    patch_path.write_text(patch, encoding="utf-8")
    return {
        "task_id": "node-1",
        "execute_attempt_id": "exec-1",
        "base_revision": base_revision,
        "repository_path": str(repo),
        "patch_uri": f"file://{patch_path}",
        "patch_hash": "sha256:" + hashlib.sha256(patch.encode("utf-8")).hexdigest(),
        "expected_result_tree": expected_tree,
        "artifact_uris": [],
        "declared_commands": [],
        "evidence_uri": "artifact://evidence",
        "gate_snapshot_hash": gate_hash,
    }
