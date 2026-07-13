"""Bounded stdio host for provider-neutral Performer control operations."""

from __future__ import annotations

import asyncio
import json
import os
import struct
from collections.abc import Mapping
from typing import Any, BinaryIO

from performer_api.performer_control import (
    CONTROL_PROTOCOL_VERSION,
    MAX_SECRET_INPUT_BYTES,
    PerformerControlError,
    PerformerControlEvent,
    PerformerControlRequest,
    PerformerControlResult,
)


MAX_CONTROL_METADATA_BYTES = 256 * 1024
MAX_CONTROL_OUTPUT_BYTES = 256 * 1024
_LENGTH_PREFIX = struct.Struct(">I")


class ControlProtocolError(RuntimeError):
    """Closed protocol failure that is safe to report without source input."""

    code = "performer_control_protocol_invalid"


def encode_metadata_frame(
    request: PerformerControlRequest | Mapping[str, Any],
) -> bytes:
    """Encode one bounded metadata frame for a control-host stdin stream."""

    payload = request.to_dict() if isinstance(request, PerformerControlRequest) else dict(request)
    encoded = _json_bytes(payload)
    if not encoded or len(encoded) > MAX_CONTROL_METADATA_BYTES:
        raise ControlProtocolError("metadata frame size is invalid")
    return _LENGTH_PREFIX.pack(len(encoded)) + encoded


def encode_secret_frame(secret_input: bytes) -> bytes:
    """Encode secret bytes separately from serializable request metadata."""

    if not isinstance(secret_input, bytes):
        raise TypeError("secret input must be bytes")
    if not 1 <= len(secret_input) <= MAX_SECRET_INPUT_BYTES:
        raise ControlProtocolError("secret frame size is invalid")
    return _LENGTH_PREFIX.pack(len(secret_input)) + secret_input


async def run_control_host(
    backend: Any,
    *,
    stdin: BinaryIO,
    stdout: BinaryIO,
    stderr: BinaryIO,
) -> int:
    """Serve control requests until clean stdin EOF or a protocol violation.

    Blocking pipe reads run in a worker thread so provider-owned background
    login tasks can continue while the host waits for the next request.
    """

    output_lock = asyncio.Lock()
    stderr_lock = asyncio.Lock()
    active_requests: set[str] = set()
    tasks: set[asyncio.Task[None]] = set()
    fatal: ControlProtocolError | None = None
    stdin_interrupted = False

    async def write_output(frame_kind: str, payload: dict[str, Any]) -> None:
        async with output_lock:
            _write_output(stdout, frame_kind, payload)

    async def write_log(**fields: Any) -> None:
        async with stderr_lock:
            _write_log(stderr, **fields)

    async def emit_event(request: PerformerControlRequest, event: Any) -> None:
        if not isinstance(event, PerformerControlEvent):
            raise ControlProtocolError("backend emitted an invalid control event")
        try:
            normalized = PerformerControlEvent.from_dict(event.to_dict())
        except (TypeError, ValueError) as exc:
            raise ControlProtocolError("backend emitted an invalid control event") from exc
        if (
            normalized.protocol_version != request.protocol_version
            or normalized.request_id != request.request_id
            or normalized.operation != request.operation
        ):
            raise ControlProtocolError("backend event does not match request")
        await write_output("control.event", normalized.to_dict())

    async def handle_request(request: PerformerControlRequest, secret_input: bytes | None) -> None:
        nonlocal fatal, stdin_interrupted
        try:
            try:
                result = await _call_backend(
                    backend,
                    request,
                    secret_input,
                    (
                        (lambda event: emit_event(request, event))
                        if request.operation in {"performer.login", "performer.check"}
                        else None
                    ),
                )
            except ControlProtocolError:
                raise
            except Exception:
                result = _failed_result(request)
                await write_log(
                    event="performer_control_operation_failed",
                    error_type="PerformerControlError",
                    error_code="performer_control_failed",
                    sanitized_reason="The Performer control operation failed.",
                    action_required=True,
                    retryable=False,
                    next_action="Correct the backend setup and retry the control operation.",
                    request_id=request.request_id,
                    operation=request.operation,
                )
            normalized = _validate_result(result, request)
            await write_output("control.result", normalized.to_dict())
        except ControlProtocolError as error:
            fatal = error
            stdin_interrupted = _interrupt_stdin(stdin) or stdin_interrupted
        finally:
            active_requests.discard(request.request_id)
            secret_input = None

    try:
        while True:
            if fatal is not None:
                raise fatal
            try:
                metadata = await asyncio.to_thread(
                    _read_frame,
                    stdin,
                    MAX_CONTROL_METADATA_BYTES,
                    True,
                )
            except (OSError, ValueError) as exc:
                if fatal is not None:
                    raise fatal from exc
                raise ControlProtocolError("control input could not be read") from exc
            if metadata is None:
                if tasks:
                    await asyncio.gather(*tasks, return_exceptions=True)
                if fatal is not None:
                    raise fatal
                return 0
            request = _parse_request(metadata)
            if request.performer_kind != _backend_kind(backend):
                raise ControlProtocolError("request backend kind does not match host")
            if request.request_id in active_requests:
                raise ControlProtocolError("duplicate control request id")

            secret_input: bytes | None = None
            if request.secret_input is not None:
                try:
                    secret_frame = await asyncio.to_thread(
                        _read_frame,
                        stdin,
                        MAX_SECRET_INPUT_BYTES,
                        False,
                    )
                except (OSError, ValueError) as exc:
                    if fatal is not None:
                        raise fatal from exc
                    raise ControlProtocolError("control input could not be read") from exc
                if secret_frame is None or len(secret_frame) != request.secret_input.length:
                    raise ControlProtocolError("secret frame length does not match metadata")
                secret_input = secret_frame
            active_requests.add(request.request_id)
            task = asyncio.create_task(handle_request(request, secret_input))
            tasks.add(task)
            task.add_done_callback(tasks.discard)
    except ControlProtocolError:
        if not stdin_interrupted:
            try:
                stdin.close()
            except (OSError, ValueError):
                pass
        await write_log(
            event="performer_control_protocol_failed",
            error_type="ControlProtocolError",
            error_code="performer_control_protocol_invalid",
            sanitized_reason="The Performer control protocol input was invalid.",
            action_required=True,
            retryable=False,
            next_action="Restart the Performer control host and retry the request.",
        )
        return 1


def _interrupt_stdin(stdin: BinaryIO) -> bool:
    try:
        descriptor = stdin.fileno()
    except (AttributeError, OSError, ValueError):
        try:
            stdin.close()
        except (OSError, ValueError):
            pass
        return True
    try:
        os.close(descriptor)
    except OSError:
        return False
    return True


async def _call_backend(
    backend: Any,
    request: PerformerControlRequest,
    secret_input: bytes | None,
    emit_event: Any,
) -> PerformerControlResult:
    control = getattr(backend, "control", None)
    if not callable(control):
        raise ControlProtocolError("backend control operation is unavailable")
    return await control(request, secret_input, emit_event=emit_event)


def _read_frame(
    stream: BinaryIO,
    maximum_bytes: int,
    allow_clean_eof: bool,
) -> bytes | None:
    prefix = stream.read(_LENGTH_PREFIX.size)
    if prefix == b"" and allow_clean_eof:
        return None
    if len(prefix) != _LENGTH_PREFIX.size:
        raise ControlProtocolError("frame length prefix is incomplete")
    (length,) = _LENGTH_PREFIX.unpack(prefix)
    if not 1 <= length <= maximum_bytes:
        raise ControlProtocolError("frame length is out of bounds")
    payload = stream.read(length)
    if len(payload) != length:
        raise ControlProtocolError("frame payload is incomplete")
    return payload


def _parse_request(metadata: bytes) -> PerformerControlRequest:
    try:
        payload = json.loads(metadata.decode("utf-8"))
        if not isinstance(payload, dict):
            raise ValueError("metadata must be an object")
        return PerformerControlRequest.from_dict(payload)
    except (UnicodeDecodeError, json.JSONDecodeError, TypeError, ValueError) as exc:
        raise ControlProtocolError("metadata frame is invalid") from exc


def _backend_kind(backend: Any) -> str:
    kind = getattr(backend, "kind", None)
    if not isinstance(kind, str) or not kind:
        raise ControlProtocolError("backend kind is invalid")
    return kind


def _failed_result(request: PerformerControlRequest) -> PerformerControlResult:
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
            error_code="performer_control_failed",
            sanitized_reason="The Performer control operation failed.",
            action_required=True,
            retryable=False,
            attempt_number=None,
            next_action="Correct the backend setup and retry the control operation.",
        ),
    )


def _validate_result(
    result: Any,
    request: PerformerControlRequest,
) -> PerformerControlResult:
    if not isinstance(result, PerformerControlResult):
        raise ControlProtocolError("backend returned an invalid control result")
    try:
        normalized = PerformerControlResult.from_dict(result.to_dict())
    except (TypeError, ValueError) as exc:
        raise ControlProtocolError("backend returned an invalid control result") from exc
    if (
        normalized.protocol_version != request.protocol_version
        or normalized.request_id != request.request_id
        or normalized.operation != request.operation
    ):
        raise ControlProtocolError("backend result does not match request")
    return normalized


def _write_output(stdout: BinaryIO, frame_kind: str, payload: dict[str, Any]) -> None:
    encoded = _json_bytes({"frame_kind": frame_kind, "payload": payload})
    if len(encoded) > MAX_CONTROL_OUTPUT_BYTES:
        raise ControlProtocolError("control output frame is oversized")
    stdout.write(encoded + b"\n")
    stdout.flush()


def _write_log(stderr: BinaryIO, **fields: Any) -> None:
    stderr.write(_json_bytes(fields) + b"\n")
    stderr.flush()


def _json_bytes(payload: Mapping[str, Any]) -> bytes:
    try:
        return json.dumps(
            payload,
            ensure_ascii=True,
            separators=(",", ":"),
            sort_keys=True,
        ).encode("utf-8")
    except (TypeError, ValueError) as exc:
        raise ControlProtocolError("control payload is not JSON serializable") from exc


__all__ = [
    "ControlProtocolError",
    "MAX_CONTROL_METADATA_BYTES",
    "MAX_CONTROL_OUTPUT_BYTES",
    "encode_metadata_frame",
    "encode_secret_frame",
    "run_control_host",
]
