from __future__ import annotations

from pathlib import Path

import pytest

from conductor.conductor_models import ConductorSettings, InstanceRecord
from conductor.conductor_store import ConductorStore


def make_instance(tmp_path: Path, *, instance_id: str, name: str, port: int) -> InstanceRecord:
    instance_dir = tmp_path / "conductor-data" / "instances" / instance_id
    return InstanceRecord.create(
        id=instance_id,
        name=name,
        repo_source_type="local_path",
        repo_source_value=str(tmp_path / f"repo-{instance_id}"),
        resolved_repo_path=str(tmp_path / f"repo-{instance_id}"),
        instance_dir=str(instance_dir),
        linear_project="ENG",
        linear_filters={"labels": ["codex"]},
        workflow_profile="default",
        workflow_inputs={"goal": "Ship"},
        workspace_root=str(instance_dir / "workspace"),
        persistence_path=str(instance_dir / "state" / "performer.json"),
        log_path=str(instance_dir / "logs" / "performer.log"),
        workflow_path=str(instance_dir / "WORKFLOW.md"),
        http_port=port,
    )


def test_store_saves_and_loads_instances(tmp_path: Path) -> None:
    store = ConductorStore(tmp_path / "conductor-data")
    instance = make_instance(tmp_path, instance_id="inst-1", name="Main", port=8801)

    store.save_instance(instance)
    loaded = store.get_instance("inst-1")

    assert loaded is not None
    assert loaded.name == "Main"
    assert store.list_instances()[0].id == "inst-1"


def test_store_delete_removes_instance_metadata(tmp_path: Path) -> None:
    store = ConductorStore(tmp_path / "conductor-data")
    instance = make_instance(tmp_path, instance_id="inst-1", name="Main", port=8801)
    store.save_instance(instance)

    store.delete_instance("inst-1")

    assert store.get_instance("inst-1") is None
    assert store.list_instances() == []


def test_store_allocates_sequential_ports(tmp_path: Path) -> None:
    store = ConductorStore(tmp_path / "conductor-data")
    store.save_instance(make_instance(tmp_path, instance_id="inst-1", name="One", port=8801))
    store.save_instance(make_instance(tmp_path, instance_id="inst-2", name="Two", port=8802))

    assert store.allocate_port() == 8803


def test_store_prevents_duplicate_ids(tmp_path: Path) -> None:
    store = ConductorStore(tmp_path / "conductor-data")
    instance = make_instance(tmp_path, instance_id="inst-1", name="Main", port=8801)
    store.save_instance(instance)

    with pytest.raises(FileExistsError):
        store.save_instance(instance)


def test_store_saves_and_loads_conductor_settings(tmp_path: Path) -> None:
    store = ConductorStore(tmp_path / "conductor-data")

    store.save_settings(ConductorSettings(linear_api_key="linear-token"))
    loaded = store.get_settings()

    assert loaded.linear_api_key == "linear-token"
    public = loaded.to_public_dict()
    assert public["linear_api_key_configured"] is True
    assert public["podium_token_configured"] is False
    assert public["podium_url"] == ""
    assert public["conductor_id"]


def test_managed_runtime_settings_round_trip_without_public_tokens(tmp_path: Path) -> None:
    store = ConductorStore(tmp_path / "conductor-data")

    store.save_settings(
        ConductorSettings(
            podium_url="https://podium.example",
            podium_runtime_id="runtime-1",
            podium_runtime_token="runtime-secret",
            podium_proxy_token="proxy-secret",
            podium_ws_url="wss://podium.example/api/v1/runtime/ws",
            runtime_group_id="group-1",
            managed_mode=True,
        )
    )
    loaded = store.get_settings()
    public = loaded.to_public_dict()

    assert loaded.podium_runtime_token == "runtime-secret"
    assert loaded.podium_proxy_token == "proxy-secret"
    assert loaded.managed_mode is True
    assert public["managed_mode"] is True
    assert public["podium_runtime_id"] == "runtime-1"
    assert public["runtime_group_id"] == "group-1"
    assert public["podium_runtime_token_configured"] is True
    assert public["podium_proxy_token_configured"] is True
    assert "runtime-secret" not in str(public)
    assert "proxy-secret" not in str(public)
