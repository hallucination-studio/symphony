from __future__ import annotations

import logging
import os
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Protocol

from .store.failures import BackgroundFailure, FailureRepository
from .store.sqlite import SQLiteStore

LOGGER = logging.getLogger(__name__)


class BackgroundJob(Protocol):
    name: str

    def start(self, report_failure: Callable[[BackgroundFailure], None]) -> None: ...

    def stop(self) -> None: ...


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
    def __init__(self, data_root: Path, *, jobs: tuple[BackgroundJob, ...] = ()) -> None:
        self.data_root = data_root
        self.jobs = jobs
        self.paths: DesktopPaths | None = None
        self.store: SQLiteStore | None = None
        self.snapshot = LifecycleSnapshot("starting", "unknown")
        self.accepting_work = False
        self._started_jobs: list[BackgroundJob] = []

    def start(self) -> LifecycleSnapshot:
        stage = "paths"
        try:
            self.paths = DesktopPaths.create(self.data_root)
            stage = "database"
            self.store = SQLiteStore(self.paths.database_path)
            self.store.initialize()
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
        if self.store is None and not self._started_jobs and self.snapshot.status == "stopped":
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
                "podium_database_unavailable", "database_unavailable",
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
                "podium_database_write_failed", "database_write_failed",
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
