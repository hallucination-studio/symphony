from __future__ import annotations

import logging
import sqlite3
import io
from pathlib import Path
from typing import Callable

import pytest

from podium.desktop_app import DesktopLifecycle
from podium.desktop_cli import run_desktop_protocol
from podium.desktop_protocol import encode_frame, read_frame
from podium.store.failures import BackgroundFailure, FailureRepository


class FakeJob:
    def __init__(
        self,
        name: str,
        events: list[str],
        *,
        start_error: bool = False,
        stop_error: bool = False,
        start_failure: BackgroundFailure | None = None,
    ) -> None:
        self.name = name
        self.events = events
        self.start_error = start_error
        self.stop_error = stop_error
        self.start_failure = start_failure
        self.report_failure: Callable[[BackgroundFailure], None] | None = None

    def start(self, report_failure: Callable[[BackgroundFailure], None]) -> None:
        self.events.append(f"start:{self.name}")
        if self.start_error:
            raise RuntimeError("raw start detail")
        self.report_failure = report_failure
        if self.start_failure is not None:
            report_failure(self.start_failure)

    def stop(self) -> None:
        self.events.append(f"stop:{self.name}")
        if self.stop_error:
            raise RuntimeError("raw stop detail")


def test_startup_creates_paths_opens_sqlite_then_starts_jobs(tmp_path: Path) -> None:
    events: list[str] = []
    job = FakeJob("polling", events)
    lifecycle = DesktopLifecycle(tmp_path / "app-data", jobs=(job,))

    snapshot = lifecycle.start()

    assert snapshot.status == "ready"
    assert snapshot.installation_status == "not_installed"
    assert lifecycle.accepting_work is True
    assert lifecycle.paths is not None
    assert lifecycle.paths.database_path.exists()
    assert lifecycle.paths.runtime_root.is_dir()
    assert lifecycle.paths.logs_root.is_dir()
    assert events == ["start:polling"]


def test_background_failure_is_durable_visible_and_logged(
    tmp_path: Path, caplog: pytest.LogCaptureFixture
) -> None:
    job = FakeJob("polling", [])
    lifecycle = DesktopLifecycle(tmp_path / "app-data", jobs=(job,))
    lifecycle.start()
    caplog.set_level(logging.ERROR)

    assert job.report_failure is not None
    failure = BackgroundFailure(
        "linear_polling_failed", 2, "linear_poll_timeout", "retry_linear_polling", 100
    )
    job.report_failure(failure)

    assert lifecycle.snapshot.status == "degraded"
    assert lifecycle.snapshot.error_code == "linear_polling_failed"
    assert lifecycle.accepting_work is False
    assert FailureRepository(lifecycle.store.connection).get(failure.failure_id) == failure
    assert "event=podium_background_job_failed" in caplog.text
    assert "error_code=linear_polling_failed" in caplog.text
    assert "raw" not in caplog.text


def test_synchronous_job_start_failure_cannot_be_overwritten_by_ready(tmp_path: Path) -> None:
    failure = BackgroundFailure(
        "linear_polling_failed", 1, "linear_poll_timeout", "retry_linear_polling", 100
    )
    lifecycle = DesktopLifecycle(
        tmp_path / "app-data", jobs=(FakeJob("polling", [], start_failure=failure),)
    )

    snapshot = lifecycle.start()

    assert snapshot.status == "degraded"
    assert snapshot.installation_status == "not_installed"
    assert snapshot.error_code == "linear_polling_failed"
    assert snapshot.retryable is True
    assert snapshot.next_action == "retry_linear_polling"
    assert lifecycle.accepting_work is False


def test_background_failure_observation_survives_database_write_failure(
    tmp_path: Path, caplog: pytest.LogCaptureFixture
) -> None:
    job = FakeJob("polling", [])
    lifecycle = DesktopLifecycle(tmp_path / "app-data", jobs=(job,))
    lifecycle.start()
    lifecycle.store.connection.close()
    caplog.set_level(logging.ERROR)

    assert job.report_failure is not None
    job.report_failure(
        BackgroundFailure(
            "linear_polling_failed", 1, "linear_poll_timeout", "retry_linear_polling", 100
        )
    )

    assert lifecycle.snapshot.status == "degraded"
    assert lifecycle.snapshot.error_code == "podium_database_write_failed"
    assert "event=podium_background_failure_not_persisted" in caplog.text
    assert "sanitized_reason=database_write_failed" in caplog.text


def test_unopenable_database_fails_closed_without_fallback(
    tmp_path: Path, caplog: pytest.LogCaptureFixture
) -> None:
    root = tmp_path / "app-data"
    root.mkdir()
    database = root / "podium.db"
    content = b"not a sqlite database"
    database.write_bytes(content)
    caplog.set_level(logging.ERROR)

    lifecycle = DesktopLifecycle(root)
    snapshot = lifecycle.start()

    assert snapshot.status == "failed"
    assert snapshot.error_code == "podium_database_startup_failed"
    assert lifecycle.accepting_work is False
    assert lifecycle.store is None
    assert database.read_bytes() == content
    assert list(root.glob("*.db")) == [database]
    assert "sanitized_reason=database_startup_failed" in caplog.text


def test_job_start_failure_stops_started_jobs_and_closes_database(tmp_path: Path) -> None:
    events: list[str] = []
    first = FakeJob("first", events)
    second = FakeJob("second", events, start_error=True)
    lifecycle = DesktopLifecycle(tmp_path / "app-data", jobs=(first, second))

    snapshot = lifecycle.start()

    assert snapshot.status == "failed"
    assert snapshot.error_code == "podium_background_jobs_startup_failed"
    assert lifecycle.store is None
    assert lifecycle.accepting_work is False
    assert events == ["start:first", "start:second", "stop:second", "stop:first"]


def test_desktop_protocol_reports_real_lifecycle_and_shuts_it_down(tmp_path: Path) -> None:
    lifecycle = DesktopLifecycle(tmp_path / "app-data")
    lifecycle.start()
    stdout = io.BytesIO()
    requests = b"".join(
        encode_frame({"kind": kind, "request_id": request_id, "protocol_version": 1})
        for kind, request_id in (("handshake", "start"), ("shutdown", "stop"))
    )

    assert run_desktop_protocol(
        stdin=io.BytesIO(requests), stdout=stdout, stderr=io.BytesIO(), lifecycle=lifecycle
    ) == 0
    stdout.seek(0)
    assert read_frame(stdout)["status"] == "ready"
    assert read_frame(stdout)["status"] == "stopping"
    assert lifecycle.snapshot.status == "stopped"
    assert lifecycle.store is None


def test_protocol_sanitizes_shutdown_failure(tmp_path: Path) -> None:
    lifecycle = DesktopLifecycle(
        tmp_path / "app-data", jobs=(FakeJob("failing", [], stop_error=True),)
    )
    lifecycle.start()
    stderr = io.BytesIO()

    assert run_desktop_protocol(
        stdin=io.BytesIO(
            encode_frame({"kind": "shutdown", "request_id": "stop", "protocol_version": 1})
        ),
        stdout=io.BytesIO(),
        stderr=stderr,
        lifecycle=lifecycle,
    ) == 3
    assert b"error_code=podium_desktop_shutdown_failed" in stderr.getvalue()
    assert b"raw stop detail" not in stderr.getvalue()


@pytest.mark.parametrize("payload", [b"", b"\x00\x00"])
def test_protocol_exit_always_stops_jobs_and_closes_database(
    tmp_path: Path, payload: bytes
) -> None:
    events: list[str] = []
    lifecycle = DesktopLifecycle(tmp_path / "app-data", jobs=(FakeJob("job", events),))
    lifecycle.start()

    run_desktop_protocol(
        stdin=io.BytesIO(payload), stdout=io.BytesIO(), stderr=io.BytesIO(), lifecycle=lifecycle
    )

    assert events == ["start:job", "stop:job"]
    assert lifecycle.store is None
    assert lifecycle.snapshot.status == "stopped"


def test_failed_handshake_exposes_bounded_lifecycle_reason(tmp_path: Path) -> None:
    root = tmp_path / "app-data"
    root.mkdir()
    (root / "podium.db").write_bytes(b"not sqlite")
    lifecycle = DesktopLifecycle(root)
    lifecycle.start()
    stdout = io.BytesIO()

    run_desktop_protocol(
        stdin=io.BytesIO(
            encode_frame({"kind": "handshake", "request_id": "start", "protocol_version": 1})
        ),
        stdout=stdout,
        stderr=io.BytesIO(),
        lifecycle=lifecycle,
    )
    stdout.seek(0)

    assert read_frame(stdout) == {
        "kind": "handshake.result",
        "request_id": "start",
        "protocol_version": 1,
        "status": "failed",
        "error_code": "podium_database_startup_failed",
        "sanitized_reason": "database_startup_failed",
        "action_required": True,
        "retryable": False,
        "next_action": "repair_application_data",
    }


def test_database_close_failure_has_specific_operator_log(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
) -> None:
    lifecycle = DesktopLifecycle(tmp_path / "app-data")
    lifecycle.start()
    monkeypatch.setattr(
        lifecycle.store, "close", lambda: (_ for _ in ()).throw(RuntimeError("raw close"))
    )
    caplog.set_level(logging.ERROR)

    with pytest.raises(RuntimeError, match="podium_desktop_shutdown_failed"):
        lifecycle.shutdown()

    assert "event=podium_database_close_failed" in caplog.text
    assert "sanitized_reason=database_close_failed" in caplog.text
    assert "raw close" not in caplog.text


def test_shutdown_stops_all_jobs_and_closes_sqlite_without_hiding_error(
    tmp_path: Path,
) -> None:
    events: list[str] = []
    first = FakeJob("first", events)
    second = FakeJob("second", events, stop_error=True)
    lifecycle = DesktopLifecycle(tmp_path / "app-data", jobs=(first, second))
    lifecycle.start()
    connection = lifecycle.store.connection

    with pytest.raises(RuntimeError, match="podium_desktop_shutdown_failed"):
        lifecycle.shutdown()

    assert lifecycle.accepting_work is False
    assert lifecycle.snapshot.status == "failed"
    assert events == ["start:first", "start:second", "stop:second", "stop:first"]
    with pytest.raises(sqlite3.ProgrammingError, match="closed"):
        connection.execute("SELECT 1")
