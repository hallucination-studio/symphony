from __future__ import annotations

import asyncio
import hmac
import secrets
from datetime import datetime, timedelta, timezone
from typing import Any

from fastapi import FastAPI, WebSocket

from .store.postgres import PgStore
from .store.redis import RedisStore

from .podium_shared import (
    bearer_token,
    dispatch_public,
    hash_secret,
    sanitize_codex_profile,
    utc_now_iso,
    _datetime_from_json,
)

class PodiumRuntimeMixin:
    def ensure_conductor_record(self, runtime_id: str) -> dict[str, Any]:
        runtime = self.runtimes[runtime_id]
        group = self.runtime_groups.get(str(runtime.get("runtime_group_id") or ""), {})
        user_id = str(runtime.get("user_id") or group.get("linear_workspace_id") or "")
        conductor = self.conductors.get(runtime_id)
        if conductor is None:
            conductor = {
                "id": runtime_id,
                "conductor_id": runtime_id,
                "user_id": user_id,
                "hostname": "",
                "label": "",
                "version": "",
                "disabled": bool(runtime.get("disabled")),
                "revoked": bool(runtime.get("revoked")),
                "created_at": runtime.get("created_at") or utc_now_iso(),
                "last_report_at": None,
            }
            self.conductors[runtime_id] = conductor
            self.persist()
        elif user_id and not conductor.get("user_id"):
            conductor["user_id"] = user_id
            self.persist()
        return conductor

    async def apply_runtime_report(self, runtime_id: str, payload: dict[str, Any]) -> dict[str, Any]:
        conductor = self.ensure_conductor_record(runtime_id)
        for key in ("hostname", "label", "version"):
            if key in payload:
                conductor[key] = str(payload.get(key) or "")
        conductor["last_report_at"] = utc_now_iso()
        if self.pg_store is not None:
            runtime = self.runtimes.get(runtime_id, {})
            await self.pg_store.upsert_conductor(
                {
                    **conductor,
                    "runtime_token_hash": runtime.get("runtime_token_hash") or "",
                    "proxy_token_hash": runtime.get("proxy_token_hash") or "",
                }
            )
        bindings = payload.get("bindings") if isinstance(payload.get("bindings"), list) else []
        metrics = payload.get("metrics") if isinstance(payload.get("metrics"), dict) else {}
        queue = payload.get("queue") if isinstance(payload.get("queue"), dict) else {}
        log_tail = payload.get("log_tail") if isinstance(payload.get("log_tail"), dict) else {}
        upserted = 0
        for raw_binding in bindings:
            if not isinstance(raw_binding, dict):
                continue
            instance_id = str(raw_binding.get("instance_id") or "").strip()
            if not instance_id:
                continue
            binding_id = f"{runtime_id}:{instance_id}"
            binding = {
                "id": binding_id,
                "conductor_id": runtime_id,
                "user_id": str(conductor.get("user_id") or ""),
                "instance_id": instance_id,
                "name": str(raw_binding.get("name") or instance_id),
                "linear_project": str(raw_binding.get("linear_project") or ""),
                "project_slug": str(raw_binding.get("project_slug") or raw_binding.get("linear_project") or ""),
                "agent_app_user_id": str(raw_binding.get("agent_app_user_id") or raw_binding.get("linear_agent_app_user_id") or ""),
                "workflow_profile": str(raw_binding.get("workflow_profile") or "task"),
                "codex_profile": sanitize_codex_profile(raw_binding.get("codex_profile")),
                "process_status": str(raw_binding.get("process_status") or ""),
                "constraint_labels": [
                    str(label)
                    for label in (raw_binding.get("constraint_labels") or [])
                    if isinstance(label, str) and label
                ],
                "repo_source": raw_binding.get("repo_source") if isinstance(raw_binding.get("repo_source"), dict) else {},
                "updated_at": utc_now_iso(),
            }
            self.project_bindings[binding_id] = binding
            if self.pg_store is not None:
                await self.pg_store.upsert_project_binding(binding)
            self.runtime_groups[binding_id] = {
                "id": binding_id,
                "linear_workspace_id": binding["user_id"],
                "project_slug": binding["project_slug"],
                "linear_agent_app_user_id": binding["agent_app_user_id"],
                "workflow_profile": binding["workflow_profile"],
                "codex_profile": binding["codex_profile"],
                "project_binding_id": binding_id,
            }
            instance_metrics = metrics.get(instance_id) if isinstance(metrics.get(instance_id), dict) else {}
            instance_queue = queue.get(instance_id) if isinstance(queue.get(instance_id), dict) else {}
            queue_depth = int(instance_queue.get("queue_depth") or instance_queue.get("queued") or 0) + int(instance_queue.get("leased") or 0)
            self.metrics_snapshots[(runtime_id, instance_id)] = {
                "tokens": int(instance_metrics.get("tokens") or 0),
                "runtime_seconds": float(instance_metrics.get("runtime_seconds") or 0),
                "retries": int(instance_metrics.get("retries") or 0),
                "continuations": int(instance_metrics.get("continuations") or 0),
                "blocked": int(instance_metrics.get("blocked") or 0),
                "pending_human": int(instance_metrics.get("pending_human") or 0),
                "failures": int(instance_metrics.get("failures") or 0),
                "queue_depth": queue_depth,
                "running": bool(instance_queue.get("running") or binding["process_status"] == "running"),
                "captured_at": conductor["last_report_at"],
            }
            tail = log_tail.get(instance_id) if isinstance(log_tail.get(instance_id), dict) else None
            if tail is not None:
                self.instance_log_tails[(runtime_id, instance_id)] = {
                    "generation": tail.get("generation"),
                    "offset_end": int(tail.get("offset_end") or 0),
                    "updated_at": conductor["last_report_at"],
                    "lines": list(tail.get("lines") or []),
                }
            upserted += 1
        self.persist()
        return {"status": "ok", "bindings_upserted": upserted}

    async def is_runtime_online(self, runtime_id: str) -> bool:
        if self.redis_store is not None:
            return bool(await self.redis_store.get_conductor_owner(runtime_id))
        return runtime_id in self.presence

    async def presence_snapshot(self, runtime_ids: list[str]) -> dict[str, str]:
        snapshot: dict[str, str] = {}
        for runtime_id in runtime_ids:
            if await self.is_runtime_online(runtime_id):
                snapshot[runtime_id] = self.presence.get(runtime_id) or utc_now_iso()
        return snapshot

    async def list_conductors_for_user(self, user_id: str) -> list[dict[str, Any]]:
        if self.pg_store is not None:
            for conductor in await self.pg_store.list_conductors_for_user(user_id):
                conductor_id = str(conductor["id"])
                self.conductors[conductor_id] = conductor
                self.runtimes[conductor_id] = {
                    "id": conductor_id,
                    "runtime_group_id": f"group_{user_id}",
                    "user_id": user_id,
                    "runtime_token_hash": str(conductor.get("runtime_token_hash") or ""),
                    "proxy_token_hash": str(conductor.get("proxy_token_hash") or ""),
                    "disabled": bool(conductor.get("disabled")),
                    "revoked": bool(conductor.get("revoked")),
                    "created_at": str(conductor.get("created_at") or ""),
                }
                for binding in await self.pg_store.list_project_bindings_for_conductor(conductor_id):
                    binding_id = str(binding.get("id") or "")
                    if binding_id:
                        self.project_bindings[binding_id] = binding
                        self.runtime_groups[binding_id] = self._runtime_group_from_project_binding(binding)
        rows = [self.ensure_conductor_record(runtime_id) for runtime_id in self.runtimes]
        conductors = [row for row in rows if str(row.get("user_id") or "") == user_id]
        result: list[dict[str, Any]] = []
        for conductor in sorted(conductors, key=lambda row: str(row.get("created_at") or "")):
            conductor_id = str(conductor["id"])
            bindings = [
                self.binding_public(binding)
                for binding in self.project_bindings.values()
                if str(binding.get("conductor_id") or "") == conductor_id
            ]
            bindings.sort(key=lambda row: str(row.get("project_slug") or ""))
            result.append(
                {
                    "id": conductor_id,
                    "conductor_id": conductor_id,
                    "runtime_id": conductor_id,
                    "hostname": conductor.get("hostname") or "",
                    "label": conductor.get("label") or "",
                    "version": conductor.get("version") or "",
                    "online": await self.is_runtime_online(conductor_id),
                    "last_report_at": conductor.get("last_report_at"),
                    "bindings": bindings,
                }
            )
        return result

    def binding_public(self, binding: dict[str, Any]) -> dict[str, Any]:
        conductor_id = str(binding.get("conductor_id") or "")
        instance_id = str(binding.get("instance_id") or "")
        metrics = self.metrics_snapshots.get((conductor_id, instance_id), {})
        return {**binding, "metrics": metrics, "queue": {"queue_depth": metrics.get("queue_depth", 0), "running": metrics.get("running", False)}}

    def conductor_belongs_to_user(self, conductor_id: str, user_id: str) -> bool:
        conductor = self.ensure_conductor_record(conductor_id) if conductor_id in self.runtimes else None
        return conductor is not None and str(conductor.get("user_id") or "") == user_id

    async def attach_runtime_ws(self, runtime_id: str) -> asyncio.Queue[dict[str, Any]]:
        queue: asyncio.Queue[dict[str, Any]] = asyncio.Queue()
        self.ws_queues[runtime_id] = queue
        await self.set_presence(runtime_id)
        return queue

    async def detach_runtime_ws(self, runtime_id: str) -> None:
        self.ws_queues.pop(runtime_id, None)
        await self.clear_presence(runtime_id)

    async def enqueue_runtime_command(self, runtime_id: str, command: dict[str, Any]) -> dict[str, Any]:
        queue = self.ws_queues.get(runtime_id)
        if queue is not None:
            queue.put_nowait(command)
        if self.redis_store is not None:
            await self.redis_store.publish_runtime_command(runtime_id, command)
        return command

    async def apply_log_chunk(self, runtime_id: str, payload: dict[str, Any]) -> dict[str, Any]:
        request_id = str(payload.get("request_id") or "")
        instance_id = str(payload.get("instance_id") or "")
        result = {
            "request_id": request_id,
            "conductor_id": runtime_id,
            "instance_id": instance_id,
            "generation": payload.get("generation"),
            "offset_start": int(payload.get("offset_start") or 0),
            "offset_end": int(payload.get("offset_end") or 0),
            "cursor": int(payload.get("offset_end") or 0),
            "order": str(payload.get("order") or "desc"),
            "lines": list(payload.get("lines") or []),
        }
        await self.save_log_fetch_result(request_id, result)
        self.instance_log_tails[(runtime_id, instance_id)] = {
            "generation": result["generation"],
            "offset_end": result["offset_end"],
            "updated_at": utc_now_iso(),
            "lines": result["lines"],
        }
        self.persist()
        return result

    async def runtime_for_bearer(self, authorization: str) -> dict[str, Any] | None:
        token = bearer_token(authorization)
        if not token:
            return None
        token_hash = hash_secret(token)
        if self.pg_store is not None:
            runtime = await self.pg_store.get_runtime_by_token_hash(token_hash)
            if runtime is None or runtime.get("disabled") or runtime.get("revoked"):
                return None
            self.runtimes[str(runtime["id"])] = runtime
            return runtime
        for runtime in self.runtimes.values():
            if hmac.compare_digest(str(runtime["runtime_token_hash"]), token_hash):
                if runtime.get("disabled") or runtime.get("revoked"):
                    return None
                return runtime
        return None

    async def runtime_for_proxy_bearer(self, authorization: str) -> dict[str, Any] | None:
        token = bearer_token(authorization)
        if not token:
            return None
        token_hash = hash_secret(token)
        if self.pg_store is not None:
            runtime = await self.pg_store.get_runtime_by_token_hash(token_hash, proxy=True)
            if runtime is None or runtime.get("disabled") or runtime.get("revoked"):
                return None
            self.runtimes[str(runtime["id"])] = runtime
            return runtime
        for runtime in self.runtimes.values():
            if hmac.compare_digest(str(runtime["proxy_token_hash"]), token_hash):
                if runtime.get("disabled") or runtime.get("revoked"):
                    return None
                return runtime
        return None

