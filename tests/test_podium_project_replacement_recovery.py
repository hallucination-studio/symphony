from __future__ import annotations

import asyncio
import re
from types import SimpleNamespace
from typing import Any
from unittest.mock import AsyncMock

import asyncpg
import pytest

from podium.app import create_app
from podium.podium_project_bindings import ProjectBindingError
from podium.podium_project_labels import LinearProjectLabelError
from podium.podium_project_replacements import ProjectReplacementError
from podium.store import PgStore


USER_ID = "user-1"


def _state(store: object) -> Any:
    return create_app(
        secure_cookies=False,
        secret_key="test-secret",
        store=store,
    ).state.podium


def _binding(
    conductor_id: str,
    binding_id: str,
    *,
    state: str = "unbound",
    active: bool = False,
) -> dict[str, Any]:
    return {
        "id": binding_id,
        "conductor_id": conductor_id,
        "user_id": USER_ID,
        "instance_id": f"instance-{conductor_id}",
        "linear_project_id": "project-alpha",
        "project_slug": "ALPHA",
        "project_name": "Alpha",
        "agent_app_user_id": "agent-alpha",
        "installation_id": "installation-1",
        "repo_source": {"type": "local_path", "value": "/repo/new"},
        "state": state,
        "active": active,
        "config_version": 1,
        "acknowledged_config_version": 1,
        "replacement_conductor_id": "runtime-new",
        "replacement_repo_source": {"type": "local_path", "value": "/repo/new"},
        "replacement_state": "pending_unbind",
        "replacement_binding_id": "",
        "error_code": "",
        "sanitized_reason": "",
        "updated_at": "2026-07-11T00:00:00Z",
    }


def _replacement_error_was_logged(
    caplog: pytest.LogCaptureFixture,
    code: str,
) -> bool:
    return bool(
        re.search(
            rf"event=project_replacement_failed .*error_code={re.escape(code)}",
            caplog.text,
        )
    )


def _transition_replacement(target: dict[str, Any]) -> AsyncMock:
    async def transition(
        binding_id: str,
        *,
        replacement_conductor_id: str,
        expected_state: str,
        expected_config_version: int,
        expected_updated_at: str,
        expected_replacement_binding_id: str,
        replacement_state: str,
        replacement_binding_id: str,
        error_code: str,
        sanitized_reason: str,
        updated_at: str,
    ) -> dict[str, Any] | None:
        if (
            target["id"] != binding_id
            or target["replacement_conductor_id"] != replacement_conductor_id
            or target["replacement_state"] != expected_state
            or target["config_version"] != expected_config_version
            or target["updated_at"] != expected_updated_at
            or target["replacement_binding_id"] != expected_replacement_binding_id
        ):
            return None
        target.update(
            replacement_state=replacement_state,
            replacement_binding_id=replacement_binding_id,
            error_code=error_code,
            sanitized_reason=sanitized_reason,
            updated_at=updated_at,
        )
        return dict(target)

    return AsyncMock(side_effect=transition)


async def _seed_pg_replacement(
    store: PgStore,
    *,
    replacement_state: str = "",
    replacement_binding_id: str = "",
) -> dict[str, Any]:
    await store.migrate()
    await store.create_user(
        USER_ID,
        email="operator@example.com",
        password_hash="password-hash",
        created_at="2026-07-11T00:00:00Z",
    )
    for index, conductor_id in enumerate(
        ("runtime-old", "runtime-new-a", "runtime-new-b"),
        start=1,
    ):
        await store.upsert_runtime_group({"id": f"group-{conductor_id}"})
        await store.upsert_conductor(
            {
                "id": conductor_id,
                "user_id": USER_ID,
                "runtime_group_id": f"group-{conductor_id}",
                "name": conductor_id,
                "public_id": f"public-{index}",
                "enrollment_state": "enrolled",
                "runtime_token_hash": f"runtime-token-{index}",
                "proxy_token_hash": f"proxy-token-{index}",
                "created_at": "2026-07-11T00:00:00Z",
            }
        )
        if conductor_id != "runtime-old":
            await store.set_presence(
                conductor_id,
                timestamp="2026-07-11T00:00:00Z",
                expires_at="2099-07-11T00:00:00Z",
            )
    old = {
        **_binding("runtime-old", "binding-old", state="ready", active=True),
        "repo_source": {"type": "local_path", "value": "/repo/old"},
        "replacement_conductor_id": "runtime-new-a" if replacement_state else "",
        "replacement_repo_source": (
            {"type": "local_path", "value": "/repo/new-a"}
            if replacement_state
            else {}
        ),
        "replacement_state": replacement_state,
        "replacement_binding_id": replacement_binding_id,
        "updated_at": "2026-07-11T00:00:00Z",
    }
    await store.upsert_project_binding(old)
    return old


def _gate_old_binding_read(store: PgStore, barrier: asyncio.Barrier) -> None:
    list_bindings = store.list_project_bindings_for_conductor

    async def gated(conductor_id: str) -> list[dict[str, Any]]:
        rows = await list_bindings(conductor_id)
        if conductor_id == "runtime-old":
            await barrier.wait()
        return rows

    store.list_project_bindings_for_conductor = gated  # type: ignore[method-assign]


@pytest.mark.asyncio
async def test_competing_replacement_starts_have_one_winner_and_one_command(
    postgres_database_url: str,
) -> None:
    first_store = await PgStore.connect(postgres_database_url)
    second_store = await PgStore.connect(postgres_database_url)
    try:
        await _seed_pg_replacement(first_store)
        barrier = asyncio.Barrier(2)
        _gate_old_binding_read(first_store, barrier)
        _gate_old_binding_read(second_store, barrier)
        first_state = _state(first_store)
        second_state = _state(second_store)

        outcomes = await asyncio.gather(
            first_state.start_project_replacement(
                USER_ID,
                "runtime-new-a",
                old_conductor_id="runtime-old",
                linear_project_id="project-alpha",
                repository={"mode": "local_path", "value": "/repo/new-a"},
            ),
            second_state.start_project_replacement(
                USER_ID,
                "runtime-new-b",
                old_conductor_id="runtime-old",
                linear_project_id="project-alpha",
                repository={"mode": "local_path", "value": "/repo/new-b"},
            ),
            return_exceptions=True,
        )
        binding = await first_store.get_project_binding("binding-old")
        commands = await first_store.pool.fetch(
            "SELECT command_json ->> 'config_version' AS config_version "
            "FROM runtime_commands WHERE runtime_id = $1",
            "runtime-old",
        )
    finally:
        await first_store.close()
        await second_store.close()

    successes = [outcome for outcome in outcomes if isinstance(outcome, dict)]
    conflicts = [
        outcome
        for outcome in outcomes
        if isinstance(outcome, ProjectReplacementError)
        and outcome.code == "replacement_in_progress"
    ]
    assert len(successes) == 1
    assert len(conflicts) == 1
    assert binding is not None
    assert binding["replacement_conductor_id"] in {
        "runtime-new-a",
        "runtime-new-b",
    }
    assert binding["config_version"] == 2
    assert len(commands) == 1
    assert int(commands[0]["config_version"]) == 2


@pytest.mark.asyncio
async def test_plain_unbind_and_replacement_share_one_atomic_unconfigure(
    postgres_database_url: str,
) -> None:
    unbind_store = await PgStore.connect(postgres_database_url)
    replacement_store = await PgStore.connect(postgres_database_url)
    try:
        await _seed_pg_replacement(unbind_store)
        barrier = asyncio.Barrier(2)
        _gate_old_binding_read(unbind_store, barrier)
        _gate_old_binding_read(replacement_store, barrier)
        unbind_state = _state(unbind_store)
        replacement_state = _state(replacement_store)

        unbound, replacement = await asyncio.gather(
            unbind_state.begin_project_unbind(USER_ID, "runtime-old"),
            replacement_state.start_project_replacement(
                USER_ID,
                "runtime-new-a",
                old_conductor_id="runtime-old",
                linear_project_id="project-alpha",
                repository={"mode": "local_path", "value": "/repo/new-a"},
            ),
        )
        binding = await unbind_store.get_project_binding("binding-old")
        commands = await unbind_store.pool.fetch(
            "SELECT command_json FROM runtime_commands WHERE runtime_id = $1",
            "runtime-old",
        )
    finally:
        await unbind_store.close()
        await replacement_store.close()

    assert unbound[0]["state"] == "pending_unbind"
    assert replacement["replacement_conductor_id"] == "runtime-new-a"
    assert binding is not None
    assert binding["replacement_conductor_id"] == "runtime-new-a"
    assert binding["replacement_state"] == "pending_unbind"
    assert binding["config_version"] == 2
    assert len(commands) == 1


@pytest.mark.asyncio
async def test_concurrent_target_bind_has_one_stable_owner(
    postgres_database_url: str,
) -> None:
    first_store = await PgStore.connect(postgres_database_url)
    second_store = await PgStore.connect(postgres_database_url)
    try:
        await _seed_pg_replacement(first_store)
        barrier = asyncio.Barrier(2)
        for store in (first_store, second_store):
            list_bindings = store.list_project_bindings_for_conductor

            async def gated(
                conductor_id: str,
                *,
                _list_bindings: Any = list_bindings,
            ) -> list[dict[str, Any]]:
                rows = await _list_bindings(conductor_id)
                if conductor_id == "runtime-new-a":
                    await barrier.wait()
                return rows

            store.list_project_bindings_for_conductor = gated  # type: ignore[method-assign]

        first_state = _state(first_store)
        second_state = _state(second_store)
        projects = [
            {
                "linear_project_id": "project-beta",
                "project_name": "Beta",
                "project_slug": "BETA",
            },
            {
                "linear_project_id": "project-gamma",
                "project_name": "Gamma",
                "project_slug": "GAMMA",
            },
        ]
        installation = {"id": "installation-1", "app_user_id": "agent-alpha"}
        for state in (first_state, second_state):
            state.list_selected_linear_projects = AsyncMock(return_value=projects)
            state.get_active_linear_installation = AsyncMock(return_value=installation)

        outcomes = await asyncio.gather(
            first_state.bind_conductor_project(
                USER_ID,
                "runtime-new-a",
                linear_project_id="project-beta",
                repository={"mode": "local_path", "value": "/repo/beta"},
            ),
            second_state.bind_conductor_project(
                USER_ID,
                "runtime-new-a",
                linear_project_id="project-gamma",
                repository={"mode": "local_path", "value": "/repo/gamma"},
            ),
            return_exceptions=True,
        )
        binding = await first_store.get_project_binding("binding_runtime-new-a")
    finally:
        await first_store.close()
        await second_store.close()

    successes = [outcome for outcome in outcomes if isinstance(outcome, dict)]
    conflicts = [
        outcome
        for outcome in outcomes
        if isinstance(outcome, ProjectBindingError)
        and outcome.code == "conductor_already_bound"
    ]
    assert len(successes) == 1
    assert len(conflicts) == 1
    assert binding is not None
    assert binding["linear_project_id"] == successes[0]["linear_project_id"]


@pytest.mark.asyncio
async def test_pending_replacement_durably_reserves_target_conductor(
    postgres_database_url: str,
) -> None:
    store = await PgStore.connect(postgres_database_url)
    try:
        await _seed_pg_replacement(store)
        state = _state(store)
        state.list_selected_linear_projects = AsyncMock(
            return_value=[{
                "linear_project_id": "project-beta",
                "project_name": "Beta",
                "project_slug": "BETA",
            }]
        )
        state.get_active_linear_installation = AsyncMock(
            return_value={"id": "installation-1", "app_user_id": "agent-alpha"}
        )

        replacement = await state.start_project_replacement(
            USER_ID,
            "runtime-new-a",
            old_conductor_id="runtime-old",
            linear_project_id="project-alpha",
            repository={"mode": "local_path", "value": "/repo/new-a"},
        )
        with pytest.raises(ProjectBindingError) as raised:
            await state.bind_conductor_project(
                USER_ID,
                "runtime-new-a",
                linear_project_id="project-beta",
                repository={"mode": "local_path", "value": "/repo/beta"},
            )
        target_binding = await store.get_project_binding("binding_runtime-new-a")
    finally:
        await store.close()

    assert replacement["replacement_state"] == "pending_unbind"
    assert raised.value.code == "replacement_conductor_reserved"
    assert target_binding is None


@pytest.mark.asyncio
@pytest.mark.parametrize("winner", ["replacement", "ordinary_binding"])
async def test_replacement_claim_races_ordinary_target_bind_without_overwrite(
    postgres_database_url: str,
    winner: str,
) -> None:
    replacement_store = await PgStore.connect(postgres_database_url)
    binding_store = await PgStore.connect(postgres_database_url)
    try:
        await _seed_pg_replacement(replacement_store)
        barrier = asyncio.Barrier(2)

        def gate_initial_target_read(delegate: Any) -> Any:
            initial_read_complete = False

            async def gated(conductor_id: str) -> list[dict[str, Any]]:
                nonlocal initial_read_complete
                rows = await delegate(conductor_id)
                if conductor_id == "runtime-new-a" and not initial_read_complete:
                    initial_read_complete = True
                    await barrier.wait()
                return rows

            return gated

        for store in (replacement_store, binding_store):
            store.list_project_bindings_for_conductor = gate_initial_target_read(  # type: ignore[method-assign]
                store.list_project_bindings_for_conductor
            )

        replacement_state = _state(replacement_store)
        binding_state = _state(binding_store)
        binding_state.list_selected_linear_projects = AsyncMock(
            return_value=[{
                "linear_project_id": "project-beta",
                "project_name": "Beta",
                "project_slug": "BETA",
            }]
        )
        binding_state.get_active_linear_installation = AsyncMock(
            return_value={"id": "installation-1", "app_user_id": "agent-alpha"}
        )
        winner_committed = asyncio.Event()
        if winner == "replacement":
            create_binding = binding_store.create_project_binding

            async def create_after_replacement(*args: Any, **kwargs: Any) -> Any:
                await winner_committed.wait()
                return await create_binding(*args, **kwargs)

            binding_store.create_project_binding = create_after_replacement  # type: ignore[method-assign]
            claim_unbind = replacement_store.claim_project_unbind

            async def claim_first(*args: Any, **kwargs: Any) -> Any:
                result = await claim_unbind(*args, **kwargs)
                winner_committed.set()
                return result

            replacement_store.claim_project_unbind = claim_first  # type: ignore[method-assign]
        else:
            claim_unbind = replacement_store.claim_project_unbind

            async def claim_after_binding(*args: Any, **kwargs: Any) -> Any:
                await winner_committed.wait()
                return await claim_unbind(*args, **kwargs)

            replacement_store.claim_project_unbind = claim_after_binding  # type: ignore[method-assign]
            create_binding = binding_store.create_project_binding

            async def create_first(*args: Any, **kwargs: Any) -> Any:
                result = await create_binding(*args, **kwargs)
                winner_committed.set()
                return result

            binding_store.create_project_binding = create_first  # type: ignore[method-assign]

        outcomes = await asyncio.gather(
            replacement_state.start_project_replacement(
                USER_ID,
                "runtime-new-a",
                old_conductor_id="runtime-old",
                linear_project_id="project-alpha",
                repository={"mode": "local_path", "value": "/repo/new-a"},
            ),
            binding_state.bind_conductor_project(
                USER_ID,
                "runtime-new-a",
                linear_project_id="project-beta",
                repository={"mode": "local_path", "value": "/repo/beta"},
            ),
            return_exceptions=True,
        )
        old = await replacement_store.get_project_binding("binding-old")
        target = await replacement_store.get_project_binding("binding_runtime-new-a")
    finally:
        await replacement_store.close()
        await binding_store.close()

    assert len([outcome for outcome in outcomes if isinstance(outcome, dict)]) == 1
    assert old is not None
    if old["replacement_conductor_id"]:
        assert old["replacement_conductor_id"] == "runtime-new-a"
        assert target is None
        assert any(
            isinstance(outcome, ProjectBindingError)
            and outcome.code == "replacement_conductor_reserved"
            for outcome in outcomes
        )
    else:
            assert target is not None
            assert target["linear_project_id"] == "project-beta"
            assert any(
                isinstance(outcome, (ProjectBindingError, ProjectReplacementError))
                and outcome.code == "replacement_conductor_already_bound"
                for outcome in outcomes
            )


@pytest.mark.asyncio
async def test_stale_failure_cannot_overwrite_concurrently_persisted_ready(
    postgres_database_url: str,
    caplog: pytest.LogCaptureFixture,
) -> None:
    caplog.set_level("WARNING", logger="podium.podium_project_replacements")
    failing_store = await PgStore.connect(postgres_database_url)
    completing_store = await PgStore.connect(postgres_database_url)
    try:
        old = await _seed_pg_replacement(
            failing_store,
            replacement_state="pending_ack",
            replacement_binding_id="binding-new",
        )
        new = {
            **_binding(
                "runtime-new-a",
                "binding-new",
                state="pending_ack",
                active=True,
            ),
            "replacement_conductor_id": "",
            "replacement_repo_source": {},
            "replacement_state": "",
            "replacement_binding_id": "",
            "updated_at": "2026-07-11T00:01:00Z",
        }
        await failing_store.upsert_project_binding({**old, "active": False})
        await failing_store.upsert_project_binding(new)

        replacement_read = asyncio.Event()
        allow_failure = asyncio.Event()
        get_replacement = failing_store.get_project_binding_replacement_for_new_binding

        async def pause_after_read(binding_id: str) -> dict[str, Any] | None:
            row = await get_replacement(binding_id)
            replacement_read.set()
            await allow_failure.wait()
            return row

        failing_store.get_project_binding_replacement_for_new_binding = (  # type: ignore[method-assign]
            pause_after_read
        )
        failing_state = _state(failing_store)
        completing_state = _state(completing_store)
        failure = asyncio.create_task(
            failing_state.fail_project_replacement_for_binding(
                new,
                "stale_failure",
                "A stale failure must not reopen replacement",
            )
        )
        await replacement_read.wait()
        await completing_state.complete_project_replacement(new)
        allow_failure.set()
        await failure
        final = await completing_store.get_project_binding("binding-old")
    finally:
        await failing_store.close()
        await completing_store.close()

    assert final is not None
    assert final["replacement_state"] == "ready"
    assert final["error_code"] == ""
    assert "event=project_replacement_failure_ignored" in caplog.text
    assert "error_code=stale_replacement_transition" in caplog.text


@pytest.mark.asyncio
async def test_current_replacement_owner_ignores_historical_link(
    postgres_database_url: str,
) -> None:
    store = await PgStore.connect(postgres_database_url)
    try:
        historical = await _seed_pg_replacement(store)
        await store.upsert_project_binding(
            {
                **historical,
                "active": False,
                "state": "unbound",
                "replacement_conductor_id": "runtime-new-a",
                "replacement_state": "ready",
                "replacement_binding_id": "binding-new",
            }
        )
        current = {
            **_binding("runtime-new-b", "binding-current"),
            "config_version": 2,
            "replacement_conductor_id": "runtime-new-a",
            "replacement_state": "pending_ack",
            "replacement_binding_id": "binding-new",
            "updated_at": "2026-07-11T00:01:00Z",
        }
        target = {
            **_binding("runtime-new-a", "binding-new", state="ready", active=True),
            "replacement_conductor_id": "",
            "replacement_repo_source": {},
            "replacement_state": "",
            "replacement_binding_id": "",
            "updated_at": "2026-07-11T00:02:00Z",
        }
        await store.upsert_project_binding(current)
        await store.upsert_project_binding(target)

        await _state(store).complete_project_replacement(target)
        historical_after = await store.get_project_binding("binding-old")
        current_after = await store.get_project_binding("binding-current")
    finally:
        await store.close()

    assert historical_after is not None
    assert historical_after["replacement_state"] == "ready"
    assert current_after is not None
    assert current_after["replacement_state"] == "ready"


@pytest.mark.asyncio
async def test_repeated_same_target_start_rechecks_unbind_command() -> None:
    old = {
        **_binding("runtime-old", "binding-old", state="ready", active=True),
        "replacement_conductor_id": "",
        "replacement_repo_source": {},
        "replacement_state": "",
    }

    async def begin_unbind(
        _user_id: str,
        _conductor_id: str,
        replacement: dict[str, Any],
    ) -> tuple[dict[str, Any], bool]:
        old.update(replacement, state="pending_unbind", config_version=2)
        return dict(old), True

    store = SimpleNamespace(
        get_active_project_binding_for_project=AsyncMock(return_value=old),
        list_project_bindings_for_conductor=AsyncMock(return_value=[]),
        get_project_binding=AsyncMock(side_effect=lambda _binding_id: dict(old)),
    )
    state = _state(store)
    state.conductor_for_user = AsyncMock(
        return_value={"id": "runtime-new", "enrollment_state": "enrolled"}
    )
    state.is_runtime_online = AsyncMock(return_value=True)
    state.begin_project_unbind = AsyncMock(side_effect=begin_unbind)

    first = await state.start_project_replacement(
        USER_ID,
        "runtime-new",
        old_conductor_id="runtime-old",
        linear_project_id="project-alpha",
        repository={"mode": "local_path", "value": "/repo/new"},
    )
    repeated = await state.start_project_replacement(
        USER_ID,
        "runtime-new",
        old_conductor_id="runtime-old",
        linear_project_id="project-alpha",
        repository={"mode": "local_path", "value": "/repo/new"},
    )

    assert first["replacement_state"] == "pending_unbind"
    assert repeated["replacement_conductor_id"] == "runtime-new"
    assert state.begin_project_unbind.await_count == 2


@pytest.mark.asyncio
async def test_pending_unbind_repairs_missing_unconfigure_command(
    postgres_database_url: str,
) -> None:
    store = await PgStore.connect(postgres_database_url)
    try:
        await _seed_pg_replacement(store)
        await store.pool.execute(
            """
            UPDATE project_bindings SET
              state = 'pending_unbind', config_version = 2,
              replacement_conductor_id = 'runtime-new-a',
              replacement_repo_source = '{"type":"local_path","value":"/repo/new-a"}'::jsonb,
              replacement_state = 'pending_unbind'
            WHERE id = 'binding-old'
            """
        )

        recovered, _ = await _state(store).begin_project_unbind(
            USER_ID,
            "runtime-old",
            replacement={
                "replacement_conductor_id": "runtime-new-a",
                "replacement_repo_source": {
                    "type": "local_path",
                    "value": "/repo/new-a",
                },
            },
        )
        commands = await store.pool.fetch(
            "SELECT dedupe_key, command_json ->> 'config_version' AS config_version "
            "FROM runtime_commands WHERE runtime_id = $1",
            "runtime-old",
        )
    finally:
        await store.close()

    assert recovered["replacement_conductor_id"] == "runtime-new-a"
    assert len(commands) == 1
    assert commands[0]["dedupe_key"] == "project.unconfigure:binding-old:2"
    assert int(commands[0]["config_version"]) == 2


@pytest.mark.asyncio
async def test_unbind_claim_rolls_back_when_command_insert_fails(
    postgres_database_url: str,
) -> None:
    store = await PgStore.connect(postgres_database_url)
    try:
        await _seed_pg_replacement(store)
        await store.pool.execute(
            """
            CREATE FUNCTION reject_runtime_command() RETURNS trigger AS $$
            BEGIN
              RAISE EXCEPTION 'forced runtime command failure';
            END;
            $$ LANGUAGE plpgsql
            """
        )
        await store.pool.execute(
            """
            CREATE TRIGGER reject_runtime_command
            BEFORE INSERT ON runtime_commands
            FOR EACH ROW EXECUTE FUNCTION reject_runtime_command()
            """
        )

        with pytest.raises(asyncpg.RaiseError, match="forced runtime command failure"):
            await _state(store).begin_project_unbind(USER_ID, "runtime-old")
        binding = await store.get_project_binding("binding-old")
        commands = await store.pool.fetch(
            "SELECT id FROM runtime_commands WHERE runtime_id = $1",
            "runtime-old",
        )
    finally:
        await store.close()

    assert binding is not None
    assert binding["state"] == "ready"
    assert binding["config_version"] == 1
    assert commands == []


@pytest.mark.asyncio
async def test_replacement_replay_rejects_changed_repository_payload() -> None:
    old = {
        **_binding("runtime-old", "binding-old", state="pending_unbind", active=True),
        "replacement_conductor_id": "runtime-new",
        "replacement_repo_source": {"type": "local_path", "value": "/repo/original"},
    }
    store = SimpleNamespace(
        get_active_project_binding_for_project=AsyncMock(return_value=old),
    )
    state = _state(store)

    with pytest.raises(ProjectReplacementError) as raised:
        await state.start_project_replacement(
            USER_ID,
            "runtime-new",
            old_conductor_id="runtime-old",
            linear_project_id="project-alpha",
            repository={"mode": "local_path", "value": "/repo/changed"},
        )

    assert raised.value.code == "replacement_payload_mismatch"


@pytest.mark.asyncio
async def test_same_replacement_post_replays_after_old_binding_ack() -> None:
    old = {
        **_binding("runtime-old", "binding-old"),
        "replacement_state": "pending_ack",
        "replacement_binding_id": "binding-new",
    }
    store = SimpleNamespace(
        get_active_project_binding_for_project=AsyncMock(return_value=None),
        get_project_replacement=AsyncMock(return_value=old),
        get_project_binding=AsyncMock(return_value=old),
    )
    state = _state(store)
    state.advance_project_replacement = AsyncMock(return_value=None)

    replayed = await state.start_project_replacement(
        USER_ID,
        "runtime-new",
        old_conductor_id="runtime-old",
        linear_project_id="project-alpha",
        repository={"mode": "local_path", "value": "/repo/new"},
    )

    assert replayed == old
    state.advance_project_replacement.assert_awaited_once_with(old)


@pytest.mark.asyncio
@pytest.mark.parametrize("label_failure", [False, True])
async def test_unbind_ack_preserves_replacement_attached_during_label_io(
    label_failure: bool,
) -> None:
    current = {
        **_binding("runtime-old", "binding-old", state="pending_unbind", active=True),
        "config_version": 2,
        "replacement_conductor_id": "",
        "replacement_repo_source": {},
        "replacement_state": "",
    }
    label_started = asyncio.Event()
    release_label = asyncio.Event()

    async def remove_label(_binding: dict[str, Any]) -> None:
        label_started.set()
        await release_label.wait()
        if label_failure:
            raise LinearProjectLabelError("label operation failed")

    async def replace_row(row: dict[str, Any]) -> None:
        current.clear()
        current.update(row)

    async def complete_unbind(
        _binding_id: str, **kwargs: Any
    ) -> dict[str, Any] | None:
        if (
            current["state"] != kwargs["expected_state"]
            or current["config_version"] != kwargs["expected_config_version"]
        ):
            return None
        current.update(
            state="unbound",
            active=False,
            acknowledged_config_version=kwargs["acknowledged_config_version"],
            process_status="",
            error_code="",
            sanitized_reason="",
            updated_at=kwargs["updated_at"],
        )
        return dict(current)

    async def record_error(
        _binding_id: str, **kwargs: Any
    ) -> dict[str, Any] | None:
        if (
            current["state"] != kwargs["expected_state"]
            or current["config_version"] != kwargs["expected_config_version"]
        ):
            return None
        current.update(
            error_code=kwargs["error_code"],
            sanitized_reason=kwargs["sanitized_reason"],
            updated_at=kwargs["updated_at"],
        )
        return dict(current)

    store = SimpleNamespace(
        get_project_binding=AsyncMock(return_value=dict(current)),
        upsert_project_binding=AsyncMock(side_effect=replace_row),
        complete_project_unbind=AsyncMock(side_effect=complete_unbind),
        record_project_unbind_error=AsyncMock(side_effect=record_error),
        get_runtime=AsyncMock(return_value=None),
        get_runtime_group=AsyncMock(return_value=None),
    )
    state = _state(store)
    state.remove_managed_project_label = AsyncMock(side_effect=remove_label)
    state.advance_project_replacement = AsyncMock()

    acknowledgement = asyncio.create_task(
        state.acknowledge_project_unbind(
            "runtime-old",
            {
                "unbound_binding_id": "binding-old",
                "unbound_config_version": 2,
            },
        )
    )
    await label_started.wait()
    current.update(
        replacement_conductor_id="runtime-new",
        replacement_repo_source={"type": "local_path", "value": "/repo/new"},
        replacement_state="pending_unbind",
    )
    release_label.set()

    if label_failure:
        with pytest.raises(ProjectBindingError) as raised:
            await acknowledgement
        assert raised.value.code == "linear_project_label_remove_failed"
    else:
        await acknowledgement

    assert current["replacement_conductor_id"] == "runtime-new"
    assert current["replacement_repo_source"] == {
        "type": "local_path",
        "value": "/repo/new",
    }
    assert current["replacement_state"] == "pending_unbind"


@pytest.mark.asyncio
async def test_replacement_retry_advances_after_target_returns_online(
    caplog: pytest.LogCaptureFixture,
) -> None:
    old = _binding("runtime-old", "binding-old")
    new = _binding("runtime-new", "binding-new", state="pending_ack", active=True)
    store = SimpleNamespace(
        list_project_bindings_for_conductor=AsyncMock(return_value=[]),
        transition_project_replacement=_transition_replacement(old),
        get_project_binding=AsyncMock(side_effect=lambda _binding_id: dict(old)),
    )
    state = _state(store)
    state.bind_conductor_project = AsyncMock(
        side_effect=[
            ProjectBindingError("conductor_offline", "Conductor must be online"),
            new,
        ]
    )

    with pytest.raises(ProjectBindingError, match="online"):
        await state.advance_project_replacement(old)
    recovered = await state.advance_project_replacement(old)

    assert old["replacement_state"] == "pending_ack"
    assert old["error_code"] == ""
    assert recovered == new
    assert _replacement_error_was_logged(caplog, "conductor_offline")


@pytest.mark.asyncio
async def test_replacement_binding_race_fails_closed_with_exact_error(
    caplog: pytest.LogCaptureFixture,
) -> None:
    old = _binding("runtime-old", "binding-old")
    competing = {
        **_binding("runtime-new", "binding-competing", active=True),
        "linear_project_id": "project-beta",
        "repo_source": {"type": "local_path", "value": "/repo/beta"},
    }
    store = SimpleNamespace(
        list_project_bindings_for_conductor=AsyncMock(return_value=[competing]),
        transition_project_replacement=_transition_replacement(old),
    )
    state = _state(store)
    state.bind_conductor_project = AsyncMock()

    with pytest.raises(ProjectBindingError) as raised:
        await state.advance_project_replacement(old)

    assert raised.value.code == "conductor_already_bound"
    assert old["replacement_state"] == "failed"
    assert old["error_code"] == "conductor_already_bound"
    state.bind_conductor_project.assert_not_awaited()
    assert _replacement_error_was_logged(caplog, "conductor_already_bound")


@pytest.mark.asyncio
async def test_ready_replacement_ignores_stale_ack_failure(
    caplog: pytest.LogCaptureFixture,
) -> None:
    new = _binding("runtime-new", "binding-new", state="pending_ack", active=True)
    old = {
        **_binding("runtime-old", "binding-old"),
        "replacement_state": "pending_ack",
        "replacement_binding_id": new["id"],
    }

    transition = _transition_replacement(old)
    store = SimpleNamespace(
        get_project_binding_replacement_for_new_binding=AsyncMock(
            side_effect=lambda _binding_id: dict(old)
        ),
        transition_project_replacement=transition,
    )
    state = _state(store)

    await state.fail_project_replacement_for_binding(
        new,
        "linear_project_label_sync_failed",
        "Linear project label operation failed",
    )
    await state.complete_project_replacement({**new, "state": "ready"})
    await state.fail_project_replacement_for_binding(
        new,
        "stale_failure",
        "A stale report must not reopen replacement",
    )

    assert old["replacement_state"] == "ready"
    assert old["error_code"] == ""
    assert transition.await_count == 2
    assert _replacement_error_was_logged(caplog, "linear_project_label_sync_failed")
    assert "error_code=stale_failure" not in caplog.text


@pytest.mark.asyncio
@pytest.mark.parametrize("concurrent_change", ["failed", "config_aba", "state_cycle"])
async def test_stale_completion_cannot_cross_exact_replacement_fence(
    concurrent_change: str,
) -> None:
    new = _binding("runtime-new", "binding-new", state="ready", active=True)
    old = {
        **_binding("runtime-old", "binding-old"),
        "config_version": 2,
        "replacement_state": "pending_ack",
        "replacement_binding_id": new["id"],
    }

    async def transition(
        _binding_id: str,
        **fence: Any,
    ) -> dict[str, Any] | None:
        if concurrent_change == "failed":
            old.update(
                replacement_state="failed",
                error_code="newer_failure",
                sanitized_reason="A newer attempt failed",
            )
        elif concurrent_change == "config_aba":
            old["config_version"] = 3
        else:
            old["updated_at"] = "2026-07-11T00:05:00Z"

        expected_state = fence.get("expected_state")
        expected_states = fence.get("expected_states", ())
        state_matches = (
            old["replacement_state"] == expected_state
            if expected_state is not None
            else old["replacement_state"] in expected_states
        )
        config_matches = (
            "expected_config_version" not in fence
            or old["config_version"] == fence["expected_config_version"]
        )
        revision_matches = (
            "expected_updated_at" not in fence
            or old["updated_at"] == fence["expected_updated_at"]
        )
        if not state_matches or not config_matches or not revision_matches:
            return None
        old.update(
            replacement_state=fence["replacement_state"],
            replacement_binding_id=fence["replacement_binding_id"],
            error_code=fence["error_code"],
            sanitized_reason=fence["sanitized_reason"],
        )
        return dict(old)

    store = SimpleNamespace(
        get_project_binding_replacement_for_new_binding=AsyncMock(
            return_value=dict(old)
        ),
        transition_project_replacement=AsyncMock(side_effect=transition),
    )
    state = _state(store)

    await state.complete_project_replacement(new)

    if concurrent_change == "failed":
        assert old["replacement_state"] == "failed"
        assert old["error_code"] == "newer_failure"
    else:
        assert old["replacement_state"] == "pending_ack"
        if concurrent_change == "config_aba":
            assert old["config_version"] == 3
        else:
            assert old["updated_at"] == "2026-07-11T00:05:00Z"


@pytest.mark.asyncio
async def test_interrupted_replacement_reuses_existing_target_binding() -> None:
    old = _binding("runtime-old", "binding-old")
    existing = _binding("runtime-new", "binding-new", state="pending_ack", active=True)

    store = SimpleNamespace(
        list_project_bindings_for_conductor=AsyncMock(return_value=[existing]),
        get_project_binding=AsyncMock(return_value=existing),
        transition_project_replacement=_transition_replacement(old),
    )
    state = _state(store)
    state.bind_conductor_project = AsyncMock()

    recovered = await state.advance_project_replacement(old)
    repeated = await state.advance_project_replacement(old)

    assert recovered == existing
    assert repeated == existing
    assert old["replacement_state"] == "pending_ack"
    assert old["replacement_binding_id"] == existing["id"]
    state.bind_conductor_project.assert_not_awaited()


@pytest.mark.asyncio
async def test_linked_ready_target_converges_old_pending_ack_to_ready() -> None:
    old = {
        **_binding("runtime-old", "binding-old"),
        "replacement_state": "pending_ack",
        "replacement_binding_id": "binding-new",
    }
    ready = _binding("runtime-new", "binding-new", state="ready", active=True)
    store = SimpleNamespace(
        get_project_binding=AsyncMock(return_value=ready),
    )
    state = _state(store)
    state.complete_project_replacement = AsyncMock()

    recovered = await state.advance_project_replacement(old)

    assert recovered == ready
    state.complete_project_replacement.assert_awaited_once_with(ready)
