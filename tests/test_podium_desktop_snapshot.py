from __future__ import annotations

import json
from pathlib import Path

from podium.conductor_bindings import DesiredBinding, RuntimeReport, RuntimeStatus
from podium.desktop_app import LifecycleSnapshot
from podium.desktop_protocol import MAX_FRAME_BYTES, encode_frame
from podium.desktop_snapshot import build_desktop_snapshot
from podium.linear_models import (
    InstallationMetadata,
    InstallationStatus,
    LinearProject,
)
from podium.store.bindings import BindingRepository
from podium.store.failures import BackgroundFailure, FailureRepository
from podium.store.linear import LinearRepository
from podium.store.runtime_reports import RuntimeReportRepository
from podium.store.sqlite import SQLiteStore


def initialized_store(path: Path) -> SQLiteStore:
    store = SQLiteStore(path)
    store.initialize()
    return store


def seed_bound_runtime(
    store: SQLiteStore,
    *,
    heartbeat_at: int,
    access_token: str = "seed-access",
    refresh_token: str = "seed-refresh",
) -> None:
    linear = LinearRepository(store.connection)
    linear.save_installation(
        InstallationMetadata(
            "installation-1",
            "organization-1",
            "Example",
            "app-user-1",
            ("read", "write"),
            None,
            InstallationStatus.DISCONNECTED,
            100,
            None,
        )
    )
    store.replace_linear_credentials(
        "installation-1", access_token, refresh_token, expires_at=999
    )
    linear.replace_projects(
        "installation-1",
        [LinearProject("project-1", "organization-1", "team-1", "Project", "project")],
    )
    linear.replace_selection(
        "installation-1", ["project-1"], protected_project_ids=[]
    )
    binding = DesiredBinding("binding-1", "project-1", "conductor-1", 3)
    BindingRepository(store.connection).save(binding)
    RuntimeReportRepository(store.connection).save(
        RuntimeReport(
            binding.binding_id,
            binding.generation,
            "instance-1",
            RuntimeStatus.READY,
            heartbeat_at,
        )
    )


def test_snapshot_uses_closed_states_and_never_exposes_credentials(tmp_path: Path) -> None:
    store = initialized_store(tmp_path / "podium.db")
    seed_bound_runtime(
        store,
        heartbeat_at=95,
        access_token="access-secret",
        refresh_token="refresh-secret",
    )

    snapshot = build_desktop_snapshot(
        store.connection,
        LifecycleSnapshot("ready", "connected"),
        now=100,
    )

    assert snapshot["podium"] == {"kind": "ready"}
    assert snapshot["linear"] == {
        "kind": "connected",
        "installation_id": "installation-1",
        "organization_name": "Example",
    }
    assert snapshot["conductors"]["items"] == [
        {
            "kind": "ready",
            "binding_id": "binding-1",
            "project_id": "project-1",
            "conductor_id": "conductor-1",
            "desired_revision": 3,
            "applied_revision": 3,
            "instance_id": "instance-1",
            "heartbeat_at": 95,
        }
    ]
    assert snapshot["performer"] == {
        "kind": "unavailable",
        "reason": "performer_report_unavailable",
    }
    assert snapshot["runs"] == {"kind": "unavailable", "reason": "run_report_unavailable"}
    assert snapshot["waits"] == {"kind": "unavailable", "reason": "wait_report_unavailable"}
    encoded = json.dumps(snapshot)
    assert "access-secret" not in encoded
    assert "refresh-secret" not in encoded
    assert "access_token" not in encoded
    assert "refresh_token" not in encoded


def test_snapshot_marks_missing_and_stale_runtime_reports_as_not_healthy(tmp_path: Path) -> None:
    store = initialized_store(tmp_path / "podium.db")
    seed_bound_runtime(store, heartbeat_at=10)
    linear = LinearRepository(store.connection)
    linear.replace_projects(
        "installation-1",
        [
            LinearProject("project-1", "organization-1", "team-1", "Project", "project"),
            LinearProject("project-2", "organization-1", "team-1", "Other", "other"),
        ],
    )
    BindingRepository(store.connection).save(
        DesiredBinding("binding-2", "project-2", "conductor-2", 1)
    )

    snapshot = build_desktop_snapshot(
        store.connection,
        LifecycleSnapshot("ready", "connected"),
        now=100,
        stale_after=30,
    )

    assert [item["kind"] for item in snapshot["conductors"]["items"]] == [
        "stale",
        "unknown",
    ]


def test_snapshot_marks_future_runtime_report_as_unknown(tmp_path: Path) -> None:
    store = initialized_store(tmp_path / "podium.db")
    seed_bound_runtime(store, heartbeat_at=101)

    snapshot = build_desktop_snapshot(
        store.connection,
        LifecycleSnapshot("ready", "connected"),
        now=100,
    )

    assert snapshot["conductors"]["items"][0]["kind"] == "unknown"


def test_snapshot_bounds_conductors_with_a_cursor(tmp_path: Path) -> None:
    store = initialized_store(tmp_path / "podium.db")
    seed_bound_runtime(store, heartbeat_at=100)
    linear = LinearRepository(store.connection)
    linear.replace_projects(
        "installation-1",
        [
            LinearProject("project-1", "organization-1", "team-1", "One", "one"),
            LinearProject("project-2", "organization-1", "team-1", "Two", "two"),
        ],
    )
    BindingRepository(store.connection).save(
        DesiredBinding("binding-2", "project-2", "conductor-2", 1)
    )

    first = build_desktop_snapshot(
        store.connection, LifecycleSnapshot("ready", "connected"), now=100, limit=1
    )
    second = build_desktop_snapshot(
        store.connection,
        LifecycleSnapshot("ready", "connected"),
        now=100,
        limit=1,
        cursor=first["conductors"]["next_cursor"],
    )

    assert [item["binding_id"] for item in first["conductors"]["items"]] == ["binding-1"]
    assert first["conductors"]["next_cursor"] == "binding-1"
    assert [item["binding_id"] for item in second["conductors"]["items"]] == ["binding-2"]
    assert second["conductors"]["next_cursor"] is None


def test_snapshot_preserves_bounded_correlated_failures(tmp_path: Path) -> None:
    store = initialized_store(tmp_path / "podium.db")
    failures = FailureRepository(store.connection)
    for index in range(3):
        failures.save(
            BackgroundFailure(
                f"polling_failed_{index}",
                index,
                "linear_polling_failed",
                "retry_linear_poll",
                200 + index,
            )
        )

    snapshot = build_desktop_snapshot(
        store.connection,
        LifecycleSnapshot(
            "degraded",
            "connected",
            "podium_background_failed",
            "background_failed",
            True,
            True,
            "retry_background_job",
        ),
        now=100,
        limit=2,
    )

    assert snapshot["podium"] == {
        "kind": "degraded",
        "error_code": "podium_background_failed",
        "sanitized_reason": "background_failed",
        "action_required": True,
        "retryable": True,
        "next_action": "retry_background_job",
    }
    assert len(snapshot["failures"]) == 2
    assert snapshot["failures"][0] == {
        "kind": "active",
        "error_code": "polling_failed_0",
        "correlation_id": "polling_failed_0",
        "sanitized_reason": "linear_polling_failed",
        "retry_count": 0,
        "next_action": "retry_linear_poll",
        "next_attempt_at": 200,
    }


def test_snapshot_rejects_unbounded_or_invalid_page_inputs(tmp_path: Path) -> None:
    store = initialized_store(tmp_path / "podium.db")

    for invalid_limit in (0, 26, True):
        try:
            build_desktop_snapshot(
                store.connection,
                LifecycleSnapshot("ready", "not_installed"),
                now=100,
                limit=invalid_limit,
            )
        except ValueError as error:
            assert str(error) == "desktop_snapshot_limit_invalid"
        else:
            raise AssertionError("invalid limit accepted")

    try:
        build_desktop_snapshot(
            store.connection,
            LifecycleSnapshot("ready", "not_installed"),
            now=100,
            cursor="not a valid cursor",
        )
    except ValueError as error:
        assert str(error) == "desktop_snapshot_cursor_invalid"
    else:
        raise AssertionError("invalid cursor accepted")


def test_maximum_snapshot_page_fits_the_desktop_frame(tmp_path: Path) -> None:
    store = initialized_store(tmp_path / "podium.db")
    seed_bound_runtime(store, heartbeat_at=100)
    linear = LinearRepository(store.connection)
    projects = [
        LinearProject(
            f"project-{index}-" + "p" * 180,
            "organization-1",
            "team-1",
            f"Project {index}",
            f"project-{index}",
        )
        for index in range(2, 26)
    ]
    linear.replace_projects("installation-1", projects)
    bindings = BindingRepository(store.connection)
    failures = FailureRepository(store.connection)
    for index, project in enumerate(projects, start=2):
        bindings.save(
            DesiredBinding(
                f"binding-{index}-" + "b" * 180,
                project.project_id,
                f"conductor-{index}-" + "c" * 175,
                1,
            )
        )
    for index in range(25):
        failures.save(
            BackgroundFailure(
                f"failure_{index}_" + "f" * 110,
                index,
                "r" * 500,
                "n" * 128,
                200 + index,
            )
        )

    snapshot = build_desktop_snapshot(
        store.connection,
        LifecycleSnapshot("ready", "connected"),
        now=100,
        limit=25,
    )

    assert len(snapshot["conductors"]["items"]) == 25
    assert len(snapshot["failures"]) == 25
    assert len(encode_frame(snapshot)) <= MAX_FRAME_BYTES + 4


def test_oversized_linear_metadata_fails_closed_inside_the_frame(
    tmp_path: Path, caplog
) -> None:
    store = initialized_store(tmp_path / "podium.db")
    seed_bound_runtime(store, heartbeat_at=100)
    store.connection.execute(
        "UPDATE linear_installations SET organization_name = ?",
        ("x" * (MAX_FRAME_BYTES + 1),),
    )

    snapshot = build_desktop_snapshot(
        store.connection,
        LifecycleSnapshot("ready", "connected"),
        now=100,
    )

    assert snapshot["linear"] == {
        "kind": "unavailable",
        "reason": "linear_metadata_invalid",
        "error_code": "linear_snapshot_invalid",
        "correlation_id": "linear_snapshot_invalid",
    }
    assert len(encode_frame(snapshot)) <= MAX_FRAME_BYTES + 4
    assert "event=desktop_snapshot_linear_invalid" in caplog.text
    assert "x" * 100 not in caplog.text


def test_snapshot_has_a_deterministic_final_size_guard(tmp_path: Path, caplog) -> None:
    store = initialized_store(tmp_path / "podium.db")

    snapshot = build_desktop_snapshot(
        store.connection,
        LifecycleSnapshot(
            "degraded",
            "not_installed",
            "podium_failure",
            "x" * MAX_FRAME_BYTES,
            True,
            False,
            "inspect_application_data",
        ),
        now=100,
    )

    assert snapshot["podium"]["error_code"] == "desktop_snapshot_too_large"
    assert snapshot["failures"][0]["correlation_id"] == "desktop_snapshot_too_large"
    assert len(encode_frame(snapshot)) <= MAX_FRAME_BYTES + 4
    assert "event=desktop_snapshot_too_large" in caplog.text
    assert "x" * 100 not in caplog.text
