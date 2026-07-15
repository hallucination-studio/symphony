from __future__ import annotations

from pathlib import Path

import pytest

from podium.conductor_bindings import DesiredBinding
from podium.desktop_commands import CommandError
from podium.desktop_commands_linear import dispatch_linear_command
from podium.desktop_app import DesktopLifecycle
from podium.desktop_health import handle_request
from podium.linear_disconnect import (
    LinearAuthorizationFailure,
    LinearAuthorizationLifecycle,
)
from podium.linear_models import (
    InstallationMetadata,
    InstallationStatus,
    LinearProject,
)
from podium.linear_tokens import LinearTokenFailure
from podium.store.bindings import BindingRepository
from podium.store.linear import LinearCredentials, LinearRepository
from podium.store.sqlite import SQLiteStore


class Tokens:
    def __init__(self, outcome: str = "access") -> None:
        self.outcome = outcome
        self.calls: list[str] = []

    async def startup(self, installation_id: str) -> str:
        self.calls.append(installation_id)
        if self.outcome.startswith("linear_"):
            raise LinearTokenFailure(self.outcome)
        return self.outcome


def setup(path: Path, *, connected: bool = True, removed: bool = False):
    store = SQLiteStore(path)
    store.initialize()
    repository = LinearRepository(store.connection)
    repository.save_installation(
        InstallationMetadata(
            "installation-1",
            "organization-1",
            "Workspace",
            "app-user-1",
            ("read", "write", "app:assignable"),
            None,
            InstallationStatus.DISCONNECTED,
            100,
            None,
        )
    )
    if connected:
        repository.replace_credentials(
            "installation-1",
            "access-token-sentinel",
            "refresh-token-sentinel",
            expires_at=1000,
        )
    revocations: list[tuple[str, str]] = []

    async def revoke(access: str, refresh: str) -> None:
        revocations.append((access, refresh))

    async def observe_removal(_installation_id: str) -> bool:
        return removed

    tokens = Tokens()
    lifecycle = LinearAuthorizationLifecycle(
        repository, tokens, revoke=revoke, observe_removal=observe_removal
    )
    return store, repository, tokens, lifecycle, revocations


@pytest.mark.asyncio
async def test_recovery_uses_healthy_stored_credentials_first(tmp_path: Path) -> None:
    _store, _repository, tokens, lifecycle, _revocations = setup(
        tmp_path / "podium.db"
    )

    assert await lifecycle.recover(
        "installation-1", workspace_app_exists=True
    ) == {"state": "connected", "next_action": "none"}
    assert tokens.calls == ["installation-1"]


@pytest.mark.asyncio
async def test_manage_timeout_with_missing_credentials_records_distinct_state(
    tmp_path: Path,
) -> None:
    _store, repository, tokens, lifecycle, _revocations = setup(
        tmp_path / "podium.db", connected=False
    )
    tokens.outcome = "linear_credentials_missing"

    assert await lifecycle.recover(
        "installation-1", workspace_app_exists=True
    ) == {
        "state": "credentials_missing_for_existing_installation",
        "next_action": "open_linear_app_settings",
    }
    record = repository.installation("installation-1")
    assert record.status is InstallationStatus.CREDENTIALS_MISSING
    assert record.error_code == "credentials_missing_for_existing_installation"


@pytest.mark.asyncio
async def test_missing_credential_persistence_failure_is_bounded(
    tmp_path: Path, caplog
) -> None:
    store, repository, tokens, lifecycle, _revocations = setup(
        tmp_path / "podium.db", connected=False
    )
    tokens.outcome = "linear_credentials_missing"
    store.connection.execute(
        """CREATE TRIGGER reject_missing BEFORE UPDATE OF status
        ON linear_installations BEGIN SELECT RAISE(ABORT, 'token-sentinel'); END"""
    )

    with pytest.raises(LinearAuthorizationFailure) as raised:
        await lifecycle.recover("installation-1", workspace_app_exists=True)

    assert raised.value.code == "linear_authorization_persistence_failed"
    assert raised.value.next_action == "retry_recovery"
    assert repository.installation("installation-1").status is InstallationStatus.DISCONNECTED
    assert "token-sentinel" not in caplog.text


@pytest.mark.asyncio
async def test_reset_requires_confirmation_and_observed_app_removal(
    tmp_path: Path,
) -> None:
    _store, repository, _tokens, lifecycle, _revocations = setup(
        tmp_path / "podium.db"
    )

    with pytest.raises(LinearAuthorizationFailure) as confirmation:
        await lifecycle.reset_and_reconnect(
            "installation-1", admin_confirmed=False
        )
    assert confirmation.value.code == "linear_reset_confirmation_required"
    assert repository.load_credentials("installation-1") is not None

    with pytest.raises(LinearAuthorizationFailure) as removal:
        await lifecycle.reset_and_reconnect(
            "installation-1", admin_confirmed=True
        )
    assert removal.value.code == "linear_app_removal_required"
    assert removal.value.retryable is True
    assert repository.load_credentials("installation-1") is not None

    _store, repository, _tokens, lifecycle, _revocations = setup(
        tmp_path / "removed.db", removed=True
    )
    assert await lifecycle.reset_and_reconnect(
        "installation-1", admin_confirmed=True
    ) == {"state": "disconnected", "next_action": "start_authorization"}
    assert repository.load_credentials("installation-1") is None
    assert repository.installation("installation-1").status is InstallationStatus.DISCONNECTED


@pytest.mark.asyncio
async def test_reset_persistence_failure_preserves_pair_and_is_bounded(
    tmp_path: Path, caplog
) -> None:
    store, repository, _tokens, lifecycle, _revocations = setup(
        tmp_path / "podium.db", removed=True
    )
    store.connection.execute(
        """CREATE TRIGGER reject_reset BEFORE UPDATE OF status
        ON linear_installations BEGIN SELECT RAISE(ABORT, 'access-token-sentinel'); END"""
    )

    with pytest.raises(LinearAuthorizationFailure) as raised:
        await lifecycle.reset_and_reconnect(
            "installation-1", admin_confirmed=True
        )

    assert raised.value.code == "linear_authorization_persistence_failed"
    assert raised.value.next_action == "retry_reset"
    assert repository.load_credentials("installation-1") == LinearCredentials(
        "access-token-sentinel", "refresh-token-sentinel", 1000
    )
    assert "access-token-sentinel" not in caplog.text


@pytest.mark.asyncio
async def test_active_binding_blocks_disconnect_before_revocation(tmp_path: Path) -> None:
    store, repository, _tokens, lifecycle, revocations = setup(tmp_path / "podium.db")
    repository.replace_projects(
        "installation-1",
        [LinearProject("project-1", "organization-1", "team-1", "Project", "project")],
    )
    BindingRepository(store.connection).save(
        DesiredBinding("binding-1", "project-1", "conductor-1", 1, True)
    )

    with pytest.raises(LinearAuthorizationFailure) as raised:
        await lifecycle.disconnect("installation-1")

    assert raised.value.code == "linear_disconnect_in_use"
    assert raised.value.next_action == "unbind_active_projects"
    assert revocations == []
    assert repository.load_credentials("installation-1") is not None


@pytest.mark.asyncio
async def test_revocation_failure_preserves_pair_and_logs_no_tokens(
    tmp_path: Path, caplog
) -> None:
    _store, repository, tokens, _lifecycle, _revocations = setup(
        tmp_path / "podium.db"
    )

    async def fail(_access: str, _refresh: str) -> None:
        raise OSError("offline access-token-sentinel")

    async def not_removed(_installation_id: str) -> bool:
        return False

    lifecycle = LinearAuthorizationLifecycle(
        repository, tokens, revoke=fail, observe_removal=not_removed
    )
    with pytest.raises(LinearAuthorizationFailure) as raised:
        await lifecycle.disconnect("installation-1")

    assert raised.value.code == "linear_disconnect_revocation_failed"
    assert raised.value.retryable is True
    assert repository.load_credentials("installation-1") == LinearCredentials(
        "access-token-sentinel", "refresh-token-sentinel", 1000
    )
    assert (
        repository.installation("installation-1").error_code
        == "linear_disconnect_revocation_failed"
    )
    assert "access-token-sentinel" not in caplog.text
    assert "refresh-token-sentinel" not in caplog.text


@pytest.mark.asyncio
async def test_successful_disconnect_is_atomic_and_preserves_catalog(tmp_path: Path) -> None:
    _store, repository, _tokens, lifecycle, revocations = setup(
        tmp_path / "podium.db"
    )
    repository.replace_projects(
        "installation-1",
        [LinearProject("project-1", "organization-1", "team-1", "Project", "project")],
    )

    assert await lifecycle.disconnect("installation-1") == {
        "state": "disconnected",
        "next_action": "none",
    }
    assert len(revocations) == 1
    assert repository.load_credentials("installation-1") is None
    assert repository.installation("installation-1").status is InstallationStatus.DISCONNECTED
    assert repository.projects("installation-1")[0].bound is False


@pytest.mark.asyncio
async def test_disconnect_database_failure_keeps_complete_pair(tmp_path: Path) -> None:
    store, repository, _tokens, lifecycle, _revocations = setup(tmp_path / "podium.db")
    store.connection.execute(
        """CREATE TRIGGER reject_disconnect BEFORE UPDATE OF status
        ON linear_installations WHEN NEW.status = 'disconnected'
        BEGIN SELECT RAISE(ABORT, 'disconnect rejected'); END"""
    )

    with pytest.raises(LinearAuthorizationFailure) as raised:
        await lifecycle.disconnect("installation-1")
    assert raised.value.code == "linear_authorization_persistence_failed"
    assert raised.value.next_action == "retry_disconnect"
    assert repository.load_credentials("installation-1") == LinearCredentials(
        "access-token-sentinel", "refresh-token-sentinel", 1000
    )


def test_desktop_reset_command_has_closed_input_and_sanitized_failure(
    tmp_path: Path,
) -> None:
    _store, _repository, _tokens, lifecycle, _revocations = setup(
        tmp_path / "podium.db"
    )
    with pytest.raises(CommandError) as raised:
        dispatch_linear_command(
            "linear.reset_and_reconnect",
            {
                "installation_id": "installation-1",
                "admin_confirmed": True,
            },
            lifecycle,
        )
    assert raised.value.to_dict() == {
        "code": "linear_app_removal_required",
        "sanitized_reason": "linear_app_removal_required",
        "action_required": True,
        "retryable": True,
        "next_action": "open_linear_app_settings",
    }


def test_desktop_protocol_exposes_only_closed_linear_command_result(
    tmp_path: Path,
) -> None:
    _store, _repository, _tokens, authorization, _revocations = setup(
        tmp_path / "state.db"
    )
    desktop = DesktopLifecycle(tmp_path / "desktop")
    desktop.start()
    desktop.linear_authorization = authorization

    response, stopping = handle_request(
        {
            "kind": "command",
            "request_id": "reset-1",
            "protocol_version": 1,
            "command": "linear.reset_and_reconnect",
            "input": {
                "installation_id": "installation-1",
                "admin_confirmed": True,
            },
        },
        desktop,
    )

    assert stopping is False
    assert response == {
        "kind": "command.result",
        "request_id": "reset-1",
        "protocol_version": 1,
        "command": "linear.reset_and_reconnect",
        "ok": False,
        "error": {
            "code": "linear_app_removal_required",
            "sanitized_reason": "linear_app_removal_required",
            "action_required": True,
            "retryable": True,
            "next_action": "open_linear_app_settings",
        },
    }
    assert "token" not in str(response)
    desktop.shutdown()
