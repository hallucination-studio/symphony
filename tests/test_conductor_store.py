from __future__ import annotations

import json
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
    assert (tmp_path / "conductor-data" / "conductor.db").exists()
    assert not (tmp_path / "conductor-data" / "settings.json").exists()
    assert not (tmp_path / "conductor-data" / "instances" / "inst-1" / "metadata.json").exists()


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

    store.save_settings(ConductorSettings(podium_url="https://podium.example", managed_mode=True))
    loaded = store.get_settings()

    assert loaded.podium_url == "https://podium.example"
    assert loaded.managed_mode is True
    public = loaded.to_public_dict()
    assert public["podium_url"] == "https://podium.example"
    assert public["managed_mode"] is True
    assert public["conductor_id"]


def test_store_initializes_sqlite_with_required_pragmas(tmp_path: Path) -> None:
    store = ConductorStore(tmp_path / "conductor-data")

    with store.connect() as connection:
        journal_mode = connection.execute("PRAGMA journal_mode").fetchone()[0]
        foreign_keys = connection.execute("PRAGMA foreign_keys").fetchone()[0]
        busy_timeout = connection.execute("PRAGMA busy_timeout").fetchone()[0]

    assert journal_mode == "wal"
    assert foreign_keys == 1
    assert busy_timeout >= 5000


def test_store_ignores_legacy_json_without_migration(tmp_path: Path) -> None:
    data_root = tmp_path / "conductor-data"
    legacy_instance_dir = data_root / "instances" / "legacy"
    legacy_instance_dir.mkdir(parents=True)
    (data_root / "settings.json").write_text('{"podium_url": "https://legacy.example"}', encoding="utf-8")
    (legacy_instance_dir / "metadata.json").write_text(
        json.dumps(make_instance(tmp_path, instance_id="legacy", name="Legacy", port=8801).to_dict()),
        encoding="utf-8",
    )

    store = ConductorStore(data_root)

    assert store.get_settings().podium_url == ""
    assert store.list_instances() == []


def test_runtime_action_claim_is_transactional_across_store_instances(tmp_path: Path) -> None:
    store_a = ConductorStore(tmp_path / "conductor-data")
    store_b = ConductorStore(tmp_path / "conductor-data")
    instance = make_instance(tmp_path, instance_id="inst-1", name="Main", port=8801)
    store_a.create_instance(instance)
    action_id = store_a.enqueue_runtime_action(instance_id="inst-1", action_type="start", payload={"issue_id": "ENG-1"})

    claim_a = store_a.claim_runtime_action(action_id, lease_owner="worker-a")
    claim_b = store_b.claim_runtime_action(action_id, lease_owner="worker-b")

    assert claim_a is not None
    assert claim_a["id"] == action_id
    assert claim_a["attempt"] == 1
    assert claim_a["payload"] == {"issue_id": "ENG-1"}
    assert claim_b is None
    loaded = store_b.get_runtime_action(action_id)
    assert loaded is not None
    assert loaded["status"] == "leased"
    assert loaded["lease_owner"] == "worker-a"


def test_gated_followup_marker_claim_is_unique_and_retryable_after_failure(tmp_path: Path) -> None:
    store_a = ConductorStore(tmp_path / "conductor-data")
    store_b = ConductorStore(tmp_path / "conductor-data")
    instance = make_instance(tmp_path, instance_id="inst-1", name="Main", port=8801)
    store_a.create_instance(instance)

    assert store_a.claim_gated_followup_marker("inst-1", "issue-1", "gate") is True
    assert store_b.claim_gated_followup_marker("inst-1", "issue-1", "gate") is False
    store_a.mark_gated_followup_failed("inst-1", "issue-1", "gate", "boom")
    assert store_b.claim_gated_followup_marker("inst-1", "issue-1", "gate") is True
    store_b.mark_gated_followup_started("inst-1", "issue-1", "gate")
    assert store_a.claim_gated_followup_marker("inst-1", "issue-1", "gate") is False


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
