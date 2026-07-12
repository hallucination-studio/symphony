from __future__ import annotations

import pytest

from conductor.conductor_api import ConductorApiServer


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
