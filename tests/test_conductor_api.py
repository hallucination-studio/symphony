from __future__ import annotations

import pytest

from conductor.conductor_api import ConductorApiServer
from conductor.conductor_service import ConductorService
from conductor.models import ConductorSettings
from conductor.store import ConductorStore


@pytest.mark.anyio
@pytest.mark.parametrize(
    ("method", "path"),
    [("POST", "/api/instances"), ("PATCH", "/api/instances/instance-1")],
)
async def test_instance_api_rejects_legacy_managed_run_profile_field(method: str, path: str) -> None:
    status, payload = await ConductorApiServer(object())._route(
        method,
        path,
        b'{"managed_run_profile":"default"}',
    )

    assert status == 400
    assert payload["error"]["code"] == "legacy_runtime_profile_field"
    assert payload["error"]["message"] == "managed_run_profile is no longer accepted by the instance API."


@pytest.mark.anyio
async def test_settings_api_derives_runtime_group_without_persisting_it(tmp_path) -> None:
    store = ConductorStore(tmp_path)
    initial = store.get_settings()
    service = ConductorService(store=store, data_root=tmp_path)
    service.update_settings(ConductorSettings(conductor_id="conductor-1"))

    status, payload = await ConductorApiServer(service)._route("GET", "/api/settings", b"")

    assert status == 200
    assert "runtime_group_id" not in initial.to_dict()
    assert initial.to_public_dict()["runtime_group_id"] == f"group_{initial.conductor_id}"
    assert payload["settings"]["runtime_group_id"] == "group_conductor-1"
    with store.connect() as connection:
        columns = {row["name"] for row in connection.execute("PRAGMA table_info(settings)")}
    assert "runtime_group_id" not in columns
