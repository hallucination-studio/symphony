from __future__ import annotations

import hmac
from typing import Any

from .podium_project_bindings import ProjectBindingError
from .podium_shared import bearer_token, hash_secret, utc_now_iso


class PodiumRuntimeMixin:
    async def apply_runtime_report(self, runtime_id: str, payload: dict[str, Any]) -> dict[str, Any]:
        runtime = await self.store.get_runtime(runtime_id)
        if runtime is None:
            return {"status": "unknown_runtime", "bindings_upserted": 0}
        # HTTP reports are the liveness signal now that the runtime channel is polling-only.
        await self.set_presence(runtime_id)
        conductor = await self._runtime_report_conductor(runtime_id, runtime, payload)
        await self.store.upsert_conductor(conductor)
        bindings = payload.get("bindings") if isinstance(payload.get("bindings"), list) else []
        if payload.get("unbound_binding_id"):
            try:
                binding = await self.acknowledge_project_unbind(runtime_id, payload)
            except ProjectBindingError as exc:
                return {
                    "status": "rejected",
                    "error_code": exc.code,
                    "sanitized_reason": exc.reason,
                    "bindings_upserted": 0,
                }
            return {"status": "ok", "bindings_upserted": 0, "binding_state": binding["state"]}
        if len(bindings) > 1:
            return {
                "status": "rejected",
                "error_code": "multiple_project_bindings",
                "sanitized_reason": "A Conductor may report at most one project binding",
                "bindings_upserted": 0,
            }
        metrics = payload.get("metrics") if isinstance(payload.get("metrics"), dict) else {}
        queue = payload.get("queue") if isinstance(payload.get("queue"), dict) else {}
        log_tail = payload.get("log_tail") if isinstance(payload.get("log_tail"), dict) else {}
        if not bindings:
            return {"status": "ok", "bindings_upserted": 0, "binding_state": "unbound"}
        raw_binding = bindings[0]
        if not isinstance(raw_binding, dict):
            return {
                "status": "rejected",
                "error_code": "invalid_project_binding_report",
                "sanitized_reason": "Project binding report must be an object",
                "bindings_upserted": 0,
            }
        try:
            await self.acknowledge_candidate_installation(runtime_id, raw_binding)
            binding = await self.acknowledge_project_binding(runtime_id, raw_binding)
        except ProjectBindingError as exc:
            await self.fail_project_binding(runtime_id, exc)
            return {
                "status": "rejected",
                "error_code": exc.code,
                "sanitized_reason": exc.reason,
                "bindings_upserted": 0,
            }
        await self._store_binding_report(runtime_id, conductor, binding, metrics, queue, log_tail)
        return {"status": "ok", "bindings_upserted": 1, "binding_state": binding["state"]}

    async def _runtime_report_conductor(
        self,
        runtime_id: str,
        runtime: dict[str, Any],
        payload: dict[str, Any],
    ) -> dict[str, Any]:
        conductor_rows = await self.store.list_conductors_for_user(str(runtime.get("user_id") or ""))
        conductor = next((row for row in conductor_rows if str(row.get("id") or "") == runtime_id), {})
        conductor = {
            **conductor,
            "id": runtime_id,
            "conductor_id": runtime_id,
            "user_id": str(runtime.get("user_id") or conductor.get("user_id") or ""),
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
        return conductor

    async def _store_binding_report(
        self,
        runtime_id: str,
        conductor: dict[str, Any],
        binding: dict[str, Any],
        metrics: dict[str, Any],
        queue: dict[str, Any],
        log_tail: dict[str, Any],
    ) -> None:
        await self.store.upsert_project_binding(binding)
        instance_id = str(binding.get("instance_id") or "")
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

    async def list_conductors_for_user(self, user_id: str) -> list[dict[str, Any]]:
        result: list[dict[str, Any]] = []
        for conductor in await self.store.list_conductors_for_user(user_id):
            conductor_id = str(conductor["id"])
            bindings = [
                self.binding_public(binding)
                for binding in await self.store.list_project_bindings_for_conductor(conductor_id)
                if binding.get("active", True)
            ]
            for binding in bindings:
                metrics = await self.store.get_metrics_snapshot(conductor_id, str(binding.get("instance_id") or ""))
                binding["metrics"] = metrics or {}
                binding["queue"] = {
                    "queue_depth": (metrics or {}).get("queue_depth", 0),
                    "running": (metrics or {}).get("running", False),
                }
            bindings.sort(key=lambda row: str(row.get("project_slug") or ""))
            public = await self.conductor_public(conductor)
            public.update({"conductor_id": conductor_id, "runtime_id": conductor_id, "bindings": bindings})
            result.append(public)
        return result

    def binding_public(self, binding: dict[str, Any]) -> dict[str, Any]:
        payload = dict(binding)
        payload["managed_run_profile"] = "default"
        source = payload.pop("repo_source", {})
        source = source if isinstance(source, dict) else {}
        source_type = str(source.get("type") or "")
        payload["repository"] = {
            "mode": "git_url" if source_type == "git" else source_type,
            "value": str(source.get("value") or ""),
        }
        return payload

    async def conductor_belongs_to_user(self, conductor_id: str, user_id: str) -> bool:
        return any(str(row.get("id") or "") == conductor_id for row in await self.store.list_conductors_for_user(user_id))

    async def enqueue_runtime_command(self, runtime_id: str, command: dict[str, Any]) -> dict[str, Any]:
        return await self.store.append_runtime_command(runtime_id, command)

    async def enqueue_runtime_command_once(
        self,
        runtime_id: str,
        dedupe_key: str,
        command: dict[str, Any],
    ) -> dict[str, Any]:
        return await self.store.append_runtime_command_once(runtime_id, dedupe_key, command)

    async def lease_runtime_command(self, runtime_id: str) -> dict[str, Any] | None:
        return await self.store.lease_runtime_command(runtime_id)

    async def ack_runtime_command(
        self,
        runtime_id: str,
        command_id: int,
        fencing_token: int,
        *,
        status: str,
        result: dict[str, Any] | None = None,
    ) -> dict[str, Any] | None:
        return await self.store.ack_runtime_command(
            runtime_id,
            command_id,
            fencing_token,
            status=status,
            result=result,
        )

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
