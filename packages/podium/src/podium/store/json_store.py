from __future__ import annotations

import json
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from ..models import OnboardingProgress, OnboardingStep, RepositoryMapping, RuntimeRecord
from ..podium_shared import _datetime_from_json, utc_now_iso


class PodiumStore:
    """JSON-backed Podium state store used by tests.

    The object stores only its root path. Every operation reads and writes JSON
    files so tests exercise the same restart-safe shape as the PostgreSQL store.
    """

    def __init__(self, data_dir: str | Path | None = None) -> None:
        self.data_dir = Path(data_dir) if data_dir is not None else Path(tempfile.mkdtemp(prefix="podium-json-store-"))
        self.data_dir.mkdir(parents=True, exist_ok=True)

    def _path(self, name: str) -> Path:
        return self.data_dir / name

    def _load_map(self, name: str) -> dict[str, Any]:
        path = self._path(name)
        if not path.exists():
            return {}
        try:
            payload = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return {}
        return payload if isinstance(payload, dict) else {}

    def _load_list(self, name: str) -> list[Any]:
        path = self._path(name)
        if not path.exists():
            return []
        try:
            payload = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return []
        return payload if isinstance(payload, list) else []

    def _write(self, name: str, payload: Any) -> None:
        path = self._path(name)
        tmp = path.with_name(f"{path.name}.tmp")
        tmp.write_text(json.dumps(payload, indent=2, sort_keys=True), encoding="utf-8")
        tmp.replace(path)

    def _next_id(self, prefix: str, name: str) -> str:
        rows = self._load_map(name)
        used: set[int] = set()
        for key in rows:
            if key.startswith(prefix):
                try:
                    used.add(int(key.removeprefix(prefix)))
                except ValueError:
                    continue
        index = 1
        while index in used:
            index += 1
        return f"{prefix}{index}"

    # Legacy synchronous API used by small service unit tests.
    def save_runtime_record(self, record: RuntimeRecord) -> None:
        rows = self._load_map("runtimes.json")
        rows[record.runtime_id] = record.to_dict()
        self._write("runtimes.json", rows)

    def get_runtime_record(self, runtime_id: str) -> RuntimeRecord | None:
        row = self._load_map("runtimes.json").get(runtime_id)
        return RuntimeRecord.from_dict(row) if isinstance(row, dict) else None

    def list_runtime_records(self) -> list[RuntimeRecord]:
        return [
            RuntimeRecord.from_dict(row)
            for row in self._load_map("runtimes.json").values()
            if isinstance(row, dict)
        ]

    def update_runtime_heartbeat(
        self,
        runtime_id: str,
        *,
        version: str | None = None,
        metadata: dict[str, Any] | None = None,
        timestamp: str | None = None,
    ) -> RuntimeRecord:
        existing = self.get_runtime_record(runtime_id)
        record = RuntimeRecord(
            runtime_id=runtime_id,
            online=True,
            last_heartbeat=timestamp or utc_now_iso(),
            version=version if version is not None else (existing.version if existing else None),
            metadata=metadata if metadata is not None else (existing.metadata if existing else {}),
        )
        self.save_runtime_record(record)
        return record

    def save_onboarding_progress(self, workspace_id: str, progress: OnboardingProgress) -> None:
        rows = self._load_map("legacy_onboarding.json")
        rows[workspace_id] = progress.to_dict()
        self._write("legacy_onboarding.json", rows)

    def get_onboarding_progress(self, workspace_id: str) -> OnboardingProgress | None:
        row = self._load_map("legacy_onboarding.json").get(workspace_id)
        return OnboardingProgress.from_dict(row) if isinstance(row, dict) else None

    def get_or_create_onboarding_progress(self, workspace_id: str) -> OnboardingProgress:
        progress = self.get_onboarding_progress(workspace_id)
        if progress is None:
            progress = OnboardingProgress(
                current_step=OnboardingStep.LINEAR_CONNECT,
                completed_steps=[],
                next_action=OnboardingStep.LINEAR_CONNECT.value,
            )
            self.save_onboarding_progress(workspace_id, progress)
        return progress

    def save_repository_mapping(self, workspace_id: str, mapping: RepositoryMapping) -> None:
        rows = self._load_map("repositories.json")
        rows[workspace_id] = mapping.to_dict()
        self._write("repositories.json", rows)

    def get_repository_mapping(self, workspace_id: str) -> RepositoryMapping | None:
        row = self._load_map("repositories.json").get(workspace_id)
        return RepositoryMapping.from_dict(row) if isinstance(row, dict) else None

    def save_user(self, user_id: str, user: dict[str, Any]) -> None:
        rows = self._load_map("users.json")
        rows[user_id] = dict(user)
        self._write("users.json", rows)

    # Async app state API.
    async def next_user_id(self) -> str:
        return self._next_id("user_", "users.json")

    async def create_user(self, user_id: str, *, email: str, password_hash: str, created_at: str) -> dict[str, Any]:
        rows = self._load_map("users.json")
        user = {"id": user_id, "email": email, "password_hash": password_hash, "created_at": created_at, "linear_app": None}
        rows[user_id] = user
        self._write("users.json", rows)
        return dict(user)

    async def get_user(self, user_id: str) -> dict[str, Any] | None:
        row = self._load_map("users.json").get(user_id)
        return dict(row) if isinstance(row, dict) else None

    async def get_user_by_email(self, email: str) -> dict[str, Any] | None:
        for row in self._load_map("users.json").values():
            if isinstance(row, dict) and str(row.get("email") or "") == email:
                return dict(row)
        return None

    async def set_user_linear_app(self, user_id: str, linear_app: dict[str, Any] | None) -> None:
        rows = self._load_map("users.json")
        user = rows.get(user_id)
        if not isinstance(user, dict):
            return
        user["linear_app"] = linear_app
        rows[user_id] = user
        self._write("users.json", rows)

    async def save_session(self, token_hash: str, *, user_id: str, expires_at: str) -> None:
        rows = self._load_map("sessions.json")
        current = rows.get(token_hash) if isinstance(rows.get(token_hash), dict) else {}
        rows[token_hash] = {"user_id": user_id, "expires_at": expires_at, "revoked": bool(current.get("revoked"))}
        self._write("sessions.json", rows)

    async def get_session(self, token_hash: str) -> dict[str, Any] | None:
        row = self._load_map("sessions.json").get(token_hash)
        if not isinstance(row, dict):
            return None
        expires_at = _datetime_from_json(str(row.get("expires_at") or ""))
        if expires_at is not None and expires_at < datetime.now(timezone.utc):
            return None
        return dict(row)

    async def revoke_session(self, token_hash: str) -> None:
        rows = self._load_map("sessions.json")
        row = rows.get(token_hash)
        if isinstance(row, dict):
            row["revoked"] = True
            rows[token_hash] = row
            self._write("sessions.json", rows)

    async def upsert_runtime_group(self, group: dict[str, Any]) -> None:
        rows = self._load_map("runtime_groups.json")
        rows[str(group["id"])] = dict(group)
        self._write("runtime_groups.json", rows)

    async def get_runtime_group(self, group_id: str) -> dict[str, Any] | None:
        row = self._load_map("runtime_groups.json").get(group_id)
        return dict(row) if isinstance(row, dict) else None

    async def list_runtime_groups(self) -> list[dict[str, Any]]:
        return [dict(row) for row in self._load_map("runtime_groups.json").values() if isinstance(row, dict)]

    async def save_enrollment_token(self, token_hash: str, *, runtime_group_id: str, expires_at: str) -> None:
        rows = self._load_map("enrollment_tokens.json")
        rows[token_hash] = {"runtime_group_id": runtime_group_id, "used": False, "expires_at": expires_at}
        self._write("enrollment_tokens.json", rows)

    async def consume_enrollment_token(self, token_hash: str) -> tuple[dict[str, Any] | None, str | None]:
        rows = self._load_map("enrollment_tokens.json")
        row = rows.get(token_hash)
        if not isinstance(row, dict):
            return None, "invalid_enrollment_token"
        if bool(row.get("used")):
            return None, "enrollment_token_used"
        expires_at = _datetime_from_json(str(row.get("expires_at") or ""))
        if expires_at is not None and expires_at < datetime.now(timezone.utc):
            return None, "enrollment_token_expired"
        row["used"] = True
        rows[token_hash] = row
        self._write("enrollment_tokens.json", rows)
        return dict(row), None

    async def has_pending_enrollment(self, runtime_group_id: str) -> bool:
        now = datetime.now(timezone.utc)
        for row in self._load_map("enrollment_tokens.json").values():
            if not isinstance(row, dict) or bool(row.get("used")):
                continue
            expires_at = _datetime_from_json(str(row.get("expires_at") or ""))
            if str(row.get("runtime_group_id") or "") == runtime_group_id and (expires_at is None or expires_at >= now):
                return True
        return False

    async def upsert_conductor(self, conductor: dict[str, Any]) -> None:
        rows = self._load_map("conductors.json")
        rows[str(conductor["id"])] = dict(conductor)
        self._write("conductors.json", rows)

    async def get_runtime(self, runtime_id: str) -> dict[str, Any] | None:
        row = self._load_map("conductors.json").get(runtime_id)
        return _runtime_from_conductor(row) if isinstance(row, dict) else None

    async def get_runtime_by_token_hash(self, token_hash: str, *, proxy: bool = False) -> dict[str, Any] | None:
        field = "proxy_token_hash" if proxy else "runtime_token_hash"
        for row in self._load_map("conductors.json").values():
            if isinstance(row, dict) and str(row.get(field) or "") == token_hash:
                return _runtime_from_conductor(row)
        return None

    async def list_conductors_for_user(self, user_id: str) -> list[dict[str, Any]]:
        rows = [
            dict(row)
            for row in self._load_map("conductors.json").values()
            if isinstance(row, dict) and str(row.get("user_id") or "") == user_id
        ]
        return sorted(rows, key=lambda row: str(row.get("created_at") or ""))

    async def upsert_project_binding(self, binding: dict[str, Any]) -> None:
        rows = self._load_map("project_bindings.json")
        rows[str(binding["id"])] = dict(binding)
        self._write("project_bindings.json", rows)
        await self.upsert_runtime_group(
            {
                "id": str(binding["id"]),
                "linear_workspace_id": str(binding.get("user_id") or ""),
                "project_slug": str(binding.get("project_slug") or ""),
                "linear_agent_app_user_id": str(binding.get("agent_app_user_id") or ""),
                "pipeline_profile": str(binding.get("pipeline_profile") or "default"),
                "project_binding_id": str(binding["id"]),
            }
        )

    async def list_project_bindings_for_conductor(self, conductor_id: str) -> list[dict[str, Any]]:
        rows = [
            dict(row)
            for row in self._load_map("project_bindings.json").values()
            if isinstance(row, dict) and str(row.get("conductor_id") or "") == conductor_id
        ]
        return sorted(rows, key=lambda row: str(row.get("id") or ""))

    async def list_project_bindings_for_route(self, *, user_id: str, project_slug: str, agent_app_user_ids: list[str]) -> list[dict[str, Any]]:
        expected_agents = {str(agent_id) for agent_id in agent_app_user_ids if str(agent_id)}
        return [
            dict(row)
            for row in self._load_map("project_bindings.json").values()
            if isinstance(row, dict)
            and str(row.get("user_id") or "") == user_id
            and str(row.get("project_slug") or "") == project_slug
            and (not str(row.get("agent_app_user_id") or "") or str(row.get("agent_app_user_id") or "") in expected_agents)
        ]

    async def upsert_dispatch(self, dispatch: dict[str, Any]) -> bool:
        rows = self._load_map("dispatches.json")
        for existing in rows.values():
            if not isinstance(existing, dict):
                continue
            same_binding = existing.get("project_binding_id") == dispatch.get("project_binding_id")
            if same_binding and str(dispatch.get("agent_session_id") or ""):
                if existing.get("agent_session_id") == dispatch.get("agent_session_id"):
                    return False
            elif same_binding and existing.get("issue_id") == dispatch.get("issue_id") and not str(existing.get("agent_session_id") or ""):
                return False
        rows[str(dispatch["dispatch_id"])] = dict(dispatch)
        self._write("dispatches.json", rows)
        return True

    async def lease_dispatch(self, conductor_id: str, *, binding_ids: list[str], lease_until: str) -> dict[str, Any] | None:
        rows = self._load_map("dispatches.json")
        now = datetime.now(timezone.utc)
        for dispatch_id, dispatch in sorted(rows.items(), key=lambda item: str((item[1] or {}).get("created_at") or "")):
            if not isinstance(dispatch, dict) or dispatch.get("project_binding_id") not in binding_ids:
                continue
            leased_until = _datetime_from_json(str(dispatch.get("leased_until") or ""))
            retryable = dispatch.get("status") == "leased" and leased_until is not None and leased_until < now
            if dispatch.get("status") != "queued" and not retryable:
                continue
            dispatch["status"] = "leased"
            dispatch["leased_runtime_id"] = conductor_id
            dispatch["leased_conductor_id"] = conductor_id
            dispatch["leased_until"] = lease_until
            dispatch["fencing_token"] = int(dispatch.get("fencing_token") or 0) + 1
            dispatch["updated_at"] = utc_now_iso()
            rows[dispatch_id] = dispatch
            self._write("dispatches.json", rows)
            return dict(dispatch)
        return None

    async def ack_dispatch(
        self,
        conductor_id: str,
        dispatch_id: str,
        status: str,
        *,
        fencing_token: int | None,
        reason: str = "",
        pipeline: dict[str, Any] | None = None,
        completed_at: str | None = None,
    ) -> dict[str, Any] | None:
        rows = self._load_map("dispatches.json")
        dispatch = rows.get(dispatch_id)
        if not isinstance(dispatch, dict) or fencing_token is None:
            return None
        if (dispatch.get("leased_runtime_id") or dispatch.get("leased_conductor_id")) != conductor_id:
            return None
        if int(dispatch.get("fencing_token") or 0) != int(fencing_token):
            return None
        dispatch["status"] = status
        dispatch["reason"] = reason
        if pipeline:
            dispatch.update(pipeline)
        dispatch["updated_at"] = utc_now_iso()
        if completed_at is not None:
            dispatch["completed_at"] = completed_at
        elif status in {"completed", "failed", "cancelled", "canceled"}:
            dispatch["completed_at"] = dispatch["updated_at"]
        rows[dispatch_id] = dispatch
        self._write("dispatches.json", rows)
        return dict(dispatch)

    async def reap_expired_dispatch_leases(self) -> int:
        rows = self._load_map("dispatches.json")
        now = datetime.now(timezone.utc)
        reaped = 0
        for dispatch_id, dispatch in rows.items():
            if not isinstance(dispatch, dict) or dispatch.get("status") != "leased":
                continue
            leased_until = _datetime_from_json(str(dispatch.get("leased_until") or ""))
            if leased_until is not None and leased_until < now:
                dispatch["status"] = "queued"
                dispatch["leased_runtime_id"] = None
                dispatch["leased_conductor_id"] = None
                dispatch["leased_until"] = None
                dispatch["updated_at"] = utc_now_iso()
                rows[dispatch_id] = dispatch
                reaped += 1
        if reaped:
            self._write("dispatches.json", rows)
        return reaped

    async def save_onboarding_state(self, user_id: str, completed_steps: list[str], metadata: dict[str, Any]) -> None:
        rows = self._load_map("onboarding_state.json")
        rows[user_id] = {"completed_steps": list(completed_steps), "metadata": dict(metadata), "updated_at": utc_now_iso()}
        self._write("onboarding_state.json", rows)

    async def get_onboarding_state(self, user_id: str) -> dict[str, Any] | None:
        row = self._load_map("onboarding_state.json").get(user_id)
        return dict(row) if isinstance(row, dict) else None

    async def save_smoke_result(self, user_id: str, result: dict[str, Any]) -> None:
        rows = self._load_map("smoke_results.json")
        rows[user_id] = dict(result)
        self._write("smoke_results.json", rows)

    async def get_smoke_result(self, user_id: str) -> dict[str, Any] | None:
        row = self._load_map("smoke_results.json").get(user_id)
        return dict(row) if isinstance(row, dict) else None

    async def save_linear_installation(self, workspace_id: str, installation: dict[str, Any]) -> None:
        rows = self._load_map("linear_installations.json")
        rows[workspace_id] = dict(installation)
        self._write("linear_installations.json", rows)

    async def get_linear_installation(self, workspace_id: str) -> dict[str, Any] | None:
        row = self._load_map("linear_installations.json").get(workspace_id)
        return dict(row) if isinstance(row, dict) else None

    async def save_linear_poll_state(self, binding_id: str, state: dict[str, Any]) -> None:
        rows = self._load_map("linear_poll_state.json")
        rows[binding_id] = {"binding_id": binding_id, **dict(state)}
        self._write("linear_poll_state.json", rows)

    async def get_linear_poll_state(self, binding_id: str) -> dict[str, Any] | None:
        row = self._load_map("linear_poll_state.json").get(binding_id)
        return dict(row) if isinstance(row, dict) else None

    async def save_oauth_state(self, state: str, *, workspace_id: str, expires_at: str) -> None:
        rows = self._load_map("oauth_states.json")
        rows[state] = {"workspace_id": workspace_id, "expires_at": expires_at}
        self._write("oauth_states.json", rows)

    async def consume_oauth_state(self, state: str) -> str | None:
        rows = self._load_map("oauth_states.json")
        row = rows.pop(state, None)
        self._write("oauth_states.json", rows)
        if not isinstance(row, dict):
            return None
        expires_at = _datetime_from_json(str(row.get("expires_at") or ""))
        if expires_at is not None and expires_at < datetime.now(timezone.utc):
            return None
        return str(row.get("workspace_id") or "") or None

    async def set_presence(self, runtime_id: str, *, timestamp: str, expires_at: str) -> None:
        rows = self._load_map("runtime_presence.json")
        rows[runtime_id] = {"runtime_id": runtime_id, "last_seen_at": timestamp, "expires_at": expires_at}
        self._write("runtime_presence.json", rows)

    async def clear_presence(self, runtime_id: str) -> None:
        rows = self._load_map("runtime_presence.json")
        rows.pop(runtime_id, None)
        self._write("runtime_presence.json", rows)

    async def get_presence(self, runtime_id: str) -> dict[str, Any] | None:
        row = self._load_map("runtime_presence.json").get(runtime_id)
        if not isinstance(row, dict):
            return None
        expires_at = _datetime_from_json(str(row.get("expires_at") or ""))
        if expires_at is not None and expires_at < datetime.now(timezone.utc):
            return None
        return dict(row)

    async def upsert_metrics_snapshot(self, conductor_id: str, instance_id: str, metrics: dict[str, Any]) -> None:
        rows = self._load_map("metrics_snapshots.json")
        rows[f"{conductor_id}\t{instance_id}"] = dict(metrics)
        self._write("metrics_snapshots.json", rows)

    async def get_metrics_snapshot(self, conductor_id: str, instance_id: str) -> dict[str, Any] | None:
        row = self._load_map("metrics_snapshots.json").get(f"{conductor_id}\t{instance_id}")
        return dict(row) if isinstance(row, dict) else None

    async def upsert_instance_log_tail(self, conductor_id: str, instance_id: str, tail: dict[str, Any]) -> None:
        rows = self._load_map("instance_log_tails.json")
        rows[f"{conductor_id}\t{instance_id}"] = dict(tail)
        self._write("instance_log_tails.json", rows)

    async def get_instance_log_tail(self, conductor_id: str, instance_id: str) -> dict[str, Any] | None:
        row = self._load_map("instance_log_tails.json").get(f"{conductor_id}\t{instance_id}")
        return dict(row) if isinstance(row, dict) else None

    async def save_log_fetch_result(self, request_id: str, result: dict[str, Any]) -> None:
        rows = self._load_map("log_fetch_results.json")
        rows[request_id] = dict(result)
        self._write("log_fetch_results.json", rows)

    async def get_log_fetch_result(self, request_id: str) -> dict[str, Any] | None:
        row = self._load_map("log_fetch_results.json").get(request_id)
        return dict(row) if isinstance(row, dict) else None

    async def save_runtime_config(self, runtime_group_id: str, config: dict[str, Any]) -> None:
        rows = self._load_map("runtime_configs.json")
        rows[runtime_group_id] = dict(config)
        self._write("runtime_configs.json", rows)

    async def get_runtime_config(self, runtime_group_id: str) -> dict[str, Any] | None:
        row = self._load_map("runtime_configs.json").get(runtime_group_id)
        return dict(row) if isinstance(row, dict) else None

    async def save_pipeline_view(self, runtime_group_id: str, view: dict[str, Any]) -> None:
        rows = self._load_map("pipeline_views.json")
        rows[runtime_group_id] = dict(view)
        self._write("pipeline_views.json", rows)

    async def get_pipeline_view(self, runtime_group_id: str) -> dict[str, Any] | None:
        row = self._load_map("pipeline_views.json").get(runtime_group_id)
        return dict(row) if isinstance(row, dict) else None

    async def append_runtime_command(self, runtime_id: str, command: dict[str, Any]) -> dict[str, Any]:
        rows = self._load_map("runtime_commands.json")
        commands = rows.get(runtime_id) if isinstance(rows.get(runtime_id), list) else []
        command_id = len(commands) + 1
        row = {"id": command_id, "runtime_id": runtime_id, "command": dict(command), "created_at": utc_now_iso(), "delivered": False}
        commands.append(row)
        rows[runtime_id] = commands
        self._write("runtime_commands.json", rows)
        return row

    async def next_runtime_command(self, runtime_id: str, *, after_id: int = 0) -> dict[str, Any] | None:
        rows = self._load_map("runtime_commands.json")
        commands = rows.get(runtime_id) if isinstance(rows.get(runtime_id), list) else []
        for row in commands:
            if isinstance(row, dict) and int(row.get("id") or 0) > after_id:
                return dict(row)
        return None

    async def insert_proxy_audit_event(self, event: dict[str, Any]) -> None:
        rows = self._load_list("proxy_audit_events.json")
        rows.append(dict(event))
        self._write("proxy_audit_events.json", rows)


def _runtime_from_conductor(row: dict[str, Any]) -> dict[str, Any]:
    user_id = str(row.get("user_id") or "")
    return {
        "id": str(row["id"]),
        "runtime_group_id": str(row.get("runtime_group_id") or f"group_{user_id}"),
        "user_id": user_id,
        "runtime_token_hash": str(row.get("runtime_token_hash") or ""),
        "proxy_token_hash": str(row.get("proxy_token_hash") or ""),
        "disabled": bool(row.get("disabled")),
        "revoked": bool(row.get("revoked")),
        "created_at": str(row.get("created_at") or ""),
        "hostname": str(row.get("hostname") or ""),
        "label": str(row.get("label") or ""),
        "version": str(row.get("version") or ""),
    }
