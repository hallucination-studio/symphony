from __future__ import annotations

from pathlib import Path

import pytest

from podium.conductor_bindings import DesiredBinding
from podium.desktop_app import DesktopLifecycle
from podium.desktop_commands import CommandError, dispatch_command
from podium.linear_models import InstallationMetadata, InstallationStatus, LinearProject
from podium.store.bindings import BindingRepository
from podium.store.linear import LinearRepository


def lifecycle(path: Path) -> tuple[DesktopLifecycle, LinearRepository]:
    app = DesktopLifecycle(path)
    app.start()
    repository = app.linear_authorization.repository
    repository.save_installation(
        InstallationMetadata(
            "installation-1",
            "organization-1",
            "Workspace",
            "app-user-1",
            ("app:assignable", "read", "write"),
            None,
            InstallationStatus.DISCONNECTED,
            100,
            None,
        )
    )
    repository.replace_credentials(
        "installation-1", "access-sentinel", "refresh-sentinel", expires_at=1000
    )
    repository.replace_projects(
        "installation-1",
        [
            LinearProject("project-1", "organization-1", "", "Runtime", "runtime"),
            LinearProject("project-2", "organization-1", "", "Agents", "agents"),
        ],
    )
    BindingRepository(app.store.connection).save(
        DesiredBinding("binding-1", "project-1", "conductor-1", 1)
    )
    BindingRepository(app.store.connection).save(
        DesiredBinding("binding-2", "project-2", "conductor-2", 1, active=False)
    )
    return app, repository


def test_catalog_returns_only_closed_safe_fields_and_active_binding(tmp_path: Path) -> None:
    app, _repository = lifecycle(tmp_path / "app-data")

    output = dispatch_command(
        "linear.projects", {"installation_id": "installation-1"}, app
    )

    assert output == {
        "projects": [
            {"id": "project-1", "name": "Runtime", "slug": "runtime", "bound": True},
            {"id": "project-2", "name": "Agents", "slug": "agents", "bound": False},
        ]
    }
    encoded = str(output)
    assert "selected" not in encoded
    assert "repository" not in encoded
    assert "sentinel" not in encoded
    app.shutdown()


def test_catalog_reopens_without_standalone_selection_state(tmp_path: Path) -> None:
    root = tmp_path / "app-data"
    app, _repository = lifecycle(root)
    app.shutdown()
    reopened = DesktopLifecycle(root)
    reopened.start()

    assert dispatch_command(
        "linear.projects", {"installation_id": "installation-1"}, reopened
    )["projects"][0]["bound"] is True
    columns = {
        row["name"]
        for row in reopened.store.connection.execute("PRAGMA table_info(linear_projects)")
    }
    assert "selected" not in columns
    reopened.shutdown()


@pytest.mark.parametrize(
    "input_value",
    [
        {},
        {"installation_id": "installation-1", "selected": True},
        {"installation_id": "installation-1", "repository": "/tmp/repo"},
    ],
)
def test_catalog_rejects_selection_and_repository_inputs(
    tmp_path: Path, input_value: dict[str, object]
) -> None:
    app, _repository = lifecycle(tmp_path / "app-data")

    with pytest.raises(CommandError, match="desktop_command_input_invalid"):
        dispatch_command("linear.projects", input_value, app)

    app.shutdown()


def test_catalog_read_failure_is_a_closed_sanitized_command_error(
    tmp_path: Path, caplog
) -> None:
    app, _repository = lifecycle(tmp_path / "app-data")
    app.store.connection.close()

    with pytest.raises(CommandError) as raised:
        dispatch_command(
            "linear.projects", {"installation_id": "installation-1"}, app
        )

    assert raised.value.to_dict() == {
        "code": "linear_project_catalog_persistence_failed",
        "sanitized_reason": "linear_project_catalog_persistence_failed",
        "action_required": True,
        "retryable": False,
        "next_action": "repair_application_data",
    }
    assert "event=linear_project_catalog_failed" in caplog.text
    assert "database" not in raised.value.sanitized_reason
