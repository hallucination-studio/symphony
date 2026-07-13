"""Codex implementation of Performer's private backend interface."""

from __future__ import annotations

from collections.abc import Callable
import asyncio
import base64
import binascii
from datetime import datetime, timezone
import json
import logging
import os
from pathlib import Path
import re
from types import SimpleNamespace
import tomllib
from typing import Any

from performer_api import (
    CONTROL_PROTOCOL_VERSION,
    PerformerAccountState,
    PerformerCapabilities,
    PerformerCheckOutcome,
    PerformerConfigurationSnapshot,
    PerformerControlError,
    PerformerControlRequest,
    PerformerControlResult,
    PerformerLoginState,
    PerformerReadinessState,
    PerformerTurnEvent,
    PerformerTurnRequest,
    PerformerTurnResult,
    RuntimePolicy,
    RuntimeWait,
)

from ..backend_interface import ControlEventSink, PerformerBackendError
from ..codex_client import CodexSdkClient
from ..codex_client_helpers import (
    CodexError,
    _classify_sdk_exception,
    _sanitized_sdk_reason,
)
from ..codex_config import CodexConfig
from ..managed_turn import ManagedTurnError, ProviderTurnOutput, run_managed_turn


ClientFactory = Callable[[CodexConfig], Any]
SdkFactory = Callable[[CodexConfig], Any]
AppServerFactory = Callable[[CodexConfig], Any]

_CONTROL_POLICY = {
    "version": 1,
    "model": "gpt-5.4",
    "model_provider": "openai",
    "approval_mode": "auto_review",
    "reasoning_effort": "high",
    "reasoning_summary": "auto",
    "sandbox": {"plan": "read_only", "execute": "workspace_write", "gate": "read_only"},
    "initialize_timeout_ms": 5_000,
    "turn_timeout_ms": 3_600_000,
    "initialize_max_attempts": 4,
    "overload_max_attempts": 5,
}
_MAX_CONFIG_BYTES = 64 * 1024
_MAX_DEVICE_TEXT = 256
_CONTROL_HEARTBEAT_INTERVAL_SECONDS = 30.0
LOGGER = logging.getLogger(__name__)
_SENSITIVE_CONFIG_KEY_MARKERS = (
    "apikey",
    "authorization",
    "accesstoken",
    "refreshtoken",
    "clientsecret",
    "cookie",
    "credential",
    "password",
    "privatekey",
    "secret",
    "token",
)


class CodexBackend:
    def __init__(
        self,
        *,
        client_factory: ClientFactory | None = None,
        sdk_codex_bin: str | None = None,
        sdk_factory: SdkFactory | None = None,
        app_server_factory: AppServerFactory | None = None,
    ) -> None:
        self._client_factory = client_factory or CodexSdkClient
        self._sdk_codex_bin = sdk_codex_bin
        self._sdk_factory = sdk_factory or create_codex_sdk_client
        self._app_server_factory = app_server_factory or _create_codex_app_server
        self._device_handle: Any | None = None
        self._device_sdk: Any | None = None
        self._device_task: asyncio.Task[None] | None = None
        self._login_status = "idle"
        self._login_method: str | None = None
        self._login_error: PerformerControlError | None = None
        self._binding_generation = 1
        self._execution_policy_sha256 = "0" * 64
        self._last_check_status = "none"
        self._readiness_status = "unchecked"
        self._readiness_error: PerformerControlError | None = None

    @property
    def kind(self) -> str:
        return "codex"

    def capabilities(self) -> PerformerCapabilities:
        return PerformerCapabilities(
            protocol_version=CONTROL_PROTOCOL_VERSION,
            capability_version=1,
            performer_kind=self.kind,
            display_name="Codex",
            turn_kinds=("plan", "execute", "gate"),
            login_methods=("device_code", "api_key"),
            supports_session_delete=True,
            editable_settings=("api_base_url",),
            config_source_visible=True,
            check_supported=True,
        )

    async def control(
        self,
        request: PerformerControlRequest,
        secret_input: bytes | None,
        *,
        emit_event: ControlEventSink | None = None,
    ) -> PerformerControlResult:
        try:
            if request.operation == "performer.status":
                return await self._status_result(request)
            if request.operation == "performer.login":
                return await self._login_result(
                    request,
                    secret_input,
                    emit_event=emit_event,
                )
            if request.operation == "performer.session.delete":
                return await self._session_delete_result(request)
            if request.operation == "performer.config.read":
                configuration, _ = await self._read_configuration()
                return self._success(request, configuration=configuration)
            if request.operation == "performer.config.write":
                configuration = await self._write_configuration(request.arguments["value"])
                self._invalidate_readiness()
                return self._success(
                    request,
                    readiness=self._readiness(),
                    configuration=configuration,
                )
            if request.operation == "performer.check":
                return await self._check_result(request, emit_event=emit_event)
            raise PerformerBackendError(
                "performer_control_protocol_invalid",
                "Unsupported Performer control operation.",
            )
        except PerformerBackendError as exc:
            _log_control_failure(request, exc.code, str(exc), retryable=exc.retryable)
            return self._failed(request, exc.code, str(exc), retryable=exc.retryable)
        except Exception as exc:
            error = _control_error(request.operation, exc)
            _log_control_failure(
                request,
                error.error_code,
                error.sanitized_reason,
                retryable=error.retryable,
            )
            return self._failed(
                request,
                error.error_code,
                error.sanitized_reason,
                retryable=error.retryable,
                action_required=error.action_required,
                next_action=error.next_action,
            )

    def _control_config(self, turn_kind: str = "gate") -> CodexConfig:
        policy = RuntimePolicy.from_dict(_CONTROL_POLICY)
        return CodexConfig.from_runtime_policy(
            policy,
            turn_kind,
            sdk_codex_bin=self._sdk_codex_bin,
        )

    def _readiness(self) -> PerformerReadinessState:
        return PerformerReadinessState(
            performer_kind=self.kind,
            binding_generation=self._binding_generation,
            capability_version=1,
            execution_policy_sha256=self._execution_policy_sha256,
            status=self._readiness_status,
            last_check_status=self._last_check_status,
            error=self._readiness_error,
        )

    def _success(
        self,
        request: PerformerControlRequest,
        *,
        readiness: PerformerReadinessState | None = None,
        account: PerformerAccountState | None = None,
        login: PerformerLoginState | None = None,
        configuration: PerformerConfigurationSnapshot | None = None,
        check: PerformerCheckOutcome | None = None,
    ) -> PerformerControlResult:
        return PerformerControlResult(
            protocol_version=CONTROL_PROTOCOL_VERSION,
            request_id=request.request_id,
            operation=request.operation,
            status="succeeded",
            capabilities=self.capabilities() if request.operation == "performer.status" else None,
            readiness=readiness,
            account=account,
            login=login,
            configuration=configuration,
            check=check,
            error=None,
        )

    def _failed(
        self,
        request: PerformerControlRequest,
        code: str,
        reason: str,
        *,
        retryable: bool = False,
        action_required: bool = True,
        next_action: str = "Inspect the Performer backend and retry the operation.",
    ) -> PerformerControlResult:
        return PerformerControlResult(
            protocol_version=CONTROL_PROTOCOL_VERSION,
            request_id=request.request_id,
            operation=request.operation,
            status="failed",
            capabilities=None,
            readiness=None,
            account=None,
            login=None,
            configuration=None,
            check=None,
            error=PerformerControlError(
                error_code=code,
                sanitized_reason=reason[:500],
                action_required=action_required,
                retryable=retryable,
                attempt_number=None,
                next_action=next_action[:500],
            ),
        )

    async def _status_result(self, request: PerformerControlRequest) -> PerformerControlResult:
        account = await self._account_state()
        login = PerformerLoginState(
            status=self._login_status,
            method=self._login_method,
        )
        return self._success(
            request,
            readiness=self._readiness(),
            account=account,
            login=login,
        )

    async def _account_state(self) -> PerformerAccountState:
        if self._device_handle is not None:
            return PerformerAccountState(status="unknown", display_label=None)
        try:
            sdk = self._sdk_factory(self._control_config())
            await _enter_async(sdk)
            try:
                response = await sdk.account()
            finally:
                await _close_async(sdk)
        except Exception as exc:
            raise PerformerBackendError(
                "performer_backend_setup_failed",
                "Codex account status could not be read.",
                retryable=True,
            ) from exc
        account = getattr(response, "account", None)
        if account is None:
            return PerformerAccountState(status="logged_out", display_label=None)
        root = getattr(account, "root", account)
        email = getattr(root, "email", None)
        label = email if isinstance(email, str) and len(email.encode("utf-8")) <= 200 else None
        return PerformerAccountState(status="authenticated", display_label=label)

    async def _login_result(
        self,
        request: PerformerControlRequest,
        secret_input: bytes | None,
        *,
        emit_event: ControlEventSink | None,
    ) -> PerformerControlResult:
        method = request.arguments["method"]
        if method == "api_key":
            if not isinstance(secret_input, bytes):
                raise PerformerBackendError("performer_login_failed", "API-key input is missing.")
            try:
                api_key = secret_input.decode("utf-8")
            except UnicodeDecodeError as exc:
                raise PerformerBackendError("performer_login_failed", "API-key input is invalid.") from exc
            sdk = self._sdk_factory(self._control_config())
            await _enter_async(sdk)
            try:
                await sdk.login_api_key(api_key)
            except Exception as exc:
                raise PerformerBackendError(
                    "performer_login_failed",
                    "Codex API-key login failed.",
                    retryable=False,
                ) from exc
            finally:
                api_key = ""
                await _close_async(sdk)
            self._login_status = "succeeded"
            self._login_method = "api_key"
            self._login_error = None
            self._invalidate_readiness()
            return self._success(
                request,
                readiness=self._readiness(),
                login=PerformerLoginState(status="succeeded", method="api_key"),
            )

        if self._device_task is not None and not self._device_task.done():
            return self._success(
                request,
                readiness=self._readiness(),
                login=PerformerLoginState(status="pending", method="device_code"),
            )
        sdk = self._sdk_factory(self._control_config())
        await _enter_async(sdk)
        try:
            handle = await sdk.login_chatgpt_device_code()
            verification_url = _safe_device_url(getattr(handle, "verification_url", None))
            user_code = _safe_device_code(getattr(handle, "user_code", None))
        except Exception as exc:
            await _close_async(sdk)
            raise PerformerBackendError(
                "performer_login_failed",
                "Codex device login could not be started.",
                retryable=True,
            ) from exc
        self._device_sdk = sdk
        self._device_handle = handle
        self._login_status = "pending"
        self._login_method = "device_code"
        self._login_error = None
        self._invalidate_readiness()
        await self._emit_control_event(
            request,
            emit_event=emit_event,
            event_kind="login.pending",
            message="Open the Codex device verification URL.",
            verification_url=verification_url,
            user_code=user_code,
            expires_at=None,
            sequence=1,
        )
        self._device_task = asyncio.create_task(
            self._watch_device_login(request, handle, sdk, emit_event)
        )
        return self._success(
            request,
            readiness=self._readiness(),
            login=PerformerLoginState(status="pending", method="device_code"),
        )

    async def _watch_device_login(
        self,
        request: PerformerControlRequest,
        handle: Any,
        sdk: Any,
        emit_event: ControlEventSink | None,
    ) -> None:
        try:
            completion = await handle.wait()
            succeeded = getattr(completion, "success", None) is not False
            self._login_status = "succeeded" if succeeded else "failed"
            self._login_error = None if succeeded else PerformerControlError(
                error_code="performer_login_failed",
                sanitized_reason="Performer device login failed.",
                action_required=True,
                retryable=True,
                attempt_number=None,
                next_action="Retry device login.",
            )
            if self._login_error is not None:
                self._readiness_status = "failed"
                self._readiness_error = self._login_error
            await self._emit_control_event(
                request,
                emit_event=emit_event,
                event_kind="login.succeeded" if succeeded else "login.failed",
                message="Codex device login completed." if succeeded else "Performer device login failed.",
                verification_url=None,
                user_code=None,
                expires_at=None,
                sequence=2,
            )
        except asyncio.CancelledError:
            raise
        except Exception:
            self._login_status = "failed"
            self._login_error = PerformerControlError(
                error_code="performer_login_failed",
                sanitized_reason="Performer device login failed.",
                action_required=True,
                retryable=True,
                attempt_number=None,
                next_action="Retry device login.",
            )
            self._readiness_status = "failed"
            self._readiness_error = self._login_error
            await self._emit_control_event(
                request,
                emit_event=emit_event,
                event_kind="login.failed",
                message="Performer device login failed.",
                verification_url=None,
                user_code=None,
                expires_at=None,
                sequence=2,
            )
        finally:
            await _close_async(sdk)
            self._device_handle = None
            self._device_sdk = None
            self._device_task = None

    async def _session_delete_result(self, request: PerformerControlRequest) -> PerformerControlResult:
        action = request.arguments["action"]
        if action == "cancel_login" and self._device_handle is not None:
            handle = self._device_handle
            task = self._device_task
            try:
                cancel = getattr(handle, "cancel", None)
                if callable(cancel):
                    await cancel()
            finally:
                if task is not None:
                    task.cancel()
                    await asyncio.gather(task, return_exceptions=True)
                self._device_handle = None
                self._device_sdk = None
                self._device_task = None
            self._login_status = "idle"
            self._login_method = None
            self._invalidate_readiness()
        elif action == "logout":
            sdk = self._sdk_factory(self._control_config())
            await _enter_async(sdk)
            try:
                await sdk.logout()
            finally:
                await _close_async(sdk)
            self._login_status = "idle"
            self._login_method = None
            self._invalidate_readiness()
        return self._success(
            request,
            readiness=self._readiness(),
            account=PerformerAccountState(status="logged_out", display_label=None),
            login=PerformerLoginState(status="idle", method=None),
        )

    async def _check_result(
        self,
        request: PerformerControlRequest,
        *,
        emit_event: ControlEventSink | None,
    ) -> PerformerControlResult:
        policy = RuntimePolicy.from_dict(request.arguments["execution_policy"])
        self._binding_generation = request.arguments["binding_generation"]
        self._execution_policy_sha256 = request.arguments["execution_policy_sha256"]
        started = _now()
        self._readiness_status = "checking"
        self._last_check_status = "none"
        self._readiness_error = None
        sdk: Any | None = None
        heartbeat_task: asyncio.Task[None] | None = None
        await self._emit_control_event(
            request,
            emit_event=emit_event,
            event_kind="control.heartbeat",
            message="Codex Check is running.",
            verification_url=None,
            user_code=None,
            expires_at=None,
            sequence=1,
        )
        if emit_event is not None:
            heartbeat_task = asyncio.create_task(
                self._emit_check_heartbeats(request, emit_event)
            )
        try:
            sdk = self._sdk_factory(
                CodexConfig.from_runtime_policy(policy, "gate", sdk_codex_bin=self._sdk_codex_bin)
            )
            initialize_timeout = policy.initialize_timeout_ms / 1000
            await asyncio.wait_for(_enter_async(sdk), timeout=initialize_timeout)
            types = codex_sdk_types()
            thread = await asyncio.wait_for(
                sdk.thread_start(
                    cwd=os.getcwd(),
                    model=policy.model,
                    model_provider=policy.model_provider,
                    sandbox=types.Sandbox.read_only,
                    approval_mode=types.ApprovalMode(policy.approval_mode),
                    ephemeral=True,
                ),
                timeout=initialize_timeout,
            )
            turn = getattr(thread, "turn", None) or getattr(thread, "run", None)
            if not callable(turn):
                raise RuntimeError("Codex SDK Check turn is unavailable")
            handle = await turn(
                "Return exactly JSON {\"ok\":true} to confirm the managed Codex runtime is ready.",
                effort=types.ReasoningEffort(policy.reasoning_effort),
                summary=types.ReasoningSummary.model_validate(policy.reasoning_summary),
                sandbox=types.Sandbox.read_only,
                approval_mode=types.ApprovalMode(policy.approval_mode),
                output_schema={"type": "object", "properties": {"ok": {"type": "boolean"}}, "required": ["ok"], "additionalProperties": False},
            )
            run = getattr(handle, "run", None)
            if not callable(run):
                raise RuntimeError("Codex SDK Check turn handle cannot be consumed")
            result = await asyncio.wait_for(
                run(),
                timeout=policy.turn_timeout_ms / 1000,
            )
            final = getattr(result, "final_response", None)
            if not _valid_check_response(final):
                raise RuntimeError("Codex Check returned invalid structured output")
            self._readiness_status = "ready"
            self._last_check_status = "passed"
            finished = _now()
            return self._success(
                request,
                readiness=self._readiness(),
                check=PerformerCheckOutcome(status="passed", started_at=started, finished_at=finished, summary="Codex Check passed."),
            )
        except TimeoutError:
            error = PerformerControlError(
                error_code="performer_check_timeout",
                sanitized_reason="Codex Check timed out.",
                action_required=True,
                retryable=True,
                attempt_number=1,
                next_action="Repair Codex configuration or timeout policy and run Check again.",
            )
            _log_control_failure(
                request,
                error.error_code,
                error.sanitized_reason,
                retryable=error.retryable,
            )
            self._readiness_status = "failed"
            self._last_check_status = "failed"
            self._readiness_error = error
            return self._success(
                request,
                readiness=self._readiness(),
                check=PerformerCheckOutcome(status="failed", started_at=started, finished_at=_now(), summary=error.sanitized_reason),
            )
        except Exception as exc:
            classified = _classify_sdk_exception(exc)
            adapter_reason = _sanitized_sdk_reason(exc, classified)
            error = PerformerControlError(
                error_code="performer_check_failed",
                sanitized_reason=f"Codex Check failed: {adapter_reason}.",
                action_required=True,
                retryable=True,
                attempt_number=1,
                next_action="Repair Codex configuration and run Check again.",
            )
            _log_control_failure(
                request,
                error.error_code,
                error.sanitized_reason,
                retryable=error.retryable,
            )
            self._readiness_status = "failed"
            self._last_check_status = "failed"
            self._readiness_error = error
            return self._success(
                request,
                readiness=self._readiness(),
                check=PerformerCheckOutcome(status="failed", started_at=started, finished_at=_now(), summary=error.sanitized_reason),
            )
        finally:
            if sdk is not None:
                await _close_async(sdk)
            if heartbeat_task is not None:
                heartbeat_task.cancel()
                await asyncio.gather(heartbeat_task, return_exceptions=True)

    async def _emit_check_heartbeats(
        self,
        request: PerformerControlRequest,
        emit_event: ControlEventSink,
    ) -> None:
        sequence = 2
        while True:
            await asyncio.sleep(_CONTROL_HEARTBEAT_INTERVAL_SECONDS)
            await self._emit_control_event(
                request,
                emit_event=emit_event,
                event_kind="control.heartbeat",
                message="Codex Check is running.",
                verification_url=None,
                user_code=None,
                expires_at=None,
                sequence=sequence,
            )
            sequence += 1

    async def _read_configuration(self) -> tuple[PerformerConfigurationSnapshot, str | None]:
        client = self._app_server_factory(self._control_config())
        await _enter_async(client)
        try:
            from openai_codex.generated.v2_all import ConfigReadParams, ConfigReadResponse, FsReadFileParams, FsReadFileResponse

            response = await client.request("config/read", ConfigReadParams(includeLayers=True), response_model=ConfigReadResponse)
            layer = _user_config_layer(response)
            if layer is None:
                return PerformerConfigurationSnapshot(settings={}, source_format=None, source_text=None), None
            path, version = layer
            file_response = await client.request("fs/readFile", FsReadFileParams(path=path), response_model=FsReadFileResponse)
            source = _decode_config_source(file_response)
            return _configuration_snapshot(source), version
        finally:
            await _close_async(client)

    async def _write_configuration(self, value: str) -> PerformerConfigurationSnapshot:
        _, version = await self._read_configuration()
        client = self._app_server_factory(self._control_config())
        await _enter_async(client)
        try:
            from openai_codex.generated.v2_all import ConfigValueWriteParams, ConfigWriteResponse, MergeStrategy

            response = await client.request(
                "config/value/write",
                ConfigValueWriteParams(
                    expectedVersion=version,
                    keyPath="openai_base_url",
                    mergeStrategy=MergeStrategy.upsert,
                    value=value,
                ),
                response_model=ConfigWriteResponse,
            )
            _bounded_text(getattr(response, "version", None), "config version")
        finally:
            await _close_async(client)
        configuration, _ = await self._read_configuration()
        return configuration

    def _invalidate_readiness(self) -> None:
        self._readiness_status = "unchecked"
        self._last_check_status = "none"
        self._readiness_error = None

    async def _emit_control_event(
        self,
        request: PerformerControlRequest,
        *,
        emit_event: ControlEventSink | None,
        event_kind: str,
        message: str,
        verification_url: str | None,
        user_code: str | None,
        expires_at: str | None,
        sequence: int,
    ) -> None:
        if emit_event is None:
            return
        from performer_api import PerformerControlEvent

        event = PerformerControlEvent(
            protocol_version=CONTROL_PROTOCOL_VERSION,
            request_id=request.request_id,
            operation=request.operation,
            sequence=sequence,
            event_kind=event_kind,
            message=message,
            verification_url=verification_url,
            user_code=user_code,
            expires_at=expires_at,
        )
        outcome = emit_event(event)
        if hasattr(outcome, "__await__"):
            await outcome

    async def run_turn(self, request: PerformerTurnRequest) -> PerformerTurnResult:
        if request.performer_kind != self.kind:
            raise PerformerBackendError(
                "performer_backend_kind_mismatch",
                "The turn request does not match the selected Performer backend.",
            )
        policy = RuntimePolicy.from_dict(request.execution_policy)
        config = CodexConfig.from_runtime_policy(
            policy,
            request.context.turn_kind,
            sdk_codex_bin=self._sdk_codex_bin,
        )
        client = self._client_factory(config)

        async def provider_runner(
            workspace: Path,
            prompt: str,
            existing_thread_id: str | None,
            output_schema: dict[str, Any],
        ) -> ProviderTurnOutput:
            try:
                result = await client.run_session(
                    workspace,
                    prompt,
                    existing_thread_id=existing_thread_id,
                    output_schema=output_schema,
                )
            except Exception as exc:
                classified = _classify_sdk_exception(exc)
                reason = _sanitized_sdk_reason(exc, classified)
                raise PerformerBackendError(
                    classified.code,
                    reason,
                    retryable=classified.code
                    in {"timeout", "upstream_overloaded", "sdk_transport_error"},
                ) from exc
            structured = getattr(result, "structured_result", None)
            if not isinstance(structured, dict):
                raise PerformerBackendError(
                    "invalid_structured_output",
                    "Codex returned invalid structured output.",
                )
            raw_events = [
                dict(event)
                for event in (getattr(result, "events", None) or [])
                if isinstance(event, dict)
            ]
            return ProviderTurnOutput(
                thread_id=str(getattr(result, "thread_id", "") or existing_thread_id or ""),
                structured_result=dict(structured),
                events=_normalized_events(raw_events),
                runtime_wait=_runtime_wait_from_events(raw_events),
            )

        try:
            return await run_managed_turn(request, provider_runner)
        except PerformerBackendError:
            raise
        except ManagedTurnError as exc:
            raise PerformerBackendError(exc.code, str(exc)) from exc
        except Exception as exc:
            raise PerformerBackendError(
                "performer_turn_invalid",
                "The Performer turn result failed validation.",
            ) from exc


def _normalized_events(events: list[dict[str, Any]]) -> tuple[PerformerTurnEvent, ...]:
    normalized: list[PerformerTurnEvent] = []
    for sequence, event in enumerate(events, start=1):
        name = _event_name(event)
        kind = "progress"
        if any(marker in name for marker in ("error", "failed", "warning")):
            kind = "warning"
        elif "heartbeat" in name:
            kind = "heartbeat"
        label = re.sub(r"[^a-z0-9_]+", "_", name)[:100].strip("_") or "event"
        normalized.append(
            PerformerTurnEvent(
                protocol_version=1,
                kind=kind,
                message=f"Codex backend event: {label}.",
                sequence=sequence,
            )
        )
    return tuple(normalized)


def _runtime_wait_from_events(events: list[dict[str, Any]]) -> RuntimeWait | None:
    completed_reviews = {
        _approval_review_id(event)
        for event in events
        if _event_name(event) == "item_autoapprovalreview_completed"
        and _approval_review_id(event)
    }
    for event in reversed(events):
        name = _event_name(event)
        if name == "item_autoapprovalreview_started":
            review_id = _approval_review_id(event)
            if review_id and review_id in completed_reviews:
                continue
            kind = _approval_wait_kind(event)
            fallback = {
                "approval_requested": "Codex requested approval.",
                "permission_required": "Codex requested permission.",
                "tool_input_required": "Codex requested tool input.",
            }[kind]
            return _safe_runtime_wait(kind, _event_message(event, fallback), fallback)
        if name == "item_commandexecution_terminalinteraction":
            fallback = "Codex requested terminal input."
            return _safe_runtime_wait(
                "tool_input_required", _event_message(event, fallback), fallback
            )
        if name == "guardianwarning":
            fallback = "Codex reported a permission warning."
            return _safe_runtime_wait(
                "permission_required", _event_message(event, fallback), fallback
            )
    return None


def _safe_runtime_wait(kind: str, reason: str, fallback: str) -> RuntimeWait:
    try:
        return RuntimeWait(kind, reason)
    except ValueError:
        return RuntimeWait(kind, fallback)


def _event_name(event: dict[str, Any]) -> str:
    payload = event.get("payload") if isinstance(event.get("payload"), dict) else event
    value = (
        payload.get("type")
        or payload.get("event")
        or payload.get("method")
        or event.get("event")
    )
    return (
        str(value or "")
        .replace("/", "_")
        .replace(".", "_")
        .replace("-", "_")
        .lower()
        .removeprefix("sdk_")
    )


def _approval_review_id(event: dict[str, Any]) -> str:
    payload = event.get("payload") if isinstance(event.get("payload"), dict) else event
    return str(payload.get("reviewId") or payload.get("review_id") or "")


def _approval_wait_kind(event: dict[str, Any]) -> str:
    payload = event.get("payload") if isinstance(event.get("payload"), dict) else event
    action = payload.get("action") if isinstance(payload.get("action"), dict) else {}
    action_type = str(action.get("type") or "").lower()
    if action_type in {"requestpermissions", "networkaccess"}:
        return "permission_required"
    if action_type == "mcptoolcall":
        return "tool_input_required"
    return "approval_requested"


def _event_message(event: dict[str, Any], fallback: str) -> str:
    payload = event.get("payload") if isinstance(event.get("payload"), dict) else event
    action = payload.get("action") if isinstance(payload.get("action"), dict) else {}
    for value in (
        event.get("message"),
        payload.get("message"),
        payload.get("stdin"),
        action.get("reason"),
    ):
        message = str(value or "").strip()
        if message:
            return message
    return fallback


def codex_sdk_types() -> Any:
    try:
        from openai_codex import ApprovalMode, Sandbox  # type: ignore
        from openai_codex.types import ReasoningEffort, ReasoningSummary  # type: ignore
    except ImportError as exc:
        raise CodexError(
            "codex_sdk_not_installed",
            "Install openai-codex to run Performer Codex turns",
        ) from exc
    return SimpleNamespace(
        ApprovalMode=ApprovalMode,
        Sandbox=Sandbox,
        ReasoningEffort=ReasoningEffort,
        ReasoningSummary=ReasoningSummary,
    )


def create_codex_sdk_client(config: CodexConfig) -> Any:
    try:
        from openai_codex import AsyncCodex  # type: ignore
        from openai_codex import CodexConfig as SdkCodexConfig  # type: ignore
    except ImportError as exc:
        raise CodexError(
            "codex_sdk_not_installed",
            "Install openai-codex to run Performer Codex turns",
        ) from exc
    sdk_config = CodexSdkClient(config)._sdk_config(SdkCodexConfig)
    return AsyncCodex(config=sdk_config)


def is_codex_sdk_retryable(exc: BaseException) -> bool:
    try:
        from openai_codex.errors import is_retryable_error  # type: ignore
    except ImportError:
        return False
    try:
        return bool(is_retryable_error(exc))
    except Exception:
        return False


def _create_codex_app_server(config: CodexConfig) -> Any:
    try:
        from openai_codex import CodexConfig as SdkCodexConfig
        from openai_codex.async_client import AsyncCodexClient
    except ImportError as exc:
        raise CodexError(
            "codex_sdk_not_installed",
            "The Codex SDK is not installed.",
        ) from exc
    sdk_config = CodexSdkClient(config)._sdk_config(SdkCodexConfig)
    return AsyncCodexClient(config=sdk_config)


async def _enter_async(value: Any) -> Any:
    enter = getattr(value, "__aenter__", None)
    if callable(enter):
        return await enter()
    return value


async def _close_async(value: Any) -> None:
    exit_method = getattr(value, "__aexit__", None)
    if callable(exit_method):
        try:
            await exit_method(None, None, None)
        except Exception:
            return
        return
    close = getattr(value, "close", None)
    if callable(close):
        try:
            result = close()
            if hasattr(result, "__await__"):
                await result
        except Exception:
            return


def _safe_device_url(value: Any) -> str:
    from urllib.parse import urlsplit

    if not isinstance(value, str) or len(value.encode("utf-8")) > _MAX_DEVICE_TEXT:
        raise ValueError("invalid device verification URL")
    parsed = urlsplit(value)
    if parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.password:
        raise ValueError("invalid device verification URL")
    return value


def _safe_device_code(value: Any) -> str:
    if not isinstance(value, str) or not value or len(value.encode("utf-8")) > _MAX_DEVICE_TEXT:
        raise ValueError("invalid device user code")
    return value.replace("\r", " ").replace("\n", " ").strip()


def _now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def _bounded_text(value: Any, label: str) -> str:
    if not isinstance(value, str) or not value or len(value.encode("utf-8")) > 256:
        raise ValueError(f"invalid {label}")
    return value


def _valid_check_response(value: Any) -> bool:
    if isinstance(value, dict):
        return value == {"ok": True}
    if not isinstance(value, str) or len(value.encode("utf-8")) > 1_024:
        return False
    try:
        decoded = json.loads(value)
    except (TypeError, json.JSONDecodeError):
        return False
    return decoded == {"ok": True}


def _user_config_layer(response: Any) -> tuple[str, str] | None:
    for layer in getattr(response, "layers", None) or []:
        source = getattr(getattr(layer, "name", None), "root", None)
        if getattr(source, "type", None) != "user":
            continue
        path = getattr(getattr(source, "file", None), "root", None)
        version = getattr(layer, "version", None)
        if not isinstance(path, str) or not path or not os.path.isabs(path):
            raise ValueError("invalid Codex config source")
        return path, _bounded_text(version, "config version")
    return None


def _decode_config_source(response: Any) -> str:
    encoded = getattr(response, "data_base64", None)
    if not isinstance(encoded, str) or len(encoded) > _MAX_CONFIG_BYTES * 2:
        raise ValueError("Codex config source is too large")
    try:
        decoded = base64.b64decode(encoded, validate=True)
        source = decoded.decode("utf-8")
    except (binascii.Error, UnicodeDecodeError, ValueError) as exc:
        raise ValueError("Codex config source is invalid") from exc
    if len(decoded) > _MAX_CONFIG_BYTES:
        raise ValueError("Codex config source is too large")
    return source


def _configuration_snapshot(source: str) -> PerformerConfigurationSnapshot:
    parse_failed = False
    try:
        parsed = tomllib.loads(source)
    except (TypeError, tomllib.TOMLDecodeError):
        parsed = {}
        parse_failed = True
    settings: dict[str, str | None] = {}
    value = parsed.get("openai_base_url") if isinstance(parsed, dict) else None
    if isinstance(value, str):
        settings["api_base_url"] = value
    redacted = _redact_config_source(source, parsed, parse_failed=parse_failed)
    return PerformerConfigurationSnapshot(
        settings=settings,
        source_format="text",
        source_text=redacted,
    )


def _redact_config_source(
    source: str,
    parsed: dict[str, Any],
    *,
    parse_failed: bool,
) -> str:
    if parse_failed or _contains_sensitive_config_key(parsed):
        return "# [REDACTED SENSITIVE CONFIGURATION]\n"
    patterns = (
        r"(?im)(^\s*(?:api[_-]?key|token|password|secret|client[_-]?secret)\s*=\s*)([^\n#]+)",
    )
    redacted = source
    for pattern in patterns:
        redacted = re.sub(pattern, r"\1\"[REDACTED]\"", redacted)
    return redacted[:_MAX_CONFIG_BYTES]


def _contains_sensitive_config_key(value: Any) -> bool:
    if isinstance(value, dict):
        for key, item in value.items():
            normalized = re.sub(r"[^a-z0-9]", "", str(key).lower())
            if normalized in {"env", "httpheaders", "headers"} or any(
                marker in normalized for marker in _SENSITIVE_CONFIG_KEY_MARKERS
            ):
                return True
            if _contains_sensitive_config_key(item):
                return True
    elif isinstance(value, list):
        return any(_contains_sensitive_config_key(item) for item in value)
    return False


def _log_control_failure(
    request: PerformerControlRequest,
    error_code: str,
    sanitized_reason: str,
    *,
    retryable: bool,
) -> None:
    LOGGER.error(
        "event=performer_control_failed request_id=%s operation=%s "
        "error_type=PerformerBackendError error_code=%s sanitized_reason=%s "
        "action_required=%s retryable=%s next_action=inspect_performer_backend",
        request.request_id,
        request.operation,
        error_code,
        sanitized_reason.replace(" ", "_")[:500],
        "true",
        str(retryable).lower(),
    )


def _control_error(operation: str, exc: Exception) -> PerformerControlError:
    codes = {
        "performer.status": "performer_status_failed",
        "performer.login": "performer_login_failed",
        "performer.session.delete": "performer_session_delete_failed",
        "performer.config.read": "performer_config_read_failed",
        "performer.config.write": "performer_config_write_failed",
        "performer.check": "performer_check_failed",
    }
    return PerformerControlError(
        error_code=codes.get(operation, "performer_control_failed"),
        sanitized_reason="Codex control operation failed.",
        action_required=True,
        retryable=True,
        attempt_number=None,
        next_action="Inspect the Codex backend configuration and retry.",
    )


__all__ = [
    "CodexBackend",
    "codex_sdk_types",
    "create_codex_sdk_client",
    "is_codex_sdk_retryable",
]
