from __future__ import annotations

import asyncio
import logging
from typing import Any, Callable

import httpx

from .linear_reconciliation_model import (
    after_checkpoint,
    failure_state,
    initial_reconciliation_state,
    issue_order_key,
    observation_and_event,
    page_state,
    reconciliation_deferred,
)
from .linear_reconciliation_queries import LinearReconciliationClient, LinearReconciliationError
from .podium_shared import utc_now_iso


LOGGER = logging.getLogger(__name__)
Transport = Callable[[httpx.Request], httpx.Response]


class BindingReconciliationFailed(RuntimeError):
    def __init__(self, cause: Exception, queued: int) -> None:
        super().__init__(str(cause))
        self.cause = cause
        self.queued = queued


class LinearReconciler:
    def __init__(
        self,
        *,
        state: Any,
        transport: Transport | None = None,
        page_size: int = 50,
    ) -> None:
        self.state = state
        self.client = LinearReconciliationClient(
            state=state,
            transport=transport,
            page_size=page_size,
        )

    async def reconcile_once(self) -> dict[str, int]:
        totals = {"installations": 0, "bindings": 0, "queued": 0, "errors": 0}
        for installation in await self.state.list_active_linear_installations():
            totals["installations"] += 1
            result = await self._reconcile_installation(installation)
            for key in ("bindings", "queued", "errors"):
                totals[key] += result[key]
        LOGGER.info(
            "event=linear_reconciliation_cycle installations=%s bindings=%s queued=%s errors=%s",
            totals["installations"],
            totals["bindings"],
            totals["queued"],
            totals["errors"],
        )
        return totals

    async def _reconcile_installation(self, installation: dict[str, Any]) -> dict[str, int]:
        result = {"bindings": 0, "queued": 0, "errors": 0}
        deferred = False
        user_id = str(installation["user_id"])
        for project in await self.state.list_selected_linear_projects(user_id):
            binding = await self.state.store.get_active_project_binding_for_project(
                user_id,
                str(project["linear_project_id"]),
            )
            if binding is None or binding.get("state") != "ready":
                continue
            result["bindings"] += 1
            try:
                queued = await self._reconcile_binding(installation, project, binding)
                if queued is None:
                    deferred = True
                else:
                    result["queued"] += queued
            except BindingReconciliationFailed as failure:
                result["queued"] += failure.queued
                result["errors"] += 1
                await self._record_binding_error(installation, binding, failure.cause)
        if result["bindings"] and result["errors"] == 0 and not deferred:
            await self.state.update_linear_reconciliation_health(
                installation,
                reconciliation_state="healthy",
                last_reconciliation_at=utc_now_iso(),
                reconciliation_error_code="",
                reconciliation_error="",
                reconciliation_retry_count=0,
                reconciliation_next_retry_at=None,
            )
        return result

    async def _reconcile_binding(
        self,
        installation: dict[str, Any],
        project: dict[str, Any],
        binding: dict[str, Any],
    ) -> int | None:
        binding_id = str(binding["id"])
        state = await self.state.store.get_linear_reconciliation_state(binding_id)
        state = {**initial_reconciliation_state(binding_id), **(state or {})}
        if reconciliation_deferred(state):
            return None
        queued = 0
        try:
            mode = "incremental" if state.get("baseline_complete") else "baseline"
            scan_started_at = str(state.get("scan_started_at") or utc_now_iso())
            after = str(state.get("page_cursor") or "") or None
            while True:
                page = await self.client.fetch_page(
                    installation,
                    project,
                    mode=mode,
                    updated_after=(str(state.get("checkpoint_updated_at") or "") or None),
                    after=after,
                )
                if page.has_next_page and (not page.end_cursor or page.end_cursor == after):
                    raise LinearReconciliationError(
                        "linear_reconciliation_pagination_invalid",
                        "Linear reconciliation cursor did not advance",
                    )
                issues = sorted(page.issues, key=issue_order_key)
                observations, dispatches = await self._page_changes(
                    installation,
                    project,
                    binding,
                    state,
                    mode,
                    issues,
                )
                next_state = page_state(
                    state,
                    mode=mode,
                    scan_started_at=scan_started_at,
                    page_cursor=page.end_cursor,
                    issues=issues,
                    final_page=not page.has_next_page,
                )
                inserted = await self.state.store.commit_linear_reconciliation_page(
                    binding_id,
                    state=next_state,
                    observations=observations,
                    dispatches=dispatches,
                )
                await self.state.notify_reconciled_dispatches(binding, inserted)
                queued += inserted
                state = next_state
                if not page.has_next_page:
                    return queued
                after = page.end_cursor
        except Exception as exc:
            raise BindingReconciliationFailed(exc, queued) from exc

    async def _page_changes(
        self,
        installation: dict[str, Any],
        project: dict[str, Any],
        binding: dict[str, Any],
        state: dict[str, Any],
        mode: str,
        issues: list[dict[str, Any]],
    ) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
        observations: list[dict[str, Any]] = []
        dispatches: list[dict[str, Any]] = []
        binding_id = str(binding["id"])
        issue_ids = [str(issue.get("id") or "") for issue in issues if issue.get("id")]
        previous_by_issue = await self.state.store.get_linear_issue_observations(binding_id, issue_ids)
        for issue in issues:
            if not after_checkpoint(issue, state, mode):
                continue
            previous = previous_by_issue.get(str(issue.get("id") or ""))
            observation, event = observation_and_event(
                installation,
                project,
                binding_id,
                issue,
                previous,
            )
            if observation is not None:
                observations.append(observation)
            if event is not None:
                dispatches.append(self.state.reconciliation_dispatch(event, binding))
        return observations, dispatches

    async def _record_binding_error(
        self,
        installation: dict[str, Any],
        binding: dict[str, Any],
        error: Exception,
    ) -> None:
        binding_id = str(binding["id"])
        current = await self.state.store.get_linear_reconciliation_state(binding_id)
        code, reason = _visible_error(error)
        failed = failure_state(current or initial_reconciliation_state(binding_id), binding_id, code, reason)
        await self.state.store.save_linear_reconciliation_state(binding_id, failed)
        await self.state.update_linear_reconciliation_health(
            installation,
            reconciliation_state="degraded",
            reconciliation_error_code=code,
            reconciliation_error=reason,
            reconciliation_retry_count=int(failed["retry_count"]),
            reconciliation_next_retry_at=failed["next_retry_at"],
        )
        LOGGER.warning(
            "event=linear_reconciliation_failed installation_id=%s binding_id=%s error_type=%s error_code=%s "
            "sanitized_reason=%s action_required=retry retryable=true next_action=retry_reconciliation",
            installation.get("id"),
            binding_id,
            type(error).__name__,
            code,
            reason,
        )


async def run_linear_reconciliation_loop(
    reconciler: LinearReconciler,
    *,
    interval_seconds: float,
) -> None:
    interval = max(1.0, float(interval_seconds or 1.0))
    while True:
        await reconciler.reconcile_once()
        await asyncio.sleep(interval)


def _visible_error(error: Exception) -> tuple[str, str]:
    code = str(getattr(error, "code", "linear_reconciliation_failed"))
    reason = str(getattr(error, "reason", "") or f"Linear reconciliation failed ({type(error).__name__})")
    return code[:64], reason.replace("\n", " ").replace("\r", " ")[:300]
