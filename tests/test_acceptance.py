from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest

from performer.acceptance import (
    CodexAcceptanceRunner,
    CodexGatePlanner,
    SmokeAcceptanceRunner,
    parse_acceptance_report,
    parse_gate_plan_report,
)
from performer_api.config import (
    AcceptanceConfig,
    AgentConfig,
    CodexConfig,
    HooksConfig,
    PollingConfig,
    ServiceConfig,
    TrackerConfig,
    WorkspaceConfig,
)
from performer_api.models import Issue
from performer_api.ops_models import CompletionVerdict


class FakeCodex:
    def __init__(self, result: Any = '{"score": 4}', *, emitted_message: str | None = None) -> None:
        self.result = result
        self.emitted_message = emitted_message
        self.calls: list[dict[str, Any]] = []

    async def run_session(self, workspace_path: Path, prompt: str, title: str, **kwargs: Any) -> Any:
        self.calls.append(
            {
                "workspace_path": workspace_path,
                "prompt": prompt,
                "title": title,
                "kwargs": kwargs,
            }
        )
        if self.emitted_message is not None:
            kwargs["on_event"]({"event": "agent_message", "message": self.emitted_message})
        return self.result


def make_config(tmp_path: Path) -> ServiceConfig:
    return ServiceConfig(
        tracker=TrackerConfig(
            kind="linear",
            endpoint="https://api.linear.app/graphql",
            project_slug="MT",
            api_key="linear-token",
        ),
        polling=PollingConfig(),
        workspace=WorkspaceConfig(root=tmp_path),
        hooks=HooksConfig(),
        agent=AgentConfig(max_turns=7),
        codex=CodexConfig(),
        prompt_template="Do {{ issue.identifier }}",
        workflow_path=tmp_path / "WORKFLOW.md",
        acceptance=AcceptanceConfig(enabled=True),
    )


def test_parse_acceptance_report_passes_score_4_with_evidence() -> None:
    report = parse_acceptance_report(
        """
{
  "score": 4,
  "result": "pass",
  "score_reason": "Workspace diff, focused pytest command, ops run, and Linear state evidence all support completion.",
  "evidence_citations": ["workspace.diff_stat", "ops.runs.run-1", "linear.issue.MT-1"],
  "residual_findings": [],
  "recommended_next_action": "Move the original issue to Done."
}
""",
        minimum_score=3,
        require_findings_for_score_3=True,
    )

    assert report.accepted is True
    assert report.score == 4
    assert report.residual_findings == []


def test_parse_acceptance_report_passes_score_3_only_with_concrete_findings() -> None:
    report = parse_acceptance_report(
        """
{
  "score": 3,
  "result": "pass",
  "score_reason": "Core behavior is implemented and verified by pytest, but docs still omit the new retry label.",
  "evidence_citations": ["workspace.git_status", "ops.events.evt-7"],
  "residual_findings": ["README does not mention performer:gate/pass-with-findings for operator triage."],
  "recommended_next_action": "Move to Done and track the README follow-up."
}
""",
        minimum_score=3,
        require_findings_for_score_3=True,
    )

    assert report.accepted is True
    assert report.score == 3
    assert report.residual_findings == [
        "README does not mention performer:gate/pass-with-findings for operator triage."
    ]


def test_parse_acceptance_report_rejects_score_3_without_findings() -> None:
    report = parse_acceptance_report(
        """
{
  "score": 3,
  "result": "pass",
  "score_reason": "Implementation looks mostly correct based on available evidence.",
  "evidence_citations": ["workspace.git_status", "ops.events.evt-7"],
  "residual_findings": [],
  "recommended_next_action": "Move to Done."
}
""",
        minimum_score=3,
        require_findings_for_score_3=True,
    )

    assert report.accepted is False
    assert "score_3_requires_residual_findings" in report.rejection_reasons


def test_parse_acceptance_report_rejects_vague_reason() -> None:
    report = parse_acceptance_report(
        """
{
  "score": 4,
  "result": "pass",
  "score_reason": "Looks good.",
  "evidence_citations": ["workspace.git_status"],
  "residual_findings": [],
  "recommended_next_action": "Move to Done."
}
""",
        minimum_score=3,
        require_findings_for_score_3=True,
    )

    assert report.accepted is False
    assert "score_reason_not_substantive" in report.rejection_reasons


def test_parse_acceptance_report_rejects_invalid_json() -> None:
    report = parse_acceptance_report(
        "score: 4",
        minimum_score=3,
        require_findings_for_score_3=True,
    )

    assert report.accepted is False
    assert "invalid_json" in report.rejection_reasons


def test_parse_gate_plan_report_accepts_multiple_valid_gates() -> None:
    plan = parse_gate_plan_report(
        """
{
  "gates": [
    {
      "title": "Behavior",
      "purpose": "Verify only the requested user-visible behavior.",
      "acceptance_criteria": ["The requested behavior works."],
      "required_evidence": ["Focused test command and exact output."]
    },
    {
      "title": "Regression Coverage",
      "purpose": "Verify only regression coverage.",
      "acceptance_criteria": ["A regression test covers the requested case."],
      "required_evidence": ["Test file citation and pytest output."]
    }
  ]
}
"""
    )

    assert plan.valid is True
    assert plan.needs_more_info is False
    assert [gate.title for gate in plan.gates] == ["Behavior", "Regression Coverage"]


def test_parse_gate_plan_report_accepts_needs_more_info_questions() -> None:
    plan = parse_gate_plan_report(
        """
{
  "needs_more_info": true,
  "questions": ["Which API should expose the new field?", "What migration behavior is expected?"]
}
"""
    )

    assert plan.valid is True
    assert plan.needs_more_info is True
    assert plan.questions == ["Which API should expose the new field?", "What migration behavior is expected?"]
    assert plan.gates == []


def test_parse_gate_plan_report_rejects_empty_or_unfocused_gate() -> None:
    plan = parse_gate_plan_report(
        """
{
  "gates": [
    {
      "title": "Everything",
      "purpose": "Check it.",
      "acceptance_criteria": [],
      "required_evidence": ["output"]
    }
  ]
}
"""
    )

    assert plan.valid is False
    assert "gate_1_missing_acceptance_criteria" in plan.rejection_reasons
    assert "gate_1_purpose_not_substantive" in plan.rejection_reasons


@pytest.mark.asyncio
async def test_codex_acceptance_runner_prompts_for_task_scoped_gate_and_strict_json(tmp_path: Path) -> None:
    codex = FakeCodex(result='{"score": 4, "result": "pass"}')
    runner = CodexAcceptanceRunner(make_config(tmp_path), codex_client=codex)
    issue = Issue(
        id="mt-1",
        identifier="MT-1",
        title="Build Linear gate",
        description="Add acceptance issue workflow.",
        state="Done",
        labels=["performer:type/task"],
        url="https://linear.app/x/issue/MT-1",
    )
    acceptance_issue = {
        "id": "acceptance-1",
        "identifier": "MT-2",
        "url": "https://linear.app/x/issue/MT-2",
    }
    verdict = CompletionVerdict(
        status="VERIFIED",
        reason="Completion checks passed.",
        checks=[],
        verified_at="2026-07-01T00:00:00Z",
        evidence={},
    )

    result = await runner.run_acceptance(
        original_issue=issue,
        acceptance_issue=acceptance_issue,
        completion_verdict=verdict,
        workspace_path=str(tmp_path),
    )

    assert result == '{"score": 4, "result": "pass"}'
    call = codex.calls[0]
    assert call["workspace_path"] == tmp_path
    assert call["title"] == "Acceptance MT-1"
    prompt = call["prompt"]
    assert "Do not trust the implementer report" in prompt
    assert "Spec compliance" in prompt
    assert "Code quality" in prompt
    assert "evidence_citations" in prompt
    assert "Return one JSON object only" in prompt
    assert "MT-1" in prompt
    assert "acceptance-1" in prompt
    assert call["kwargs"]["max_turns"] == 7


@pytest.mark.asyncio
async def test_codex_acceptance_runner_returns_last_agent_message_when_client_returns_turn_result(tmp_path: Path) -> None:
    class TurnResult:
        success = True

    codex = FakeCodex(
        result=TurnResult(),
        emitted_message='{"score": 4, "result": "pass", "score_reason": "Evidence supports completion."}',
    )
    runner = CodexAcceptanceRunner(make_config(tmp_path), codex_client=codex)

    result = await runner.run_acceptance(
        original_issue=Issue(id="mt-1", identifier="MT-1", title="Build", state="Done"),
        acceptance_issue={"id": "acceptance-1"},
        completion_verdict=CompletionVerdict(
            status="VERIFIED",
            reason="Completion checks passed.",
            checks=[],
            verified_at="2026-07-01T00:00:00Z",
            evidence={},
        ),
        workspace_path=str(tmp_path),
    )

    assert result == '{"score": 4, "result": "pass", "score_reason": "Evidence supports completion."}'
    assert callable(codex.calls[0]["kwargs"]["on_event"])


@pytest.mark.asyncio
async def test_smoke_acceptance_runner_passes_from_local_evidence(tmp_path: Path) -> None:
    (tmp_path / "SYMPHONY_REAL_E2E_RESULT.md").write_text(
        "MT-1\nPodium, Conductor, and Performer reached Codex successfully.\n",
        encoding="utf-8",
    )
    issue = Issue(
        id="mt-1",
        identifier="MT-1",
        title="Build",
        state="In Review",
        description=(
            "Implementation summary: created file.\n"
            "Test commands and exact output: pytest tests/test_smoke.py -q passed.\n"
            "Remaining risks: none."
        ),
    )
    verdict = CompletionVerdict(
        status="VERIFIED",
        reason="Completion checks passed.",
        checks=[],
        verified_at="2026-07-01T00:00:00Z",
        evidence={},
    )

    raw = await SmokeAcceptanceRunner().run_acceptance(
        original_issue=issue,
        acceptance_issue={"id": "gate-1"},
        completion_verdict=verdict,
        workspace_path=str(tmp_path),
    )
    report = parse_acceptance_report(raw, minimum_score=3, require_findings_for_score_3=True)

    assert report.accepted is True
    assert report.score == 4
    assert "workspace/SYMPHONY_REAL_E2E_RESULT.md" in report.evidence_citations


@pytest.mark.asyncio
async def test_smoke_acceptance_runner_uses_config_workspace_without_completion_verdict(tmp_path: Path) -> None:
    config = make_config(tmp_path)
    (tmp_path / "SYMPHONY_REAL_E2E_RESULT.md").write_text(
        "MT-1\nPodium, Conductor, and Performer reached Codex successfully.\n",
        encoding="utf-8",
    )
    issue = Issue(
        id="mt-1",
        identifier="MT-1",
        title="Build",
        state="In Review",
        description=(
            "Implementation summary: created file.\n"
            "Test commands and exact output: pytest tests/test_smoke.py -q passed.\n"
            "Remaining risks: none."
        ),
    )

    raw = await SmokeAcceptanceRunner(config).run_acceptance(
        original_issue=issue,
        acceptance_issue={"id": "gate-1"},
        completion_verdict=None,
        workspace_path=None,
    )
    report = parse_acceptance_report(raw, minimum_score=3, require_findings_for_score_3=True)

    assert report.accepted is True


@pytest.mark.asyncio
async def test_codex_gate_planner_returns_last_agent_message_when_client_returns_turn_result(tmp_path: Path) -> None:
    class TurnResult:
        success = True

    emitted = """
{
  "gates": [
    {
      "title": "Implementation Evidence",
      "purpose": "Verify only implementation summary and concrete workspace evidence.",
      "acceptance_criteria": ["The requested validation artifact exists and is cited."],
      "required_evidence": ["Workspace file citation and implementation summary."]
    }
  ]
}
"""
    codex = FakeCodex(result=TurnResult(), emitted_message=emitted)
    planner = CodexGatePlanner(make_config(tmp_path), codex_client=codex)

    result = await planner.plan_gates(
        issue=Issue(id="mt-1", identifier="MT-1", title="Build", state="Todo"),
        workspace_path=str(tmp_path),
    )

    assert json.loads(result)["gates"][0]["title"] == "Implementation Evidence"
    assert callable(codex.calls[0]["kwargs"]["on_event"])
