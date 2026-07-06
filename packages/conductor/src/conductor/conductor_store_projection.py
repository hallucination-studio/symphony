from __future__ import annotations

import json
import sqlite3
from typing import Any
from uuid import uuid4

from performer_api.phase import RunPhase

from .conductor_models import ConductorSettings, InstanceRecord, utc_now_iso
from .conductor_phase import OrchestrationEvent, OrchestrationRun, new_run, with_updates

def _settings_values(settings: ConductorSettings) -> tuple[Any, ...]:
    return (
        settings.podium_url,
        settings.podium_runtime_id,
        settings.podium_runtime_token,
        settings.podium_proxy_token,
        settings.podium_ws_url,
        settings.runtime_group_id,
        1 if settings.managed_mode else 0,
        settings.conductor_id,
        utc_now_iso(),
    )


def _instance_values(instance: InstanceRecord) -> tuple[Any, ...]:
    return (
        instance.id,
        instance.name,
        instance.repo_source_type,
        instance.repo_source_value,
        instance.resolved_repo_path,
        instance.instance_dir,
        instance.workflow_path,
        instance.workspace_root,
        instance.persistence_path,
        instance.log_path,
        instance.http_port,
        instance.linear_project,
        _json_dumps(instance.linear_filters),
        instance.workflow_profile,
        _json_dumps(instance.workflow_inputs),
        instance.workflow_content,
        instance.workflow_generation_status,
        instance.process_status,
        instance.pid,
        instance.last_exit_code,
        instance.last_error,
        instance.restart_count,
        instance.restart_window_started_at,
        instance.restart_next_at,
        instance.created_at,
        instance.updated_at,
    )


def _instance_from_row(row: sqlite3.Row) -> InstanceRecord:
    return InstanceRecord(
        id=str(row["id"]),
        name=str(row["name"]),
        repo_source_type=row["repo_source_type"],
        repo_source_value=str(row["repo_source_value"]),
        resolved_repo_path=str(row["resolved_repo_path"]),
        instance_dir=str(row["instance_dir"]),
        workflow_path=str(row["workflow_path"]),
        workspace_root=str(row["workspace_root"]),
        persistence_path=str(row["persistence_path"]),
        log_path=str(row["log_path"]),
        http_port=int(row["http_port"]),
        linear_project=str(row["linear_project"]),
        linear_filters=_json_loads_dict(row["linear_filters_json"]),
        workflow_profile=str(row["workflow_profile"]),
        workflow_inputs=_json_loads_dict(row["workflow_inputs_json"]),
        workflow_content=str(row["workflow_content"]),
        workflow_generation_status=row["workflow_generation_status"],
        process_status=row["process_status"],
        pid=row["pid"],
        last_exit_code=row["last_exit_code"],
        last_error=row["last_error"],
        restart_count=int(row["restart_count"] or 0),
        restart_window_started_at=row["restart_window_started_at"],
        restart_next_at=row["restart_next_at"],
        created_at=str(row["created_at"]),
        updated_at=str(row["updated_at"]),
    )


def _orchestration_run_values(run: OrchestrationRun) -> tuple[Any, ...]:
    return (
        run.run_id,
        run.instance_id,
        run.issue_id,
        run.issue_identifier,
        _json_dumps(run.blocked_by),
        run.parent_issue_id,
        run.phase.value,
        run.status,
        run.epoch,
        run.attempt,
        run.workflow_profile,
        run.dispatch_id,
        run.fencing_token,
        run.request_path,
        run.result_path,
        run.workspace_path,
        run.ops_snapshot_path,
        _json_dumps(run.human_action),
        run.human_response,
        run.last_reason,
        run.last_error,
        run.process_pid,
        run.crash_count,
        run.retry_count,
        run.init_failure_count,
        run.overload_count,
        run.next_run_at,
        run.ack_status,
        run.acked_at,
        run.created_at,
        run.updated_at,
    )


def _orchestration_run_from_row(row: sqlite3.Row) -> OrchestrationRun:
    return OrchestrationRun(
        run_id=str(row["run_id"]),
        instance_id=str(row["instance_id"]),
        issue_id=str(row["issue_id"]),
        issue_identifier=row["issue_identifier"],
        blocked_by=_json_loads_list(row["blocked_by_json"]),
        parent_issue_id=row["parent_issue_id"],
        phase=RunPhase(str(row["phase"])),
        status=str(row["status"]),
        epoch=int(row["epoch"] or 1),
        attempt=int(row["attempt"] or 1),
        workflow_profile=row["workflow_profile"],
        dispatch_id=row["dispatch_id"],
        fencing_token=row["fencing_token"],
        request_path=row["request_path"],
        result_path=row["result_path"],
        workspace_path=row["workspace_path"],
        ops_snapshot_path=row["ops_snapshot_path"],
        human_action=_json_loads_dict(row["human_action_json"]),
        human_response=row["human_response"],
        last_reason=row["last_reason"],
        last_error=row["last_error"],
        process_pid=row["process_pid"],
        crash_count=int(row["crash_count"] or 0),
        retry_count=int(row["retry_count"] or 0),
        init_failure_count=int(row["init_failure_count"] or 0),
        overload_count=int(row["overload_count"] or 0),
        next_run_at=row["next_run_at"],
        ack_status=row["ack_status"],
        acked_at=row["acked_at"],
        created_at=str(row["created_at"]),
        updated_at=str(row["updated_at"]),
    )


def _write_orchestration_run_projection(connection: sqlite3.Connection, run: OrchestrationRun) -> None:
    connection.execute(
        """
        INSERT INTO orchestration_runs (
          run_id,
          instance_id,
          issue_id,
          issue_identifier,
          blocked_by_json,
          parent_issue_id,
          phase,
          status,
          epoch,
          attempt,
          workflow_profile,
          dispatch_id,
          fencing_token,
          request_path,
          result_path,
          workspace_path,
          ops_snapshot_path,
          human_action_json,
          human_response,
          last_reason,
          last_error,
          process_pid,
          crash_count,
          retry_count,
          init_failure_count,
          overload_count,
          next_run_at,
          ack_status,
          acked_at,
          created_at,
          updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(run_id) DO UPDATE SET
          instance_id = excluded.instance_id,
          issue_id = excluded.issue_id,
          issue_identifier = excluded.issue_identifier,
          blocked_by_json = excluded.blocked_by_json,
          parent_issue_id = excluded.parent_issue_id,
          phase = excluded.phase,
          status = excluded.status,
          epoch = excluded.epoch,
          attempt = excluded.attempt,
          workflow_profile = excluded.workflow_profile,
          dispatch_id = excluded.dispatch_id,
          fencing_token = excluded.fencing_token,
          request_path = excluded.request_path,
          result_path = excluded.result_path,
          workspace_path = excluded.workspace_path,
          ops_snapshot_path = excluded.ops_snapshot_path,
          human_action_json = excluded.human_action_json,
          human_response = excluded.human_response,
          last_reason = excluded.last_reason,
          last_error = excluded.last_error,
          process_pid = excluded.process_pid,
          crash_count = excluded.crash_count,
          retry_count = excluded.retry_count,
          init_failure_count = excluded.init_failure_count,
          overload_count = excluded.overload_count,
          next_run_at = excluded.next_run_at,
          ack_status = excluded.ack_status,
          acked_at = excluded.acked_at,
          created_at = excluded.created_at,
          updated_at = excluded.updated_at
        """,
        _orchestration_run_values(run),
    )


def _active_run_for_issue(connection: sqlite3.Connection, instance_id: str, issue_id: str) -> OrchestrationRun | None:
    row = connection.execute(
        """
        SELECT *
        FROM orchestration_runs
        WHERE instance_id = ?
          AND issue_id = ?
          AND phase NOT IN ('done', 'failed')
        ORDER BY epoch DESC, created_at DESC, run_id DESC
        LIMIT 1
        """,
        (instance_id, issue_id),
    ).fetchone()
    return _orchestration_run_from_row(row) if row is not None else None


def _project_orchestration_event(current: OrchestrationRun | None, event: OrchestrationEvent) -> OrchestrationRun:
    payload = dict(event.payload)
    if current is None:
        if event.event_type != "dispatch.created":
            raise FileNotFoundError(f"Cannot project {event.event_type} without an existing run")
        return new_run(
            run_id=event.run_id,
            instance_id=event.instance_id,
            issue_id=event.issue_id,
            issue_identifier=_optional_text(payload.get("issue_identifier")),
            blocked_by=_clean_string_list(payload.get("blocked_by")),
            parent_issue_id=_optional_text(payload.get("parent_issue_id")),
            workflow_profile=_optional_text(payload.get("workflow_profile")),
            dispatch_id=_optional_text(payload.get("dispatch_id")),
            fencing_token=_optional_int(payload.get("fencing_token"), default=None),
            epoch=_optional_int(payload.get("epoch"), default=1),
            now=event.created_at,
        )

    changes: dict[str, Any] = {"updated_at": event.created_at}
    if event.to_phase is not None:
        changes["phase"] = event.to_phase
    if event.event_type == "dispatch.duplicate":
        for key in ("issue_identifier", "workflow_profile", "dispatch_id", "fencing_token"):
            if payload.get(key):
                changes[key] = payload[key]
        if "blocked_by" in payload:
            changes["blocked_by"] = _clean_string_list(payload.get("blocked_by"))
        if "parent_issue_id" in payload:
            changes["parent_issue_id"] = _optional_text(payload.get("parent_issue_id"))
    elif event.event_type == "projection.patch":
        changes.update(_normalize_projection_payload(payload))
    elif event.event_type in {
        "performer.started",
        "performer.start_failed",
        "performer.result",
        "performer.init_failed",
        "performer.upstream_overloaded",
        "performer.crashed",
        "human.completed",
        "dispatch.acked",
        "human.failure_child_created",
    }:
        changes.update(_normalize_projection_payload(payload))
    elif event.event_type.startswith("remediation."):
        changes.update(_normalize_projection_payload(payload))
    return with_updates(current, **changes)


def _append_orchestration_event(
    connection: sqlite3.Connection,
    *,
    run_id: str,
    instance_id: str,
    issue_id: str,
    event_type: str,
    from_phase: RunPhase | None,
    to_phase: RunPhase | None,
    reason: str | None,
    payload: dict[str, Any],
    now: str,
) -> str:
    event_id = f"evt-{uuid4().hex}"
    connection.execute(
        """
        INSERT INTO orchestration_events (
          event_id,
          run_id,
          instance_id,
          issue_id,
          event_type,
          from_phase,
          to_phase,
          reason,
          payload_json,
          created_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            event_id,
            run_id,
            instance_id,
            issue_id,
            event_type,
            from_phase.value if from_phase is not None else None,
            to_phase.value if to_phase is not None else None,
            reason,
            _json_dumps(payload),
            now,
        ),
    )
    return event_id


def _orchestration_event_from_row(row: sqlite3.Row) -> OrchestrationEvent:
    return OrchestrationEvent.from_dict(
        {
            "event_id": row["event_id"],
            "run_id": row["run_id"],
            "instance_id": row["instance_id"],
            "issue_id": row["issue_id"],
            "event_type": row["event_type"],
            "from_phase": row["from_phase"],
            "to_phase": row["to_phase"],
            "reason": row["reason"],
            "payload": _json_loads_dict(row["payload_json"]),
            "created_at": row["created_at"],
        }
    )


def _normalize_run_change(key: str, value: Any) -> Any:
    if key == "phase" and isinstance(value, RunPhase):
        return value
    if key == "phase" and value is not None:
        return RunPhase(str(value))
    if key == "status" and hasattr(value, "value"):
        return value.value
    if key == "blocked_by":
        return _clean_string_list(value)
    if key == "parent_issue_id":
        return _optional_text(value)
    return value


def _normalize_projection_payload(payload: dict[str, Any]) -> dict[str, Any]:
    normalized: dict[str, Any] = {}
    allowed = {
        "phase",
        "status",
        "epoch",
        "attempt",
        "workflow_profile",
        "dispatch_id",
        "request_path",
        "result_path",
        "workspace_path",
        "ops_snapshot_path",
        "human_action",
        "human_response",
        "last_reason",
        "last_error",
        "process_pid",
        "crash_count",
        "retry_count",
        "init_failure_count",
        "overload_count",
        "next_run_at",
        "ack_status",
        "acked_at",
        "issue_identifier",
        "blocked_by",
        "parent_issue_id",
    }
    for key, value in payload.items():
        if key not in allowed:
            continue
        if key == "status" and "run_status" in payload:
            continue
        normalized[key] = _normalize_run_change(key, value)
    if "run_status" in payload:
        normalized["status"] = _normalize_run_change("status", payload["run_status"])
    return normalized


def _event_payload(event: OrchestrationEvent | dict[str, Any]) -> dict[str, Any]:
    if isinstance(event, OrchestrationEvent):
        return dict(event.payload)
    value = event.get("payload", {})
    return dict(value) if isinstance(value, dict) else {}


def _event_field(event: OrchestrationEvent | dict[str, Any], key: str) -> str:
    value = _event_value(event, key)
    return str(value or "")


def _event_value(event: OrchestrationEvent | dict[str, Any], key: str) -> Any:
    if isinstance(event, OrchestrationEvent):
        return getattr(event, key)
    return event.get(key)


def _event_phase(event: OrchestrationEvent | dict[str, Any], key: str) -> RunPhase | None:
    value = _event_value(event, key)
    if isinstance(value, RunPhase):
        return value
    if value is None:
        return None
    text = str(value)
    return RunPhase(text) if text else None


def _phase_value(value: RunPhase | str) -> str:
    return value.value if isinstance(value, RunPhase) else str(value)


def _optional_text(value: Any) -> str | None:
    if value is None:
        return None
    text = str(value)
    return text if text else None


def _optional_int(value: Any, *, default: int) -> int:
    if isinstance(value, bool):
        return default
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def _ensure_column(connection: sqlite3.Connection, table: str, name: str, definition: str) -> None:
    columns = {str(row["name"]) for row in connection.execute(f"PRAGMA table_info({table})").fetchall()}
    if name not in columns:
        connection.execute(f"ALTER TABLE {table} ADD COLUMN {name} {definition}")


def _runtime_action_from_row(row: sqlite3.Row) -> dict[str, Any]:
    data = dict(row)
    data["payload"] = _json_loads_dict(data.pop("payload_json"))
    return data


def _json_dumps(value: Any) -> str:
    return json.dumps(value, separators=(",", ":"), sort_keys=True)


def _json_loads_dict(value: Any) -> dict[str, Any]:
    if not value:
        return {}
    payload = json.loads(str(value))
    return payload if isinstance(payload, dict) else {}


def _json_loads_list(value: Any) -> list[str]:
    if not value:
        return []
    payload = json.loads(str(value))
    return _clean_string_list(payload)


def _clean_string_list(value: Any) -> list[str]:
    if not isinstance(value, list):
        return []
    cleaned: list[str] = []
    seen: set[str] = set()
    for item in value:
        text = str(item or "").strip()
        if not text or text in seen:
            continue
        seen.add(text)
        cleaned.append(text)
    return cleaned

__all__ = [name for name in globals() if name.startswith("_") and name != "__builtins__"]
