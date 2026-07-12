from __future__ import annotations

from pathlib import Path
from types import SimpleNamespace

import pytest

from conductor.conductor_podium_sync import ConductorPodiumSyncMixin
from conductor.conductor_podium_sync_smoke import PodiumSmokeCheckMixin
from conductor.conductor_smoke_protocol import normalize_smoke_command
from conductor.conductor_service_types import CoordinationCadence


class _SmokeProxy:
    async def find_project_id(self, _slug: str) -> str:
        return "project-1"

    async def fetch_project_labels(self, _project_id: str) -> list[dict[str, str]]:
        return [{"id": "label-1", "name": "symphony:performer/example"}]


@pytest.mark.anyio
async def test_smoke_check_accepts_and_matches_the_performer_project_label(tmp_path: Path) -> None:
    command = normalize_smoke_command(
        {
            "type": "smoke.check",
            "smoke_check_id": "smoke-1",
            "binding_id": "binding-1",
            "config_version": 1,
            "linear_project_id": "project-1",
            "project_slug": "example",
            "repository": {"mode": "local_path", "value": str(tmp_path)},
            "expected_label": {"id": "label-1", "name": "symphony:performer/example"},
            "runtime_config_version": 1,
        }
    )
    instance = SimpleNamespace(
        linear_filters={
            "binding_id": "binding-1",
            "binding_config_version": 1,
            "linear_project_id": "project-1",
        },
        linear_project="example",
        repo_source_type="local_path",
        repo_source_value=str(tmp_path),
        resolved_repo_path=str(tmp_path),
    )
    service = SimpleNamespace(project_label_proxy_factory=lambda _instance: _SmokeProxy())

    result = await PodiumSmokeCheckMixin._execute_smoke_check(service, command, instance)

    assert result["status"] == "passed"
    assert all(check["passed"] for check in result["checks"])


@pytest.mark.anyio
async def test_background_tick_runs_due_project_label_sync(monkeypatch: pytest.MonkeyPatch) -> None:
    class FakeDriver:
        async def drive_once(self) -> dict[str, int]:
            return {"started": 0, "applied": 0}

    class FakeSync(ConductorPodiumSyncMixin):
        coordination_cadence = CoordinationCadence()

        def __init__(self) -> None:
            self.sync_calls = 0

        async def sync_project_labels_once(self) -> int:
            self.sync_calls += 1
            return 1

    monkeypatch.setattr("conductor.conductor_podium_sync.WorkflowDriver", lambda _service: FakeDriver())
    service = FakeSync()

    result = await ConductorPodiumSyncMixin.coordinate_background_once(service)

    assert service.sync_calls == 1
    assert result.project_labels_synced == 1
