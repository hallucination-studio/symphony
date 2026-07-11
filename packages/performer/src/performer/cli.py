from __future__ import annotations

import argparse
import asyncio
import json
import os
from pathlib import Path
from typing import Any

from performer_api.managed_runs import ManagedRunRuntimeWait, ManagedRunTurnContext, WorkItem, WorkItemResultStatus
from performer_api.turns import TurnContext
from performer_api.workflow import Task

from .backend import TurnBackend
from .codex_client import CodexSdkClient
from .codex_config import CodexConfig
from .managed_run_backend import CodexManagedRunBackend


async def run_turn(
    turn_request_path: Path,
    turn_result_path: Path,
    *,
    codex_client: Any | None = None,
) -> dict[str, object]:
    payload = _read_json_object(turn_request_path, "turn request")
    context_payload = payload.get("context") if isinstance(payload.get("context"), dict) else {}
    context = TurnContext.from_dict(context_payload)
    errors = context.validation_errors()
    if errors:
        raise RuntimeError("turn_context_invalid:" + ",".join(errors))

    workspace_path = Path(str(payload.get("workspace_path") or "")).expanduser().resolve()
    backend = TurnBackend(codex_client or _managed_codex_backend())
    thread_id = str(payload.get("thread_id") or "")
    if context.turn_kind == "plan":
        result = await backend.plan(workspace_path, str(payload.get("issue_description") or ""), thread_id=thread_id)
        body: dict[str, object] = {
            "turn_kind": "plan",
            "context": context.to_dict(),
            "thread_id": result.thread_id,
            "plan": result.plan.to_dict(),
            "events": result.events,
        }
    else:
        task_payload = payload.get("task")
        if not isinstance(task_payload, dict):
            raise RuntimeError(f"{context.turn_kind} turn requires task payload")
        task = Task.from_dict(task_payload)
        if task.id != context.task_id:
            raise RuntimeError("turn_context_task_id_mismatch")
        if context.turn_kind == "execute":
            result = await backend.execute(workspace_path, task, thread_id=thread_id)
            body = {
                "turn_kind": "execute",
                "context": context.to_dict(),
                "thread_id": result.thread_id,
                "result": result.result.to_dict(),
                "events": result.events,
            }
        else:
            evidence = payload.get("evidence") if isinstance(payload.get("evidence"), dict) else {}
            result = await backend.gate(workspace_path, task, evidence, thread_id=thread_id)
            body = {
                "turn_kind": "gate",
                "context": context.to_dict(),
                "thread_id": result.thread_id,
                "gate_result": result.result.to_dict(),
                "events": result.events,
            }
    _write_json_atomic(turn_result_path, body)
    return body


def _read_json_object(path: Path, label: str) -> dict[str, Any]:
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise RuntimeError(f"could not read {label}: {path}") from exc
    if not isinstance(payload, dict):
        raise RuntimeError(f"{label} must be a JSON object: {path}")
    return payload


async def run_managed_run_turn(
    turn_request_path: Path,
    turn_result_path: Path,
    *,
    codex_client: Any | None = None,
) -> dict[str, object]:
    try:
        payload = json.loads(turn_request_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise RuntimeError(f"could not read managed-run turn request: {turn_request_path}") from exc
    if not isinstance(payload, dict):
        raise RuntimeError(f"managed-run turn request must be a JSON object: {turn_request_path}")
    context_payload = payload.get("context") if isinstance(payload.get("context"), dict) else {}
    context = ManagedRunTurnContext.from_dict(context_payload)
    errors = context.validation_errors()
    if errors:
        raise RuntimeError("managed_run_turn_context_invalid:" + ",".join(errors))
    backend = CodexManagedRunBackend(codex_client or _managed_codex_backend())
    turn_kind = str(payload.get("turn_kind") or "")
    workspace_path = Path(str(payload.get("workspace_path") or "")).expanduser().resolve()
    if turn_kind == "plan":
        result = await backend.plan_turn(
            workspace_path,
            str(payload.get("issue_description") or ""),
            existing_thread_id=_optional_str(payload.get("thread_id")),
        )
        body: dict[str, object] = {
            "turn_kind": "plan",
            "context": context.to_dict(),
            "thread_id": result.thread_id,
            "plan": result.plan.to_dict(),
            "events": result.events,
        }
    elif turn_kind == "work_item":
        work_item_payload = payload.get("work_item")
        if not isinstance(work_item_payload, dict):
            raise RuntimeError("work_item turn requires work_item payload")
        work_item = WorkItem.from_dict(work_item_payload)
        if context.work_item_id != work_item.id:
            raise RuntimeError("managed_run_turn_context_work_item_mismatch")
        wait = _runtime_wait_probe(payload)
        if wait is not None:
            body = _runtime_wait_body(context, str(payload.get("thread_id") or ""), wait, [{"event": "runtime_wait_probe"}])
        else:
            result = await backend.execute_turn(
                workspace_path,
                work_item,
                thread_id=str(payload.get("thread_id") or ""),
            )
            wait = _runtime_wait_from_events(result.events) if result.result.status_claimed is WorkItemResultStatus.BLOCKED else None
            body = (
                _runtime_wait_body(context, result.thread_id, wait, result.events)
                if wait is not None
                else {
                    "turn_kind": "work_item",
                    "context": context.to_dict(),
                    "thread_id": result.thread_id,
                    "result": result.result.to_dict(),
                    "events": result.events,
                }
            )
    else:
        raise RuntimeError(f"unsupported managed-run turn kind: {turn_kind}")
    _write_json_atomic(turn_result_path, body)
    return body


def _runtime_wait_probe(payload: dict[str, Any]) -> ManagedRunRuntimeWait | None:
    if payload.get("runtime_wait_probe") is not True:
        return None
    return ManagedRunRuntimeWait(
        wait_kind="approval_requested",
        message="Symphony runtime wait probe requires approval.",
    )


def _runtime_wait_from_events(events: list[dict[str, Any]]) -> ManagedRunRuntimeWait | None:
    completed_reviews = _completed_approval_reviews(events)
    completed_without_id = any(
        _runtime_wait_event_name(event) == "item_autoapprovalreview_completed" and not _approval_review_id(event)
        for event in events
        if isinstance(event, dict)
    )
    for event in reversed(events):
        if not isinstance(event, dict):
            continue
        event_name = _runtime_wait_event_name(event)
        if event_name == "item_autoapprovalreview_started":
            review_id = _approval_review_id(event)
            if (review_id and review_id in completed_reviews) or (not review_id and completed_without_id):
                continue
            return ManagedRunRuntimeWait(
                wait_kind=_approval_wait_kind(event),
                message=_runtime_wait_message(event, "Codex requested approval."),
            )
        if event_name == "item_commandexecution_terminalinteraction":
            return ManagedRunRuntimeWait(
                wait_kind="tool_input_required",
                message=_runtime_wait_message(event, "Codex requested terminal input."),
            )
        if event_name == "guardianwarning":
            return ManagedRunRuntimeWait(
                wait_kind="permission_required",
                message=_runtime_wait_message(event, "Codex reported a guardian warning."),
            )
    return None


def _completed_approval_reviews(events: list[dict[str, Any]]) -> set[str]:
    return {
        review_id
        for event in events
        if isinstance(event, dict)
        and _runtime_wait_event_name(event) == "item_autoapprovalreview_completed"
        and (review_id := _approval_review_id(event))
    }


def _runtime_wait_event_name(event: dict[str, Any]) -> str:
    payload = _event_payload(event)
    name = payload.get("type") or payload.get("event") or payload.get("method") or event.get("type") or event.get("event")
    normalized = str(name or "").replace("/", "_").replace(".", "_").replace("-", "_").lower()
    return normalized.removeprefix("sdk_")


def _approval_review_id(event: dict[str, Any]) -> str:
    payload = _event_payload(event)
    return str(payload.get("reviewId") or payload.get("review_id") or event.get("reviewId") or event.get("review_id") or "")


def _approval_wait_kind(event: dict[str, Any]) -> str:
    action = _event_payload(event).get("action")
    action_type = str(action.get("type") or "").lower() if isinstance(action, dict) else ""
    if action_type in {"requestpermissions", "networkaccess"}:
        return "permission_required"
    if action_type == "mcptoolcall":
        return "tool_input_required"
    return "approval_requested"


def _runtime_wait_message(event: dict[str, Any], fallback: str) -> str:
    payload = _event_payload(event)
    action = payload.get("action") if isinstance(payload.get("action"), dict) else {}
    for value in (event.get("message"), payload.get("message"), payload.get("stdin"), action.get("reason")):
        message = str(value or "").strip()
        if message:
            return message
    return fallback


def _event_payload(event: dict[str, Any]) -> dict[str, Any]:
    payload = event.get("payload")
    return payload if isinstance(payload, dict) else event


def _runtime_wait_body(
    context: ManagedRunTurnContext,
    thread_id: str,
    wait: ManagedRunRuntimeWait,
    events: list[dict[str, Any]],
) -> dict[str, object]:
    return {
        "turn_kind": "work_item",
        "context": context.to_dict(),
        "thread_id": thread_id,
        "runtime_wait": wait.to_dict(),
        "events": events,
    }


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Run one Symphony managed-run turn.")
    parser.add_argument("--turn-request-path", required=True, help="Read one managed-run turn request JSON file.")
    parser.add_argument("--turn-result-path", required=True, help="Write one managed-run turn result JSON file.")
    return parser.parse_args(argv)


def _managed_codex_backend() -> CodexSdkClient:
    codex_home = os.environ.get("CODEX_HOME")
    if not codex_home or not Path(codex_home).is_dir():
        raise RuntimeError("managed_codex_home_required")
    return CodexSdkClient(
        CodexConfig(
            model=_env_str("CODEX_MODEL"),
            sdk_codex_bin=_env_str("CODEX_SDK_CODEX_BIN"),
            sandbox=_env_sandbox("CODEX_SANDBOX"),
            config_overrides=_env_config_overrides("CODEX_CONFIG_OVERRIDES"),
            hard_turn_timeout_ms=_env_int("CODEX_HARD_TURN_TIMEOUT_MS", 3_600_000),
            read_timeout_ms=_env_int("CODEX_READ_TIMEOUT_MS", 5_000),
            init_max_attempts=_env_int("CODEX_INIT_MAX_ATTEMPTS", 4),
            init_backoff_ms=_env_int("CODEX_INIT_BACKOFF_MS", 500),
            init_backoff_max_ms=_env_int("CODEX_INIT_BACKOFF_MAX_MS", 8_000),
            overload_max_attempts=_env_int("CODEX_OVERLOAD_MAX_ATTEMPTS", 5),
            overload_initial_delay_ms=_env_int("CODEX_OVERLOAD_INITIAL_DELAY_MS", 250),
            overload_max_delay_ms=_env_int("CODEX_OVERLOAD_MAX_DELAY_MS", 8_000),
        )
    )


def _write_json_atomic(path: Path, payload: dict[str, object]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(payload, separators=(",", ":"), sort_keys=True), encoding="utf-8")
    tmp.replace(path)


def _optional_str(value: Any) -> str | None:
    if value is None:
        return None
    text = str(value).strip()
    return text or None


def _env_str(key: str) -> str | None:
    value = os.environ.get(key)
    if value is None:
        return None
    value = value.strip()
    return value or None


def _env_sandbox(key: str) -> str | None:
    value = _env_str(key)
    return value.replace("-", "_") if value is not None else None


def _env_int(key: str, default: int) -> int:
    value = os.environ.get(key)
    if value is None or not value.strip():
        return default
    try:
        parsed = int(value)
    except ValueError:
        return default
    return parsed if parsed > 0 else default


def _env_config_overrides(key: str) -> tuple[str, ...]:
    raw = os.environ.get(key)
    if raw is None or not raw.strip():
        return ()
    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError:
        return tuple(item for item in raw.split(os.pathsep) if item)
    if not isinstance(parsed, list):
        return ()
    return tuple(str(item) for item in parsed if str(item).strip())


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    try:
        asyncio.run(
            run_turn(
                Path(args.turn_request_path).resolve(),
                Path(args.turn_result_path).resolve(),
            )
        )
        os._exit(0)
    except KeyboardInterrupt:
        return 0
    except Exception as exc:
        print(f"performer startup failed: {exc}", flush=True)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
