from __future__ import annotations

import json
import socket
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from .conductor_models import InstanceRecord
from .conductor_phase_human_actions import (
    find_phase_human_child,
    human_response_from_child,
    linear_issue_is_done,
    phase_human_action_requires_response,
)
from .conductor_repository_handoff import (
    repository_handoff_closeout_event,
    repository_handoff_comment,
    repository_handoff_marker,
    repository_integration_description,
)
from .conductor_service_types import PROJECT_LABEL_PREFIX
from performer_api.ops_models import OpsSnapshot, TraceEvent
from performer_api.persistence import PersistedSession, PersistedState

def json_stable(payload: dict[str, Any]) -> str:
    import json

    return json.dumps(payload, separators=(",", ":"), sort_keys=True)


def _normalize_linear_issue_dict(node: dict[str, Any]) -> dict[str, Any]:
    labels = node.get("labels") if isinstance(node.get("labels"), dict) else {}
    label_nodes = labels.get("nodes") if isinstance(labels, dict) else []
    delegate = node.get("delegate") if isinstance(node.get("delegate"), dict) else None
    state = node.get("state") if isinstance(node.get("state"), dict) else {}
    return {
        "id": node.get("id"),
        "identifier": node.get("identifier"),
        "title": node.get("title"),
        "description": node.get("description") or "",
        "url": node.get("url"),
        "state": state.get("name") if isinstance(state, dict) else node.get("state"),
        "state_type": state.get("type") if isinstance(state, dict) else None,
        "delegate_id": delegate.get("id") if delegate else None,
        "labels": [
            str(label.get("name") or "")
            for label in (label_nodes or [])
            if isinstance(label, dict) and label.get("name")
        ],
    }


def _replace_marker_block(current: str, marker_name: str, block: str) -> str:
    start = f"<!-- {marker_name}:START -->"
    end = f"<!-- {marker_name}:END -->"
    replacement = f"{start}\n{block.strip()}\n{end}"
    if start in current and end in current:
        prefix, rest = current.split(start, 1)
        _old, suffix = rest.split(end, 1)
        return f"{prefix.rstrip()}\n\n{replacement}\n\n{suffix.lstrip()}".strip()
    base = current.strip()
    return f"{base}\n\n{replacement}".strip() if base else replacement


def _find_phase_human_child(human_action: dict[str, Any], children: list[dict[str, Any]]) -> dict[str, Any] | None:
    return find_phase_human_child(human_action, children)


def _linear_issue_is_done(issue: dict[str, Any]) -> bool:
    return linear_issue_is_done(issue)


def _human_response_from_child(child: dict[str, Any]) -> str | None:
    return human_response_from_child(child)


def _phase_human_action_requires_response(human_action: dict[str, Any]) -> bool:
    return phase_human_action_requires_response(human_action)


def _persisted_session_row(session: PersistedSession) -> dict[str, Any]:
    return {
        "issue_id": session.issue_id,
        "issue_identifier": session.issue_identifier,
        "issue_url": session.issue_url,
        "session_id": session.session_id,
        "turn_id": session.turn_id,
        "worker_host": session.worker_host,
        "phase": session.phase,
        "status_label": session.status_label,
        "workspace_path": session.workspace_path,
        "started_at": session.started_at.isoformat().replace("+00:00", "Z"),
        "last_event": session.last_event,
        "last_message": session.last_message,
        "last_raw_message": session.last_raw_message,
        "recent_events": session.recent_events,
        "turn_count": session.turn_count,
        "tokens": {
            "input_tokens": session.tokens.input_tokens,
            "output_tokens": session.tokens.output_tokens,
            "cached_tokens": session.tokens.cached_tokens,
            "total_tokens": session.tokens.total_tokens,
        },
    }


def _persisted_retry_row(entry) -> dict[str, Any]:
    return {
        "issue_id": entry.issue_id,
        "issue_identifier": entry.identifier,
        "issue_url": entry.issue_url,
        "attempt": entry.attempt,
        "due_at": entry.due_at.isoformat().replace("+00:00", "Z"),
        "due_at_ms": entry.due_at_ms,
        "error": entry.error,
        "last_message": entry.last_message,
        "phase": entry.phase,
        "status_label": entry.status_label,
        "recent_events": entry.recent_events,
    }


def _persisted_continuation_row(entry) -> dict[str, Any]:
    return {
        "issue_id": entry.issue_id,
        "issue_identifier": entry.identifier,
        "issue_url": entry.issue_url,
        "attempt": entry.attempt,
        "due_at": entry.due_at.isoformat().replace("+00:00", "Z"),
        "due_at_ms": entry.due_at_ms,
        "error": None,
        "last_message": entry.last_message,
        "phase": entry.phase,
        "status_label": entry.status_label,
        "recent_events": entry.recent_events,
    }


def _persisted_blocked_row(entry) -> dict[str, Any]:
    return {
        "issue_id": entry.issue_id,
        "issue_identifier": entry.identifier,
        "issue_url": entry.issue_url,
        "attempt": entry.attempt,
        "blocked_at": entry.blocked_at.isoformat().replace("+00:00", "Z"),
        "error": entry.error,
        "last_message": entry.last_message,
        "phase": entry.phase,
        "status_label": entry.status_label,
        "recent_events": entry.recent_events,
    }


def _persisted_human_intervention_row(entry) -> dict[str, Any]:
    return {
        "issue_id": entry.issue_id,
        "issue_identifier": entry.identifier,
        "issue_url": entry.issue_url,
        "attempt": entry.attempt,
        "created_at": entry.created_at.isoformat().replace("+00:00", "Z"),
        "kind": entry.kind,
        "error": entry.error,
        "last_message": entry.last_message,
        "phase": entry.phase,
        "status_label": entry.status_label,
        "child_issue_id": entry.child_issue_id,
        "child_identifier": entry.child_identifier,
        "child_url": entry.child_url,
        "questions": entry.questions,
        "resume_strategy": entry.resume_strategy,
        "recent_events": entry.recent_events,
    }


def _phase_runtime_row(run) -> dict[str, Any]:
    return {
        "run_id": run.run_id,
        "issue_id": run.issue_id,
        "issue_identifier": run.issue_identifier,
        "phase": run.phase.value,
        "status": run.status,
        "attempt": run.attempt,
        "workflow_profile": run.workflow_profile,
        "dispatch_id": run.dispatch_id,
        "workspace_path": run.workspace_path,
        "ops_snapshot_path": run.ops_snapshot_path,
        "human_action": dict(run.human_action),
        "human_response": run.human_response,
        "last_reason": run.last_reason,
        "last_error": run.last_error,
        "retry_count": run.retry_count,
        "crash_count": run.crash_count,
        "init_failure_count": run.init_failure_count,
        "overload_count": run.overload_count,
        "next_run_at": run.next_run_at,
        "ack_status": run.ack_status,
        "created_at": run.created_at,
        "updated_at": run.updated_at,
    }


def _run_due(run) -> bool:
    next_run_at = _parse_iso(run.next_run_at)
    return next_run_at is None or datetime.now(timezone.utc) >= next_run_at


def _latest_ops_run_id_for_issue(snapshot: OpsSnapshot, issue_id: str) -> str | None:
    candidates = [run for run in snapshot.runs.values() if run.issue_id == issue_id]
    if not candidates:
        return None
    candidates.sort(key=lambda run: run.last_activity_at or run.completed_at or run.started_at or "", reverse=True)
    return candidates[0].run_id


def _runtime_metrics(performer: dict[str, Any]) -> dict[str, Any]:
    running = performer.get("running") if isinstance(performer.get("running"), list) else []
    retrying = performer.get("retrying") if isinstance(performer.get("retrying"), list) else []
    continuing = performer.get("continuing") if isinstance(performer.get("continuing"), list) else []
    blocked = performer.get("blocked") if isinstance(performer.get("blocked"), list) else []
    human_interventions = (
        performer.get("human_interventions") if isinstance(performer.get("human_interventions"), list) else []
    )
    tokens = {"input_tokens": 0, "output_tokens": 0, "cached_tokens": 0, "total_tokens": 0}
    turns = 0
    for row in running:
        if not isinstance(row, dict):
            continue
        row_tokens = row.get("tokens") if isinstance(row.get("tokens"), dict) else {}
        tokens["input_tokens"] += _int(row_tokens.get("input_tokens"))
        tokens["output_tokens"] += _int(row_tokens.get("output_tokens"))
        tokens["cached_tokens"] += _int(row_tokens.get("cached_tokens"))
        tokens["total_tokens"] += _int(row_tokens.get("total_tokens"))
        turns += _int(row.get("turn_count"))
    return {
        "tokens": tokens,
        "turns": turns,
        "running": len(running),
        "retrying": len(retrying),
        "continuing": len(continuing),
        "blocked": len(blocked),
        "pending_human": len(human_interventions),
    }


def _performer_retry_metric(performer: dict[str, Any]) -> int:
    if performer.get("source") == "conductor_phase":
        rows = performer.get("issues") if isinstance(performer.get("issues"), list) else []
        return sum(_int(row.get("retry_count")) for row in rows if isinstance(row, dict))
    counts = performer.get("counts") if isinstance(performer.get("counts"), dict) else {}
    return _int(counts.get("retrying"))


def _performer_failure_metric(performer: dict[str, Any]) -> int:
    if performer.get("source") == "conductor_phase":
        rows = performer.get("failed") if isinstance(performer.get("failed"), list) else []
        return len(rows)
    return 0


def _int(value: Any) -> int:
    if isinstance(value, bool):
        return 0
    if isinstance(value, int):
        return value
    return 0


def _config_int(value: Any, default: int) -> int:
    if isinstance(value, bool):
        return default
    if isinstance(value, int):
        return value
    if isinstance(value, str):
        try:
            return int(value.strip())
        except ValueError:
            return default
    return default


def _optional_int(value: Any, default: int | None) -> int | None:
    if value is None:
        return default
    if isinstance(value, str) and value.strip().lower() in {"", "none", "null", "all"}:
        return None
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def _hostname() -> str:
    try:
        return socket.gethostname()
    except OSError:
        return ""


def _linear_agent_app_user_id(filters: dict[str, Any]) -> str:
    return str(filters.get("linear_agent_app_user_id") or filters.get("agent_app_user_id") or "").strip()


def _desired_project_labels(instance: InstanceRecord) -> list[str]:
    """The `symphony:` project labels that mirror an instance's routing scope.

    Human-readable and keyed on the instance name (unique per Conductor) so the
    Linear project shows exactly which Performers and profiles target it.
    """
    labels = [f"{PROJECT_LABEL_PREFIX}performer/{instance.name}"]
    profile = str(instance.workflow_profile or "").strip()
    if profile:
        labels.append(f"{PROJECT_LABEL_PREFIX}profile/{profile}")
    return labels


def _merge_project_labels(existing: list[str], desired: list[str]) -> list[str]:
    """Replace only the `symphony:` namespace, preserving user-owned labels.

    Linear's `projectUpdate.labelIds` is a full replacement, so the caller must
    send the complete set: every non-`symphony:` label kept as-is plus the
    desired managed labels.
    """
    kept = [label for label in existing if not label.startswith(PROJECT_LABEL_PREFIX)]
    merged = list(kept)
    for label in desired:
        if label not in merged:
            merged.append(label)
    return merged


def _first_pending_performer_issue(persisted: PersistedState) -> dict[str, Any] | None:
    for collection in (persisted.retry_attempts, persisted.continuations, persisted.blocked, persisted.human_interventions):
        for entry in collection:
            issue_id = str(getattr(entry, "issue_id", "") or "").strip()
            if issue_id:
                return {
                    "issue_id": issue_id,
                    "issue_identifier": str(getattr(entry, "identifier", "") or "").strip() or None,
                    "attempt": _optional_positive_int(getattr(entry, "attempt", None)),
                }
    return None


def _first_pending_performer_issue_id(persisted: PersistedState) -> str | None:
    pending = _first_pending_performer_issue(persisted)
    return str(pending["issue_id"]) if pending is not None else None


def _has_pending_performer_work(persisted: PersistedState) -> bool:
    return _first_pending_performer_issue_id(persisted) is not None


def _optional_positive_int(value: Any) -> int | None:
    if isinstance(value, bool):
        return None
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        return None
    return parsed if parsed > 0 else None


def _parse_iso(value: str | None) -> datetime | None:
    if not value:
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None


def _iso(value: datetime) -> str:
    return value.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


def _write_json_atomic(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(payload, separators=(",", ":"), sort_keys=True), encoding="utf-8")
    tmp.replace(path)


def _sanitize_connection_error(error: str | None) -> str | None:
    if error is None:
        return None
    text = str(error)
    for marker in ("Bearer ", "token=", "access_token="):
        if marker in text:
            text = text.split(marker, 1)[0] + marker + "[redacted]"
    return text[:500]


def _repository_handoff_marker(source_issue_id: str) -> str:
    return repository_handoff_marker(source_issue_id)


def _repository_handoff_closeout_event(
    snapshot: OpsSnapshot,
    *,
    source_event: TraceEvent,
    status: str,
    payload: dict[str, Any],
) -> TraceEvent:
    return repository_handoff_closeout_event(snapshot, source_event=source_event, status=status, payload=payload)


def _repository_integration_description(report: dict[str, Any], *, instance: InstanceRecord) -> str:
    return repository_integration_description(report, instance=instance)


def _repository_handoff_comment(report: dict[str, Any], *, child: dict[str, Any], mention: str) -> str:
    return repository_handoff_comment(report, child=child, mention=mention)


def _phase_diagnostic_comment(
    title: str,
    run,
    *,
    reason: str | None,
    instance: InstanceRecord,
    extra: dict[str, Any],
) -> str:
    issue_ref = run.issue_identifier or run.issue_id
    lines = [
        f"{title} for {issue_ref}.",
        "",
        f"run_id: `{run.run_id}`",
        f"phase: `{run.phase.value}`",
        f"status: `{run.status}`",
        f"reason: {_safe_linear_value(reason or run.last_reason or 'unknown')}",
        f"attempt: {run.attempt}",
        f"retry_count: {run.retry_count}",
        f"crash_count: {run.crash_count}",
        f"init_failure_count: {run.init_failure_count}",
        f"overload_count: {run.overload_count}",
    ]
    for key, value in extra.items():
        if value is None:
            continue
        lines.append(f"{key}: {_safe_linear_value(value)}")
    lines.extend(
        [
            "",
            f"Local log: `{instance.log_path}`",
            "No secret values were included in this diagnostic.",
        ]
    )
    return "\n".join(lines)


def _phase_failure_needs_human_action(run, detail: dict[str, Any]) -> bool:
    text = " ".join(
        str(value or "")
        for value in (
            run.last_reason,
            run.last_error,
            detail.get("reason"),
            detail.get("error"),
        )
    ).lower()
    return any(
        marker in text
        for marker in (
            "upstream_overloaded",
            "upstream overload",
            "server overloaded",
            "codex_bad_request",
            "invalid request",
            "invalid params",
            "json-rpc error",
            "scenario_timeout_unresolved",
            "linear_phase_projection_failed",
            "gate_parent_relationship_drift",
            "orchestration_event_rebuild_failed",
        )
    )


def _phase_failure_human_action_description(run, detail: dict[str, Any]) -> str:
    issue_ref = run.issue_identifier or run.issue_id
    reason = detail.get("reason") or run.last_reason or "runtime_error"
    error = detail.get("error") or run.last_error or reason
    lines = [
        "The managed Performer phase hit an execution failure that needs human review.",
        "",
        f"Parent issue: {issue_ref}",
    ]
    http_status = detail.get("http_status")
    if http_status is not None:
        lines.extend(["", f"Upstream HTTP status: {http_status}"])
    lines.extend(
        [
            "",
            "Last error:",
            _safe_multiline_linear_value(error),
            "",
            f"Reason: {_safe_linear_value(reason)}",
            f"Run ID: `{run.run_id}`",
            f"attempt: {run.attempt}",
            f"retry_count: {run.retry_count}",
            f"crash_count: {run.crash_count}",
            f"init_failure_count: {run.init_failure_count}",
            f"overload_count: {run.overload_count}",
            "",
            "Human response:",
            "(Add the answer or decision here when information is required.)",
            "",
            "When finished, move this child issue to Done.",
        ]
    )
    return "\n".join(lines)


def _phase_failure_error_is_summary(value: str) -> bool:
    return value in {"upstream overload exhausted repeatedly", "codex init failed repeatedly"} or not value


def _safe_linear_value(value: Any) -> str:
    text = str(value).replace("\r", " ").replace("\n", " ").strip()
    for marker in ("Bearer ", "token=", "access_token=", "refresh_token=", "api_key="):
        if marker in text:
            text = text.split(marker, 1)[0] + marker + "[redacted]"
    return text[:500]


def _safe_multiline_linear_value(value: Any) -> str:
    text = str(value).replace("\r", " ").strip()
    for marker in ("Bearer ", "token=", "access_token=", "refresh_token=", "api_key="):
        if marker in text:
            text = text.split(marker, 1)[0] + marker + "[redacted]"
    return text[:1000]


def _optional_dispatch_ref(value: Any) -> str | None:
    if isinstance(value, dict):
        value = value.get("id")
    text = str(value or "").strip()
    return text or None


def _blocked_by_issue_ids(value: Any) -> list[str]:
    if not isinstance(value, list):
        return []
    blocked_by: list[str] = []
    seen: set[str] = set()
    for blocker in value:
        candidate = blocker.get("id") if isinstance(blocker, dict) else getattr(blocker, "id", blocker)
        text = str(candidate or "").strip()
        if not text or text in seen:
            continue
        seen.add(text)
        blocked_by.append(text)
    return blocked_by


def _sanitize_codex_profile(value: Any) -> dict[str, Any]:
    if not isinstance(value, dict):
        return {}
    profile: dict[str, Any] = {}
    model = str(value.get("model") or "").strip()
    sandbox = str(value.get("sandbox") or "").strip()
    if model:
        profile["model"] = model
    if sandbox:
        profile["sandbox"] = sandbox
    overrides = value.get("config_overrides")
    if isinstance(overrides, list):
        safe_overrides: list[str] = []
        for item in overrides:
            text = str(item).strip()
            if not text or "=" not in text:
                continue
            key, raw_value = text.split("=", 1)
            lowered_key = key.lower()
            if any(marker in lowered_key for marker in ("api_key", "apikey", "token", "secret", "password")) and not raw_value.strip().startswith("$"):
                continue
            safe_overrides.append(text)
        if safe_overrides:
            profile["config_overrides"] = safe_overrides
    return profile

__all__ = [name for name in globals() if name.startswith("_") or name == "json_stable"]
