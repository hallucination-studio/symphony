from __future__ import annotations

import asyncio
import logging
from dataclasses import dataclass, field
from datetime import timedelta
from typing import Any, Protocol

from .config import ConfigError, ServiceConfig
from .models import (
    LIFECYCLE_LABELS,
    Issue,
    RetryEntry,
    RunningEntry,
    RuntimeTokens,
    monotonic_ms,
    normalize_state_key,
    sort_for_dispatch,
    utc_now,
)
from .persistence import PersistedState, PersistenceStore
from .workspace import WorkspaceManager


logger = logging.getLogger(__name__)


class TrackerProtocol(Protocol):
    async def fetch_candidate_issues(self) -> list[Issue]: ...

    async def fetch_issues_by_states(self, state_names: list[str]) -> list[Issue]: ...

    async def fetch_issue_states_by_ids(self, issue_ids: list[str]) -> list[Issue]: ...

    async def comment_issue(self, issue_id: str, body: str) -> dict[str, Any]: ...

    async def set_issue_lifecycle_label(self, issue_id: str, label_name: str) -> dict[str, Any]: ...


class RunnerProtocol(Protocol):
    async def run_issue(
        self, issue: Issue, attempt: int | None, on_event: Any, *, worker_host: str | None = None
    ) -> None: ...


@dataclass
class OrchestratorState:
    running: dict[str, RunningEntry] = field(default_factory=dict)
    claimed: set[str] = field(default_factory=set)
    retry_attempts: dict[str, RetryEntry] = field(default_factory=dict)
    completed: set[str] = field(default_factory=set)
    codex_totals: RuntimeTokens = field(default_factory=RuntimeTokens)
    codex_rate_limits: dict[str, Any] | None = None
    ended_runtime_seconds: float = 0


class Orchestrator:
    def __init__(
        self,
        config: ServiceConfig,
        tracker: TrackerProtocol,
        runner: RunnerProtocol,
        *,
        workspace_manager: WorkspaceManager | None = None,
        persistence_store: PersistenceStore | None = None,
    ):
        self.config = config
        self.tracker = tracker
        self.runner = runner
        self.workspace_manager = workspace_manager
        self.persistence_store = persistence_store
        self.state = OrchestratorState()
        self._worker_tasks: set[asyncio.Task[Any]] = set()
        self._desired_lifecycle_labels: dict[str, str] = {}

    def load_persisted_state(self) -> None:
        if self.persistence_store is None:
            return
        persisted = self.persistence_store.load()
        for retry in persisted.retry_attempts:
            self.state.retry_attempts[retry.issue_id] = retry
            self.state.claimed.add(retry.issue_id)

    async def tick(self) -> None:
        await self.reconcile_running()
        try:
            self.config.validate_for_dispatch()
        except ConfigError as exc:
            logger.warning("symphony_dispatch_validation failed code=%s reason=%s", exc.code, exc)
            return
        await self.process_due_retries()
        try:
            candidates = await self.tracker.fetch_candidate_issues()
        except Exception as exc:
            logger.warning("symphony_dispatch failed reason=%s", exc)
            return
        logger.info(
            "symphony_dispatch_scan candidate_count=%s available_slots=%s running=%s claimed=%s",
            len(candidates),
            self.available_slots(),
            len(self.state.running),
            len(self.state.claimed),
        )
        dispatched = 0
        skipped = 0
        for candidate in sort_for_dispatch(candidates):
            if self.available_slots() <= 0:
                logger.info(
                    "symphony_dispatch_candidate outcome=skip issue_id=%s issue_identifier=%s reason=no_available_slots",
                    candidate.id,
                    candidate.identifier,
                )
                skipped += 1
                break
            reason = self.dispatch_skip_reason(candidate)
            if reason is not None:
                logger.info(
                    "symphony_dispatch_candidate outcome=skip issue_id=%s issue_identifier=%s reason=%s",
                    candidate.id,
                    candidate.identifier,
                    reason,
                )
                skipped += 1
                continue
            worker_host = self._select_worker_host()
            if self.config.worker.ssh_hosts and worker_host is None:
                logger.info(
                    "symphony_dispatch_candidate outcome=skip issue_id=%s issue_identifier=%s reason=no_available_worker_host",
                    candidate.id,
                    candidate.identifier,
                )
                skipped += 1
                continue
            logger.info(
                "symphony_dispatch_candidate outcome=dispatch issue_id=%s issue_identifier=%s worker_host=%s",
                candidate.id,
                candidate.identifier,
                worker_host or "local",
            )
            self.dispatch_issue(candidate, attempt=None, worker_host=worker_host)
            dispatched += 1
        logger.info(
            "symphony_dispatch_summary dispatched=%s skipped=%s running=%s claimed=%s",
            dispatched,
            skipped,
            len(self.state.running),
            len(self.state.claimed),
        )
        await asyncio.sleep(0)

    async def startup_terminal_workspace_cleanup(self, workspace_manager: WorkspaceManager) -> None:
        try:
            issues = await self.tracker.fetch_issues_by_states(self.config.tracker.terminal_states)
        except Exception as exc:
            logger.warning("symphony_startup_cleanup failed reason=%s", exc)
            return
        for issue in issues:
            await workspace_manager.remove_for_issue(issue.identifier)

    async def process_due_retries(self) -> None:
        now_ms = monotonic_ms()
        due = [entry for entry in self.state.retry_attempts.values() if entry.due_at_ms <= now_ms]
        if not due:
            return
        try:
            candidates = await self.tracker.fetch_candidate_issues()
        except Exception as exc:
            logger.warning("symphony_retry failed reason=%s", exc)
            for retry in due:
                issue = Issue(
                    id=retry.issue_id,
                    identifier=retry.identifier,
                    title=retry.identifier,
                    state=self.config.tracker.active_states[0] if self.config.tracker.active_states else "",
                    url=retry.issue_url,
                    project_slug=self.config.tracker.project_slug,
                )
                self._schedule_retry(
                    issue,
                    retry.attempt + 1,
                    error="retry poll failed",
                    delay_ms=None,
                )
            return
        by_id = {issue.id: issue for issue in candidates}
        for retry in due:
            self.state.retry_attempts.pop(retry.issue_id, None)
            issue = by_id.get(retry.issue_id)
            if issue is None:
                self.state.claimed.discard(retry.issue_id)
                self._persist_state()
                continue
            self.state.claimed.discard(retry.issue_id)
            if self.available_slots() <= 0 or not self.should_dispatch(issue):
                if self.available_slots() <= 0:
                    self._schedule_retry(
                        issue,
                        retry.attempt + 1,
                        error="no available orchestrator slots",
                        delay_ms=None,
                    )
                continue
            worker_host = self._select_worker_host()
            if self.config.worker.ssh_hosts and worker_host is None:
                self._schedule_retry(
                    issue,
                    retry.attempt + 1,
                    error="no available worker host",
                    delay_ms=None,
                )
                continue
            self.dispatch_issue(issue, attempt=retry.attempt, worker_host=worker_host)
        await asyncio.sleep(0)

    def should_dispatch(self, issue: Issue) -> bool:
        return self.dispatch_skip_reason(issue) is None

    def dispatch_skip_reason(self, issue: Issue) -> str | None:
        if not issue.id or not issue.identifier or not issue.title or not issue.state:
            return "missing_required_issue_fields"
        if issue.id in self.state.running or issue.id in self.state.claimed:
            return "already_running_or_claimed"
        if not self._is_active(issue):
            return "inactive_state"
        if self.config.tracker.kind == "linear" and issue.project_slug != self.config.tracker.project_slug:
            return "project_mismatch"
        if not self._matches_assignee(issue):
            return "assignee_mismatch"
        if issue.has_required_labels(self.config.tracker.required_labels) is False:
            return "missing_required_labels"
        if issue.state_key() == "todo" and issue.has_non_terminal_blocker(self.config.tracker.terminal_states):
            return "blocked_by_non_terminal_dependency"
        if self.available_slots() <= 0:
            return "no_available_slots"
        if self._available_state_slots(issue.state) <= 0:
            return "no_available_state_slots"
        return None

    def available_slots(self) -> int:
        return max(self.config.agent.max_concurrent_agents - len(self.state.running), 0)

    def dispatch_issue(self, issue: Issue, attempt: int | None, *, worker_host: str | None = None) -> None:
        self.state.claimed.add(issue.id)
        task = asyncio.create_task(self._run_worker(issue, attempt, worker_host=worker_host))
        self._worker_tasks.add(task)
        task.add_done_callback(self._worker_tasks.discard)
        self.state.running[issue.id] = RunningEntry(
            issue=issue,
            task=task,
            started_at=utc_now(),
            retry_attempt=attempt or 0,
            worker_host=worker_host,
        )
        self._set_running_phase(issue.id, "starting")
        self._sync_lifecycle_label_background(issue.id, LIFECYCLE_LABELS["starting"])
        self._persist_state()

    async def _run_worker(self, issue: Issue, attempt: int | None, *, worker_host: str | None) -> None:
        def on_event(event: dict[str, Any]) -> None:
            self.on_codex_event(issue.id, event)

        logger.info(
            "symphony_worker outcome=started issue_id=%s issue_identifier=%s session_id=%s attempt=%s",
            issue.id,
            issue.identifier,
            "-",
            attempt or 0,
        )
        try:
            await self.runner.run_issue(issue, attempt, on_event, worker_host=worker_host)
        except asyncio.CancelledError:
            session_id = self._session_id_for_log(issue.id)
            logger.info(
                "symphony_worker outcome=cancelled issue_id=%s issue_identifier=%s session_id=%s",
                issue.id,
                issue.identifier,
                session_id,
            )
            await self._finish_worker(issue.id, normal=False, error="cancelled")
            raise
        except Exception as exc:
            session_id = self._session_id_for_log(issue.id)
            logger.exception(
                "symphony_worker outcome=failed issue_id=%s issue_identifier=%s session_id=%s reason=%s issue=%s",
                issue.id,
                issue.identifier,
                session_id,
                exc,
                issue.identifier,
            )
            await self._finish_worker(issue.id, normal=False, error=str(exc))
        else:
            session_id = self._session_id_for_log(issue.id)
            logger.info(
                "symphony_worker outcome=completed issue_id=%s issue_identifier=%s session_id=%s issue=%s",
                issue.id,
                issue.identifier,
                session_id,
                issue.identifier,
            )
            await self._finish_worker(issue.id, normal=True, error=None)

    async def _finish_worker(self, issue_id: str, *, normal: bool, error: str | None) -> None:
        entry = self.state.running.pop(issue_id, None)
        if not entry:
            return
        self.state.ended_runtime_seconds += max((utc_now() - entry.started_at).total_seconds(), 0)
        if normal:
            self.state.completed.add(issue_id)
            await self._sync_lifecycle_label(entry.issue.id, LIFECYCLE_LABELS["done"])
            self._schedule_retry(entry.issue, 1, error=None, delay_ms=1_000)
        else:
            next_attempt = max(entry.retry_attempt + 1, 1)
            retry_error = f"worker exited: {error}"
            self._schedule_retry(entry.issue, next_attempt, error=retry_error, delay_ms=None)
            await self._sync_lifecycle_label(entry.issue.id, LIFECYCLE_LABELS["retrying"])
            await self._comment_worker_failure(entry, retry_error, next_attempt)
        self._persist_state()

    async def _comment_worker_failure(self, entry: RunningEntry, error: str, next_attempt: int) -> None:
        if self.config.tracker.kind != "linear" or error == "worker exited: cancelled":
            return
        comment_issue = getattr(self.tracker, "comment_issue", None)
        if not callable(comment_issue):
            return
        body = _failure_comment_body(entry, error, next_attempt)
        try:
            result = await comment_issue(entry.issue.id, body)
        except Exception as exc:
            logger.warning(
                "symphony_worker_failure_comment outcome=failed issue_id=%s issue_identifier=%s reason=%s",
                entry.issue.id,
                entry.issue.identifier,
                exc,
            )
            return
        if isinstance(result, dict) and result.get("success") is False:
            logger.warning(
                "symphony_worker_failure_comment outcome=failed issue_id=%s issue_identifier=%s reason=linear_unsuccessful",
                entry.issue.id,
                entry.issue.identifier,
            )

    def _schedule_retry(self, issue: Issue, attempt: int, *, error: str | None, delay_ms: int | None) -> None:
        if delay_ms is None:
            delay_ms = min(10_000 * (2 ** max(attempt - 1, 0)), self.config.agent.max_retry_backoff_ms)
        due_at = utc_now() + timedelta(milliseconds=delay_ms)
        due_at_ms = monotonic_ms() + delay_ms
        self.state.claimed.add(issue.id)
        self.state.retry_attempts[issue.id] = RetryEntry(
            issue_id=issue.id,
            identifier=issue.identifier,
            attempt=attempt,
            due_at=due_at,
            due_at_ms=due_at_ms,
            error=error,
            issue_url=issue.url,
            phase="retrying" if error is not None else "done",
            status_label=LIFECYCLE_LABELS["retrying"] if error is not None else LIFECYCLE_LABELS["done"],
            last_message=error,
        )
        self._sync_lifecycle_label_background(
            issue.id,
            LIFECYCLE_LABELS["retrying"] if error is not None else LIFECYCLE_LABELS["done"],
        )
        self._persist_state()

    async def reconcile_running(self) -> None:
        await self._reconcile_stalled()
        running_ids = list(self.state.running.keys())
        if not running_ids:
            return
        try:
            refreshed = await self.tracker.fetch_issue_states_by_ids(running_ids)
        except Exception as exc:
            logger.warning("symphony_reconcile failed reason=%s", exc)
            return
        by_id = {issue.id: issue for issue in refreshed}
        for issue_id in running_ids:
            entry = self.state.running.get(issue_id)
            if not entry:
                continue
            refreshed_issue = by_id.get(issue_id)
            if not refreshed_issue:
                await self._terminate_running(issue_id, retry=False)
                continue
            if self._is_terminal(refreshed_issue):
                await self._sync_lifecycle_label(issue_id, LIFECYCLE_LABELS["done"])
                await self._terminate_running(issue_id, retry=False, cleanup_workspace=True)
            elif self._is_run_eligible(refreshed_issue):
                entry.issue = refreshed_issue
                self._persist_state()
            else:
                await self._terminate_running(issue_id, retry=False)

    async def _reconcile_stalled(self) -> None:
        stall_timeout_ms = self.config.codex.stall_timeout_ms
        if stall_timeout_ms <= 0:
            return
        now = utc_now()
        for issue_id, entry in list(self.state.running.items()):
            since = entry.last_codex_timestamp or entry.started_at
            if (now - since).total_seconds() * 1000 > stall_timeout_ms:
                await self._terminate_running(issue_id, retry=True)

    async def _terminate_running(self, issue_id: str, *, retry: bool, cleanup_workspace: bool = False) -> None:
        entry = self.state.running.pop(issue_id, None)
        if not entry:
            return
        task = entry.task
        if task and not task.done():
            task.cancel()
        self.state.claimed.discard(issue_id)
        if cleanup_workspace and self.workspace_manager is not None:
            await self.workspace_manager.remove_for_issue(entry.issue.identifier)
        if retry:
            next_attempt = max(entry.retry_attempt + 1, 1)
            self._schedule_retry(entry.issue, next_attempt, error="stalled", delay_ms=None)
            await self._comment_worker_failure(entry, "stalled", next_attempt)
        self._persist_state()

    def on_codex_event(self, issue_id: str, event: dict[str, Any]) -> None:
        entry = self.state.running.get(issue_id)
        if not entry:
            return
        session_id = event.get("session_id")
        if isinstance(session_id, str) and session_id:
            entry.session_id = session_id
        thread_id = event.get("thread_id")
        if isinstance(thread_id, str) and thread_id:
            entry.thread_id = thread_id
        turn_id = event.get("turn_id")
        if isinstance(turn_id, str) and turn_id:
            entry.turn_id = turn_id
        pid = event.get("codex_app_server_pid")
        if isinstance(pid, int):
            entry.codex_app_server_pid = pid
        cwd = event.get("cwd")
        if isinstance(cwd, str) and cwd:
            entry.workspace_path = cwd
        entry.last_codex_event = event.get("event")
        raw_message = event.get("message") or event.get("raw_method") or event.get("method")
        entry.last_raw_codex_message = str(raw_message) if raw_message is not None else None
        message = _status_message_from_event(event)
        if message is not None:
            entry.last_codex_message = message
        entry.last_codex_timestamp = utc_now()
        if event.get("event") == "turn_completed":
            entry.turn_count += 1
        self._apply_phase_from_event(entry, event)
        self._append_recent_event(entry, event)
        logger.info(
            "symphony_codex_event issue_id=%s issue_identifier=%s session_id=%s event=%s raw_method=%s message=%s",
            issue_id,
            entry.issue.identifier,
            entry.session_id or "-",
            event.get("event") or "-",
            event.get("raw_method") or event.get("method") or "-",
            _log_message(event.get("message") or event.get("tool_name") or ""),
        )
        rate_limits = self._extract_rate_limits(event)
        if rate_limits is not None:
            self.state.codex_rate_limits = rate_limits
        tokens = self._extract_absolute_tokens(event)
        if tokens is not None:
            self._apply_absolute_tokens(entry, tokens)
        self._persist_state()

    def _set_running_phase(self, issue_id: str, phase: str) -> None:
        entry = self.state.running.get(issue_id)
        if entry is None:
            return
        entry.phase = phase
        entry.status_label = LIFECYCLE_LABELS.get(phase, f"symphony:{phase}")

    def _apply_phase_from_event(self, entry: RunningEntry, event: dict[str, Any]) -> None:
        event_name = event.get("event")
        if event_name in {"process_launch", "session_started"}:
            entry.phase = "starting"
            entry.status_label = LIFECYCLE_LABELS["starting"]
        elif event_name == "turn_started":
            entry.phase = "running"
            entry.status_label = LIFECYCLE_LABELS["running"]
            self._sync_lifecycle_label_background(entry.issue.id, LIFECYCLE_LABELS["running"])
        elif event_name in {"request_timeout", "stderr", "turn_failed", "turn_cancelled", "turn_ended_with_error"}:
            entry.phase = "error"
            entry.status_label = LIFECYCLE_LABELS["failed"]
            self._sync_lifecycle_label_background(entry.issue.id, LIFECYCLE_LABELS["failed"])
        elif event_name == "turn_completed":
            entry.phase = "running"
            entry.status_label = LIFECYCLE_LABELS["running"]

    def _append_recent_event(self, entry: RunningEntry, event: dict[str, Any]) -> None:
        row = {
            "at": entry.last_codex_timestamp.astimezone().isoformat()
            if entry.last_codex_timestamp is not None
            else None,
            "event": event.get("event"),
            "message": entry.last_codex_message,
            "raw_method": event.get("raw_method") or event.get("method"),
            "usage": event.get("usage") or self._usage_row_from_tokens(self._extract_absolute_tokens(event)),
            "raw_event": dict(event),
        }
        entry.recent_events.append(row)
        if len(entry.recent_events) > 20:
            del entry.recent_events[:-20]

    def _usage_row_from_tokens(self, tokens: RuntimeTokens | None) -> dict[str, int] | None:
        if tokens is None:
            return None
        return {
            "input_tokens": tokens.input_tokens,
            "output_tokens": tokens.output_tokens,
            "total_tokens": tokens.total_tokens,
        }

    def _sync_lifecycle_label_background(self, issue_id: str, label_name: str) -> None:
        self._desired_lifecycle_labels[issue_id] = label_name
        try:
            loop = asyncio.get_running_loop()
        except RuntimeError:
            return
        loop.create_task(self._sync_lifecycle_label(issue_id, label_name, only_if_current=True))

    async def _sync_lifecycle_label(
        self, issue_id: str, label_name: str, *, only_if_current: bool = False
    ) -> None:
        if only_if_current:
            if self._desired_lifecycle_labels.get(issue_id) != label_name:
                return
        else:
            self._desired_lifecycle_labels[issue_id] = label_name
        if self.config.tracker.kind != "linear":
            return
        set_label = getattr(self.tracker, "set_issue_lifecycle_label", None)
        if not callable(set_label):
            return
        try:
            result = await set_label(issue_id, label_name)
        except Exception as exc:
            logger.warning(
                "symphony_lifecycle_label outcome=failed issue_id=%s label=%s reason=%s",
                issue_id,
                label_name,
                exc,
            )
            return
        if isinstance(result, dict) and result.get("success") is False:
            logger.warning(
                "symphony_lifecycle_label outcome=failed issue_id=%s label=%s reason=linear_unsuccessful",
                issue_id,
                label_name,
            )

    async def wait_for_idle(self) -> None:
        tasks = list(self._worker_tasks)
        for entry in self.state.running.values():
            if entry.task not in tasks:
                tasks.append(entry.task)
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)

    def _is_active(self, issue: Issue) -> bool:
        active = {normalize_state_key(state) for state in self.config.tracker.active_states}
        terminal = {normalize_state_key(state) for state in self.config.tracker.terminal_states}
        return issue.state_key() in active and issue.state_key() not in terminal

    def _is_terminal(self, issue: Issue) -> bool:
        terminal = {normalize_state_key(state) for state in self.config.tracker.terminal_states}
        return issue.state_key() in terminal

    def _matches_assignee(self, issue: Issue) -> bool:
        configured = self.config.tracker.assignee_id
        if not configured:
            return True
        return issue.assignee_id == configured

    def _is_run_eligible(self, issue: Issue) -> bool:
        if not self._is_active(issue):
            return False
        if self.config.tracker.kind == "linear" and issue.project_slug != self.config.tracker.project_slug:
            return False
        if not self._matches_assignee(issue):
            return False
        if not issue.has_required_labels(self.config.tracker.required_labels):
            return False
        if issue.state_key() == "todo" and issue.has_non_terminal_blocker(self.config.tracker.terminal_states):
            return False
        return True

    def _available_state_slots(self, state: str) -> int:
        state_key = normalize_state_key(state)
        limit = self.config.agent.max_concurrent_agents_by_state.get(
            state_key, self.config.agent.max_concurrent_agents
        )
        running_count = sum(1 for entry in self.state.running.values() if entry.issue.state_key() == state_key)
        return max(limit - running_count, 0)

    def _select_worker_host(self) -> str | None:
        hosts = self.config.worker.ssh_hosts
        if not hosts:
            return None
        for host in hosts:
            running_count = sum(1 for entry in self.state.running.values() if entry.worker_host == host)
            if running_count < self.config.worker.max_concurrent_agents_per_host:
                return host
        return None

    def _session_id_for_log(self, issue_id: str) -> str:
        entry = self.state.running.get(issue_id)
        if entry and entry.session_id:
            return entry.session_id
        return "-"

    def _apply_absolute_tokens(self, entry: RunningEntry, tokens: RuntimeTokens) -> None:
        input_delta = max(tokens.input_tokens - entry.last_reported_tokens.input_tokens, 0)
        output_delta = max(tokens.output_tokens - entry.last_reported_tokens.output_tokens, 0)
        total_delta = max(tokens.total_tokens - entry.last_reported_tokens.total_tokens, 0)
        entry.tokens = tokens
        entry.last_reported_tokens = RuntimeTokens(tokens.input_tokens, tokens.output_tokens, tokens.total_tokens)
        self.state.codex_totals.input_tokens += input_delta
        self.state.codex_totals.output_tokens += output_delta
        self.state.codex_totals.total_tokens += total_delta

    def _extract_absolute_tokens(self, event: dict[str, Any]) -> RuntimeTokens | None:
        payload = event.get("payload")
        if not isinstance(payload, dict):
            return None
        token_payload: Any = None
        if event.get("raw_method") == "thread/tokenUsage/updated":
            token_payload = payload.get("tokenUsage") or payload.get("token_usage") or payload
        if token_payload is None:
            token_payload = payload.get("total_token_usage") or payload.get("totalTokenUsage")
        if not isinstance(token_payload, dict):
            return None
        return RuntimeTokens(
            input_tokens=self._int_from_keys(token_payload, "input_tokens", "inputTokens", "input"),
            output_tokens=self._int_from_keys(token_payload, "output_tokens", "outputTokens", "output"),
            total_tokens=self._int_from_keys(token_payload, "total_tokens", "totalTokens", "total"),
        )

    def _extract_rate_limits(self, event: dict[str, Any]) -> dict[str, Any] | None:
        payload = event.get("payload")
        if not isinstance(payload, dict):
            return None
        rate_limits = payload.get("rate_limits") or payload.get("rateLimits")
        return rate_limits if isinstance(rate_limits, dict) else None

    def _int_from_keys(self, values: dict[str, Any], *keys: str) -> int:
        for key in keys:
            value = values.get(key)
            if isinstance(value, bool):
                continue
            if isinstance(value, int):
                return value
            if isinstance(value, str) and value.strip().isdigit():
                return int(value.strip())
        return 0

    def _persist_state(self) -> None:
        if self.persistence_store is None:
            return
        self.persistence_store.save(
            PersistedState.from_runtime(
                retry_attempts=list(self.state.retry_attempts.values()),
                running=list(self.state.running.values()),
            )
        )


def _log_message(value: Any) -> str:
    text = str(value or "-").replace("\n", "\\n")
    if len(text) > 240:
        return text[:237] + "..."
    return text


def _status_message_from_event(event: dict[str, Any]) -> str | None:
    message = event.get("message")
    if isinstance(message, str) and message.strip():
        if _is_low_value_message(message):
            return None
        return message

    raw_method = event.get("raw_method") or event.get("method")
    if raw_method in {
        "item/started",
        "item/completed",
        "thread/tokenUsage/updated",
        "account/rateLimits/updated",
        "turn/diff/updated",
        "thread/status/changed",
    }:
        return None

    event_name = event.get("event")
    if event_name == "request_timeout":
        method = event.get("method")
        if isinstance(method, str) and method:
            return f"{method} timed out"
        return "request timed out"
    if event_name in {
        "stderr",
        "turn_failed",
        "turn_cancelled",
        "turn_ended_with_error",
        "unsupported_tool_call",
        "malformed",
    }:
        fallback = raw_method or event_name
        return str(fallback) if fallback else None

    tool_name = event.get("tool_name")
    if isinstance(tool_name, str) and tool_name:
        return tool_name
    return None


def _is_low_value_message(message: str) -> bool:
    stripped = message.strip()
    return bool(stripped) and set(stripped) <= {".", " ", "\n", "\r", "\t"}


def _failure_comment_body(entry: RunningEntry, error: str, next_attempt: int) -> str:
    lines = [
        f"Symphony could not complete {entry.issue.identifier}.",
        "",
        f"Failure: {error}",
        f"Next retry attempt: {next_attempt}",
    ]
    if entry.session_id:
        lines.append(f"Codex session: {entry.session_id}")
    if entry.last_codex_message:
        lines.extend(["", f"Last observed message: {entry.last_codex_message}"])
    return "\n".join(lines)
