from __future__ import annotations

from array import array
import json
import logging
import os
import socket
import struct
import sys
from dataclasses import dataclass
from pathlib import Path
import threading
from typing import Callable, Protocol

from .local_runtime_server import LocalRuntimeServer
from .local_sessions import LocalSessionIdentity

from .store.failures import BackgroundFailure, FailureRepository
from .store.linear import LinearRepository
from .store.sqlite import SQLiteStore
from .linear_disconnect import (
    LinearAuthorizationLifecycle,
    default_authorization_lifecycle,
)

LOGGER = logging.getLogger(__name__)
_HANDOFF_FIELDS = frozenset(
    {
        "protocol_version",
        "conductor_id",
        "instance_id",
        "project_id",
        "binding_id",
        "binding_generation",
        "session_id",
        "expected_pid",
    }
)
_MAX_HANDOFF_BYTES = 4 * 1024


class BackgroundJob(Protocol):
    name: str

    def start(self, report_failure: Callable[[BackgroundFailure], None]) -> None: ...

    def stop(self) -> None: ...


class DesktopSessionHandoff:
    name = "desktop_session_handoff"

    def __init__(self, channel: socket.socket, server: LocalRuntimeServer) -> None:
        self.channel = channel
        self.server = server
        self._thread: threading.Thread | None = None
        self._stopping = False

    def start(self, report_failure: Callable[[BackgroundFailure], None]) -> None:
        if self._thread is not None:
            raise RuntimeError("desktop_session_handoff_already_started")
        self._stopping = False
        self._thread = threading.Thread(
            target=self._run,
            args=(report_failure,),
            name="podium-session-handoff",
            daemon=True,
        )
        self._thread.start()

    def stop(self) -> None:
        self._stopping = True
        self.server.close_all()
        try:
            self.channel.shutdown(socket.SHUT_RDWR)
        except OSError:
            pass
        self.channel.close()
        thread = self._thread
        if thread is not None:
            thread.join(timeout=1)
            if thread.is_alive():
                raise RuntimeError("desktop_session_handoff_stop_failed")
        self._thread = None

    def _run(self, report_failure: Callable[[BackgroundFailure], None]) -> None:
        while not self._stopping:
            transferred: socket.socket | None = None
            session_id = "unknown"
            try:
                payload, transferred = _receive_handoff(self.channel)
                if payload is None:
                    return
                _validate_handoff_metadata(payload)
                session_id = payload["session_id"]
                identity = LocalSessionIdentity(
                    payload["conductor_id"],
                    payload["project_id"],
                    payload["binding_id"],
                    payload["binding_generation"],
                    payload["instance_id"],
                    payload["expected_pid"],
                )
                record = self.server.adopt(
                    identity, transferred, session_id=session_id
                )
                transferred = None
                self.server.accept(session_id, peer_pid=identity.expected_pid)
                _write_handoff_result(
                    self.channel,
                    {"status": "accepted", "session_id": record.session_id},
                )
            except Exception as error:
                if transferred is not None:
                    transferred.close()
                if self._stopping:
                    return
                code = _handoff_error_code(error)
                LOGGER.error(
                    "event=podium_session_handoff_failed session_id=%s "
                    "error_type=local_runtime error_code=%s sanitized_reason=%s "
                    "action_required=true retryable=false "
                    "next_action=restart_conductor",
                    session_id,
                    code,
                    code,
                )
                try:
                    _write_handoff_result(
                        self.channel,
                        {
                            "status": "rejected",
                            "session_id": session_id,
                            "error_code": code,
                        },
                    )
                except OSError:
                    report_failure(
                        BackgroundFailure(
                            "desktop_session_handoff_failed",
                            1,
                            "desktop_session_handoff_failed",
                            "restart_desktop",
                            None,
                        )
                    )
                    return


def _receive_handoff(
    channel: socket.socket,
) -> tuple[dict[str, object] | None, socket.socket | None]:
    fd_size = array("i").itemsize
    data, ancillary, flags, _ = channel.recvmsg(
        _MAX_HANDOFF_BYTES + 4, socket.CMSG_SPACE(fd_size)
    )
    if not data:
        return None, None
    while len(data) < 4:
        chunk = channel.recv(4 - len(data))
        if not chunk:
            raise ValueError("desktop_session_handoff_frame_incomplete")
        data += chunk
    size = struct.unpack(">I", data[:4])[0]
    if size > _MAX_HANDOFF_BYTES:
        raise ValueError("desktop_session_handoff_frame_too_large")
    body = data[4:]
    while len(body) < size:
        chunk = channel.recv(size - len(body))
        if not chunk:
            raise ValueError("desktop_session_handoff_frame_incomplete")
        body += chunk
    if len(body) != size:
        raise ValueError("desktop_session_handoff_frame_invalid")
    descriptors = array("i")
    for level, kind, value in ancillary:
        if level == socket.SOL_SOCKET and kind == socket.SCM_RIGHTS:
            descriptors.frombytes(value[: len(value) - (len(value) % fd_size)])
    if flags & socket.MSG_CTRUNC or len(descriptors) != 1:
        for descriptor in descriptors:
            os.close(descriptor)
        raise ValueError("desktop_session_handoff_descriptor_invalid")
    try:
        payload = json.loads(body)
        if not isinstance(payload, dict) or set(payload) != _HANDOFF_FIELDS:
            raise ValueError("desktop_session_handoff_metadata_invalid")
        transferred = socket.socket(fileno=descriptors[0])
        return payload, transferred
    except Exception:
        os.close(descriptors[0])
        raise


def _validate_handoff_metadata(payload: dict[str, object]) -> None:
    if type(payload["protocol_version"]) is not int or payload["protocol_version"] != 1:
        raise ValueError("desktop_session_handoff_version_invalid")
    for field in (
        "conductor_id",
        "instance_id",
        "project_id",
        "binding_id",
        "session_id",
    ):
        if not isinstance(payload[field], str):
            raise ValueError("desktop_session_handoff_metadata_invalid")
    for field in ("binding_generation", "expected_pid"):
        if type(payload[field]) is not int:
            raise ValueError("desktop_session_handoff_metadata_invalid")


def _write_handoff_result(channel: socket.socket, result: dict[str, object]) -> None:
    body = json.dumps(result, separators=(",", ":")).encode()
    channel.sendall(struct.pack(">I", len(body)) + body)


def _handoff_error_code(error: Exception) -> str:
    code = str(error)
    if code.startswith("local_runtime_") or code.startswith("desktop_session_handoff_"):
        return code
    return "desktop_session_handoff_failed"


@dataclass(frozen=True)
class DesktopPaths:
    data_root: Path
    runtime_root: Path
    logs_root: Path
    database_path: Path

    @classmethod
    def create(cls, data_root: Path) -> DesktopPaths:
        root = data_root.expanduser().resolve()
        paths = cls(root, root / "runtime", root / "logs", root / "podium.db")
        for directory in (paths.data_root, paths.runtime_root, paths.logs_root):
            directory.mkdir(parents=True, exist_ok=True)
        return paths


@dataclass(frozen=True)
class LifecycleSnapshot:
    status: str
    installation_status: str
    error_code: str | None = None
    sanitized_reason: str | None = None
    action_required: bool = False
    retryable: bool = False
    next_action: str = "none"


class DesktopLifecycle:
    def __init__(
        self,
        data_root: Path,
        *,
        jobs: tuple[BackgroundJob, ...] = (),
        local_runtime_server: LocalRuntimeServer | None = None,
    ) -> None:
        self.data_root = data_root
        self.jobs = jobs
        self.paths: DesktopPaths | None = None
        self.store: SQLiteStore | None = None
        self.linear_authorization: LinearAuthorizationLifecycle | None = None
        self.snapshot = LifecycleSnapshot("starting", "unknown")
        self.accepting_work = False
        self._started_jobs: list[BackgroundJob] = []
        self.local_runtime_server = local_runtime_server

    def start(self) -> LifecycleSnapshot:
        stage = "paths"
        try:
            self.paths = DesktopPaths.create(self.data_root)
            stage = "database"
            self.store = SQLiteStore(self.paths.database_path)
            self.store.initialize()
            self.linear_authorization = default_authorization_lifecycle(
                LinearRepository(self.store.connection)
            )
            stage = "installation_state"
            installation_status = self._installation_status()
            self.snapshot = LifecycleSnapshot("starting", installation_status)
            stage = "background_jobs"
            for job in self.jobs:
                self._started_jobs.append(job)
                job.start(self._record_background_failure)
            if self.snapshot.status != "degraded":
                self.accepting_work = True
                self.snapshot = LifecycleSnapshot("ready", installation_status)
                LOGGER.info(
                    "event=podium_desktop_ready installation_status=%s "
                    "retryable=false next_action=none",
                    installation_status,
                )
        except Exception as error:
            self._fail_startup(error, stage)
        return self.snapshot

    def shutdown(self) -> LifecycleSnapshot:
        if (
            self.store is None
            and not self._started_jobs
            and self.snapshot.status == "stopped"
        ):
            return self.snapshot
        self.accepting_work = False
        self.snapshot = LifecycleSnapshot("stopping", self.snapshot.installation_status)
        errors: list[Exception] = []
        for job in reversed(self._started_jobs):
            try:
                job.stop()
            except Exception as error:
                errors.append(error)
                LOGGER.error(
                    "event=podium_background_job_stop_failed job=%s error_type=%s "
                    "error_code=background_job_stop_failed sanitized_reason=job_stop_failed "
                    "action_required=true retryable=false next_action=restart_desktop",
                    job.name,
                    type(error).__name__,
                )
        self._started_jobs.clear()
        if self.local_runtime_server is not None:
            try:
                self.local_runtime_server.close_all()
            except Exception as error:
                errors.append(error)
                LOGGER.error(
                    "event=podium_local_runtime_shutdown_failed error_type=%s "
                    "error_code=podium_local_runtime_shutdown_failed "
                    "sanitized_reason=local_runtime_shutdown_failed "
                    "action_required=true retryable=false next_action=restart_desktop",
                    type(error).__name__,
                )
        if self.store is not None:
            try:
                self.store.close()
            except Exception as error:
                errors.append(error)
                LOGGER.error(
                    "event=podium_database_close_failed error_type=%s "
                    "error_code=podium_database_close_failed sanitized_reason=database_close_failed "
                    "action_required=true retryable=false next_action=restart_desktop",
                    type(error).__name__,
                )
            finally:
                self.store = None
                self.linear_authorization = None
        if errors:
            self.snapshot = LifecycleSnapshot(
                "failed",
                self.snapshot.installation_status,
                "podium_desktop_shutdown_failed",
                "shutdown_failed",
                True,
                False,
                "restart_desktop",
            )
            raise RuntimeError("podium_desktop_shutdown_failed") from errors[0]
        self.snapshot = LifecycleSnapshot("stopped", self.snapshot.installation_status)
        LOGGER.info("event=podium_desktop_stopped retryable=false next_action=none")
        return self.snapshot

    def _installation_status(self) -> str:
        assert self.store is not None
        row = self.store.connection.execute(
            "SELECT status FROM linear_installations ORDER BY installation_id LIMIT 1"
        ).fetchone()
        return row["status"] if row is not None else "not_installed"

    def _record_background_failure(self, failure: BackgroundFailure) -> None:
        if self.store is None:
            self._observe_failure(
                "podium_database_unavailable",
                "database_unavailable",
                next_action="repair_application_data",
            )
            LOGGER.error(
                "event=podium_background_failure_not_persisted error_type=database_unavailable "
                "error_code=podium_database_unavailable sanitized_reason=database_unavailable "
                "action_required=true retryable=false "
                "next_action=repair_application_data"
            )
            return
        try:
            FailureRepository(self.store.connection).save(failure)
        except Exception as error:
            self._observe_failure(
                "podium_database_write_failed",
                "database_write_failed",
                next_action="repair_application_data",
            )
            LOGGER.error(
                "event=podium_background_failure_not_persisted error_type=%s "
                "error_code=podium_database_write_failed sanitized_reason=database_write_failed "
                "action_required=true retryable=false "
                "next_action=repair_application_data",
                type(error).__name__,
            )
            return
        self._observe_failure(
            failure.failure_id,
            failure.last_reason,
            retryable=True,
            next_action=failure.next_action,
        )
        LOGGER.error(
            "event=podium_background_job_failed failure_id=%s error_type=background_job "
            "error_code=%s sanitized_reason=%s action_required=true retryable=true "
            "attempt_number=%s next_action=%s",
            failure.failure_id,
            failure.failure_id,
            failure.last_reason,
            failure.retry_count,
            failure.next_action,
        )

    @property
    def needs_shutdown(self) -> bool:
        return self.store is not None or bool(self._started_jobs)

    def _observe_failure(
        self,
        error_code: str,
        reason: str,
        *,
        retryable: bool = False,
        next_action: str,
    ) -> None:
        self.accepting_work = False
        self.snapshot = LifecycleSnapshot(
            "degraded",
            self.snapshot.installation_status,
            error_code,
            reason,
            True,
            retryable,
            next_action,
        )

    def _fail_startup(self, error: Exception, stage: str) -> None:
        for job in reversed(self._started_jobs):
            try:
                job.stop()
            except Exception as stop_error:
                LOGGER.error(
                    "event=podium_background_job_stop_failed job=%s error_type=%s "
                    "error_code=background_job_stop_failed sanitized_reason=job_stop_failed "
                    "action_required=true retryable=false next_action=restart_desktop",
                    job.name,
                    type(stop_error).__name__,
                )
        self._started_jobs.clear()
        if self.store is not None:
            try:
                self.store.close()
            except Exception as close_error:
                LOGGER.error(
                    "event=podium_database_close_failed error_type=%s "
                    "error_code=podium_database_close_failed sanitized_reason=database_close_failed "
                    "action_required=true retryable=false next_action=restart_desktop",
                    type(close_error).__name__,
                )
            self.store = None
            self.linear_authorization = None
        self.accepting_work = False
        error_code = f"podium_{stage}_startup_failed"
        reason = f"{stage}_startup_failed"
        self.snapshot = LifecycleSnapshot(
            "failed",
            "unknown",
            error_code,
            reason,
            True,
            False,
            "repair_application_data",
        )
        LOGGER.error(
            "event=podium_desktop_startup_failed error_type=%s "
            "error_code=%s sanitized_reason=%s "
            "action_required=true retryable=false "
            "next_action=repair_application_data",
            type(error).__name__,
            error_code,
            reason,
        )


def default_data_root() -> Path:
    override = os.environ.get("PODIUM_DATA_ROOT")
    if override:
        return Path(override)
    if sys.platform == "darwin":
        return Path.home() / "Library" / "Application Support" / "Symphony" / "Podium"
    if os.name == "nt":
        return Path(os.environ["LOCALAPPDATA"]) / "Symphony" / "Podium"
    data_home = os.environ.get("XDG_DATA_HOME")
    root = Path(data_home) if data_home else Path.home() / ".local" / "share"
    return root / "symphony" / "podium"
