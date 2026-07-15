from __future__ import annotations

from pathlib import Path

import pytest

from podium.conductor_bindings import DesiredBinding, RuntimeReport, RuntimeStatus
from podium.linear_models import InstallationMetadata, InstallationStatus, LinearProject
from podium.store.bindings import BindingConflict, BindingRepository
from podium.store.linear import LinearRepository
from podium.store.runtime_reports import RuntimeReportRepository, StaleRuntimeReport
from podium.store.sqlite import SQLiteStore


def repositories(
    path: Path,
) -> tuple[SQLiteStore, BindingRepository, RuntimeReportRepository]:
    store = SQLiteStore(path)
    store.initialize()
    linear = LinearRepository(store.connection)
    linear.save_installation(
        InstallationMetadata(
            installation_id="installation-1",
            organization_id="organization-1",
            organization_name="Symphony",
            app_user_id="app-user-1",
            granted_scopes=("read",),
            expires_at=None,
            status=InstallationStatus.DISCONNECTED,
            last_verified_at=None,
            error_code=None,
        )
    )
    linear.replace_projects(
        "installation-1",
        (
            LinearProject("project-1", "organization-1", "team-1", "One", "one"),
            LinearProject("project-2", "organization-1", "team-1", "Two", "two"),
        ),
    )
    return (
        store,
        BindingRepository(store.connection),
        RuntimeReportRepository(store.connection),
    )


def test_active_project_and_conductor_are_unique_and_conflicts_roll_back(
    tmp_path: Path,
) -> None:
    store, bindings, _ = repositories(tmp_path / "podium.db")
    first = DesiredBinding("binding-1", "project-1", "conductor-1", 1)
    bindings.save(first)

    with pytest.raises(BindingConflict, match="active_project_binding_conflict"):
        bindings.save(DesiredBinding("binding-2", "project-1", "conductor-2", 1))
    with pytest.raises(BindingConflict, match="active_conductor_binding_conflict"):
        bindings.save(DesiredBinding("binding-3", "project-2", "conductor-1", 1))
    with pytest.raises(BindingConflict, match="binding_project_not_found"):
        bindings.save(DesiredBinding("binding-4", "missing", "conductor-4", 1))

    assert bindings.active() == [first]
    store.close()


def test_binding_generation_increases_and_reopens(tmp_path: Path) -> None:
    path = tmp_path / "podium.db"
    store, bindings, _ = repositories(path)
    bindings.save(DesiredBinding("binding-1", "project-1", "conductor-1", 1))
    bindings.save(DesiredBinding("binding-1", "project-1", "conductor-1", 2))
    with pytest.raises(BindingConflict, match="binding_generation_not_increased"):
        bindings.save(DesiredBinding("binding-1", "project-1", "conductor-1", 2))
    with pytest.raises(BindingConflict, match="binding_identity_mismatch"):
        bindings.save(DesiredBinding("binding-1", "project-2", "conductor-1", 3))
    store.close()

    reopened = SQLiteStore(path)
    reopened.initialize()
    assert BindingRepository(reopened.connection).get("binding-1").generation == 2


def test_binding_generation_is_the_desired_process_revision() -> None:
    binding = DesiredBinding("binding-1", "project-1", "conductor-1", 7)

    assert binding.desired_revision == 7


def test_stale_reports_cannot_replace_current_safe_report(tmp_path: Path) -> None:
    store, bindings, reports = repositories(tmp_path / "podium.db")
    bindings.save(DesiredBinding("binding-1", "project-1", "conductor-1", 1))
    current = RuntimeReport(
        "binding-1", 1, "instance-1", RuntimeStatus.READY, 100
    )
    reports.save(current)

    with pytest.raises(StaleRuntimeReport, match="stale_generation"):
        reports.save(
            RuntimeReport("binding-1", 2, "instance-2", RuntimeStatus.DEGRADED, 101)
        )
    with pytest.raises(StaleRuntimeReport, match="stale_heartbeat"):
        reports.save(
            RuntimeReport("binding-1", 1, "instance-2", RuntimeStatus.DEGRADED, 99)
        )

    assert reports.get("binding-1") == current

    bindings.save(DesiredBinding("binding-1", "project-1", "conductor-1", 2))
    assert reports.get("binding-1") is None
    store.close()


def test_runtime_report_fields_are_bounded_and_secret_free(tmp_path: Path) -> None:
    _, bindings, reports = repositories(tmp_path / "podium.db")
    bindings.save(DesiredBinding("binding-1", "project-1", "conductor-1", 1))

    with pytest.raises(ValueError, match="runtime_instance_id_invalid"):
        RuntimeReport("binding-1", 1, "x" * 129, RuntimeStatus.READY, 1)
    with pytest.raises(ValueError, match="binding_generation_invalid"):
        RuntimeReport("binding-1", True, "instance-1", RuntimeStatus.READY, 1)
    with pytest.raises(ValueError, match="runtime_heartbeat_invalid"):
        RuntimeReport("binding-1", 1, "instance-1", RuntimeStatus.READY, False)
    with pytest.raises(ValueError, match="runtime_error_code_invalid"):
        RuntimeReport(
            "binding-1", 1, "instance-1", RuntimeStatus.DEGRADED, 1, "raw token=secret"
        )

    columns = {
        row[1]
        for row in reports.connection.execute("PRAGMA table_info(runtime_reports)")
    }
    assert columns == {
        "binding_id",
        "generation",
        "instance_id",
        "status",
        "heartbeat_at",
        "error_code",
    }
    assert columns.isdisjoint({"workflow", "token", "log", "event", "payload"})
