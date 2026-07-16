from __future__ import annotations

from pathlib import Path

import pytest

from conductor.conductor_service import ConductorService
from conductor.store import ConductorStore
from performer_api import ConfigureCommand, LocalRuntimeContext
from performer_api.runtime_policy import PerformerProfileConfig


EXECUTION_POLICY = {
    "version": 1,
    "model": "gpt-5.4",
    "model_provider": "openai",
    "approval_mode": "auto_review",
    "reasoning_effort": "high",
    "reasoning_summary": "auto",
    "sandbox": {
        "plan": "read_only",
        "execute": "workspace_write",
        "gate": "read_only",
    },
    "initialize_timeout_ms": 5_000,
    "turn_timeout_ms": 3_600_000,
    "initialize_max_attempts": 4,
    "overload_max_attempts": 5,
}


def command(
    repository: Path,
    *,
    generation: int = 1,
    project_id: str = "project-1",
    instance_id: str = "instance-1",
    execution_policy: dict[str, object] | None = None,
) -> ConfigureCommand:
    context = LocalRuntimeContext(
        1,
        "conductor-1",
        instance_id,
        project_id,
        "binding-1",
        generation,
        f"configure-{generation}",
    )
    profile = PerformerProfileConfig.create(
        binding_id="binding-1",
        binding_config_version=generation,
        performer_binding_id="performer-binding-1",
        performer_profile_id="performer-profile-1",
        runtime_profile_id="runtime-profile-1",
        performer_kind="codex",
        runtime_kind="codex",
        execution_policy=execution_policy or EXECUTION_POLICY,
        turn_policy={"max_turns": 4},
    )
    return ConfigureCommand(
        context,
        str(repository),
        "project-slug",
        "Symphony Project",
        "app-user-1",
        generation,
        profile,
    )


def test_private_configure_persists_complete_binding_and_is_restart_idempotent(
    tmp_path: Path,
) -> None:
    repository = tmp_path / "repository"
    repository.mkdir()
    store = ConductorStore(tmp_path / "conductor")
    service = ConductorService(store=store, data_root=tmp_path / "conductor")
    configure = command(repository)

    applied = service.apply_private_configure(configure)
    restarted = ConductorService(store=store, data_root=tmp_path / "conductor")
    duplicate = restarted.apply_private_configure(configure)

    assert applied["status"] == "applied"
    assert duplicate["status"] == "already_applied"
    instance = store.list_instances()[0]
    assert instance.id == "instance-1"
    assert instance.repo_source_value == str(repository)
    assert instance.linear_project == "project-slug"
    assert instance.linear_filters["linear_project_id"] == "project-1"
    assert instance.linear_filters["agent_app_user_id"] == "app-user-1"
    assert instance.linear_filters["policy_revision"] == 1
    assert instance.linear_filters["execution_policy"] == EXECUTION_POLICY
    assert restarted.private_sync_failure is None


@pytest.mark.parametrize(
    "failure", ["stale", "hash", "repository", "project", "instance"]
)
def test_private_configure_conflicts_preserve_current_durable_binding(
    tmp_path: Path, failure: str
) -> None:
    repository = tmp_path / "repository"
    repository.mkdir()
    other_repository = tmp_path / "other"
    other_repository.mkdir()
    store = ConductorStore(tmp_path / "conductor")
    service = ConductorService(store=store, data_root=tmp_path / "conductor")
    current = command(repository, generation=2)
    service.apply_private_configure(current)

    if failure == "stale":
        conflicting = command(repository, generation=1)
    elif failure == "hash":
        conflicting = command(
            repository,
            generation=2,
            execution_policy={**EXECUTION_POLICY, "reasoning_effort": "medium"},
        )
    elif failure == "repository":
        conflicting = command(other_repository, generation=2)
    elif failure == "project":
        conflicting = command(repository, generation=2, project_id="project-2")
    else:
        conflicting = command(repository, generation=2, instance_id="instance-2")

    rejected = service.apply_private_configure(conflicting)

    assert rejected["status"] == "rejected"
    instance = store.list_instances()[0]
    assert instance.repo_source_value == str(repository)
    assert instance.linear_filters["linear_project_id"] == "project-1"
    assert instance.linear_filters["binding_config_version"] == 2
    assert service.private_sync_failure is not None
    assert service.private_sync_failure["binding_id"] == "binding-1"
    assert "token" not in str(service.private_sync_failure).lower()
    assert "event=private_configure_rejected" in Path(instance.log_path).read_text()
