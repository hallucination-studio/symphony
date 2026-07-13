from __future__ import annotations

import json
import re
from types import SimpleNamespace
from typing import Any

import pytest

from podium.podium_runtime import PodiumRuntimeMixin
from podium.podium_shared import dispatch_public
from podium.store._postgres_dispatch import (
    PROJECT_BINDING_UPSERT_SQL,
    _binding_values,
)
from podium.store._postgres_ops import PgOpsMixin
from podium.store._postgres_runtime import PgRuntimeMixin
from podium.store._postgres_profiles import (
    PERFORMER_BINDING_UPSERT_SQL,
    PERFORMER_BINDING_SELECT_SQL,
    PERFORMER_PROFILE_UPSERT_SQL,
    PgProfilesMixin,
    RUNTIME_PROFILE_UPSERT_SQL,
    _performer_binding_values,
    _performer_profile_values,
    _record_to_performer_binding,
    _runtime_profile_values,
)
from podium.store._postgres_schema_statements import POSTGRES_SCHEMA_STATEMENTS


def _placeholder_numbers(statement: str) -> list[int]:
    return sorted({int(value) for value in re.findall(r"\$(\d+)", statement)})


def _binding() -> dict[str, Any]:
    return {
        "id": "binding-1",
        "conductor_id": "conductor-1",
        "user_id": "user-1",
        "instance_id": "instance-1",
        "name": "Example",
        "linear_project": "example",
        "project_slug": "example",
        "linear_project_id": "project-1",
        "project_name": "Example",
        "agent_app_user_id": "agent-1",
        "installation_id": "installation-1",
        "process_status": "running",
        "constraint_labels": [],
        "repo_source": {"type": "git", "value": "https://example.invalid/repo.git"},
        "state": "ready",
        "active": True,
        "config_version": 1,
        "acknowledged_config_version": 1,
        "candidate_installation_id": "",
        "candidate_agent_app_user_id": "",
        "candidate_config_version": 0,
        "candidate_acknowledged_config_version": 0,
        "label_id": "label-1",
        "label_name": "symphony:conductor/Bach-abc123",
        "replacement_conductor_id": "",
        "replacement_repo_source": {},
        "replacement_state": "",
        "replacement_binding_id": "",
        "error_code": "",
        "sanitized_reason": "",
        "updated_at": "2026-07-12T00:00:00+00:00",
    }


def test_binding_public_keeps_the_web_profile_constant() -> None:
    binding = _binding() | {"managed_run_profile": "experimental"}

    public = PodiumRuntimeMixin.binding_public(SimpleNamespace(), binding)

    assert public["managed_run_profile"] == "default"


def test_fresh_schema_keeps_runtime_group_as_a_derived_alias() -> None:
    schema = "\n".join(POSTGRES_SCHEMA_STATEMENTS)

    assert "managed_run_profile" not in schema
    assert "runtime_groups" not in schema
    assert "runtime_group_id TEXT" not in schema
    assert "managed_run_profile" not in PROJECT_BINDING_UPSERT_SQL
    assert _placeholder_numbers(PROJECT_BINDING_UPSERT_SQL) == list(
        range(1, len(_binding_values(_binding())) + 2)
    )


def test_fresh_schema_contains_layered_current_profiles_without_revision_tables() -> None:
    schema = "\n".join(POSTGRES_SCHEMA_STATEMENTS)

    assert "CREATE TABLE IF NOT EXISTS runtime_profiles" in schema
    assert "CREATE TABLE IF NOT EXISTS performer_profiles" in schema
    assert "performer_" + "credentials" not in schema
    assert "CREATE TABLE IF NOT EXISTS performer_bindings" in schema
    assert "performer_binding_id TEXT" in schema
    assert "runtime_profile_revisions" not in schema
    assert "performer_profile_revisions" not in schema
    assert "execution_policy JSONB" in schema
    assert "execution_policy_sha256 TEXT" in schema
    assert "turn_policy JSONB" in schema
    assert "turn_policy_sha256 TEXT" in schema
    assert not re.search(r"\bconfig_format\b", schema)
    assert not re.search(r"\bconfig_document\b", schema)
    assert not re.search(r"\bconfig_sha256\b", schema)
    assert not re.search(r"\bpolicy_sha256\b", schema)


def test_profile_store_values_and_sql_have_stable_parameter_contracts() -> None:
    runtime = {
        "id": "runtime-profile:user-1:default",
        "workspace_id": "user-1",
        "name": "default",
        "runtime_kind": "codex",
        "execution_policy": {"version": 1},
        "execution_policy_sha256": "a" * 64,
        "state": "active",
    }
    performer = {
        "id": "performer-profile:user-1:default",
        "workspace_id": "user-1",
        "name": "default",
        "performer_kind": "codex",
        "runtime_profile_id": runtime["id"],
        "turn_policy": {"max_turns": 4},
        "turn_policy_sha256": "b" * 64,
        "state": "active",
    }
    binding = {
        "id": "performer-binding:binding-1",
        "workspace_id": "user-1",
        "project_binding_id": "binding-1",
        "performer_profile_id": performer["id"],
        "generation": 1,
        "state": "ready",
        "error_code": "",
        "sanitized_reason": "",
        "updated_at": "2026-07-12T00:00:00+00:00",
    }

    assert _placeholder_numbers(RUNTIME_PROFILE_UPSERT_SQL) == list(range(1, len(_runtime_profile_values(runtime)) + 1))
    assert _placeholder_numbers(PERFORMER_PROFILE_UPSERT_SQL) == list(range(1, len(_performer_profile_values(performer)) + 1))
    assert _placeholder_numbers(PERFORMER_BINDING_UPSERT_SQL) == list(range(1, len(_performer_binding_values(binding)) + 1))
    assert "revision" not in PERFORMER_BINDING_UPSERT_SQL.lower()
    assert "credential" not in PERFORMER_BINDING_UPSERT_SQL.lower()
    assert "execution_policy" in RUNTIME_PROFILE_UPSERT_SQL
    assert "execution_policy_sha256" in RUNTIME_PROFILE_UPSERT_SQL
    assert "turn_policy_sha256" in PERFORMER_PROFILE_UPSERT_SQL
    assert json.loads(_runtime_profile_values(runtime)[4]) == {"version": 1}
    assert json.loads(_performer_profile_values(performer)[5]) == {"max_turns": 4}


def test_profile_binding_select_maps_runtime_profile_primary_key() -> None:
    assert "rp.id AS runtime_profile_id" in PERFORMER_BINDING_SELECT_SQL
    assert "rp.runtime_profile_id" not in PERFORMER_BINDING_SELECT_SQL


def test_profile_binding_record_decodes_policy_json_as_dictionaries() -> None:
    record = _record_to_performer_binding(
        {
            "performer_binding_id": "performer-binding:binding-1",
            "workspace_id": "user-1",
            "project_binding_id": "binding-1",
            "performer_profile_id": "performer-profile:user-1:default",
            "generation": 1,
            "state": "pending",
            "error_code": "",
            "sanitized_reason": "",
            "performer_kind": "codex",
            "turn_policy": '{"max_turns":4}',
            "turn_policy_sha256": "b" * 64,
            "runtime_profile_id": "runtime-profile:user-1:default",
            "runtime_kind": "codex",
            "execution_policy": '{"version":1}',
            "execution_policy_sha256": "a" * 64,
        }
    )

    assert record["turn_policy"] == {"max_turns": 4}
    assert record["execution_policy"] == {"version": 1}


@pytest.mark.anyio
@pytest.mark.parametrize(("changed_policy", "generation_update_marker"), [
    ("execution", "FROM performer_profiles pp"),
    ("turn", "WHERE performer_profile_id = $1"),
])
async def test_profile_policy_hash_changes_bump_binding_generation(
    changed_policy: str,
    generation_update_marker: str,
) -> None:
    runtime = {
        "id": "runtime-profile:user-1:default",
        "name": "default",
        "runtime_kind": "codex",
        "execution_policy": {"version": 1},
        "execution_policy_sha256": "a" * 64,
        "state": "active",
    }
    performer = {
        "id": "performer-profile:user-1:default",
        "name": "default",
        "performer_kind": "codex",
        "runtime_profile_id": runtime["id"],
        "turn_policy": {"max_turns": 4},
        "turn_policy_sha256": "b" * 64,
        "state": "active",
    }

    class Transaction:
        async def __aenter__(self) -> None:
            return None

        async def __aexit__(self, *_args: object) -> None:
            return None

    class Connection:
        def __init__(self) -> None:
            self.executed: list[str] = []

        def transaction(self) -> Transaction:
            return Transaction()

        async def fetchrow(self, statement: str, *_args: object) -> dict[str, Any]:
            if statement.startswith("SELECT execution_policy_sha256"):
                value = "0" * 64 if changed_policy == "execution" else runtime["execution_policy_sha256"]
                return {"execution_policy_sha256": value}
            if statement.startswith("SELECT turn_policy_sha256"):
                value = "0" * 64 if changed_policy == "turn" else performer["turn_policy_sha256"]
                return {"turn_policy_sha256": value, "runtime_profile_id": runtime["id"]}
            if statement == PERFORMER_BINDING_SELECT_SQL:
                return {
                    "performer_binding_id": "performer-binding:binding-1",
                    "workspace_id": "user-1",
                    "project_binding_id": "binding-1",
                    "performer_profile_id": performer["id"],
                    "generation": 2,
                    "state": "pending",
                    "error_code": "",
                    "sanitized_reason": "",
                    "performer_kind": "codex",
                    "turn_policy": performer["turn_policy"],
                    "turn_policy_sha256": performer["turn_policy_sha256"],
                    "runtime_profile_id": runtime["id"],
                    "runtime_kind": "codex",
                    "execution_policy": runtime["execution_policy"],
                    "execution_policy_sha256": runtime["execution_policy_sha256"],
                }
            return {}

        async def execute(self, statement: str, *_args: object) -> None:
            self.executed.append(statement)

    class Acquire:
        def __init__(self, connection: Connection) -> None:
            self.connection = connection

        async def __aenter__(self) -> Connection:
            return self.connection

        async def __aexit__(self, *_args: object) -> None:
            return None

    class Pool:
        def __init__(self, connection: Connection) -> None:
            self.connection = connection

        def acquire(self) -> Acquire:
            return Acquire(self.connection)

    connection = Connection()
    store = type("Store", (PgProfilesMixin,), {})()
    store.pool = Pool(connection)

    await store.ensure_performer_binding(
        project_binding_id="binding-1",
        workspace_id="user-1",
        runtime_profile=runtime,
        performer_profile=performer,
    )

    generation_updates = [statement for statement in connection.executed if "generation =" in statement]
    assert len(generation_updates) == 1
    assert generation_update_marker in generation_updates[0]


def test_dispatch_dto_does_not_carry_a_profile() -> None:
    dispatch = {
        "dispatch_id": "dispatch-1",
        "project_binding_id": "binding-1",
        "issue_id": "issue-1",
        "issue_identifier": "SYM-1",
        "linear_workspace_id": "user-1",
        "project_slug": "example",
        "status": "queued",
        "managed_run_profile": "experimental",
    }

    assert "managed_run_profile" not in dispatch_public(dispatch)


@pytest.mark.anyio
async def test_runtime_profile_summary_exposes_only_non_secret_profile_hashes() -> None:
    class Store:
        async def get_performer_binding_for_project_binding(self, _binding_id: str) -> dict[str, Any]:
            return {
                "id": "performer-binding:binding-1",
                "performer_profile_id": "performer-profile:user-1:default",
                "runtime_profile_id": "runtime-profile:user-1:default",
                "performer_kind": "codex",
                "runtime_kind": "codex",
                "generation": 2,
                "turn_policy_sha256": "b" * 64,
                "execution_policy_sha256": "a" * 64,
            }

    summary = await PodiumRuntimeMixin._performer_profile_summary(
        SimpleNamespace(
            store=Store(),
        ),
        {"id": "binding-1", "performer_binding_id": "performer-binding:binding-1"},
    )

    serialized = str(summary)
    assert summary["profiles"]["runtime"]["execution_policy_sha256"] == "a" * 64
    assert summary["profiles"]["performer"]["turn_policy_sha256"] == "b" * 64
    assert "credential" not in summary["profiles"]
    assert "private" not in serialized
    assert "slot:main" not in serialized


class _RecordingPool:
    def __init__(self) -> None:
        self.calls: list[tuple[str, tuple[Any, ...]]] = []

    async def execute(self, statement: str, *args: Any) -> None:
        self.calls.append((statement, args))


@pytest.mark.anyio
async def test_enrollment_token_is_owned_by_conductor() -> None:
    pool = _RecordingPool()
    store = SimpleNamespace(pool=pool)

    await PgRuntimeMixin.save_enrollment_token(
        store,
        "token-hash",
        conductor_id="conductor-1",
        expires_at="2026-07-12T00:00:00+00:00",
    )

    statement, args = pool.calls[0]
    assert "runtime_group_id" not in statement
    assert "conductor_id" in statement
    assert _placeholder_numbers(statement) == list(range(1, len(args) + 1))


@pytest.mark.anyio
async def test_managed_run_view_is_owned_by_conductor() -> None:
    pool = _RecordingPool()
    store = SimpleNamespace(pool=pool)

    await PgOpsMixin.save_managed_run_view(store, "conductor-1", {"runs": []})

    statement, args = pool.calls[0]
    assert "conductor_id" in statement
    assert "runtime_group_id" not in statement
    assert args[0] == "conductor-1"


@pytest.mark.anyio
async def test_conductor_record_does_not_persist_its_runtime_group_alias() -> None:
    pool = _RecordingPool()
    store = SimpleNamespace(pool=pool)

    await PgRuntimeMixin.upsert_conductor(
        store,
        {
            "id": "conductor-1",
            "user_id": "user-1",
            "conductor_id": "conductor-1",
            "runtime_group_id": "group_conductor-1",
            "runtime_token_hash": "runtime-hash",
            "proxy_token_hash": "proxy-hash",
            "created_at": "2026-07-12T00:00:00+00:00",
        },
    )

    statement, args = pool.calls[0]
    assert "runtime_group_id" not in statement
    assert _placeholder_numbers(statement) == list(range(1, len(args) + 1))
