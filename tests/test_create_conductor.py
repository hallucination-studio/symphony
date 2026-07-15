from __future__ import annotations

from pathlib import Path

import pytest

from podium.desktop_app import DesktopLifecycle
from podium.desktop_commands import CommandError
from podium.desktop_commands_conductors import dispatch_conductor_command
from podium.desktop_health import handle_request
from podium.linear_models import InstallationMetadata, InstallationStatus, LinearProject
from podium.store.bindings import BindingRepository
from podium.store.linear import LinearRepository


def setup(tmp_path: Path):
    app = DesktopLifecycle(tmp_path / "app-data")
    app.start()
    linear = LinearRepository(app.store.connection)
    linear.save_installation(
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
    linear.replace_credentials(
        "installation-1", "access-sentinel", "refresh-sentinel", expires_at=1000
    )
    linear.replace_projects(
        "installation-1",
        [
            LinearProject("project-1", "organization-1", "", "Runtime", "runtime"),
            LinearProject("project-2", "organization-1", "", "Agents", "agents"),
        ],
    )
    first = (tmp_path / "repo-one").resolve()
    second = (tmp_path / "repo-two").resolve()
    first.mkdir()
    second.mkdir()
    return app, BindingRepository(app.store.connection), first, second


def create(repository, project, path, unique_id):
    return dispatch_conductor_command(
        "conductor.create",
        {"project_id": project, "repository": str(path)},
        repository,
        id_factory=lambda: unique_id,
    )


def test_create_atomically_persists_one_pending_desired_binding(tmp_path: Path) -> None:
    app, repository, path, _ = setup(tmp_path)

    output = create(repository, "project-1", path, "one")

    assert output == {
        "binding_id": "binding-one",
        "project_id": "project-1",
        "conductor_id": "conductor-one",
        "generation": 1,
        "desired": "running",
        "observed": "pending",
    }
    binding = repository.get("binding-one")
    assert binding.repository_path == str(path)
    assert binding.data_root_key == "conductor-one"
    assert binding.desired_state == "running"
    assert binding.observed_state == "pending"
    app.shutdown()


def test_binding_reopens_with_stable_identity_and_no_path_in_output(tmp_path: Path) -> None:
    root = tmp_path / "app-data"
    app, repository, path, _ = setup(tmp_path)
    output = create(repository, "project-1", path, "stable")
    app.shutdown()
    reopened = DesktopLifecycle(root)
    reopened.start()

    binding = BindingRepository(reopened.store.connection).get("binding-stable")
    assert binding.conductor_id == output["conductor_id"]
    assert str(path) not in str(output)
    assert "access-sentinel" not in str(output)
    reopened.shutdown()


def test_private_desktop_protocol_returns_closed_create_result(tmp_path: Path) -> None:
    app, _repository, path, _ = setup(tmp_path)

    response, stopping = handle_request(
        {
            "kind": "command",
            "request_id": "create-1",
            "protocol_version": 1,
            "command": "conductor.create",
            "input": {"project_id": "project-1", "repository": str(path)},
        },
        app,
    )

    assert stopping is False
    assert response["ok"] is True
    assert response["command"] == "conductor.create"
    assert set(response["output"]) == {
        "binding_id",
        "project_id",
        "conductor_id",
        "generation",
        "desired",
        "observed",
    }
    assert str(path) not in str(response)
    app.shutdown()


def test_unavailable_project_rolls_back_without_repository_only_state(
    tmp_path: Path,
) -> None:
    app, repository, path, _ = setup(tmp_path)

    with pytest.raises(CommandError, match="binding_project_unavailable"):
        create(repository, "missing", path, "one")

    assert repository.active() == []
    app.shutdown()


@pytest.mark.parametrize("conflict", ["project", "repository", "conductor"])
def test_create_uniqueness_conflicts_leave_only_the_first_binding(
    tmp_path: Path, conflict: str
) -> None:
    app, repository, first, second = setup(tmp_path)
    create(repository, "project-1", first, "one")
    project = "project-1" if conflict == "project" else "project-2"
    path = first if conflict == "repository" else second
    unique_id = "one" if conflict == "conductor" else "two"

    with pytest.raises(CommandError):
        create(repository, project, path, unique_id)

    assert [binding.binding_id for binding in repository.active()] == ["binding-one"]
    app.shutdown()


@pytest.mark.parametrize(
    "input_value",
    [
        [],
        {},
        {"project_id": "project-1"},
        {"project_id": "project-1", "repository": "relative"},
        {"project_id": "project-1", "repository": "/missing"},
        {"project_id": "project-1", "repository": "/tmp", "selected": True},
    ],
)
def test_invalid_picker_input_writes_nothing(
    tmp_path: Path, input_value: object
) -> None:
    app, repository, _first, _second = setup(tmp_path)

    with pytest.raises(CommandError, match="desktop_command_input_invalid"):
        dispatch_conductor_command("conductor.create", input_value, repository)

    assert repository.active() == []
    app.shutdown()


def test_transaction_failure_rolls_back_every_binding_field(tmp_path: Path, caplog) -> None:
    app, repository, path, _ = setup(tmp_path)
    app.store.connection.execute(
        """CREATE TRIGGER reject_binding BEFORE INSERT ON conductor_bindings
        BEGIN SELECT RAISE(ABORT, 'path-token-sentinel'); END"""
    )

    with pytest.raises(CommandError) as raised:
        create(repository, "project-1", path, "one")

    assert raised.value.code == "create_conductor_persistence_failed"
    assert repository.active() == []
    assert str(path) not in caplog.text
    assert "path-token-sentinel" not in caplog.text
    app.shutdown()
