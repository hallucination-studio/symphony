from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Any, Callable

import httpx

from .linear_reconciliation_model import (
    after_checkpoint,
    initial_reconciliation_state,
    issue_order_key,
    observation_and_event,
    page_state,
    reconciliation_deferred,
)
from .linear_reconciliation_queries import LinearReconciliationClient, LinearReconciliationError
from .linear_reconciliation_health import (
    BindingReconciliationFailed,
    record_binding_error,
    update_installation_health,
)
from .linear_reconciliation_supervisor import run_linear_reconciliation_loop
from .podium_shared import utc_now_iso


LOGGER = logging.getLogger(__name__)
Transport = Callable[[httpx.Request], httpx.Response]
MAX_PAGE_CAS_ATTEMPTS = 3


@dataclass(frozen=True)
class PageCommitResult:
    inserted: int | None
    state: dict[str, Any]
    has_next_page: bool
    page_cursor: str


@dataclass(frozen=True)
class BindingScanResult:
    queued: int
    complete: bool
    expected_state: dict[str, Any] | None


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
            binding = await self.state.store.get_ready_project_binding_for_installation(
                user_id,
                str(project["linear_project_id"]),
                installation_id=str(installation.get("id") or ""),
                agent_app_user_id=str(installation.get("app_user_id") or ""),
            )
            if binding is None:
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
                recorded = await record_binding_error(
                    self.state,
                    installation,
                    binding,
                    failure,
                )
                result["errors"] += int(recorded)
        if result["bindings"] and result["errors"] == 0 and not deferred:
            await update_installation_health(
                self.state,
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
        queued = 0
        for stale_attempt in range(1, MAX_PAGE_CAS_ATTEMPTS + 1):
            try:
                persisted_state = await self.state.store.get_linear_reconciliation_state(binding_id)
            except Exception as exc:
                raise BindingReconciliationFailed(
                    exc,
                    queued,
                    expected_state=None,
                    state_loaded=False,
                ) from exc
            state = {**initial_reconciliation_state(binding_id), **(persisted_state or {})}
            if reconciliation_deferred(state):
                return None
            scan = await self._scan_binding_pages(
                installation, project, binding, persisted_state, state, queued
            )
            queued = scan.queued
            if scan.complete:
                return queued
            self._log_stale_page(binding_id, stale_attempt)
            if not await self._binding_still_routes(installation, project, binding_id):
                self._log_retired_route(installation, binding_id)
                return queued
            if stale_attempt == MAX_PAGE_CAS_ATTEMPTS:
                error = LinearReconciliationError(
                    "linear_reconciliation_contention",
                    "Linear reconciliation page contention exceeded the retry limit",
                )
                raise BindingReconciliationFailed(
                    error,
                    queued,
                    expected_state=scan.expected_state,
                    state_loaded=True,
                ) from error
        raise AssertionError("bounded reconciliation retry loop exhausted unexpectedly")

    async def _scan_binding_pages(
        self,
        installation: dict[str, Any],
        project: dict[str, Any],
        binding: dict[str, Any],
        expected_state: dict[str, Any] | None,
        state: dict[str, Any],
        queued: int,
    ) -> BindingScanResult:
        mode = "incremental" if state.get("baseline_complete") else "baseline"
        scan_started_at = str(state.get("scan_started_at") or utc_now_iso())
        page_cursor = str(state.get("page_cursor") or "") or None
        while True:
            try:
                page = await self._commit_next_page(
                    installation, project, binding, expected_state, state,
                    mode, scan_started_at, page_cursor,
                )
                if page.inserted is None:
                    return BindingScanResult(queued, False, expected_state)
                expected_state = page.state
                state = page.state
                queued += page.inserted
                await self.state.notify_reconciled_dispatches(binding, page.inserted)
            except Exception as exc:
                raise BindingReconciliationFailed(
                    exc, queued, expected_state=expected_state, state_loaded=True
                ) from exc
            if not page.has_next_page:
                return BindingScanResult(queued, True, expected_state)
            page_cursor = page.page_cursor

    async def _commit_next_page(
        self,
        installation: dict[str, Any],
        project: dict[str, Any],
        binding: dict[str, Any],
        expected_state: dict[str, Any] | None,
        state: dict[str, Any],
        mode: str,
        scan_started_at: str,
        page_cursor: str | None,
    ) -> PageCommitResult:
        page = await self.client.fetch_page(
            installation,
            project,
            mode=mode,
            updated_after=str(state.get("checkpoint_updated_at") or "") or None,
            after=page_cursor,
        )
        if page.has_next_page and (not page.end_cursor or page.end_cursor == page_cursor):
            raise LinearReconciliationError(
                "linear_reconciliation_pagination_invalid",
                "Linear reconciliation cursor did not advance",
            )
        issues = sorted(page.issues, key=issue_order_key)
        observations, dispatches = await self._page_changes(
            installation, project, binding, state, mode, issues
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
            str(binding["id"]),
            expected_state=expected_state,
            expected_installation_id=str(installation.get("id") or ""),
            expected_agent_app_user_id=str(installation.get("app_user_id") or ""),
            state=next_state,
            observations=observations,
            dispatches=dispatches,
        )
        return PageCommitResult(inserted, next_state, page.has_next_page, page.end_cursor)

    async def _binding_still_routes(
        self,
        installation: dict[str, Any],
        project: dict[str, Any],
        binding_id: str,
    ) -> bool:
        current = await self.state.store.get_ready_project_binding_for_installation(
            str(installation.get("user_id") or ""),
            str(project.get("linear_project_id") or ""),
            installation_id=str(installation.get("id") or ""),
            agent_app_user_id=str(installation.get("app_user_id") or ""),
        )
        return current is not None and str(current.get("id") or "") == binding_id

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

    def _log_stale_page(self, binding_id: str, attempt: int) -> None:
        LOGGER.warning(
            "event=linear_reconciliation_page_stale binding_id=%s "
            "error_type=StaleReconciliationPage "
            "error_code=linear_reconciliation_page_stale "
            "sanitized_reason=stale_binding_snapshot action_required=none "
            "retryable=true attempt_number=%s next_action=reload_binding_state",
            binding_id,
            attempt,
        )

    def _log_retired_route(
        self,
        installation: dict[str, Any],
        binding_id: str,
    ) -> None:
        LOGGER.info(
            "event=linear_reconciliation_route_retired "
            "installation_id=%s binding_id=%s action_required=none "
            "retryable=false next_action=stop_stale_reconciliation",
            installation.get("id"),
            binding_id,
        )
