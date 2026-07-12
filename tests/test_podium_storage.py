from __future__ import annotations

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
    PERFORMER_PROFILE_UPSERT_SQL,
    RUNTIME_PROFILE_UPSERT_SQL,
    _credential_values,
    _performer_binding_values,
    _performer_profile_values,
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
    assert "CREATE TABLE IF NOT EXISTS performer_credentials" in schema
    assert "CREATE TABLE IF NOT EXISTS performer_bindings" in schema
    assert "performer_binding_id TEXT" in schema
    assert "runtime_profile_revisions" not in schema
    assert "performer_profile_revisions" not in schema


def test_profile_store_values_and_sql_have_stable_parameter_contracts() -> None:
    runtime = {
        "id": "runtime-profile:user-1:default",
        "workspace_id": "user-1",
        "name": "default",
        "runtime_kind": "codex",
        "config_format": "toml",
        "config_document": 'model = "gpt-test"\n',
        "config_sha256": "a" * 64,
        "state": "active",
    }
    performer = {
        "id": "performer-profile:user-1:default",
        "workspace_id": "user-1",
        "name": "default",
        "performer_kind": "codex",
        "runtime_profile_id": runtime["id"],
        "turn_policy": {"max_turns": 4},
        "policy_sha256": "b" * 64,
        "state": "active",
    }
    credential = {
        "id": "credential:user-1:chatgpt-main",
        "workspace_id": "user-1",
        "name": "ChatGPT main",
        "performer_kind": "codex",
        "auth_method": "chatgpt_oauth",
        "account_hint": "main",
        "local_ref": "slot:chatgpt-main",
        "state": "active",
    }
    binding = {
        "id": "performer-binding:binding-1",
        "workspace_id": "user-1",
        "project_binding_id": "binding-1",
        "performer_profile_id": performer["id"],
        "credential_id": credential["id"],
        "generation": 1,
        "state": "ready",
        "error_code": "",
        "sanitized_reason": "",
        "updated_at": "2026-07-12T00:00:00+00:00",
    }

    assert _placeholder_numbers(RUNTIME_PROFILE_UPSERT_SQL) == list(range(1, len(_runtime_profile_values(runtime)) + 1))
    assert _placeholder_numbers(PERFORMER_PROFILE_UPSERT_SQL) == list(range(1, len(_performer_profile_values(performer)) + 1))
    assert _placeholder_numbers(PERFORMER_BINDING_UPSERT_SQL) == list(range(1, len(_performer_binding_values(binding)) + 1))
    assert len(_credential_values(credential)) == 11
    assert "revision" not in PERFORMER_BINDING_UPSERT_SQL.lower()


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
