from __future__ import annotations

from pathlib import Path

import pytest

from conductor.conductor_service import ConductorService
from conductor.conductor_store import ConductorStore


def _command(
    repository: Path,
    *,
    project_id: str = "project-alpha",
    version: int = 1,
    binding_id: str = "binding-1",
) -> dict[str, object]:
    return {
        "type": "project.configure",
        "binding_id": binding_id,
        "config_version": version,
        "linear_project_id": project_id,
        "project_slug": "ALPHA" if project_id == "project-alpha" else "BETA",
        "project_name": "Alpha" if project_id == "project-alpha" else "Beta",
        "agent_app_user_id": "linear-app-user-1",
        "repository": {"mode": "local_path", "value": str(repository)},
    }


@pytest.mark.asyncio
async def test_project_configure_creates_one_reportable_project_binding(tmp_path: Path) -> None:
    repository = tmp_path / "repo"
    repository.mkdir()
    (repository / "README.md").write_text("fixture\n", encoding="utf-8")
    service = ConductorService(
        store=ConductorStore(tmp_path / "conductor"),
        data_root=tmp_path / "conductor",
    )

    applied = await service.handle_podium_ws_command(_command(repository))
    repeated = await service.handle_podium_ws_command(_command(repository))
    report = service.build_podium_report()

    assert applied["status"] == "applied"
    assert repeated["status"] == "already_applied"
    assert len(service.list_instances()) == 1
    assert len(report["bindings"]) == 1
    binding = report["bindings"][0]
    assert binding["linear_project_id"] == "project-alpha"
    assert binding["project_slug"] == "ALPHA"
    assert binding["binding_config_version"] == 1
    assert binding["agent_app_user_id"] == "linear-app-user-1"
    assert binding["repo_source"] == {"type": "local_path", "value": str(repository)}


@pytest.mark.asyncio
async def test_project_configure_rejects_second_project_or_stale_version(tmp_path: Path) -> None:
    repository = tmp_path / "repo"
    repository.mkdir()
    service = ConductorService(
        store=ConductorStore(tmp_path / "conductor"),
        data_root=tmp_path / "conductor",
    )
    await service.handle_podium_ws_command(_command(repository, version=2))

    second_project = await service.handle_podium_ws_command(
        _command(repository, project_id="project-beta", version=3)
    )
    stale = await service.handle_podium_ws_command(_command(repository, version=1))

    assert second_project == {
        "status": "rejected",
        "reason": "conductor_already_bound_to_project",
        "linear_project_id": "project-alpha",
    }
    assert stale == {
        "status": "rejected",
        "reason": "stale_project_config",
        "current_version": 2,
    }
    assert len(service.list_instances()) == 1


@pytest.mark.asyncio
async def test_installation_prepare_is_durable_and_activation_is_explicit(tmp_path: Path) -> None:
    repository = tmp_path / "repo"
    repository.mkdir()
    service = ConductorService(
        store=ConductorStore(tmp_path / "conductor"),
        data_root=tmp_path / "conductor",
    )
    await service.handle_podium_ws_command(_command(repository))

    prepared = await service.handle_podium_ws_command(
        {
            "type": "project.prepare_installation",
            "linear_project_id": "project-alpha",
            "installation_id": "installation-candidate",
            "agent_app_user_id": "linear-app-user-2",
            "config_version": 2,
        }
    )
    before_activation = service.build_podium_report()["bindings"][0]
    activated = await service.handle_podium_ws_command(
        {
            "type": "project.activate_installation",
            "installation_id": "installation-candidate",
            "config_version": 2,
        }
    )
    after_activation = service.build_podium_report()["bindings"][0]

    assert prepared == {
        "status": "prepared",
        "installation_id": "installation-candidate",
        "config_version": 2,
    }
    assert before_activation["agent_app_user_id"] == "linear-app-user-1"
    assert before_activation["binding_config_version"] == 1
    assert before_activation["prepared_installation_id"] == "installation-candidate"
    assert before_activation["prepared_binding_config_version"] == 2
    assert activated == {
        "status": "activated",
        "installation_id": "installation-candidate",
        "config_version": 2,
    }
    assert after_activation["agent_app_user_id"] == "linear-app-user-2"
    assert after_activation["binding_config_version"] == 2
    assert after_activation["prepared_installation_id"] == ""


@pytest.mark.asyncio
async def test_project_unconfigure_preserves_repository_reports_ack_and_allows_rebind(tmp_path: Path) -> None:
    repository = tmp_path / "repo"
    repository.mkdir()
    (repository / "README.md").write_text("fixture\n", encoding="utf-8")
    service = ConductorService(
        store=ConductorStore(tmp_path / "conductor"),
        data_root=tmp_path / "conductor",
    )
    await service.handle_podium_ws_command(_command(repository))
    command = {
        "type": "project.unconfigure",
        "binding_id": "binding-1",
        "config_version": 2,
        "delete_repository": False,
    }

    unbound = await service.handle_podium_ws_command(command)
    repeated = await service.handle_podium_ws_command(command)
    report = service.build_podium_report()

    assert unbound == {"status": "unbound", "binding_id": "binding-1", "config_version": 2}
    assert repeated == {"status": "already_unbound", "binding_id": "binding-1", "config_version": 2}
    assert report["bindings"] == []
    assert report["unbound_binding_id"] == "binding-1"
    assert report["unbound_config_version"] == 2
    assert repository.joinpath("README.md").read_text(encoding="utf-8") == "fixture\n"
    assert len(service.list_instances()) == 1

    rebound = await service.handle_podium_ws_command(
        _command(
            repository,
            project_id="project-beta",
            version=3,
            binding_id="binding-2",
        )
    )
    rebound_report = service.build_podium_report()

    assert rebound["status"] == "applied"
    assert rebound_report.get("unbound_binding_id") is None
    assert rebound_report["bindings"][0]["linear_project_id"] == "project-beta"
    assert rebound_report["bindings"][0]["binding_config_version"] == 3
