from __future__ import annotations

import asyncio
import os
from pathlib import Path
import time

import pytest

from conductor.conductor_service import ConductorService
from conductor.models import LocalRuntimeIdentity
from conductor.podium_ipc import LocalRuntimeClient
from conductor.store import ConductorStore
from performer_api import DispatchLease, LocalRuntimeContext, RuntimeReportMessage
from performer_api.runtime_policy import PerformerProfileConfig
from podium.conductor_bindings import DesiredBinding
from podium.linear_models import InstallationMetadata, InstallationStatus, LinearProject
from podium.local_runtime_commands import (
    LocalRuntimeCommandDispatcher,
    read_runtime_message,
    write_runtime_message,
)
from podium.local_runtime_server import LocalRuntimeServer
from podium.local_sessions import LocalSessionIdentity, LocalSessionRegistry
from podium.store.bindings import BindingRepository
from podium.store.linear import LinearRepository
from podium.store.sqlite import SQLiteStore


def profile() -> PerformerProfileConfig:
    return PerformerProfileConfig.create(
        binding_id="binding-1",
        binding_config_version=1,
        performer_binding_id="performer-binding-1",
        performer_profile_id="performer-profile-1",
        runtime_profile_id="runtime-profile-1",
        performer_kind="codex",
        runtime_kind="codex",
        execution_policy={
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
        },
        turn_policy={"max_turns": 4},
    )


@pytest.mark.asyncio
async def test_checkpoint_4b_podium_and_conductor_complete_private_flow(
    tmp_path: Path,
) -> None:
    repository = tmp_path / "repository"
    repository.mkdir()
    podium_store = SQLiteStore(tmp_path / "podium.db")
    podium_store.initialize()
    linear = LinearRepository(podium_store.connection)
    linear.save_installation(
        InstallationMetadata(
            "installation-1",
            "organization-1",
            "Symphony",
            "app-user-1",
            ("read", "write", "app:assignable"),
            None,
            InstallationStatus.DISCONNECTED,
            1,
            None,
        )
    )
    linear.replace_credentials(
        "installation-1", "test-access-value", "test-refresh-value", expires_at=100
    )
    linear.replace_projects(
        "installation-1",
        (LinearProject("project-1", "organization-1", "team-1", "One", "one"),),
    )
    bindings = BindingRepository(podium_store.connection)
    bindings.create(
        DesiredBinding(
            "binding-1",
            "project-1",
            "conductor-1",
            1,
            repository_path=str(repository),
            data_root_key="conductor-1",
        )
    )

    registry = LocalSessionRegistry()
    server = LocalRuntimeServer(registry)
    pending, child_fd = server.open(
        LocalSessionIdentity(
            "conductor-1",
            "project-1",
            "binding-1",
            1,
            "instance-1",
            os.getpid(),
        )
    )
    client = LocalRuntimeClient.connect(
        child_fd,
        LocalRuntimeIdentity(
            "conductor-1", "instance-1", "project-1", "binding-1", 1
        ),
        pending.expected,
    )
    session = server.accept(pending.session_id, peer_pid=os.getpid())
    dispatcher = LocalRuntimeCommandDispatcher(bindings, registry)
    service = ConductorService(
        store=ConductorStore(tmp_path / "conductor"),
        data_root=tmp_path / "conductor",
    )

    try:
        configure = dispatcher.configure(
            "binding-1",
            "project-slug",
            "Symphony Project",
            "app-user-1",
            profile(),
            policy_revision=3,
        )
        tick = asyncio.create_task(service.private_sync_once(client))
        report = await asyncio.to_thread(read_runtime_message, session.session.channel)
        assert isinstance(report, RuntimeReportMessage)
        assert report.status == "ready"
        assert configure.context == report.context

        lease = DispatchLease(
            LocalRuntimeContext(
                1,
                "conductor-1",
                "instance-1",
                "project-1",
                "binding-1",
                1,
                "lease-checkpoint",
            ),
            "dispatch-checkpoint",
            "issue-checkpoint",
            "lease-checkpoint",
            11,
            int(time.time()) + 30,
        )
        write_runtime_message(session.session.channel, lease)
        acknowledgment = await asyncio.to_thread(
            read_runtime_message, session.session.channel
        )
        assert acknowledgment.status == "accepted"
        assert acknowledgment.dispatch_id == "dispatch-checkpoint"
        assert (await asyncio.wait_for(tick, timeout=1))["status"] == "accepted"
        run = service.store.list_runs()[0]
        assert run["parent_issue_id"] == "issue-checkpoint"
        assert run["payload"]["dispatch_fencing_token"] == 11
    finally:
        client.close()
        server.close_all()
        podium_store.close()
