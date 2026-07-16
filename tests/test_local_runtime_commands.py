from __future__ import annotations

import os
import socket
import threading
import time
from pathlib import Path

import pytest

from conductor.podium_ipc import inherited_podium_channel, send_handshake
from performer_api import DrainAck, LocalRuntimeContext
from podium.conductor_bindings import DesiredBinding
from podium.linear_models import InstallationMetadata, InstallationStatus, LinearProject
from podium.local_runtime_commands import (
    LocalRuntimeCommandDispatcher,
    read_runtime_message,
    write_runtime_message,
)
from podium.local_runtime_server import LocalRuntimeServer
from podium.local_sessions import (
    LocalSessionIdentity,
    LocalSessionRegistry,
)
from podium.store.bindings import BindingRepository
from podium.store.linear import LinearRepository
from podium.store.sqlite import SQLiteStore


def configured_dispatcher(
    tmp_path: Path, *, generation: int = 1
) -> tuple[SQLiteStore, LocalRuntimeCommandDispatcher, socket.socket]:
    repository_path = tmp_path / "repository"
    repository_path.mkdir()
    store = SQLiteStore(tmp_path / "podium.db")
    store.initialize()
    linear = LinearRepository(store.connection)
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
        "installation-1", "access-token", "refresh-token", expires_at=100
    )
    linear.replace_projects(
        "installation-1",
        (LinearProject("project-1", "organization-1", "team-1", "One", "one"),),
    )
    bindings = BindingRepository(store.connection)
    binding = DesiredBinding(
        "binding-1",
        "project-1",
        "conductor-1",
        1,
        repository_path=str(repository_path),
        data_root_key="conductor-1",
    )
    bindings.create(binding)
    if generation > 1:
        binding = DesiredBinding(
            "binding-1",
            "project-1",
            "conductor-1",
            generation,
            repository_path=str(repository_path),
            data_root_key="conductor-1",
        )
        bindings.save(binding)
    registry = LocalSessionRegistry()
    server = LocalRuntimeServer(registry)
    pending, child_fd = server.open(
        LocalSessionIdentity(
            "conductor-1",
            "project-1",
            "binding-1",
            generation,
            "instance-1",
            os.getpid(),
        )
    )
    child = inherited_podium_channel(child_fd)
    send_handshake(child, pending.expected)
    server.accept(pending.session_id, peer_pid=os.getpid())
    return store, LocalRuntimeCommandDispatcher(bindings, registry), child


def test_configure_is_sent_only_to_the_matching_current_session(tmp_path: Path) -> None:
    store, dispatcher, child = configured_dispatcher(tmp_path, generation=2)

    command = dispatcher.configure("binding-1", "profile-1", policy_revision=3)

    received = read_runtime_message(child)
    assert received == command
    assert command.context.binding_generation == 2
    assert command.repository_path == str((tmp_path / "repository").resolve())
    child.close()
    store.close()


def test_configure_rejects_missing_offline_or_stale_sessions(tmp_path: Path) -> None:
    store, dispatcher, child = configured_dispatcher(tmp_path)
    record = dispatcher.registry.active_for_binding("binding-1")
    record.state = "offline"

    with pytest.raises(ValueError, match="local_runtime_session_not_online"):
        dispatcher.configure("binding-1", "profile-1", policy_revision=1)

    record.state = "online"
    BindingRepository(store.connection).save(
        DesiredBinding(
            "binding-1",
            "project-1",
            "conductor-1",
            2,
            repository_path=str(tmp_path / "repository"),
            data_root_key="conductor-1",
        )
    )
    with pytest.raises(ValueError, match="local_runtime_stale_generation"):
        dispatcher.configure("binding-1", "profile-1", policy_revision=1)
    child.close()
    store.close()


def test_configure_rejects_repository_path_drift(tmp_path: Path) -> None:
    store, dispatcher, child = configured_dispatcher(tmp_path)
    repository_path = tmp_path / "repository"
    repository_path.rmdir()
    repository_path.symlink_to(tmp_path, target_is_directory=True)

    with pytest.raises(ValueError, match="local_runtime_repository_mismatch"):
        dispatcher.configure("binding-1", "profile-1", policy_revision=1)
    child.close()
    store.close()


def test_drain_stops_new_work_before_send_and_accepts_duplicate_ack(
    tmp_path: Path,
) -> None:
    store, dispatcher, child = configured_dispatcher(tmp_path)
    observed: list[bool] = []

    def conductor() -> None:
        request = read_runtime_message(child)
        observed.append(dispatcher.accepts_new_work("binding-1"))
        ack = DrainAck(request.context, request.deadline_at, "drained", "", "none")
        write_runtime_message(child, ack)

    thread = threading.Thread(target=conductor)
    thread.start()
    ack = dispatcher.drain("binding-1", deadline_at=int(time.time()) + 2)
    thread.join()

    assert observed == [False]
    assert dispatcher.record_drain_ack(ack) is ack
    assert dispatcher.record_drain_ack(ack) is ack
    child.close()
    store.close()


def test_stale_drain_ack_does_not_change_current_binding(tmp_path: Path) -> None:
    store, dispatcher, child = configured_dispatcher(tmp_path, generation=2)
    stale = DrainAck(
        LocalRuntimeContext(
            1,
            "conductor-1",
            "instance-1",
            "project-1",
            "binding-1",
            1,
            "correlation-old",
        ),
        int(time.time()) + 2,
        "drained",
        "",
        "none",
    )

    with pytest.raises(ValueError, match="local_runtime_stale_generation"):
        dispatcher.record_drain_ack(stale)
    assert dispatcher.accepts_new_work("binding-1")
    child.close()
    store.close()


def test_unsolicited_current_generation_ack_is_rejected(tmp_path: Path) -> None:
    store, dispatcher, child = configured_dispatcher(tmp_path)
    unsolicited = DrainAck(
        LocalRuntimeContext(
            1,
            "conductor-1",
            "instance-1",
            "project-1",
            "binding-1",
            1,
            "correlation-unsolicited",
        ),
        int(time.time()) + 2,
        "drained",
        "",
        "none",
    )

    with pytest.raises(ValueError, match="local_runtime_ack_unexpected"):
        dispatcher.record_drain_ack(unsolicited)
    assert dispatcher.accepts_new_work("binding-1")
    child.close()
    store.close()


def test_drain_timeout_is_bounded_and_keeps_binding_closed_to_new_work(
    tmp_path: Path,
) -> None:
    store, dispatcher, child = configured_dispatcher(tmp_path)

    with pytest.raises(ValueError, match="local_runtime_drain_timeout") as error:
        dispatcher.drain("binding-1", deadline_at=int(time.time()))

    assert error.value.retryable is True
    assert error.value.next_action == "retry_quit"
    assert not dispatcher.accepts_new_work("binding-1")
    child.close()
    store.close()


def test_malformed_drain_ack_has_one_stable_sanitized_failure(tmp_path: Path) -> None:
    store, dispatcher, child = configured_dispatcher(tmp_path)

    def conductor() -> None:
        read_runtime_message(child)
        child.sendall(b"\x00\x00\x00\x01{")

    thread = threading.Thread(target=conductor)
    thread.start()
    with pytest.raises(ValueError, match="local_runtime_drain_ack_invalid") as error:
        dispatcher.drain("binding-1", deadline_at=int(time.time()) + 2)
    thread.join()

    assert error.value.retryable is True
    assert error.value.next_action == "retry_quit"
    assert not dispatcher.accepts_new_work("binding-1")
    child.close()
    store.close()
