from __future__ import annotations

import json

import pytest

from conductor.acceptance_evidence import canonical_gate_evidence
from conductor.models import RunState, TaskState
from conductor.store import ConductorStore, StaleAttemptError
from performer_api.performer_control import PerformerControlError
from performer_api.workflow import AcceptanceCatalog, Plan


def _store(tmp_path) -> ConductorStore:
    return ConductorStore(tmp_path)


def _start_gate(store: ConductorStore, run_id: str, task_id: str) -> dict[str, object]:
    execute = store.start_task(run_id, task_id)
    store.record_execute(run_id, execute["attempt_id"], execute["fencing_token"], ready_for_gate=True)
    return store.start_gate(run_id, task_id)


def _execute_and_gate(
    store: ConductorStore,
    run_id: str,
    task_id: str,
    *,
    passed: bool,
    score: int,
    evidence: dict[str, object] | None = None,
) -> dict[str, object]:
    gate = _start_gate(store, run_id, task_id)
    return store.record_gate(
        run_id,
        gate["attempt_id"],
        gate["fencing_token"],
        passed=passed,
        score=score,
        command_passed=0,
        command_total=0,
        evidence=evidence,
    )


def test_parent_plan_creates_ordered_linear_tasks(tmp_path, two_task_plan) -> None:
    store = _store(tmp_path)
    run = store.create_run("parent-1", "APP-1", instance_id="instance-1")

    store.save_plan(run["run_id"], two_task_plan)

    assert store.get_run(run["run_id"])["state"] == RunState.EXECUTING.value
    assert [task["task_id"] for task in store.list_tasks(run["run_id"])] == ["task-1", "task-2"]
    assert all(task["parent_issue_id"] == "parent-1" for task in store.list_tasks(run["run_id"]))


def test_plan_approval_is_durable_before_execution(tmp_path, minimal_plan) -> None:
    store = _store(tmp_path)
    run = store.create_run("parent-1", "APP-1", instance_id="instance-1")

    version = store.save_plan(run["run_id"], minimal_plan, approval_required=True)
    assert store.get_run(run["run_id"])["state"] == RunState.AWAITING_APPROVAL.value

    store.approve_plan(run["run_id"], version, approval_id="linear-comment-1")

    assert store.get_run(run["run_id"])["state"] == RunState.EXECUTING.value


def test_automatic_plan_revision_supersedes_the_previous_active_version(tmp_path, minimal_plan) -> None:
    store = _store(tmp_path)
    run = store.create_run("parent-1", "APP-1", instance_id="instance-1")

    first = store.save_plan(run["run_id"], minimal_plan)
    second = store.save_plan(run["run_id"], Plan(summary="Revised plan", tasks=minimal_plan.tasks))

    with store.connect() as connection:
        revisions = connection.execute(
            "SELECT version, status FROM plan_revisions WHERE run_id = ? ORDER BY version",
            (run["run_id"],),
        ).fetchall()
    assert [(revision["version"], revision["status"]) for revision in revisions] == [
        (first, "superseded"),
        (second, "active"),
    ]


def test_plan_approval_cannot_reactivate_a_superseded_revision(tmp_path, minimal_plan) -> None:
    store = _store(tmp_path)
    run = store.create_run("parent-1", "APP-1", instance_id="instance-1")
    first = store.save_plan(run["run_id"], minimal_plan, policy_revision=1)
    second = store.save_plan(
        run["run_id"],
        Plan(summary="Awaiting approval", tasks=minimal_plan.tasks, approval_required=True),
        policy_revision=2,
    )

    with pytest.raises(ValueError, match="not awaiting approval"):
        store.approve_plan(run["run_id"], first, approval_id="linear-comment-stale")

    awaiting = store.get_run(run["run_id"])
    assert awaiting is not None
    assert awaiting["state"] == RunState.AWAITING_APPROVAL.value
    assert awaiting["plan_version"] == second
    assert awaiting["policy_revision"] == 2

    store.approve_plan(run["run_id"], second, approval_id="linear-comment-current")

    active = store.get_run(run["run_id"])
    assert active is not None
    assert active["state"] == RunState.EXECUTING.value
    assert active["plan_version"] == second
    assert active["policy_revision"] == 2
    with store.connect() as connection:
        revisions = connection.execute(
            "SELECT version, status FROM plan_revisions WHERE run_id = ? ORDER BY version",
            (run["run_id"],),
        ).fetchall()
    assert [(revision["version"], revision["status"]) for revision in revisions] == [
        (first, "superseded"),
        (second, "active"),
    ]


def test_gate_failure_allows_one_rework_then_blocks_task_and_parent(tmp_path, minimal_plan) -> None:
    store = _store(tmp_path)
    run = store.create_run("parent-1", "APP-1", instance_id="instance-1")
    store.save_plan(run["run_id"], minimal_plan)
    task = store.next_task(run["run_id"])

    result = _execute_and_gate(store, run["run_id"], task["task_id"], passed=False, score=2)
    assert result["state"] == TaskState.IN_PROGRESS.value
    assert result["rework_count"] == 1

    blocked = _execute_and_gate(store, run["run_id"], task["task_id"], passed=False, score=2)

    assert blocked["state"] == TaskState.BLOCKED.value
    assert store.get_run(run["run_id"])["state"] == RunState.BLOCKED.value


def test_duplicate_gate_result_is_idempotent(tmp_path, minimal_plan) -> None:
    store = _store(tmp_path)
    run = store.create_run("parent-1", "APP-1", instance_id="instance-1")
    store.save_plan(run["run_id"], minimal_plan)
    task = store.next_task(run["run_id"])
    gate = _start_gate(store, run["run_id"], task["task_id"])

    first = store.record_gate(
        run["run_id"],
        gate["attempt_id"],
        gate["fencing_token"],
        passed=False,
        score=2,
        command_passed=0,
        command_total=0,
    )
    duplicate = store.record_gate(
        run["run_id"],
        gate["attempt_id"],
        gate["fencing_token"],
        passed=False,
        score=2,
        command_passed=0,
        command_total=0,
    )

    assert duplicate == first
    assert duplicate["rework_count"] == 1
    with store.connect() as connection:
        assert connection.execute("SELECT COUNT(*) FROM gate_evidence").fetchone()[0] == 1


def test_duplicate_plan_result_is_idempotent(tmp_path, minimal_plan) -> None:
    store = _store(tmp_path)
    run = store.create_run("parent-1", "APP-1", instance_id="instance-1")
    attempt = store.start_plan(run["run_id"])

    first = store.record_plan(
        run["run_id"],
        attempt["attempt_id"],
        attempt["fencing_token"],
        minimal_plan,
    )
    duplicate = store.record_plan(
        run["run_id"],
        attempt["attempt_id"],
        attempt["fencing_token"],
        minimal_plan,
    )

    assert duplicate == first == 1
    with store.connect() as connection:
        assert connection.execute("SELECT COUNT(*) FROM plan_revisions").fetchone()[0] == 1


def test_stale_attempt_result_cannot_change_the_current_task(tmp_path, minimal_plan) -> None:
    store = _store(tmp_path)
    run = store.create_run("parent-1", "APP-1", instance_id="instance-1")
    store.save_plan(run["run_id"], minimal_plan)
    task = store.next_task(run["run_id"])
    stale = store.start_task(run["run_id"], task["task_id"])
    store.record_runtime_wait(
        run["run_id"],
        stale["attempt_id"],
        stale["fencing_token"],
        kind="approval_requested",
        reason="Approve the tool call",
    )
    assert store.resume_runtime_wait(run["run_id"]) is True
    current = store.start_task(run["run_id"], task["task_id"])

    with pytest.raises(StaleAttemptError, match="stale_attempt_state"):
        store.record_execute(
            run["run_id"],
            stale["attempt_id"],
            stale["fencing_token"],
            ready_for_gate=True,
        )

    persisted = store.get_task(run["run_id"], task["task_id"])
    assert persisted["state"] == TaskState.IN_PROGRESS.value
    assert current["attempt_id"] != stale["attempt_id"]


def test_gate_score_below_threshold_fails_even_when_codex_claims_passed(tmp_path, minimal_plan) -> None:
    store = _store(tmp_path)
    run = store.create_run("parent-1", "APP-1", instance_id="instance-1")
    store.save_plan(run["run_id"], minimal_plan)
    task = store.next_task(run["run_id"])
    result = _execute_and_gate(store, run["run_id"], task["task_id"], passed=True, score=2)

    assert result["state"] == TaskState.IN_PROGRESS.value


def test_gate_rejects_out_of_range_score_before_advancing_state(tmp_path, minimal_plan) -> None:
    store = _store(tmp_path)
    run = store.create_run("parent-1", "APP-1", instance_id="instance-1")
    store.save_plan(run["run_id"], minimal_plan)
    task = store.next_task(run["run_id"])
    gate = _start_gate(store, run["run_id"], task["task_id"])

    with pytest.raises(ValueError, match="invalid_gate_number"):
        store.record_gate(
            run["run_id"],
            gate["attempt_id"],
            gate["fencing_token"],
            passed=True,
            score=1_000_001,
            command_passed=0,
            command_total=0,
        )

    assert store.get_task(run["run_id"], task["task_id"])["state"] == TaskState.IN_REVIEW.value
    assert store.get_gate_evidence_summary(run["run_id"], task["task_id"]) is None
    with store.connect() as connection:
        attempt = connection.execute("SELECT state FROM attempts WHERE attempt_id = ?", (gate["attempt_id"],)).fetchone()
    assert attempt is not None
    assert attempt["state"] == "running"


def test_gate_evidence_is_sanitized_and_bound_to_its_plan_revision(tmp_path, minimal_plan) -> None:
    store = _store(tmp_path)
    run = store.create_run("parent-1", "APP-1", instance_id="instance-1")
    plan = Plan(
        summary=minimal_plan.summary,
        tasks=minimal_plan.tasks,
        acceptance_catalog=AcceptanceCatalog(
            id="catalog-1",
            rubric={"correctness": {"weight": 2, "threshold": 3, "token": "catalog-secret"}},
        ),
    )
    store.save_plan(run["run_id"], plan, manifest_refs=["manifest://run-1/plan-1"])
    task = store.next_task(run["run_id"])
    gate = _start_gate(store, run["run_id"], task["task_id"])
    raw_evidence = {
        "commands": [
            {
                "command": "OPENAI_API_KEY=command-secret pytest -q",
                "passed": True,
                "exit_code": 0,
                "output": "Authorization: Bearer output-secret",
            }
        ],
        "codex_gate": {
            "passed": True,
            "score": 4,
            "threshold": 3,
            "rubric": {"correctness": {"score": 4, "weight": 2, "finding": "rubric-secret"}},
            "provenance": [{"source": "codex", "token": "provenance-secret"}],
            "findings": ["token=finding-secret"],
        },
        "artifact_refs": ["artifact://run-1/task-1", "file:///tmp/artifact-secret"],
    }

    store.record_gate(
        run["run_id"],
        gate["attempt_id"],
        gate["fencing_token"],
        passed=True,
        score=4,
        command_passed=1,
        command_total=1,
        evidence=raw_evidence,
    )

    with store.connect() as connection:
        evidence_row = connection.execute("SELECT evidence_json FROM gate_evidence").fetchone()
        artifact_row = connection.execute("SELECT artifact_ref, metadata_json FROM artifacts").fetchone()
    assert evidence_row is not None
    assert artifact_row is not None
    evidence = json.loads(evidence_row["evidence_json"])
    artifact_metadata = json.loads(artifact_row["metadata_json"])
    serialized = json.dumps({"evidence": evidence, "metadata": artifact_metadata})

    assert evidence == {
        "passed": True,
        "score": 4,
        "threshold": 3,
        "plan_version": 1,
        "catalog": {"id": "catalog-1", "rubric": [{"id": "correctness", "weight": 2, "threshold": 3}]},
        "manifest_refs": ["manifest://run-1/plan-1"],
        "command_counts": {"passed": 1, "total": 1},
        "commands": [
            {
                "command": "OPENAI_API_KEY=[REDACTED] pytest -q",
                "passed": True,
                "exit_code": 0,
                "output": "Authorization: [REDACTED]",
            }
        ],
        "rubric": [{"id": "correctness", "score": 4, "weight": 2}],
        "provenance": [{"source": "codex", "attempt_id": gate["attempt_id"]}],
        "findings": ["token=[REDACTED]"],
        "artifact_refs": ["artifact://run-1/task-1"],
        "failure_code": "",
    }
    assert artifact_row["artifact_ref"] == "artifact://run-1/task-1"
    assert artifact_metadata == {
        "plan_version": 1,
        "catalog_id": "catalog-1",
        "passed": True,
        "score": 4,
        "threshold": 3,
    }
    for secret in (
        "command-secret",
        "output-secret",
        "rubric-secret",
        "provenance-secret",
        "finding-secret",
        "artifact-secret",
        "catalog-secret",
    ):
        assert secret not in serialized

    view = store.managed_run_view()["runs"][0]
    assert "acceptance" not in view
    assert view["tasks"][0]["gate"] == {
        "passed": True,
        "score": 4,
        "threshold": 3,
        "plan_version": 1,
        "catalog": {"id": "catalog-1", "rubric": [{"id": "correctness", "weight": 2, "threshold": 3}]},
        "manifest_count": 1,
        "commands": {"passed": 1, "total": 1},
        "rubric": [{"id": "correctness", "score": 4, "weight": 2}],
        "provenance": [{"source": "codex", "attempt_id": gate["attempt_id"]}],
        "artifact_count": 1,
        "failure_code": "",
    }


def test_gate_evidence_uses_the_real_codex_attempt_and_bounds_untrusted_rows(tmp_path, minimal_plan) -> None:
    store = _store(tmp_path)
    run = store.create_run("parent-1", "APP-1", instance_id="instance-1")
    store.save_plan(run["run_id"], minimal_plan)
    task = store.next_task(run["run_id"])
    gate = _start_gate(store, run["run_id"], task["task_id"])

    store.record_gate(
        run["run_id"],
        gate["attempt_id"],
        gate["fencing_token"],
        passed=True,
        score=4,
        command_passed=12,
        command_total=12,
        evidence={
            "commands": [
                {"command": f"command-{index}", "passed": True, "output": "x" * 10_000}
                for index in range(12)
            ],
            "rubric": {f"criterion-{index}": {"score": 4, "weight": 1} for index in range(12)},
            "codex_gate": {
                "provenance": [{"source": "sk-live-forged", "attempt_id": "attempt-forged"}],
                "findings": [f"finding-{index}" for index in range(12)],
            },
        },
    )

    with store.connect() as connection:
        row = connection.execute("SELECT evidence_json FROM gate_evidence").fetchone()
    assert row is not None
    evidence = json.loads(row["evidence_json"])

    assert evidence["provenance"] == [{"source": "codex", "attempt_id": gate["attempt_id"]}]
    assert "sk-live-forged" not in json.dumps(evidence)
    assert "attempt-forged" not in json.dumps(evidence)
    assert len(evidence["commands"]) == 10
    assert all(len(command["output"]) <= 2_000 for command in evidence["commands"])
    assert len(evidence["rubric"]) == 8
    assert len(evidence["findings"]) == 8


def test_gate_evidence_does_not_copy_unknown_rubric_fields() -> None:
    class NoCopyRubricRow(dict[str, object]):
        def __iter__(self):
            raise AssertionError("unknown rubric fields must not be copied")

        def items(self):
            raise AssertionError("unknown rubric fields must not be copied")

        def keys(self):
            raise AssertionError("unknown rubric fields must not be copied")

    evidence = canonical_gate_evidence(
        {"rubric": {"correctness": NoCopyRubricRow(score=4, weight=2, nested={"secret": "ignored"})}},
        passed=True,
        score=4,
        threshold=3,
        attempt_id="attempt-1",
        plan_version=1,
        catalog=None,
        manifest_refs=[],
        command_passed=0,
        command_total=0,
    )

    assert evidence["rubric"] == [{"id": "correctness", "score": 4, "weight": 2}]


def test_gate_evidence_redacts_bare_known_token_shapes() -> None:
    openai_like = "sk-ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"
    github_like = "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"
    evidence = canonical_gate_evidence(
        {
            "commands": [{"command": "verify", "passed": False, "output": f"diagnostic {openai_like}"}],
            "codex_gate": {"findings": [f"copied {github_like}"]},
        },
        passed=False,
        score=2,
        threshold=3,
        attempt_id="attempt-1",
        plan_version=1,
        catalog=None,
        manifest_refs=[],
        command_passed=0,
        command_total=1,
    )

    serialized = json.dumps(evidence)
    assert openai_like not in serialized
    assert github_like not in serialized
    assert serialized.count("[REDACTED]") == 2


def test_gate_evidence_rejects_token_shaped_catalog_and_rubric_identifiers() -> None:
    token_shaped_id = "sk-ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"
    catalog = {"id": token_shaped_id, "rubric": {token_shaped_id: {"weight": 2, "threshold": 3}}}
    evidence = canonical_gate_evidence(
        {
            "rubric": {token_shaped_id: {"score": 4, "weight": 2}},
            "artifact_refs": [f"artifact://run/{token_shaped_id}"],
        },
        passed=True,
        score=4,
        threshold=3,
        attempt_id="attempt-1",
        plan_version=1,
        catalog=catalog,
        manifest_refs=[f"manifest://run/{token_shaped_id}"],
        command_passed=0,
        command_total=0,
    )

    assert "catalog" not in evidence
    assert evidence["rubric"] == []
    assert evidence["artifact_refs"] == []
    assert evidence["manifest_refs"] == []


def test_stale_plan_revision_gate_result_cannot_advance_task(tmp_path, minimal_plan) -> None:
    store = _store(tmp_path)
    run = store.create_run("parent-1", "APP-1", instance_id="instance-1")
    first_plan = Plan(
        summary=minimal_plan.summary,
        tasks=minimal_plan.tasks,
        acceptance_catalog=AcceptanceCatalog(id="catalog-1"),
    )
    store.save_plan(run["run_id"], first_plan, manifest_refs=["manifest://run-1/plan-1"])
    task = store.next_task(run["run_id"])
    gate = _start_gate(store, run["run_id"], task["task_id"])

    second_plan = Plan(
        summary="Revised plan",
        tasks=minimal_plan.tasks,
        acceptance_catalog=AcceptanceCatalog(id="catalog-2"),
    )
    store.save_plan(run["run_id"], second_plan, manifest_refs=["manifest://run-1/plan-2"])
    with pytest.raises(StaleAttemptError, match="stale_plan_version"):
        store.record_gate(
            run["run_id"],
            gate["attempt_id"],
            gate["fencing_token"],
            passed=True,
            score=4,
            command_passed=0,
            command_total=0,
        )

    assert store.get_gate_evidence_summary(run["run_id"], task["task_id"]) is None
    assert store.get_task(run["run_id"], task["task_id"])["state"] == TaskState.TODO.value
    with store.connect() as connection:
        attempt = connection.execute("SELECT state FROM attempts WHERE attempt_id = ?", (gate["attempt_id"],)).fetchone()
    assert attempt is not None
    assert attempt["state"] == "stale"


def test_gate_rejects_a_missing_captured_plan_version(tmp_path, minimal_plan) -> None:
    store = _store(tmp_path)
    run = store.create_run("parent-1", "APP-1", instance_id="instance-1")
    store.save_plan(run["run_id"], minimal_plan)
    task = store.next_task(run["run_id"])
    gate = _start_gate(store, run["run_id"], task["task_id"])
    with store.connect() as connection:
        connection.execute("UPDATE attempts SET result_json = '{}' WHERE attempt_id = ?", (gate["attempt_id"],))

    with pytest.raises(StaleAttemptError, match="missing_gate_plan_version"):
        store.record_gate(
            run["run_id"],
            gate["attempt_id"],
            gate["fencing_token"],
            passed=True,
            score=4,
            command_passed=0,
            command_total=0,
        )

    assert store.get_gate_evidence_summary(run["run_id"], task["task_id"]) is None


def test_gate_summary_counts_all_commands_when_details_are_bounded(tmp_path, minimal_plan) -> None:
    store = _store(tmp_path)
    run = store.create_run("parent-1", "APP-1", instance_id="instance-1")
    store.save_plan(run["run_id"], minimal_plan)
    task = store.next_task(run["run_id"])
    gate = _start_gate(store, run["run_id"], task["task_id"])
    commands = [{"command": f"command-{index}", "passed": index < 10, "output": ""} for index in range(11)]

    store.record_gate(
        run["run_id"],
        gate["attempt_id"],
        gate["fencing_token"],
        passed=False,
        score=4,
        command_passed=10,
        command_total=11,
        evidence={"commands": commands},
    )

    summary = store.get_gate_evidence_summary(run["run_id"], task["task_id"])
    assert summary is not None
    assert summary["commands"] == {"passed": 10, "total": 11}
    assert summary["failure_code"] == "verification_command_failed"
    with store.connect() as connection:
        evidence_row = connection.execute("SELECT evidence_json FROM gate_evidence").fetchone()
    assert evidence_row is not None
    assert len(json.loads(evidence_row["evidence_json"])["commands"]) == 10


def test_gate_summary_uses_the_latest_attempt_when_timestamps_tie(tmp_path, minimal_plan) -> None:
    store = _store(tmp_path)
    run = store.create_run("parent-1", "APP-1", instance_id="instance-1")
    store.save_plan(run["run_id"], minimal_plan)
    task = store.next_task(run["run_id"])
    _execute_and_gate(store, run["run_id"], task["task_id"], passed=False, score=2)
    _execute_and_gate(store, run["run_id"], task["task_id"], passed=True, score=4)

    with store.connect() as connection:
        rows = connection.execute("SELECT rowid, passed FROM gate_evidence ORDER BY rowid").fetchall()
        for row in rows:
            connection.execute(
                "UPDATE gate_evidence SET created_at = ?, attempt_id = ? WHERE rowid = ?",
                ("2026-07-12T00:00:00Z", "attempt-a" if row["passed"] else "attempt-z", row["rowid"]),
            )

    summary = store.get_gate_evidence_summary(run["run_id"], task["task_id"])
    assert summary is not None
    assert summary["passed"] is True
    assert summary["score"] == 4


def test_gate_summary_omits_evidence_from_a_superseded_plan_revision(tmp_path, minimal_plan) -> None:
    store = _store(tmp_path)
    run = store.create_run("parent-1", "APP-1", instance_id="instance-1")
    store.save_plan(run["run_id"], minimal_plan)
    task = store.next_task(run["run_id"])
    _execute_and_gate(store, run["run_id"], task["task_id"], passed=False, score=2)

    store.save_plan(run["run_id"], Plan(summary="Revised plan", tasks=minimal_plan.tasks))

    assert store.get_gate_evidence_summary(run["run_id"], task["task_id"]) is None
    assert "gate" not in store.managed_run_view()["runs"][0]["tasks"][0]


def test_all_tasks_done_marks_parent_done(tmp_path, two_task_plan) -> None:
    store = _store(tmp_path)
    run = store.create_run("parent-1", "APP-1", instance_id="instance-1")
    store.save_plan(run["run_id"], two_task_plan)

    for task in store.list_tasks(run["run_id"]):
        _execute_and_gate(store, run["run_id"], task["task_id"], passed=True, score=4)

    assert store.get_run(run["run_id"])["state"] == RunState.DONE.value


def test_stale_attempt_cannot_change_task_state(tmp_path, minimal_plan) -> None:
    store = _store(tmp_path)
    run = store.create_run("parent-1", "APP-1", instance_id="instance-1")
    store.save_plan(run["run_id"], minimal_plan)
    task = store.next_task(run["run_id"])
    attempt = store.start_task(run["run_id"], task["task_id"])

    with pytest.raises(StaleAttemptError):
        store.record_execute(run["run_id"], attempt["attempt_id"], attempt["fencing_token"] - 1, ready_for_gate=True)

    assert store.get_task(run["run_id"], task["task_id"])["state"] == TaskState.IN_PROGRESS.value


def test_runtime_wait_is_durable_and_can_resume_once_reopened(tmp_path) -> None:
    store = _store(tmp_path)
    run = store.create_run("parent-1", "APP-1", instance_id="instance-1")
    attempt = store.start_plan(run["run_id"])

    store.record_runtime_wait(
        run["run_id"],
        attempt["attempt_id"],
        attempt["fencing_token"],
        kind="approval_requested",
        reason="Authorization: Bearer wait-secret",
    )

    assert store.get_run(run["run_id"])["state"] == RunState.BLOCKED.value
    wait = store.list_runtime_waits(run["run_id"])[0]
    assert wait["reason"] == "Authorization: [REDACTED]"
    assert "wait-secret" not in str(wait)
    assert store.resume_runtime_wait(run["run_id"]) is True
    assert store.get_run(run["run_id"])["state"] == RunState.PLANNING.value
    assert store.list_runtime_waits(run["run_id"])[0]["state"] == "resolved"


def test_failure_reason_is_sanitized_before_persistence(tmp_path) -> None:
    store = _store(tmp_path)
    run = store.create_run("parent-1", "APP-1", instance_id="instance-1")

    store.fail_run(run["run_id"], "Codex failed: token=fail-secret")

    persisted = store.get_run(run["run_id"])
    assert persisted["latest_reason"] == "Codex failed: token=[REDACTED]"
    assert "fail-secret" not in str(persisted)


def test_performer_readiness_block_preserves_planning_phase_and_resumes_without_an_attempt(tmp_path) -> None:
    store = _store(tmp_path)
    run = store.create_run("parent-1", "APP-1", instance_id="instance-1")

    blocked = store.block_run_for_performer(
        run["run_id"],
        performer_kind="codex",
        binding_generation=7,
        execution_policy_sha256="a" * 64,
        error=PerformerControlError(
            error_code="performer_check_required",
            sanitized_reason="Run the manual Performer Check.",
            action_required=True,
            retryable=True,
            attempt_number=None,
            next_action="Run Check and retry the managed run.",
        ),
    )

    assert blocked["state"] == RunState.BLOCKED.value
    assert blocked["latest_reason"] == "performer_check_required"
    assert blocked["payload"]["performer_readiness_block"] == {
        "version": 1,
        "performer_kind": "codex",
        "binding_generation": 7,
        "execution_policy_sha256": "a" * 64,
        "error_code": "performer_check_required",
        "sanitized_reason": "Run the manual Performer Check.",
        "action_required": True,
        "retryable": True,
        "attempt_number": None,
        "next_action": "Run Check and retry the managed run.",
        "prior_phase": "planning",
        "linear_projection": {
            "status": "pending",
            "attempt_number": 0,
            "last_error_code": None,
            "last_sanitized_reason": None,
            "next_action": "project_linear_readiness_block",
        },
    }
    with store.connect() as connection:
        assert connection.execute("SELECT COUNT(*) FROM attempts WHERE run_id = ?", (run["run_id"],)).fetchone()[0] == 0
    assert store.managed_run_view()["runs"][0]["payload"]["performer_readiness_block"]["error_code"] == "performer_check_required"

    stale = store.resume_run_from_performer_block(
        run["run_id"],
        performer_kind="codex",
        binding_generation=8,
        execution_policy_sha256="a" * 64,
    )
    assert stale["state"] == RunState.BLOCKED.value

    pending = store.resume_run_from_performer_block(
        run["run_id"],
        performer_kind="codex",
        binding_generation=7,
        execution_policy_sha256="a" * 64,
    )
    assert pending["state"] == RunState.BLOCKED.value

    store.record_performer_readiness_projection(
        run["run_id"],
        status="complete",
        next_action="wait_for_compatible_performer_check",
    )

    resumed = store.resume_run_from_performer_block(
        run["run_id"],
        performer_kind="codex",
        binding_generation=7,
        execution_policy_sha256="a" * 64,
    )

    assert resumed["state"] == RunState.PLANNING.value
    assert "performer_readiness_block" not in resumed["payload"]


def test_performer_readiness_block_preserves_task_result_and_restores_in_review(tmp_path, minimal_plan) -> None:
    store = _store(tmp_path)
    run = store.create_run("parent-1", "APP-1", instance_id="instance-1")
    store.save_plan(run["run_id"], minimal_plan)
    task = store.next_task(run["run_id"])
    attempt = store.start_task(run["run_id"], task["task_id"])
    store.record_execute(
        run["run_id"],
        attempt["attempt_id"],
        attempt["fencing_token"],
        ready_for_gate=True,
        result={"status": "ready_for_gate", "summary": "implementation retained"},
    )

    store.block_run_for_performer(
        run["run_id"],
        task_id=task["task_id"],
        performer_kind="codex",
        binding_generation=7,
        execution_policy_sha256="a" * 64,
        error=PerformerControlError(
            error_code="performer_check_failed",
            sanitized_reason="Provider validation failed.",
            action_required=True,
            retryable=True,
            attempt_number=1,
            next_action="Repair the backend configuration and run Check again.",
        ),
    )

    blocked_task = store.get_task(run["run_id"], task["task_id"])
    assert blocked_task["state"] == TaskState.BLOCKED.value
    assert blocked_task["result"]["summary"] == "implementation retained"
    assert blocked_task["result"]["performer_readiness_block"]["prior_state"] == TaskState.IN_REVIEW.value
    assert blocked_task["result"]["performer_readiness_block"]["error_code"] == "performer_check_failed"
    assert "linear_projection" not in blocked_task["result"]["performer_readiness_block"]

    store.record_performer_readiness_projection(
        run["run_id"],
        status="complete",
        next_action="wait_for_compatible_performer_check",
    )
    store.resume_run_from_performer_block(
        run["run_id"],
        performer_kind="codex",
        binding_generation=7,
        execution_policy_sha256="a" * 64,
    )

    resumed_task = store.get_task(run["run_id"], task["task_id"])
    assert resumed_task["state"] == TaskState.IN_REVIEW.value
    assert resumed_task["result"] == {
        "status": "ready_for_gate",
        "summary": "implementation retained",
    }


def test_performer_readiness_block_before_task_attempt_restores_todo_task(
    tmp_path,
    minimal_plan,
) -> None:
    store = _store(tmp_path)
    run = store.create_run("parent-1", "APP-1", instance_id="instance-1")
    store.save_plan(run["run_id"], minimal_plan)
    task = store.next_task(run["run_id"])

    store.block_run_for_performer(
        run["run_id"],
        task_id=task["task_id"],
        performer_kind="codex",
        binding_generation=7,
        execution_policy_sha256="a" * 64,
        error=PerformerControlError(
            error_code="performer_check_required",
            sanitized_reason="Run the manual Performer Check.",
            action_required=True,
            retryable=True,
            attempt_number=None,
            next_action="Run Check and retry the managed run.",
        ),
    )

    blocked_run = store.get_run(run["run_id"])
    assert blocked_run["active_task_id"] == task["task_id"]
    blocked_task = store.get_task(run["run_id"], task["task_id"])
    assert blocked_task["state"] == TaskState.BLOCKED.value
    assert "linear_projection" not in blocked_task["result"]["performer_readiness_block"]
    with store.connect() as connection:
        assert connection.execute(
            "SELECT COUNT(*) FROM attempts WHERE run_id = ? AND task_id = ?",
            (run["run_id"], task["task_id"]),
        ).fetchone()[0] == 0

    store.record_performer_readiness_projection(
        run["run_id"],
        status="complete",
        next_action="wait_for_compatible_performer_check",
    )
    store.resume_run_from_performer_block(
        run["run_id"],
        performer_kind="codex",
        binding_generation=7,
        execution_policy_sha256="a" * 64,
    )

    resumed_run = store.get_run(run["run_id"])
    resumed_task = store.get_task(run["run_id"], task["task_id"])
    assert resumed_run["state"] == RunState.EXECUTING.value
    assert resumed_task["state"] == TaskState.TODO.value
