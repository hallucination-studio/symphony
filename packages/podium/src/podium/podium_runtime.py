from __future__ import annotations

import hmac
from typing import Any

from .podium_shared import bearer_token, hash_secret, utc_now_iso


class PodiumRuntimeMixin:
    async def ensure_conductor_record(self, runtime_id: str) -> dict[str, Any] | None:
        conductors = await self.store.list_runtime_groups()
        _ = conductors
        runtime = await self.store.get_runtime(runtime_id)
        if runtime is None:
            return None
        user_id = str(runtime.get("user_id") or "")
        rows = await self.store.list_conductors_for_user(user_id)
        for row in rows:
            if str(row.get("id") or "") == runtime_id:
                return row
        return None

    async def apply_runtime_report(self, runtime_id: str, payload: dict[str, Any]) -> dict[str, Any]:
        runtime = await self.store.get_runtime(runtime_id)
        if runtime is None:
            return {"status": "unknown_runtime", "bindings_upserted": 0}
        conductor_rows = await self.store.list_conductors_for_user(str(runtime.get("user_id") or ""))
        conductor = next((row for row in conductor_rows if str(row.get("id") or "") == runtime_id), {})
        conductor = {
            **conductor,
            "id": runtime_id,
            "conductor_id": runtime_id,
            "user_id": str(runtime.get("user_id") or conductor.get("user_id") or ""),
            "runtime_group_id": str(runtime.get("runtime_group_id") or conductor.get("runtime_group_id") or ""),
            "runtime_token_hash": str(runtime.get("runtime_token_hash") or conductor.get("runtime_token_hash") or ""),
            "proxy_token_hash": str(runtime.get("proxy_token_hash") or conductor.get("proxy_token_hash") or ""),
            "disabled": bool(runtime.get("disabled") or conductor.get("disabled")),
            "revoked": bool(runtime.get("revoked") or conductor.get("revoked")),
            "created_at": str(runtime.get("created_at") or conductor.get("created_at") or utc_now_iso()),
            "last_report_at": utc_now_iso(),
        }
        for key in ("hostname", "label", "version"):
            if key in payload:
                conductor[key] = str(payload.get(key) or "")
            else:
                conductor.setdefault(key, "")
        await self.store.upsert_conductor(conductor)
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
                "pipeline_profile": str(raw_binding.get("pipeline_profile") or "default"),
                "process_status": str(raw_binding.get("process_status") or ""),
                "constraint_labels": [
                    str(label)
                    for label in (raw_binding.get("constraint_labels") or [])
                    if isinstance(label, str) and label
                ],
                "repo_source": raw_binding.get("repo_source") if isinstance(raw_binding.get("repo_source"), dict) else {},
                "updated_at": utc_now_iso(),
            }
            await self.store.upsert_project_binding(binding)
            instance_metrics = metrics.get(instance_id) if isinstance(metrics.get(instance_id), dict) else {}
            instance_queue = queue.get(instance_id) if isinstance(queue.get(instance_id), dict) else {}
            queue_depth = int(instance_queue.get("queue_depth") or instance_queue.get("queued") or 0) + int(instance_queue.get("leased") or 0)
            await self.store.upsert_metrics_snapshot(
                runtime_id,
                instance_id,
                {
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
                },
            )
            tail = log_tail.get(instance_id) if isinstance(log_tail.get(instance_id), dict) else None
            if tail is not None:
                await self.store.upsert_instance_log_tail(
                    runtime_id,
                    instance_id,
                    {
                        "generation": tail.get("generation"),
                        "offset_end": int(tail.get("offset_end") or 0),
                        "updated_at": conductor["last_report_at"],
                        "lines": list(tail.get("lines") or []),
                    },
                )
            upserted += 1
        return {"status": "ok", "bindings_upserted": upserted}

    async def list_conductors_for_user(self, user_id: str) -> list[dict[str, Any]]:
        result: list[dict[str, Any]] = []
        for conductor in await self.store.list_conductors_for_user(user_id):
            conductor_id = str(conductor["id"])
            bindings = [self.binding_public(binding) for binding in await self.store.list_project_bindings_for_conductor(conductor_id)]
            for binding in bindings:
                metrics = await self.store.get_metrics_snapshot(conductor_id, str(binding.get("instance_id") or ""))
                binding["metrics"] = metrics or {}
                binding["queue"] = {
                    "queue_depth": (metrics or {}).get("queue_depth", 0),
                    "running": (metrics or {}).get("running", False),
                }
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
        return dict(binding)

    async def conductor_belongs_to_user(self, conductor_id: str, user_id: str) -> bool:
        return any(str(row.get("id") or "") == conductor_id for row in await self.store.list_conductors_for_user(user_id))

    async def attach_runtime_ws(self, runtime_id: str) -> int:
        await self.set_presence(runtime_id)
        return 0

    async def detach_runtime_ws(self, runtime_id: str) -> None:
        await self.clear_presence(runtime_id)

    async def enqueue_runtime_command(self, runtime_id: str, command: dict[str, Any]) -> dict[str, Any]:
        await self.store.append_runtime_command(runtime_id, command)
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
        await self.store.upsert_instance_log_tail(
            runtime_id,
            instance_id,
            {
                "generation": result["generation"],
                "offset_end": result["offset_end"],
                "updated_at": utc_now_iso(),
                "lines": result["lines"],
            },
        )
        return result

    async def runtime_for_bearer(self, authorization: str) -> dict[str, Any] | None:
        token = bearer_token(authorization)
        if not token:
            return None
        runtime = await self.store.get_runtime_by_token_hash(hash_secret(token))
        if runtime is None or runtime.get("disabled") or runtime.get("revoked"):
            return None
        return runtime

    async def runtime_for_proxy_bearer(self, authorization: str) -> dict[str, Any] | None:
        token = bearer_token(authorization)
        if not token:
            return None
        runtime = await self.store.get_runtime_by_token_hash(hash_secret(token), proxy=True)
        if runtime is None or runtime.get("disabled") or runtime.get("revoked"):
            return None
        return runtime
