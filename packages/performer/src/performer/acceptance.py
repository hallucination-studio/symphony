from __future__ import annotations

from dataclasses import dataclass, field
import json
from pathlib import Path
from typing import Any

from .codex_client import CodexSdkClient, TEXT_RESULT_SCHEMA
from performer_api.config import ServiceConfig


@dataclass(frozen=True)
class AcceptanceReport:
    score: int
    result: str
    score_reason: str
    evidence_citations: list[str]
    residual_findings: list[str]
    recommended_next_action: str
    accepted: bool
    rejection_reasons: list[str] = field(default_factory=list)


@dataclass(frozen=True)
class GatePlan:
    title: str
    purpose: str
    acceptance_criteria: list[str]
    required_evidence: list[str]


@dataclass(frozen=True)
class GatePlanReport:
    valid: bool
    needs_more_info: bool
    gates: list[GatePlan] = field(default_factory=list)
    questions: list[str] = field(default_factory=list)
    rejection_reasons: list[str] = field(default_factory=list)


class CodexAcceptanceRunner:
    def __init__(self, config: ServiceConfig, *, codex_client: Any | None = None) -> None:
        self.config = config
        self.codex_client = codex_client or CodexSdkClient(config.codex)

    async def run_acceptance(
        self,
        *,
        original_issue: Any,
        acceptance_issue: dict[str, Any],
        completion_verdict: Any,
        workspace_path: str | None,
    ) -> str:
        workspace = Path(workspace_path or self.config.workspace.root)
        prompt = build_acceptance_prompt(
            original_issue=original_issue,
            acceptance_issue=acceptance_issue,
            completion_verdict=completion_verdict,
            config=self.config,
        )
        last_message: str | None = None

        def on_event(event: dict[str, Any]) -> None:
            nonlocal last_message
            message = event.get("message")
            if isinstance(message, str) and message.strip():
                last_message = message.strip()

        result = await self.codex_client.run_session(
            workspace,
            prompt,
            f"Acceptance {getattr(original_issue, 'identifier', 'issue')}",
            on_event=on_event,
            max_turns=self.config.agent.max_turns,
            output_schema=TEXT_RESULT_SCHEMA,
        )
        if isinstance(result, str):
            return result
        final_response = getattr(result, "final_response", None)
        if isinstance(final_response, str) and final_response.strip():
            return final_response.strip()
        message = getattr(result, "message", None)
        if isinstance(message, str) and message.strip():
            return message.strip()
        if last_message is not None:
            return last_message
        return str(result)


class SmokeAcceptanceRunner:
    def __init__(self, config: ServiceConfig | None = None) -> None:
        self.config = config

    async def run_acceptance(
        self,
        *,
        original_issue: Any,
        acceptance_issue: dict[str, Any],
        completion_verdict: Any,
        workspace_path: str | None,
    ) -> str:
        _ = acceptance_issue
        identifier = getattr(original_issue, "identifier", "issue")
        description = getattr(original_issue, "description", "") or ""
        fallback_workspace = self.config.workspace.root if self.config is not None else Path(".")
        workspace = Path(workspace_path or fallback_workspace)
        result_path = workspace / "SYMPHONY_REAL_E2E_RESULT.md"
        verdict_status = getattr(completion_verdict, "status", None)
        has_required_evidence = all(
            label in description
            for label in ("Implementation summary:", "Test commands and exact output:", "Remaining risks:")
        )
        result_text = result_path.read_text(encoding="utf-8", errors="replace") if result_path.exists() else ""
        has_result_file = result_path.exists() and identifier in result_text
        verdict_ok = verdict_status in {None, "VERIFIED"}
        accepted = verdict_ok and has_required_evidence and has_result_file
        if accepted:
            payload = {
                "score": 4,
                "result": "pass",
                "score_reason": (
                    "Smoke acceptance verified the completion verdict, required Linear evidence fields, "
                    "and workspace result artifact for the delegated issue."
                ),
                "evidence_citations": [
                    "completion_verdict.status",
                    "linear.issue.description",
                    "workspace/SYMPHONY_REAL_E2E_RESULT.md",
                ],
                "residual_findings": [],
                "recommended_next_action": "Move the original issue to Done.",
            }
        else:
            missing: list[str] = []
            if not verdict_ok:
                missing.append("completion_verdict_not_verified")
            if not has_required_evidence:
                missing.append("missing_required_linear_evidence_fields")
            if not has_result_file:
                missing.append("missing_or_invalid_workspace_result")
            payload = {
                "score": 2,
                "result": "fail",
                "score_reason": "Smoke acceptance failed: " + ", ".join(missing),
                "evidence_citations": ["completion_verdict.status", "linear.issue.description"],
                "residual_findings": missing,
                "recommended_next_action": "Return the original issue to implementation.",
            }
        return json.dumps(payload)


class CodexGatePlanner:
    def __init__(self, config: ServiceConfig, *, codex_client: Any | None = None) -> None:
        self.config = config
        self.codex_client = codex_client or CodexSdkClient(config.codex)

    async def plan_gates(self, *, issue: Any, workspace_path: str | None = None) -> str:
        workspace = Path(workspace_path or self.config.workspace.root)
        prompt = build_gate_planner_prompt(issue=issue)
        last_message: str | None = None

        def on_event(event: dict[str, Any]) -> None:
            nonlocal last_message
            message = event.get("message")
            if isinstance(message, str) and message.strip():
                last_message = message.strip()

        result = await self.codex_client.run_session(
            workspace,
            prompt,
            f"Gate plan {getattr(issue, 'identifier', 'issue')}",
            on_event=on_event,
            max_turns=self.config.agent.max_turns,
            output_schema=TEXT_RESULT_SCHEMA,
        )
        if isinstance(result, str):
            return result
        final_response = getattr(result, "final_response", None)
        if isinstance(final_response, str) and final_response.strip():
            return final_response.strip()
        message = getattr(result, "message", None)
        if isinstance(message, str) and message.strip():
            return message.strip()
        if last_message is not None:
            return last_message
        return str(result)


class SmokeGatePlanner:
    async def plan_gates(self, *, issue: Any, workspace_path: str | None = None) -> str:
        _ = workspace_path
        identifier = getattr(issue, "identifier", "issue")
        return json.dumps(
            {
                "gates": [
                    {
                        "title": "Smoke completion evidence",
                        "purpose": f"Verify {identifier} produced the deterministic E2E result and evidence.",
                        "acceptance_criteria": [
                            "The workspace contains SYMPHONY_REAL_E2E_RESULT.md for the delegated issue.",
                            "The Linear issue includes implementation summary, test output, and remaining risks.",
                        ],
                        "required_evidence": [
                            "Workspace result file content.",
                            "Linear issue evidence fields and pytest tests/test_smoke.py -q output.",
                        ],
                    }
                ]
            }
        )


def build_gate_planner_prompt(*, issue: Any) -> str:
    issue_identifier = getattr(issue, "identifier", "")
    issue_title = getattr(issue, "title", "")
    issue_description = getattr(issue, "description", "") or ""
    issue_labels = getattr(issue, "labels", []) or []
    return "\n".join(
        [
            "You are Performer's gate planner for one business Linear issue.",
            "Create an acceptance gate tree under the business issue. Each gate must cover exactly one independently reviewable concern.",
            "Balance the plan: do not create one giant catch-all gate, and do not split into trivial fragments.",
            "If the issue is too ambiguous to plan, ask all needed questions at once.",
            "",
            "Business issue:",
            f"- Identifier: {issue_identifier}",
            f"- Title: {issue_title}",
            f"- Labels: {', '.join(str(label) for label in issue_labels)}",
            f"- Description: {issue_description}",
            "",
            "Return one JSON object only in one of these shapes:",
            '{"gates":[{"title":"short title","purpose":"single responsibility","acceptance_criteria":["specific criterion"],"required_evidence":["specific evidence"]}]}',
            '{"needs_more_info":true,"questions":["question 1","question 2"]}',
        ]
    )


def build_acceptance_prompt(
    *,
    original_issue: Any,
    acceptance_issue: dict[str, Any],
    completion_verdict: Any,
    config: ServiceConfig,
) -> str:
    issue_identifier = getattr(original_issue, "identifier", "")
    issue_title = getattr(original_issue, "title", "")
    issue_description = getattr(original_issue, "description", "") or ""
    issue_url = getattr(original_issue, "url", "") or ""
    issue_labels = getattr(original_issue, "labels", []) or []
    verdict_status = getattr(completion_verdict, "status", "unknown")
    verdict_reason = getattr(completion_verdict, "reason", "unknown")
    checks = getattr(completion_verdict, "checks", []) or []
    evidence = getattr(completion_verdict, "evidence", {}) or {}
    lines = [
        "You are the independent Performer acceptance reviewer for one completed Linear task.",
        "This is a task-scoped gate modeled after Superpowers task review: first judge Spec compliance, then Code quality.",
        "Do not trust the implementer report or the prior completion verdict. Treat them as claims to verify against evidence.",
        "",
        "Original issue:",
        f"- Identifier: {issue_identifier}",
        f"- Title: {issue_title}",
        f"- URL: {issue_url}",
        f"- Labels: {', '.join(str(label) for label in issue_labels)}",
        f"- Description: {issue_description}",
        "",
        "Acceptance issue:",
        f"- ID: {acceptance_issue.get('id', '')}",
        f"- Identifier: {acceptance_issue.get('identifier', '')}",
        f"- URL: {acceptance_issue.get('url', '')}",
        "",
        "Prior completion verdict:",
        f"- Status: {verdict_status}",
        f"- Reason: {verdict_reason}",
        "",
        "Completion checks:",
    ]
    for check in checks:
        lines.append(
            f"- {getattr(check, 'check_name', 'unknown')}: "
            f"{'PASS' if getattr(check, 'passed', False) else 'FAIL'} - {getattr(check, 'message', '')}"
        )
    if evidence:
        lines.extend(["", "Completion evidence keys:"])
        for key in sorted(str(item) for item in evidence.keys()):
            lines.append(f"- {key}")
    lines.extend(
        [
            "",
            "Gate rubric:",
            "- Score 4: pass; requirements are satisfied, evidence is strong, no material residual findings.",
            "- Score 3: pass only with concrete residual findings that should be tracked.",
            "- Score 2: fail; material gaps, missing evidence, or likely false positive completion.",
            "- Score 1: fail; implementation is mostly absent or unsafe.",
            "- Score 0: fail; no usable evidence or wrong task.",
            "",
            "Evaluate both:",
            "- Spec compliance: missing, extra, or misunderstood requirements.",
            "- Code quality: maintainability, error handling, tests, and evidence quality.",
            "",
            "Return one JSON object only with exactly these fields:",
            "{",
            '  "score": 0,',
            '  "result": "pass|fail",',
            '  "score_reason": "specific evidence-backed reasoning, not a vague approval",',
            '  "evidence_citations": ["workspace/file:line or command/result or Linear/ops evidence"],',
            '  "residual_findings": ["required when score is 3; concrete findings only"],',
            '  "recommended_next_action": "what Performer should do next"',
            "}",
            "",
            f"Minimum passing score: {config.acceptance.minimum_score}.",
        ]
    )
    return "\n".join(lines)


def parse_acceptance_report(
    text: str,
    *,
    minimum_score: int,
    require_findings_for_score_3: bool,
) -> AcceptanceReport:
    try:
        payload = json.loads(_extract_json_object(text))
    except (json.JSONDecodeError, ValueError):
        return _rejected(["invalid_json"])
    if not isinstance(payload, dict):
        return _rejected(["invalid_json"])

    score = _int(payload.get("score"), default=-1)
    result = _string(payload.get("result"))
    score_reason = _string(payload.get("score_reason"))
    evidence_citations = _string_list(payload.get("evidence_citations"))
    residual_findings = _string_list(payload.get("residual_findings"))
    recommended_next_action = _string(payload.get("recommended_next_action"))

    rejection_reasons: list[str] = []
    if score < minimum_score:
        rejection_reasons.append("score_below_minimum")
    if result != "pass":
        rejection_reasons.append("result_not_pass")
    if not _substantive(score_reason):
        rejection_reasons.append("score_reason_not_substantive")
    if not evidence_citations:
        rejection_reasons.append("missing_evidence_citations")
    if score == 3 and require_findings_for_score_3 and not residual_findings:
        rejection_reasons.append("score_3_requires_residual_findings")
    if not recommended_next_action:
        rejection_reasons.append("missing_recommended_next_action")

    return AcceptanceReport(
        score=score,
        result=result,
        score_reason=score_reason,
        evidence_citations=evidence_citations,
        residual_findings=residual_findings,
        recommended_next_action=recommended_next_action,
        accepted=not rejection_reasons,
        rejection_reasons=rejection_reasons,
    )


def parse_gate_plan_report(text: str) -> GatePlanReport:
    try:
        payload = json.loads(_extract_json_object(text))
    except (json.JSONDecodeError, ValueError):
        return GatePlanReport(valid=False, needs_more_info=False, rejection_reasons=["invalid_json"])
    if not isinstance(payload, dict):
        return GatePlanReport(valid=False, needs_more_info=False, rejection_reasons=["invalid_json"])

    needs_more_info = payload.get("needs_more_info") is True
    if needs_more_info:
        questions = _string_list(payload.get("questions"))
        reasons = [] if questions else ["missing_questions"]
        return GatePlanReport(
            valid=not reasons,
            needs_more_info=True,
            questions=questions,
            rejection_reasons=reasons,
        )

    raw_gates = payload.get("gates")
    if not isinstance(raw_gates, list) or not raw_gates:
        return GatePlanReport(valid=False, needs_more_info=False, rejection_reasons=["missing_gates"])

    gates: list[GatePlan] = []
    rejection_reasons: list[str] = []
    for index, raw_gate in enumerate(raw_gates, start=1):
        if not isinstance(raw_gate, dict):
            rejection_reasons.append(f"gate_{index}_invalid")
            continue
        title = _string(raw_gate.get("title"))
        purpose = _string(raw_gate.get("purpose"))
        criteria = _string_list(raw_gate.get("acceptance_criteria"))
        evidence = _string_list(raw_gate.get("required_evidence"))
        if not title:
            rejection_reasons.append(f"gate_{index}_missing_title")
        if not _substantive_gate_purpose(purpose):
            rejection_reasons.append(f"gate_{index}_purpose_not_substantive")
        if not criteria:
            rejection_reasons.append(f"gate_{index}_missing_acceptance_criteria")
        if not evidence:
            rejection_reasons.append(f"gate_{index}_missing_required_evidence")
        gates.append(
            GatePlan(
                title=title,
                purpose=purpose,
                acceptance_criteria=criteria,
                required_evidence=evidence,
            )
        )
    return GatePlanReport(
        valid=not rejection_reasons,
        needs_more_info=False,
        gates=gates,
        rejection_reasons=rejection_reasons,
    )


def _rejected(reasons: list[str]) -> AcceptanceReport:
    return AcceptanceReport(
        score=-1,
        result="invalid",
        score_reason="",
        evidence_citations=[],
        residual_findings=[],
        recommended_next_action="",
        accepted=False,
        rejection_reasons=reasons,
    )


def _extract_json_object(text: str) -> str:
    stripped = text.strip()
    if stripped.startswith("{") and stripped.endswith("}"):
        return stripped
    start = stripped.find("{")
    end = stripped.rfind("}")
    if start < 0 or end <= start:
        raise ValueError("missing JSON object")
    return stripped[start : end + 1]


def _int(value: Any, *, default: int) -> int:
    if isinstance(value, bool):
        return default
    if isinstance(value, int):
        return value
    if isinstance(value, str) and value.strip().isdigit():
        return int(value.strip())
    return default


def _string(value: Any) -> str:
    return value.strip() if isinstance(value, str) else ""


def _string_list(value: Any) -> list[str]:
    if not isinstance(value, list):
        return []
    return [item.strip() for item in value if isinstance(item, str) and item.strip()]


def _substantive(value: str) -> bool:
    lowered = value.strip().lower()
    if len(lowered) < 40:
        return False
    vague = {"looks good", "seems fine", "all good", "ok", "done"}
    return lowered not in vague


def _substantive_gate_purpose(value: str) -> bool:
    lowered = value.strip().lower()
    if len(lowered) < 24:
        return False
    vague = {"check it", "review it", "everything", "all", "done"}
    return lowered not in vague
