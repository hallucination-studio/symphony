from __future__ import annotations

from pathlib import Path

import pytest

from podium.linear_gateway import LinearGatewayFailure
from podium.linear_models import InstallationMetadata, InstallationStatus, LinearProject
from podium.linear_projects import LinearProjectDiscovery, LinearProjectDiscoveryFailure
from podium.store.linear import LinearRepository
from podium.store.sqlite import SQLiteStore


class Gateway:
    def __init__(self, pages: list[object]) -> None:
        self.pages = iter(pages)
        self.after: list[str | None] = []

    async def execute(self, _installation_id, _operation, variables, *, correlation_id):
        assert correlation_id == "discovery-1"
        self.after.append(variables["after"])
        page = next(self.pages)
        if isinstance(page, Exception):
            raise page
        return page


def page(nodes, *, after=None, app_user="app-user-1", organization="organization-1"):
    return {
        "viewer": {"id": app_user, "app": True},
        "organization": {"id": organization},
        "nodes": nodes,
        "page_info": {"has_next_page": after is not None, "end_cursor": after},
    }


def repository(path: Path, *, scopes=("app:assignable", "read", "write")):
    store = SQLiteStore(path)
    store.initialize()
    linear = LinearRepository(store.connection)
    linear.save_installation(
        InstallationMetadata(
            installation_id="installation-1",
            organization_id="organization-1",
            organization_name="Symphony",
            app_user_id="app-user-1",
            granted_scopes=scopes,
            expires_at=None,
            status=InstallationStatus.DISCONNECTED,
            last_verified_at=1_800_000_000,
            error_code=None,
        )
    )
    linear.replace_credentials(
        "installation-1", "access-token", "refresh-token", expires_at=1_900_000_000
    )
    return store, linear


@pytest.mark.asyncio
async def test_discovers_every_page_and_deduplicates_by_stable_id(tmp_path: Path) -> None:
    store, linear = repository(tmp_path / "podium.db")
    gateway = Gateway(
        [
            page(
                [{"id": "project-1", "name": "Old", "slug": "old"}],
                after="cursor-1",
            ),
            page(
                [
                    {"id": "project-1", "name": "Runtime", "slug": "runtime"},
                    {"id": "project-2", "name": "Agents", "slug": "agents"},
                ]
            ),
        ]
    )

    count = await LinearProjectDiscovery(linear, gateway).discover(
        "installation-1", correlation_id="discovery-1"
    )

    assert count == 2
    assert gateway.after == [None, "cursor-1"]
    assert [(item.project_id, item.name, item.slug) for item in linear.projects()] == [
        ("project-1", "Runtime", "runtime"),
        ("project-2", "Agents", "agents"),
    ]
    assert linear.installation("installation-1").error_code is None
    store.close()


@pytest.mark.asyncio
async def test_partial_page_failure_preserves_previous_discovery(tmp_path: Path) -> None:
    store, linear = repository(tmp_path / "podium.db")
    linear.replace_projects(
        "installation-1",
        [LinearProject("existing", "organization-1", "", "Existing", "existing")],
    )
    gateway = Gateway(
        [
            page([{"id": "new", "name": "New", "slug": "new"}], after="cursor-1"),
            LinearGatewayFailure(
                "linear_gateway_upstream_failed", "discovery-1", retryable=True
            ),
        ]
    )

    with pytest.raises(LinearProjectDiscoveryFailure) as raised:
        await LinearProjectDiscovery(linear, gateway).discover(
            "installation-1", correlation_id="discovery-1"
        )

    assert raised.value.code == "linear_project_discovery_upstream_failed"
    assert [item.project_id for item in linear.projects()] == ["existing"]
    assert linear.installation("installation-1").error_code == raised.value.code
    store.close()


@pytest.mark.asyncio
@pytest.mark.parametrize("drift", ["app_user", "organization", "scope"])
async def test_identity_or_exact_scope_drift_rejects_all_writes(
    tmp_path: Path, drift: str
) -> None:
    scopes = (
        ("read", "write")
        if drift == "scope"
        else ("app:assignable", "read", "write")
    )
    store, linear = repository(tmp_path / f"{drift}.db", scopes=scopes)
    gateway = Gateway(
        [
            page(
                [],
                app_user="other-user" if drift == "app_user" else "app-user-1",
                organization="other-org" if drift == "organization" else "organization-1",
            )
        ]
    )

    with pytest.raises(
        LinearProjectDiscoveryFailure,
        match="linear_project_discovery_identity_drift",
    ):
        await LinearProjectDiscovery(linear, gateway).discover(
            "installation-1", correlation_id="discovery-1"
        )

    assert linear.projects() == []
    assert (
        linear.installation("installation-1").error_code
        == "linear_project_discovery_identity_drift"
    )
    store.close()


@pytest.mark.asyncio
async def test_empty_discovery_is_durable_across_restart(tmp_path: Path) -> None:
    path = tmp_path / "podium.db"
    store, linear = repository(path)
    linear.record_error("installation-1", "linear_project_discovery_upstream_failed")
    assert await LinearProjectDiscovery(linear, Gateway([page([])])).discover(
        "installation-1", correlation_id="discovery-1"
    ) == 0
    store.close()

    reopened = SQLiteStore(path)
    reopened.initialize()
    linear = LinearRepository(reopened.connection)
    assert linear.projects() == []
    assert linear.installation("installation-1").error_code is None
    reopened.close()


@pytest.mark.asyncio
async def test_discovery_preserves_errors_owned_by_other_lifecycles(tmp_path: Path) -> None:
    store, linear = repository(tmp_path / "podium.db")
    linear.record_error("installation-1", "linear_disconnect_revocation_failed")

    await LinearProjectDiscovery(linear, Gateway([page([])])).discover(
        "installation-1", correlation_id="discovery-1"
    )

    assert (
        linear.installation("installation-1").error_code
        == "linear_disconnect_revocation_failed"
    )
    failure = LinearGatewayFailure(
        "linear_gateway_upstream_failed", "discovery-1", retryable=True
    )
    with pytest.raises(
        LinearProjectDiscoveryFailure,
        match="linear_project_discovery_upstream_failed",
    ):
        await LinearProjectDiscovery(linear, Gateway([failure])).discover(
            "installation-1", correlation_id="discovery-1"
        )
    assert (
        linear.installation("installation-1").error_code
        == "linear_disconnect_revocation_failed"
    )
    store.connection.execute(
        """UPDATE linear_installations
        SET access_token = NULL, refresh_token = NULL, expires_at = NULL,
            status = 'credentials_missing_for_existing_installation',
            error_code = 'credentials_missing_for_existing_installation'
        WHERE installation_id = 'installation-1'"""
    )
    with pytest.raises(
        LinearProjectDiscoveryFailure,
        match="credentials_missing_for_existing_installation",
    ):
        await LinearProjectDiscovery(linear, Gateway([])).discover(
            "installation-1", correlation_id="discovery-1"
        )
    assert (
        linear.installation("installation-1").error_code
        == "credentials_missing_for_existing_installation"
    )
    store.close()


@pytest.mark.asyncio
async def test_persistence_failure_rolls_back_and_logs_sanitized_reason(
    tmp_path: Path, caplog
) -> None:
    store, linear = repository(tmp_path / "podium.db")
    linear.replace_projects(
        "installation-1",
        [LinearProject("existing", "organization-1", "", "Existing", "existing")],
    )
    store.connection.execute(
        """CREATE TRIGGER reject_project_write BEFORE INSERT ON linear_projects
        BEGIN SELECT RAISE(ABORT, 'access-token-sentinel'); END"""
    )

    with pytest.raises(
        LinearProjectDiscoveryFailure,
        match="linear_project_discovery_persistence_failed",
    ):
        await LinearProjectDiscovery(
            linear,
            Gateway([page([{"id": "new", "name": "New", "slug": "new"}])]),
        ).discover("installation-1", correlation_id="discovery-1")

    assert [item.project_id for item in linear.projects()] == ["existing"]
    assert "error_code=linear_project_discovery_persistence_failed" in caplog.text
    assert "access-token-sentinel" not in caplog.text
    store.close()


@pytest.mark.asyncio
async def test_error_record_failure_does_not_mask_discovery_failure(
    tmp_path: Path, caplog
) -> None:
    store, linear = repository(tmp_path / "podium.db")
    store.connection.execute(
        """CREATE TRIGGER reject_error_record BEFORE UPDATE OF error_code
        ON linear_installations BEGIN SELECT RAISE(ABORT, 'raw-secret'); END"""
    )
    failure = LinearGatewayFailure(
        "linear_gateway_upstream_failed", "discovery-1", retryable=True
    )

    with pytest.raises(
        LinearProjectDiscoveryFailure,
        match="linear_project_discovery_upstream_failed",
    ):
        await LinearProjectDiscovery(linear, Gateway([failure])).discover(
            "installation-1", correlation_id="discovery-1"
        )

    assert "event=linear_project_discovery_failed" in caplog.text
    assert "event=linear_project_discovery_error_record_failed" in caplog.text
    assert "raw-secret" not in caplog.text
    store.close()


@pytest.mark.asyncio
async def test_invalid_preflight_correlation_is_not_reflected(
    tmp_path: Path, caplog
) -> None:
    store, linear = repository(tmp_path / "podium.db")

    with pytest.raises(
        LinearProjectDiscoveryFailure,
        match="linear_project_discovery_envelope_invalid",
    ):
        await LinearProjectDiscovery(linear, Gateway([])).discover(
            "installation-1", correlation_id="bad\nforged=true"
        )

    assert "correlation_id=invalid" in caplog.text
    assert "forged=true" not in caplog.text
    assert linear.installation("installation-1").error_code is None
    store.close()


@pytest.mark.asyncio
async def test_invalid_installation_id_is_not_reflected(tmp_path: Path, caplog) -> None:
    store, linear = repository(tmp_path / "podium.db")

    with pytest.raises(
        LinearProjectDiscoveryFailure,
        match="linear_project_discovery_envelope_invalid",
    ):
        await LinearProjectDiscovery(linear, Gateway([])).discover(
            "bad\nforged=true", correlation_id="discovery-1"
        )

    assert "installation_id=unknown" in caplog.text
    assert "forged=true" not in caplog.text
    store.close()
