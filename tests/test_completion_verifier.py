from __future__ import annotations

import subprocess
import sys
from pathlib import Path

import pytest

from performer.completion_verifier import CompletionVerifier
from performer_api.config import CompletionVerificationConfig
from performer_api.models import Issue
from performer_api.ops_models import OpsSnapshot, RunRecord, TraceEvent


class FakeTracker:
    async def fetch_issue_states_by_ids(self, issue_ids: list[str]) -> list[Issue]:
        return [Issue(id=issue_ids[0], identifier="MT-1", title="Task", state="In Progress")]


def issue() -> Issue:
    return Issue(id="mt-1", identifier="MT-1", title="Task", state="In Progress")


@pytest.mark.asyncio
async def test_verify_completion_rejects_non_repo_workspace_when_required() -> None:
    workspace = Path("/tmp/performer-non-repo-workspace")
    workspace.mkdir(parents=True, exist_ok=True)
    verifier = CompletionVerifier(
        CompletionVerificationConfig(
            required_checks=["repo_path"],
            optional_checks=[],
        ),
        FakeTracker(),
    )

    verdict = await verifier.verify_completion(issue(), workspace, OpsSnapshot())

    assert verdict.status == "NEEDS_RETRY"
    assert any(check.check_name == "repo_path" and not check.passed for check in verdict.checks)


@pytest.mark.asyncio
async def test_verify_completion_rejects_workspace_outside_expected_repo_root(tmp_path: Path) -> None:
    repo_root = tmp_path / "repo"
    repo_root.mkdir()
    (repo_root / ".git").mkdir()
    workspace = tmp_path / "elsewhere"
    workspace.mkdir()
    (workspace / ".git").mkdir()
    verifier = CompletionVerifier(
        CompletionVerificationConfig(
            required_checks=["repo_path"],
            optional_checks=[],
            expected_repo_root=str(repo_root),
        ),
        FakeTracker(),
    )

    verdict = await verifier.verify_completion(issue(), workspace, OpsSnapshot())

    assert verdict.status == "NEEDS_RETRY"
    assert any("outside expected repo root" in check.message for check in verdict.checks)


@pytest.mark.asyncio
async def test_verify_completion_rejects_pytest_without_expected_focused_pattern(tmp_path: Path) -> None:
    workspace = tmp_path / "repo"
    workspace.mkdir()
    (workspace / ".git").mkdir()
    (workspace / "pyproject.toml").write_text("[project]\nname='demo'\nversion='0.1.0'\n", encoding="utf-8")
    verifier = CompletionVerifier(
        CompletionVerificationConfig(
            required_checks=["test_results"],
            optional_checks=[],
            expected_test_patterns=["tests/test_target.py::test_fix"],
        ),
        FakeTracker(),
    )

    verdict = await verifier.verify_completion(issue(), workspace, OpsSnapshot())

    assert verdict.status == "NEEDS_RETRY"
    assert any(
        check.check_name == "test_results" and check.evidence.get("framework") == "pytest"
        for check in verdict.checks
    )


@pytest.mark.asyncio
async def test_verify_completion_reuses_recorded_successful_pytest_command_for_src_layout_project(
    tmp_path: Path,
) -> None:
    workspace = tmp_path / "repo"
    workspace.mkdir()
    subprocess.run(["git", "init", "-q"], cwd=workspace, check=True)
    (workspace / "pyproject.toml").write_text("[project]\nname='demo'\nversion='0.1.0'\n", encoding="utf-8")
    package = workspace / "src" / "demo_pkg"
    package.mkdir(parents=True)
    (package / "__init__.py").write_text("VALUE = 7\n", encoding="utf-8")
    tests_dir = workspace / "tests"
    tests_dir.mkdir()
    (tests_dir / "test_demo.py").write_text(
        "from demo_pkg import VALUE\n\n\ndef test_value():\n    assert VALUE == 7\n",
        encoding="utf-8",
    )
    verifier = CompletionVerifier(
        CompletionVerificationConfig(
            required_checks=["test_results"],
            optional_checks=[],
            expected_test_patterns=["tests/test_demo.py"],
        ),
        FakeTracker(),
    )
    snapshot = OpsSnapshot(
        events=[
            TraceEvent(
                event_id="evt-1",
                event_type="notification",
                timestamp="2026-07-01T00:00:00Z",
                issue_id="mt-1",
                payload={
                    "command": "PYTHONPATH=src python -m pytest tests/test_demo.py -q",
                    "exit_code": 0,
                },
            )
        ]
    )

    verdict = await verifier.verify_completion(issue(), workspace, snapshot)

    assert verdict.status == "VERIFIED"
    test_check = next(check for check in verdict.checks if check.check_name == "test_results")
    assert test_check.passed is True
    assert test_check.evidence["command"] == [
        sys.executable,
        "-m",
        "pytest",
        "tests/test_demo.py",
        "-q",
    ]
    assert test_check.evidence["env"]["PYTHONPATH"] == "src"


@pytest.mark.asyncio
async def test_verify_completion_rejects_recorded_pytest_command_with_unsafe_options(tmp_path: Path) -> None:
    workspace = tmp_path / "repo"
    workspace.mkdir()
    subprocess.run(["git", "init", "-q"], cwd=workspace, check=True)
    (workspace / "pyproject.toml").write_text("[project]\nname='demo'\nversion='0.1.0'\n", encoding="utf-8")
    tests_dir = workspace / "tests"
    tests_dir.mkdir()
    (tests_dir / "test_demo.py").write_text("def test_value():\n    assert True\n", encoding="utf-8")
    verifier = CompletionVerifier(
        CompletionVerificationConfig(
            required_checks=["test_results"],
            optional_checks=[],
            expected_test_patterns=["tests/test_demo.py"],
        ),
        FakeTracker(),
    )
    snapshot = OpsSnapshot(
        events=[
            TraceEvent(
                event_id="evt-1",
                event_type="tool_call_completed",
                timestamp="2026-07-01T00:00:00Z",
                issue_id="mt-1",
                payload={
                    "command": "python -m pytest -p malicious_plugin tests/test_demo.py -q",
                    "exit_code": 0,
                },
            )
        ]
    )

    verdict = await verifier.verify_completion(issue(), workspace, snapshot)

    check = next(check for check in verdict.checks if check.check_name == "test_results")
    assert verdict.status == "NEEDS_RETRY"
    assert check.passed is False
    assert "unsafe" in check.message.lower() or "missing" in check.message.lower()


@pytest.mark.asyncio
async def test_verify_completion_accepts_matching_test_command_evidence(tmp_path: Path) -> None:
    workspace = tmp_path / "repo"
    workspace.mkdir()
    (workspace / ".git").mkdir()
    verifier = CompletionVerifier(
        CompletionVerificationConfig(
            required_checks=["test_command_evidence"],
            optional_checks=[],
            expected_test_patterns=["tests/test_target.py::test_fix"],
        ),
        FakeTracker(),
    )
    snapshot = OpsSnapshot(
        events=[
            TraceEvent(
                event_id="evt-1",
                event_type="notification",
                timestamp="2026-06-30T00:00:00Z",
                issue_id="mt-1",
                payload={"command": "pytest tests/test_target.py::test_fix -q", "exit_code": 0},
            )
        ]
    )
    issue_payload = issue()

    verdict = await verifier.verify_completion(
        issue_payload,
        workspace,
        snapshot,
    )

    assert verdict.status == "VERIFIED"
    assert any(check.check_name == "test_command_evidence" and check.passed for check in verdict.checks)


@pytest.mark.asyncio
async def test_verify_completion_accepts_nested_codex_command_evidence(tmp_path: Path) -> None:
    workspace = tmp_path / "repo"
    workspace.mkdir()
    (workspace / ".git").mkdir()
    verifier = CompletionVerifier(
        CompletionVerificationConfig(
            required_checks=["test_command_evidence"],
            optional_checks=[],
            expected_test_patterns=["test -f PERFORMER_REAL_SMALL_TASK.md"],
        ),
        FakeTracker(),
    )
    snapshot = OpsSnapshot(
        events=[
            TraceEvent(
                event_id="evt-1",
                event_type="notification",
                timestamp="2026-06-30T00:00:00Z",
                issue_id="mt-1",
                payload={
                    "payload": {
                        "command": "test -f PERFORMER_REAL_SMALL_TASK.md",
                        "exit_code": 0,
                    }
                },
            )
        ]
    )

    verdict = await verifier.verify_completion(issue(), workspace, snapshot)

    assert verdict.status == "VERIFIED"
    assert any(check.check_name == "test_command_evidence" and check.passed for check in verdict.checks)


@pytest.mark.asyncio
async def test_verify_completion_accepts_command_evidence_associated_by_run_id(tmp_path: Path) -> None:
    workspace = tmp_path / "repo"
    workspace.mkdir()
    (workspace / ".git").mkdir()
    verifier = CompletionVerifier(
        CompletionVerificationConfig(
            required_checks=["test_command_evidence"],
            optional_checks=[],
            expected_test_patterns=["test -f PERFORMER_REAL_SMALL_TASK.md"],
        ),
        FakeTracker(),
    )
    snapshot = OpsSnapshot(
        runs={
            "run-mt-1": RunRecord(
                run_id="run-mt-1",
                issue_id="mt-1",
                instance_id="inst-1",
                status="completed",
            )
        },
        events=[
            TraceEvent(
                event_id="evt-1",
                event_type="notification",
                timestamp="2026-06-30T00:00:00Z",
                issue_id=None,
                run_id="run-mt-1",
                payload={
                    "payload": {
                        "command": "test -f PERFORMER_REAL_SMALL_TASK.md",
                        "exit_code": 0,
                    }
                },
            )
        ],
    )

    verdict = await verifier.verify_completion(issue(), workspace, snapshot)

    assert verdict.status == "VERIFIED"
    assert any(check.check_name == "test_command_evidence" and check.passed for check in verdict.checks)


@pytest.mark.asyncio
async def test_verify_completion_counts_tool_call_events_when_run_counter_is_zero(tmp_path: Path) -> None:
    workspace = tmp_path / "repo"
    workspace.mkdir()
    (workspace / ".git").mkdir()
    verifier = CompletionVerifier(
        CompletionVerificationConfig(
            required_checks=["metrics_reasonable"],
            optional_checks=[],
            min_duration_seconds=0,
        ),
        FakeTracker(),
    )
    snapshot = OpsSnapshot(
        runs={
            "run-mt-1": RunRecord(
                run_id="run-mt-1",
                issue_id="mt-1",
                instance_id="inst-1",
                status="completed",
                started_at="2026-07-01T00:00:00Z",
                completed_at="2026-07-01T00:00:02Z",
                turn_count=1,
                tool_call_count=0,
            )
        },
        events=[
            TraceEvent(
                event_id="evt-1",
                event_type="tool_call_completed",
                timestamp="2026-07-01T00:00:01Z",
                issue_id=None,
                run_id="run-mt-1",
            )
        ],
    )

    verdict = await verifier.verify_completion(issue(), workspace, snapshot)

    assert verdict.status == "VERIFIED"
    assert any(check.check_name == "metrics_reasonable" and check.passed for check in verdict.checks)


@pytest.mark.asyncio
async def test_verify_completion_uses_latest_non_acceptance_run_for_issue_metrics(tmp_path: Path) -> None:
    workspace = tmp_path / "repo"
    workspace.mkdir()
    (workspace / ".git").mkdir()
    verifier = CompletionVerifier(
        CompletionVerificationConfig(
            required_checks=["metrics_reasonable"],
            optional_checks=[],
            min_duration_seconds=0,
        ),
        FakeTracker(),
    )
    snapshot = OpsSnapshot(
        runs={
            "run-a": RunRecord(
                run_id="run-a",
                issue_id="mt-1",
                instance_id="inst-1",
                status="completed",
                started_at="2026-07-01T00:00:00Z",
                turn_count=2,
                tool_call_count=1,
            ),
            "run-b": RunRecord(
                run_id="run-b",
                issue_id="other-issue",
                instance_id="inst-1",
                status="completed",
                started_at="2026-07-01T00:00:10Z",
                turn_count=0,
                tool_call_count=0,
            ),
            "mt-1:acceptance": RunRecord(
                run_id="mt-1:acceptance",
                issue_id="mt-1",
                instance_id="inst-1",
                status="completed",
                started_at="2026-07-01T00:00:20Z",
                turn_count=0,
                tool_call_count=0,
            ),
        }
    )

    verdict = await verifier.verify_completion(issue(), workspace, snapshot)

    assert verdict.status == "VERIFIED"
    metrics = next(check for check in verdict.checks if check.check_name == "metrics_reasonable")
    assert metrics.passed is True
    assert metrics.evidence["run_id"] == "run-a"
    assert metrics.evidence["turn_count"] == 2


@pytest.mark.asyncio
async def test_verify_completion_accepts_untracked_file_as_workspace_change(tmp_path: Path) -> None:
    workspace = tmp_path / "repo"
    workspace.mkdir()
    subprocess.run(["git", "init", "-q"], cwd=workspace, check=True)
    (workspace / "PERFORMER_CONDUCTOR_VALIDATION.md").write_text(
        "conductor runtime validation passed.\n",
        encoding="utf-8",
    )
    verifier = CompletionVerifier(
        CompletionVerificationConfig(
            required_checks=["workspace_changes"],
            optional_checks=[],
            min_workspace_changes_chars=10,
        ),
        FakeTracker(),
    )

    verdict = await verifier.verify_completion(issue(), workspace, OpsSnapshot())

    assert verdict.status == "VERIFIED"
    assert any(check.check_name == "workspace_changes" and check.passed for check in verdict.checks)


@pytest.mark.asyncio
async def test_verify_completion_uses_workspace_baseline_instead_of_head(tmp_path: Path) -> None:
    workspace = tmp_path / "repo"
    workspace.mkdir()
    subprocess.run(["git", "init", "-q"], cwd=workspace, check=True)
    subprocess.run(["git", "config", "user.email", "test@example.com"], cwd=workspace, check=True)
    subprocess.run(["git", "config", "user.name", "Test"], cwd=workspace, check=True)
    (workspace / "README.md").write_text("base\n", encoding="utf-8")
    subprocess.run(["git", "add", "README.md"], cwd=workspace, check=True)
    subprocess.run(["git", "commit", "-q", "-m", "base"], cwd=workspace, check=True)
    baseline = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=workspace, text=True).strip()
    (workspace / "README.md").write_text("previous run\n", encoding="utf-8")
    subprocess.run(["git", "add", "README.md"], cwd=workspace, check=True)
    subprocess.run(["git", "commit", "-q", "-m", "previous"], cwd=workspace, check=True)
    (workspace / ".symphony").mkdir()
    (workspace / ".symphony" / "workspace-baseline").write_text(baseline + "\n", encoding="utf-8")
    (workspace / "README.md").write_text("current run changed enough for verifier\n", encoding="utf-8")
    verifier = CompletionVerifier(
        CompletionVerificationConfig(
            required_checks=["workspace_changes"],
            optional_checks=[],
            min_workspace_changes_chars=10,
        ),
        FakeTracker(),
    )

    verdict = await verifier.verify_completion(issue(), workspace, OpsSnapshot())

    check = next(check for check in verdict.checks if check.check_name == "workspace_changes")
    assert verdict.status == "VERIFIED"
    assert check.passed is True
    assert check.evidence["baseline"] == baseline


@pytest.mark.asyncio
async def test_verify_completion_accepts_small_untracked_file_as_workspace_change(tmp_path: Path) -> None:
    workspace = tmp_path / "repo"
    workspace.mkdir()
    subprocess.run(["git", "init", "-q"], cwd=workspace, check=True)
    (workspace / "RESULT.md").write_text("ok\n", encoding="utf-8")
    verifier = CompletionVerifier(
        CompletionVerificationConfig(
            required_checks=["workspace_changes"],
            optional_checks=[],
            min_workspace_changes_chars=50,
        ),
        FakeTracker(),
    )

    verdict = await verifier.verify_completion(issue(), workspace, OpsSnapshot())

    assert verdict.status == "VERIFIED"
    assert any(check.check_name == "workspace_changes" and check.passed for check in verdict.checks)


@pytest.mark.asyncio
async def test_verify_completion_rejects_structured_pytest_command_without_execution_event(tmp_path: Path) -> None:
    workspace = tmp_path / "repo"
    workspace.mkdir()
    subprocess.run(["git", "init", "-q"], cwd=workspace, check=True)
    (workspace / "tests").mkdir()
    (workspace / "tests" / "test_smoke.py").write_text("def test_smoke():\n    assert True\n", encoding="utf-8")
    snapshot = OpsSnapshot(
        runs={"run-1": RunRecord(run_id="run-1", issue_id="mt-1", instance_id="inst-1", status="completed")},
        events=[
            TraceEvent(
                event_id="evt-1",
                event_type="turn_completed",
                timestamp="2026-07-03T00:00:00Z",
                issue_id="mt-1",
                run_id="run-1",
                payload={
                    "structured_result": {
                        "test_commands": [
                            "pytest tests/test_smoke.py -q\n. [100%]\n1 passed in 0.01s",
                        ]
                    }
                },
            )
        ],
    )
    verifier = CompletionVerifier(
        CompletionVerificationConfig(
            required_checks=["test_results"],
            optional_checks=[],
            expected_test_patterns=["tests/test_smoke.py"],
        ),
        FakeTracker(),
    )

    verdict = await verifier.verify_completion(issue(), workspace, snapshot)

    assert verdict.status == "NEEDS_RETRY"
    assert any(check.check_name == "test_results" and not check.passed for check in verdict.checks)


@pytest.mark.asyncio
async def test_verify_completion_rejects_any_structured_pytest_command_without_execution_event(tmp_path: Path) -> None:
    workspace = tmp_path / "repo"
    workspace.mkdir()
    subprocess.run(["git", "init", "-q"], cwd=workspace, check=True)
    (workspace / "tests").mkdir()
    (workspace / "tests" / "test_smoke.py").write_text("def test_smoke():\n    assert True\n", encoding="utf-8")
    snapshot = OpsSnapshot(
        runs={"run-1": RunRecord(run_id="run-1", issue_id="mt-1", instance_id="inst-1", status="completed")},
        events=[
            TraceEvent(
                event_id="evt-1",
                event_type="turn_completed",
                timestamp="2026-07-03T00:00:00Z",
                issue_id="mt-1",
                run_id="run-1",
                payload={
                    "structured_result": {
                        "test_commands": [
                            "pytest tests/test_smoke.py -q\n. [100%]\n1 passed in 0.01s",
                        ]
                    }
                },
            )
        ],
    )
    verifier = CompletionVerifier(
        CompletionVerificationConfig(
            required_checks=["test_results"],
            optional_checks=[],
        ),
        FakeTracker(),
    )

    verdict = await verifier.verify_completion(issue(), workspace, snapshot)

    assert verdict.status == "NEEDS_RETRY"
    assert any(check.check_name == "test_results" and not check.passed for check in verdict.checks)


@pytest.mark.asyncio
async def test_verify_completion_rejects_pytest_command_from_summary_without_execution_event(tmp_path: Path) -> None:
    workspace = tmp_path / "repo"
    workspace.mkdir()
    subprocess.run(["git", "init", "-q"], cwd=workspace, check=True)
    (workspace / "tests").mkdir()
    (workspace / "tests" / "test_smoke.py").write_text("def test_smoke():\n    assert True\n", encoding="utf-8")
    snapshot = OpsSnapshot(
        runs={"run-1": RunRecord(run_id="run-1", issue_id="mt-1", instance_id="inst-1", status="completed")},
        events=[
            TraceEvent(
                event_id="evt-1",
                event_type="turn_completed",
                timestamp="2026-07-03T00:00:00Z",
                issue_id="mt-1",
                run_id="run-1",
                summary=(
                    '{"test_commands":["pytest tests/test_smoke.py -q"],'
                    '"summary":"pytest tests/test_smoke.py -q\\n. [100%]\\n1 passed in 0.01s"}'
                ),
            )
        ],
    )
    verifier = CompletionVerifier(
        CompletionVerificationConfig(required_checks=["test_results"], optional_checks=[]),
        FakeTracker(),
    )

    verdict = await verifier.verify_completion(issue(), workspace, snapshot)

    assert verdict.status == "NEEDS_RETRY"
    assert any(check.check_name == "test_results" and not check.passed for check in verdict.checks)


@pytest.mark.asyncio
async def test_verify_completion_accepts_verifier_run_as_test_command_evidence(tmp_path: Path) -> None:
    workspace = tmp_path / "repo"
    workspace.mkdir()
    subprocess.run(["git", "init", "-q"], cwd=workspace, check=True)
    (workspace / "pyproject.toml").write_text("[project]\nname='demo'\nversion='0.1.0'\n", encoding="utf-8")
    tests_dir = workspace / "tests"
    tests_dir.mkdir()
    (tests_dir / "test_smoke.py").write_text("def test_smoke():\n    assert True\n", encoding="utf-8")
    snapshot = OpsSnapshot(
        runs={
            "run-1": RunRecord(
                run_id="run-1",
                issue_id="mt-1",
                instance_id="inst-1",
                status="completed",
            )
        },
        events=[
            TraceEvent(
                event_id="evt-1",
                event_type="turn_completed",
                timestamp="2026-07-03T00:00:00Z",
                issue_id="mt-1",
                run_id="run-1",
                summary='{"test_commands":["pytest tests/test_smoke.py -q"]}',
            )
        ],
    )
    verifier = CompletionVerifier(
        CompletionVerificationConfig(
            required_checks=["test_results", "test_command_evidence"],
            optional_checks=[],
            expected_test_patterns=["tests/test_smoke.py"],
        ),
        FakeTracker(),
    )

    verdict = await verifier.verify_completion(issue(), workspace, snapshot)

    assert verdict.status == "VERIFIED"
    command_check = next(check for check in verdict.checks if check.check_name == "test_command_evidence")
    assert command_check.passed is True
    assert command_check.evidence["source"] == "verifier"


@pytest.mark.asyncio
async def test_verify_completion_skips_test_command_requirement_without_expected_patterns(
    tmp_path: Path,
) -> None:
    workspace = tmp_path / "repo"
    workspace.mkdir()
    (workspace / ".git").mkdir()
    verifier = CompletionVerifier(
        CompletionVerificationConfig(
            required_checks=["test_command_evidence"],
            optional_checks=[],
            expected_test_patterns=[],
        ),
        FakeTracker(),
    )

    verdict = await verifier.verify_completion(issue(), workspace, OpsSnapshot())

    assert verdict.status == "VERIFIED"
    assert any(check.check_name == "test_command_evidence" and check.passed for check in verdict.checks)


@pytest.mark.asyncio
async def test_verify_completion_rejects_self_reported_structured_test_command_evidence(
    tmp_path: Path,
) -> None:
    workspace = tmp_path / "repo"
    workspace.mkdir()
    (workspace / ".git").mkdir()
    verifier = CompletionVerifier(
        CompletionVerificationConfig(
            required_checks=["test_command_evidence"],
            optional_checks=[],
            expected_test_patterns=["tests/test_target.py::test_fix"],
        ),
        FakeTracker(),
    )
    snapshot = OpsSnapshot(
        events=[
            TraceEvent(
                event_id="evt-1",
                event_type="turn_completed",
                timestamp="2026-07-03T00:00:00Z",
                issue_id="mt-1",
                run_id="run-1",
                payload={
                    "structured_result": {
                        "test_commands": ["pytest tests/test_target.py::test_fix -q"],
                    }
                },
            )
        ],
    )

    verdict = await verifier.verify_completion(issue(), workspace, snapshot)

    assert verdict.status == "NEEDS_RETRY"
    check = next(check for check in verdict.checks if check.check_name == "test_command_evidence")
    assert check.passed is False
    assert check.evidence["commands"] == []


@pytest.mark.asyncio
async def test_verify_completion_rejects_metrics_without_issue_run_record(
    tmp_path: Path,
) -> None:
    workspace = tmp_path / "repo"
    workspace.mkdir()
    (workspace / ".git").mkdir()
    verifier = CompletionVerifier(
        CompletionVerificationConfig(
            required_checks=["metrics_reasonable"],
            optional_checks=[],
            min_duration_seconds=5,
        ),
        FakeTracker(),
    )
    snapshot = OpsSnapshot(
        runs={
            "run-other": RunRecord(
                run_id="run-other",
                issue_id="other-issue",
                instance_id="inst-1",
                status="completed",
                started_at="2026-07-01T00:00:00Z",
                completed_at="2026-07-01T00:00:10Z",
                turn_count=1,
                tool_call_count=1,
            )
        },
        events=[
            TraceEvent(
                event_id="evt-1",
                event_type="turn_started",
                timestamp="2026-07-01T00:00:00Z",
                issue_id="mt-1",
            ),
            TraceEvent(
                event_id="evt-2",
                event_type="tool_call_completed",
                timestamp="2026-07-01T00:00:02Z",
                issue_id="mt-1",
            ),
            TraceEvent(
                event_id="evt-3",
                event_type="turn_completed",
                timestamp="2026-07-01T00:00:08Z",
                issue_id="mt-1",
            ),
        ],
    )

    verdict = await verifier.verify_completion(issue(), workspace, snapshot)

    assert verdict.status == "NEEDS_RETRY"
    assert any(check.check_name == "metrics_reasonable" and not check.passed for check in verdict.checks)
