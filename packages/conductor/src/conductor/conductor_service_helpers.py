from __future__ import annotations

import json
import socket
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from .conductor_models import InstanceRecord
from .conductor_repository_handoff import (
    repository_handoff_closeout_event,
    repository_handoff_comment,
    repository_handoff_marker,
    repository_integration_description,
)
from .conductor_service_types import PROJECT_LABEL_PREFIX
from performer_api.ops_models import OpsSnapshot, TraceEvent

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
    counts = performer.get("counts") if isinstance(performer.get("counts"), dict) else {}
    return _int(counts.get("retrying"))


def _performer_failure_metric(performer: dict[str, Any]) -> int:
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
    return [f"{PROJECT_LABEL_PREFIX}performer/{instance.name}"]


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


def _pipeline_diagnostic_comment(
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


def _pipeline_failure_needs_human_action(run, detail: dict[str, Any]) -> bool:
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
            "linear_projection_failed",
            "gate_parent_relationship_drift",
            "orchestration_event_rebuild_failed",
        )
    )


def _pipeline_failure_human_action_description(run, detail: dict[str, Any]) -> str:
    issue_ref = run.issue_identifier or run.issue_id
    reason = detail.get("reason") or run.last_reason or "runtime_error"
    error = detail.get("error") or run.last_error or reason
    lines = [
        "The managed Performer pipeline hit an execution failure that needs human review.",
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


def _pipeline_failure_error_is_summary(value: str) -> bool:
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


__all__ = [name for name in globals() if name.startswith("_") or name == "json_stable"]
