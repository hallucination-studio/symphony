from __future__ import annotations

from typing import Any

import httpx
import re

from .conductor_service_helpers import _desired_project_labels, _hostname, _linear_agent_app_user_id


class PodiumReportMixin:
    def build_podium_report(self, *, log_tail_lines: int = 200) -> dict[str, Any]:
        settings = self.store.get_settings()
        bindings: list[dict[str, Any]] = []
        metrics: dict[str, dict[str, Any]] = {}
        queue: dict[str, dict[str, Any]] = {}
        log_tail: dict[str, dict[str, Any]] = {}
        managed_runs_view = _sanitize_managed_runs_view(self.managed_run_view())
        managed_run_metrics = _managed_run_report_metrics(managed_runs_view)
        managed_run_queue = _managed_run_report_queue(managed_runs_view)
        instances = self.store.list_instances()
        unbound: dict[str, Any] = {}
        for instance in instances:
            unbound = _unbound_binding_report(instance)
            if unbound:
                continue
            agent_app_user_id = _linear_agent_app_user_id(instance.linear_filters)
            bindings.append(
                {
                    "instance_id": instance.id,
                    "name": instance.name,
                    "linear_project": instance.linear_project,
                    "project_slug": instance.linear_project,
                    "linear_project_id": str(instance.linear_filters.get("linear_project_id") or ""),
                    "binding_config_version": int(instance.linear_filters.get("binding_config_version") or 0),
                    "prepared_installation_id": str(instance.linear_filters.get("pending_installation_id") or ""),
                    "prepared_binding_config_version": int(
                        instance.linear_filters.get("pending_binding_config_version") or 0
                    ),
                    "agent_app_user_id": agent_app_user_id,
                    "process_status": instance.process_status,
                    "constraint_labels": _desired_project_labels(instance),
                    "repo_source": {"type": instance.repo_source_type, "value": instance.repo_source_value},
                }
            )
            metrics[instance.id] = {
                **managed_run_metrics,
                "running": bool(instance.process_status == "running"),
            }
            queue[instance.id] = {
                "queued": managed_run_queue["queued"],
                "leased": managed_run_queue["leased"],
                "running": 1 if instance.process_status == "running" else 0,
            }
            logs = self.query_instance_logs(instance.id, tail=log_tail_lines, order="desc")
            log_tail[instance.id] = {
                "generation": logs.get("generation"),
                "offset_end": logs.get("offset_end", 0),
                "lines": logs.get("lines") or [],
            }
        report = {
            "conductor_id": settings.conductor_id,
            "hostname": _hostname(),
            "label": "",
            "version": "",
            "bindings": bindings,
            "metrics": metrics,
            "queue": queue,
            "log_tail": log_tail,
            "managed_runs": managed_runs_view,
        }
        report.update(unbound)
        return report

    async def post_podium_report(
        self,
        *,
        transport: httpx.AsyncBaseTransport | None = None,
        log_tail_lines: int = 200,
    ) -> dict[str, Any]:
        settings = self.store.get_settings()
        podium_url = settings.podium_url.strip().rstrip("/")
        runtime_token = settings.podium_runtime_token.strip()
        if not podium_url or not runtime_token:
            return {"status": "skipped", "reason": "runtime_not_configured"}
        async with httpx.AsyncClient(timeout=10, trust_env=False, transport=transport) as client:
            response = await client.post(
                f"{podium_url}/api/v1/runtime/report",
                headers={"Authorization": f"Bearer {runtime_token}"},
                json=self.build_podium_report(log_tail_lines=log_tail_lines),
            )
        if response.status_code == 401:
            return {"status": "skipped", "reason": "runtime_unauthorized"}
        response.raise_for_status()
        payload = response.json()
        return payload if isinstance(payload, dict) else {"status": "ok"}


def _unbound_binding_report(instance: Any) -> dict[str, Any]:
    binding_id = str(instance.linear_filters.get("unbound_binding_id") or "")
    if not binding_id:
        return {}
    return {
        "unbound_binding_id": binding_id,
        "unbound_config_version": int(instance.linear_filters.get("unbound_config_version") or 0),
    }


def _managed_run_report_metrics(view: dict[str, Any]) -> dict[str, Any]:
    runs = view.get("runs") if isinstance(view.get("runs"), list) else []
    return {
        "runs_total": len(runs),
        "runs_blocked": sum(1 for run in runs if isinstance(run, dict) and run.get("state") in {"blocked", "failed"}),
        "runs_done": sum(1 for run in runs if isinstance(run, dict) and run.get("state") == "done"),
    }


def _managed_run_report_queue(view: dict[str, Any]) -> dict[str, int]:
    runs = view.get("runs") if isinstance(view.get("runs"), list) else []
    return {
        "queued": sum(1 for run in runs if isinstance(run, dict) and run.get("state") in {"queued", "planning", "ready"}),
        "leased": sum(1 for run in runs if isinstance(run, dict) and run.get("state") in {"executing", "reviewing"}),
    }


def _sanitize_managed_runs_view(value: Any, *, key: str = "") -> Any:
    if isinstance(value, dict):
        return {str(name): _sanitize_managed_runs_view(item, key=str(name)) for name, item in value.items()}
    if isinstance(value, list):
        return [_sanitize_managed_runs_view(item, key=key) for item in value]
    if not isinstance(value, str):
        return value
    if any(marker in key.lower() for marker in ("token", "secret", "password", "authorization", "cookie")):
        return "[REDACTED]"
    redacted = re.sub(r"(?i)\b(bearer|basic)\s+[A-Za-z0-9._~+/=-]+", r"\1 [REDACTED]", value)
    return redacted[:4000]
