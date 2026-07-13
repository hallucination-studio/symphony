"""Provider-neutral coordination for the installed Performer control process."""

from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator, Awaitable, Callable, Mapping, Sequence
from contextlib import asynccontextmanager, suppress
from dataclasses import dataclass
import inspect
import json
import logging
from types import MappingProxyType
from typing import Any

from performer_api.performer_control import (
    MAX_SECRET_INPUT_BYTES,
    PerformerControlEvent,
    PerformerControlRequest,
    PerformerControlResult,
)


LOGGER = logging.getLogger(__name__)
_MAX_METADATA_BYTES = 256 * 1024
_MAX_STDOUT_LINE_BYTES = 512 * 1024
_READ_CHUNK_BYTES = 64 * 1024
_MUTATING_OPERATIONS = frozenset(
    {"performer.login", "performer.session.delete", "performer.config.write"}
)
_EXCLUSIVE_OPERATIONS = _MUTATING_OPERATIONS | frozenset(
    {"performer.config.read", "performer.check"}
)
_BYPASS_OPERATIONS = frozenset({"performer.status"})
_FRAME_KINDS = frozenset({"control.event", "control.result"})


class PerformerCoordinatorError(RuntimeError):
    """Closed, sanitized coordinator failure for durable-state integration."""

    def __init__(
        self,
        error_code: str,
        sanitized_reason: str,
        *,
        action_required: bool,
        retryable: bool,
        next_action: str,
    ) -> None:
        super().__init__(sanitized_reason)
        self.error_code = error_code
        self.sanitized_reason = sanitized_reason
        self.action_required = action_required
        self.retryable = retryable
        self.next_action = next_action

    def to_dict(self) -> dict[str, Any]:
        return {
            "error_code": self.error_code,
            "sanitized_reason": self.sanitized_reason,
            "action_required": self.action_required,
            "retryable": self.retryable,
            "next_action": self.next_action,
        }


Hook = Callable[[Any], Awaitable[None] | None]


@dataclass(frozen=True)
class PerformerCoordinatorHooks:
    """Side-effect ports owned by Conductor service/store integration."""

    on_event: Hook | None = None
    on_failure: Hook | None = None
    on_readiness_invalidated: Hook | None = None
    on_check_started: Hook | None = None
    on_login_lost: Hook | None = None
    on_stderr: Hook | None = None


@dataclass
class _PendingRequest:
    request: PerformerControlRequest
    future: asyncio.Future[PerformerControlResult]
    event_collector: Hook | None = None
    last_event_sequence: int = 0


@dataclass
class _LoginSubscription:
    request_id: str
    operation: str
    last_event_sequence: int


class PerformerCoordinator:
    """Own one installed Performer control process and its closed exchanges."""

    def __init__(
        self,
        *,
        command: Sequence[str],
        process_env: Mapping[str, str],
        hooks: PerformerCoordinatorHooks | None = None,
        request_timeout_seconds: float = 30.0,
        cwd: str | None = None,
    ) -> None:
        if not command or any(not isinstance(part, str) or not part for part in command):
            raise ValueError("Performer control command must be a non-empty string sequence")
        if request_timeout_seconds <= 0:
            raise ValueError("request_timeout_seconds must be positive")
        self.command = tuple(command)
        self.process_env = MappingProxyType({str(key): str(value) for key, value in process_env.items()})
        self.hooks = hooks or PerformerCoordinatorHooks()
        self.request_timeout_seconds = float(request_timeout_seconds)
        self.cwd = cwd
        self._process: asyncio.subprocess.Process | None = None
        self._reader_task: asyncio.Task[None] | None = None
        self._stderr_task: asyncio.Task[None] | None = None
        self._wait_task: asyncio.Task[None] | None = None
        self._write_lock = asyncio.Lock()
        self._exclusive_lock = asyncio.Lock()
        self._lifecycle_lock = asyncio.Lock()
        self._pending: dict[str, _PendingRequest] = {}
        self._stopping = False
        self._failed = False
        self._pending_device_login = False
        self._login_subscription: _LoginSubscription | None = None

    @property
    def is_running(self) -> bool:
        return self._process is not None and self._process.returncode is None

    async def start(self) -> None:
        async with self._lifecycle_lock:
            if self.is_running:
                return
            self._stopping = False
            self._failed = False
            try:
                self._process = await asyncio.create_subprocess_exec(
                    *self.command,
                    stdin=asyncio.subprocess.PIPE,
                    stdout=asyncio.subprocess.PIPE,
                    stderr=asyncio.subprocess.PIPE,
                    env=dict(self.process_env),
                    cwd=self.cwd,
                    limit=_MAX_STDOUT_LINE_BYTES + 1,
                )
            except OSError as exc:
                error = self._error(
                    "performer_control_process_exited",
                    "Performer control process could not be started",
                    action_required=True,
                    retryable=True,
                    next_action="install_or_reconfigure_performer",
                )
                await self._notify(self.hooks.on_failure, error)
                raise error from exc
            self._reader_task = asyncio.create_task(self._read_stdout())
            self._stderr_task = asyncio.create_task(self._read_stderr())
            self._wait_task = asyncio.create_task(self._watch_process())
            LOGGER.info(
                "event=performer_control_process_started pid=%s",
                self._process.pid,
            )

    async def stop(self) -> None:
        async with self._lifecycle_lock:
            self._stopping = True
            await self._mark_login_lost()
            process = self._process
            if process is not None and process.returncode is None:
                process.terminate()
                with suppress(asyncio.TimeoutError):
                    await asyncio.wait_for(process.wait(), timeout=2.0)
                if process.returncode is None:
                    process.kill()
                    await process.wait()
            for task in (self._reader_task, self._stderr_task, self._wait_task):
                if task is not None and task is not asyncio.current_task():
                    task.cancel()
            await asyncio.gather(
                *(task for task in (self._reader_task, self._stderr_task, self._wait_task) if task is not None),
                return_exceptions=True,
            )
            self._fail_pending(self._error(
                "performer_control_process_exited",
                "Performer control process stopped before the exchange completed",
                action_required=False,
                retryable=True,
                next_action="restart_performer_control",
            ))
            self._process = None
            self._reader_task = self._stderr_task = self._wait_task = None

    async def request(
        self,
        request: PerformerControlRequest,
        *,
        secret_input: bytes | None = None,
        timeout_seconds: float | None = None,
        event_collector: Hook | None = None,
    ) -> PerformerControlResult:
        self._validate_secret(request, secret_input)
        if request.request_id in self._pending:
            raise self._error(
                "performer_control_protocol_invalid",
                "Duplicate Performer control request id",
                action_required=True,
                retryable=False,
                next_action="use_a_unique_request_id",
            )
        cancel_pending_login = (
            request.operation == "performer.session.delete"
            and request.arguments.get("action") == "cancel_login"
            and self._pending_device_login
        )
        bypasses_exclusivity = (
            request.operation in _BYPASS_OPERATIONS or cancel_pending_login
        )
        if self._pending_device_login and not bypasses_exclusivity:
            raise self._error(
                "performer_control_busy",
                "Performer is waiting for device login completion",
                action_required=False,
                retryable=True,
                next_action="complete_or_cancel_device_login",
            )
        if request.operation not in _EXCLUSIVE_OPERATIONS and not bypasses_exclusivity:
            raise self._error(
                "performer_control_protocol_invalid",
                "Unsupported Performer control exclusivity class",
                action_required=True,
                retryable=False,
                next_action="update_conductor",
            )
        if bypasses_exclusivity:
            return await self._exchange(
                request, secret_input, timeout_seconds, event_collector
            )
        if self._exclusive_lock.locked():
            raise self._error(
                "performer_control_busy",
                "Performer control is busy with an exclusive operation",
                action_required=False,
                retryable=True,
                next_action="retry_after_current_operation",
            )
        async with self._exclusive_lock:
            return await self._exchange(
                request, secret_input, timeout_seconds, event_collector
            )

    @asynccontextmanager
    async def turn_exchange(self) -> AsyncIterator[None]:
        """Reserve the generic exclusive lane for a complete turn subprocess."""

        if self._pending_device_login or self._exclusive_lock.locked():
            raise self._error(
                "performer_control_busy",
                (
                    "Performer is waiting for device login completion"
                    if self._pending_device_login
                    else "Performer is busy with an exclusive operation"
                ),
                action_required=False,
                retryable=True,
                next_action=(
                    "complete_or_cancel_device_login"
                    if self._pending_device_login
                    else "retry_after_current_operation"
                ),
            )
        async with self._exclusive_lock:
            yield

    async def _exchange(
        self,
        request: PerformerControlRequest,
        secret_input: bytes | None,
        timeout_seconds: float | None,
        event_collector: Hook | None,
    ) -> PerformerControlResult:
        if not self.is_running:
            error = self._error(
                "performer_control_process_exited",
                "Performer control process is not running",
                action_required=True,
                retryable=True,
                next_action="restart_performer_control",
            )
            await self._notify(self.hooks.on_failure, error)
            raise error
        if request.operation == "performer.check":
            await self._notify(self.hooks.on_check_started, request)
        elif request.operation in _MUTATING_OPERATIONS:
            await self._notify(self.hooks.on_readiness_invalidated, request)
        loop = asyncio.get_running_loop()
        pending = _PendingRequest(
            request=request,
            future=loop.create_future(),
            event_collector=event_collector,
        )
        self._pending[request.request_id] = pending
        try:
            try:
                await self._write_request(request, secret_input)
            except PerformerCoordinatorError as error:
                await self._notify(self.hooks.on_failure, error)
                self._pending.pop(request.request_id, None)
                await self._terminate_after_failure(error)
                raise
            timeout = self.request_timeout_seconds if timeout_seconds is None else timeout_seconds
            if timeout <= 0:
                raise ValueError("timeout_seconds must be positive")
            try:
                return await asyncio.wait_for(asyncio.shield(pending.future), timeout=timeout)
            except asyncio.TimeoutError as exc:
                error = self._error(
                    "performer_control_timeout",
                    "Performer control operation timed out",
                    action_required=True,
                    retryable=True,
                    next_action="restart_performer_control_and_retry",
                )
                await self._notify(self.hooks.on_failure, error)
                self._pending.pop(request.request_id, None)
                await self._terminate_after_failure(error)
                raise error from exc
        except asyncio.CancelledError:
            self._pending.pop(request.request_id, None)
            await self._terminate_after_failure(
                self._error(
                    "performer_control_cancelled",
                    "Performer control operation was cancelled",
                    action_required=False,
                    retryable=True,
                    next_action="restart_performer_control_and_retry",
                )
            )
            raise
        finally:
            self._pending.pop(request.request_id, None)

    async def _write_request(
        self, request: PerformerControlRequest, secret_input: bytes | None
    ) -> None:
        payload = json.dumps(
            request.to_dict(), separators=(",", ":"), ensure_ascii=False
        ).encode("utf-8")
        if len(payload) > _MAX_METADATA_BYTES:
            raise self._error(
                "performer_control_protocol_invalid",
                "Performer control metadata frame is too large",
                action_required=True,
                retryable=False,
                next_action="reduce_control_request_size",
            )
        process = self._process
        if process is None or process.stdin is None or process.returncode is not None:
            raise self._error(
                "performer_control_process_exited",
                "Performer control process exited before request write",
                action_required=True,
                retryable=True,
                next_action="restart_performer_control",
            )
        async with self._write_lock:
            try:
                process.stdin.write(len(payload).to_bytes(4, "big") + payload)
                if secret_input is not None:
                    process.stdin.write(len(secret_input).to_bytes(4, "big") + secret_input)
                await process.stdin.drain()
            except (BrokenPipeError, ConnectionError) as exc:
                raise self._error(
                    "performer_control_process_exited",
                    "Performer control process exited during request write",
                    action_required=True,
                    retryable=True,
                    next_action="restart_performer_control",
                ) from exc

    async def _read_stdout(self) -> None:
        process = self._process
        if process is None or process.stdout is None:
            return
        while True:
            try:
                line = await process.stdout.readline()
            except (ValueError, asyncio.LimitOverrunError):
                await self._protocol_failure("Performer control stdout frame exceeded its limit")
                return
            if not line:
                return
            if len(line) > _MAX_STDOUT_LINE_BYTES:
                await self._protocol_failure("Performer control stdout frame exceeded its limit")
                return
            try:
                envelope = json.loads(line)
                if not isinstance(envelope, dict) or set(envelope) != {"frame_kind", "payload"}:
                    raise ValueError("invalid envelope shape")
                frame_kind = envelope.get("frame_kind")
                payload = envelope.get("payload")
                if frame_kind not in _FRAME_KINDS or not isinstance(payload, dict):
                    raise ValueError("invalid envelope kind or payload")
                if frame_kind == "control.event":
                    await self._accept_event(PerformerControlEvent.from_dict(payload))
                else:
                    await self._accept_result(PerformerControlResult.from_dict(payload))
            except (json.JSONDecodeError, TypeError, ValueError) as exc:
                await self._protocol_failure("Performer control emitted an invalid closed frame")
                LOGGER.warning(
                    "event=performer_control_protocol_invalid error_type=%s",
                    exc.__class__.__name__,
                )
                return

    async def _accept_event(self, event: PerformerControlEvent) -> None:
        pending = self._pending.get(event.request_id)
        if pending is not None and pending.request.operation == event.operation:
            last_sequence = pending.last_event_sequence
        else:
            subscription = self._login_subscription
            if (
                subscription is None
                or subscription.request_id != event.request_id
                or subscription.operation != event.operation
            ):
                await self._protocol_failure("Performer control emitted a stale event")
                return
            last_sequence = subscription.last_event_sequence
        if event.sequence <= last_sequence:
            await self._protocol_failure("Performer control emitted an out-of-order event")
            return
        if pending is not None and pending.request.operation == event.operation:
            pending.last_event_sequence = event.sequence
        if self._login_subscription is not None:
            self._login_subscription.last_event_sequence = event.sequence
        if event.event_kind in {"login.succeeded", "login.failed"}:
            self._pending_device_login = False
            self._login_subscription = None
        if pending is not None:
            await self._notify(pending.event_collector, event)
        await self._notify(self.hooks.on_event, event)

    async def _accept_result(self, result: PerformerControlResult) -> None:
        pending = self._pending.get(result.request_id)
        if pending is None or pending.request.operation != result.operation:
            await self._protocol_failure("Performer control emitted a stale result")
            return
        if result.operation == "performer.login":
            self._pending_device_login = bool(
                result.status == "succeeded"
                and result.login is not None
                and result.login.status == "pending"
            )
            if self._pending_device_login:
                self._login_subscription = _LoginSubscription(
                    request_id=result.request_id,
                    operation=result.operation,
                    last_event_sequence=pending.last_event_sequence,
                )
            else:
                self._login_subscription = None
        elif result.operation == "performer.session.delete" and result.status == "succeeded":
            self._pending_device_login = False
            self._login_subscription = None
        if result.status == "failed" and result.error is not None:
            error = PerformerCoordinatorError(
                result.error.error_code,
                result.error.sanitized_reason,
                action_required=result.error.action_required,
                retryable=result.error.retryable,
                next_action=result.error.next_action,
            )
            await self._notify(self.hooks.on_failure, error)
            LOGGER.error(
                "event=performer_control_result_failed request_id=%s operation=%s "
                "error_code=%s sanitized_reason=%s action_required=%s retryable=%s "
                "next_action=%s",
                result.request_id,
                result.operation,
                error.error_code,
                error.sanitized_reason.replace(" ", "_"),
                str(error.action_required).lower(),
                str(error.retryable).lower(),
                error.next_action,
            )
        if not pending.future.done():
            pending.future.set_result(result)

    async def _read_stderr(self) -> None:
        process = self._process
        if process is None or process.stderr is None:
            return
        while True:
            chunk = await process.stderr.readline()
            if not chunk:
                return
            message = chunk[:_READ_CHUNK_BYTES].decode("utf-8", errors="replace").rstrip()
            await self._notify(self.hooks.on_stderr, message)

    async def _watch_process(self) -> None:
        process = self._process
        if process is None:
            return
        returncode = await process.wait()
        if self._stopping or self._failed:
            return
        error = self._error(
            "performer_control_process_exited",
            f"Performer control process exited unexpectedly with status {returncode}",
            action_required=True,
            retryable=True,
            next_action="restart_performer_control",
        )
        self._fail_pending(error)
        await self._mark_login_lost(error)
        await self._notify(self.hooks.on_failure, error)
        LOGGER.error(
            "event=performer_control_process_exited error_code=%s sanitized_reason=%s "
            "action_required=%s retryable=%s next_action=%s",
            error.error_code,
            error.sanitized_reason.replace(" ", "_"),
            str(error.action_required).lower(),
            str(error.retryable).lower(),
            error.next_action,
        )

    async def _protocol_failure(self, reason: str) -> None:
        error = self._error(
            "performer_control_protocol_invalid",
            reason,
            action_required=True,
            retryable=False,
            next_action="restart_performer_control_and_update_performer",
        )
        await self._notify(self.hooks.on_failure, error)
        await self._terminate_after_failure(error)

    async def _terminate_after_failure(self, error: PerformerCoordinatorError) -> None:
        self._failed = True
        self._fail_pending(error)
        await self._mark_login_lost(error)
        process = self._process
        if process is not None and process.returncode is None:
            process.terminate()
            try:
                await asyncio.wait_for(process.wait(), timeout=2.0)
            except asyncio.TimeoutError:
                process.kill()
                await process.wait()

    def _fail_pending(self, error: PerformerCoordinatorError) -> None:
        for pending in tuple(self._pending.values()):
            if not pending.future.done():
                pending.future.set_exception(error)

    @staticmethod
    def _validate_secret(request: PerformerControlRequest, secret_input: bytes | None) -> None:
        expected = request.secret_input
        if expected is None:
            if secret_input is not None:
                raise ValueError("secret_input was not declared by request metadata")
            return
        if not isinstance(secret_input, bytes):
            raise ValueError("declared secret_input requires bytes")
        if not 1 <= len(secret_input) <= MAX_SECRET_INPUT_BYTES:
            raise ValueError("secret_input length is out of bounds")
        if len(secret_input) != expected.length:
            raise ValueError("secret_input length does not match metadata")

    @staticmethod
    async def _notify(hook: Hook | None, value: Any) -> None:
        if hook is None:
            return
        outcome = hook(value)
        if inspect.isawaitable(outcome):
            await outcome

    async def _mark_login_lost(
        self, error: PerformerCoordinatorError | None = None
    ) -> None:
        if not self._pending_device_login:
            return
        self._pending_device_login = False
        self._login_subscription = None
        await self._notify(self.hooks.on_login_lost, error)

    @staticmethod
    def _error(
        code: str,
        reason: str,
        *,
        action_required: bool,
        retryable: bool,
        next_action: str,
    ) -> PerformerCoordinatorError:
        return PerformerCoordinatorError(
            code,
            reason,
            action_required=action_required,
            retryable=retryable,
            next_action=next_action,
        )


__all__ = [
    "PerformerCoordinator",
    "PerformerCoordinatorError",
    "PerformerCoordinatorHooks",
]
