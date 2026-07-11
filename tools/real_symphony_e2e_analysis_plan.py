from __future__ import annotations

import json
from pathlib import Path
from typing import Any


def analyze_plan_artifacts(
    *,
    attempt_request: dict[str, Any] | Path | str | None,
    attempt_result: dict[str, Any] | Path | str | None,
    dispatch_context: dict[str, Any] | Path | str | None = None,
) -> dict[str, Any]:
    request_payload = _read_analysis_payload(attempt_request)
    result_payload = _read_analysis_payload(attempt_result)
    dispatch_payload = _read_analysis_payload(dispatch_context)
    context = _analysis_context(request_payload, dispatch_payload)
    report: dict[str, Any] = {
        "status": "no_plan_result",
        "root_cause_codes": [],
        "actionable_root_causes": [],
        "current_intent": _jsonable_dict(context.get("managed_run_intent")),
        "preferred_intent": _jsonable_dict(context.get("managed_run_intent")),
        "validator_errors_current": [],
        "validator_errors_preferred_after_repair": [],
        "proposal_shape": {},
    }
    plan_payload = result_payload.get("plan") if isinstance(result_payload.get("plan"), dict) else {}
    if not plan_payload:
        if result_payload:
            report["status"] = "no_plan"
            report["attempt_error"] = result_payload.get("error")
            report["attempt_status"] = result_payload.get("status")
        return report
    try:
        from performer_api.validation import ContractValidationError, validate_plan
        from performer_api.workflow import Plan

        plan = Plan.from_dict(plan_payload)
        try:
            validate_plan(plan.to_dict())
            errors: list[str] = []
        except ContractValidationError as error:
            errors = [str(error)]
        report.update(
            {
                "status": "analyzed",
                "validator_errors_current": errors,
                "validator_errors_preferred_after_repair": errors,
                "proposal_shape": _managed_run_plan_shape(plan),
                "preferred_repaired_shape": _managed_run_plan_shape(plan),
            }
        )
        if isinstance(context.get("intent"), dict) and not context.get("intent") and context.get("managed_run_intent"):
            _add_plan_root_cause(
                report,
                "intent_shadowed_by_empty_intent",
                "empty dispatch intent shadowed non-empty managed_run_intent",
                fix="Treat empty intent as absent, or prefer non-empty managed_run_intent when deriving managed-run context.",
            )
    except Exception as exc:
        report.update({"status": "analysis_error", "error": exc.__class__.__name__, "reason": str(exc)})
    return report


def _read_analysis_payload(value: dict[str, Any] | Path | str | None) -> dict[str, Any]:
    if value is None:
        return {}
    if isinstance(value, dict):
        return value
    path = Path(value)
    if not path.exists():
        return {}
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}
    return payload if isinstance(payload, dict) else {}


def _analysis_context(request_payload: dict[str, Any], dispatch_payload: dict[str, Any]) -> dict[str, Any]:
    context = dict(request_payload)
    context.update(dispatch_payload)
    if "managed_run_intent" not in context and isinstance(request_payload.get("managed_run_intent"), dict):
        context["managed_run_intent"] = request_payload["managed_run_intent"]
    return context


def _preferred_intent_context(request_payload: dict[str, Any], dispatch_payload: dict[str, Any]) -> dict[str, Any]:
    context = _analysis_context(request_payload, dispatch_payload)
    if isinstance(context.get("intent"), dict) and context.get("intent"):
        return dict(context["intent"])
    if isinstance(context.get("managed_run_intent"), dict):
        return dict(context["managed_run_intent"])
    return {}


def _intent_spec_summary(intent: dict[str, Any] | None) -> dict[str, Any]:
    if not isinstance(intent, dict):
        return {}
    required_gate_steps = intent.get("required_gate_steps")
    parallel_shape = intent.get("parallel_dependency_shape")
    return {
        "has_intent": True,
        "required_gate_step_count": len(required_gate_steps) if isinstance(required_gate_steps, list) else 0,
        "has_parallel_dependency_shape": isinstance(parallel_shape, dict) and bool(parallel_shape),
    }


def _plan_proposal_shape(plan_payload: dict[str, Any] | Any) -> dict[str, Any]:
    if not isinstance(plan_payload, dict):
        return _managed_run_plan_shape(plan_payload)
    try:
        from performer_api.workflow import Plan

        return _managed_run_plan_shape(Plan.from_dict(plan_payload))
    except Exception:
        work_items = plan_payload.get("tasks") if isinstance(plan_payload.get("tasks"), list) else []
        return {
            "work_item_count": len(work_items),
            "checkpoint_count": 0,
            "approval_required": bool(plan_payload.get("approval_required")),
            "work_item_ids": [str(item.get("id") or "") for item in work_items if isinstance(item, dict)],
        }


def _managed_run_plan_shape(plan: Any) -> dict[str, Any]:
    work_items = list(getattr(plan, "tasks", []) or [])
    return {
        "work_item_count": len(work_items),
        "checkpoint_count": 0,
        "approval_required": bool(getattr(plan, "approval_required", False)),
        "work_item_ids": [str(getattr(item, "id", "")) for item in work_items],
    }


def _jsonable_dict(value: Any) -> dict[str, Any]:
    if not isinstance(value, dict):
        return {}
    return json.loads(json.dumps(value, sort_keys=True, default=str))


def _add_plan_root_cause(report: dict[str, Any], code: str, summary: str, *, fix: str) -> None:
    if code not in report["root_cause_codes"]:
        report["root_cause_codes"].append(code)
    if not any(item.get("code") == code for item in report["actionable_root_causes"]):
        report["actionable_root_causes"].append({"code": code, "summary": summary, "fix": fix})
