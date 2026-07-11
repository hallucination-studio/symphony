from __future__ import annotations

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
import re
from types import SimpleNamespace
from typing import Any
from unittest.mock import AsyncMock

import httpx
import pytest

from podium.app import create_app
from podium.linear_graphql_client import LinearGraphQLRequestError
from podium.podium_conductors import ConductorIdentityError
from podium.podium_project_bindings import ProjectBindingError
from podium.podium_project_replacements import ProjectReplacementError
from podium.podium_shared import hash_secret
from podium.store import PgStore


USER_ID = "user-1"
INSTALLATION = {
    "id": "installation-1",
    "user_id": USER_ID,
    "active": True,
    "state": "ready",
    "app_user_id": "agent-alpha",
    "access_token": "linear-access-token",
}


def _state(store: object) -> Any:
    app = create_app(
        secure_cookies=False,
        secret_key="test-secret",
        store=store,
    )
    return app.state.podium


def _conductor(
    conductor_id: str,
    name: str,
    *,
    public_id: str = "abc123",
) -> dict[str, Any]:
    return {
        "id": conductor_id,
        "conductor_id": conductor_id,
        "user_id": USER_ID,
        "runtime_group_id": f"group-{conductor_id}",
        "name": name,
        "label": name,
        "public_id": public_id,
        "enrollment_state": "enrolled",
    }


def _binding(
    conductor_id: str = "runtime-1",
    *,
    binding_id: str | None = None,
    state: str = "ready",
    active: bool = True,
    label_name: str = "",
) -> dict[str, Any]:
    return {
        "id": binding_id or f"binding_{conductor_id}",
        "conductor_id": conductor_id,
        "user_id": USER_ID,
        "instance_id": "instance-1",
        "linear_project_id": "project-alpha",
        "project_slug": "ALPHA",
        "project_name": "Alpha",
        "agent_app_user_id": "agent-alpha",
        "installation_id": INSTALLATION["id"],
        "repo_source": {"type": "local_path", "value": "/repo/a"},
        "state": state,
        "active": active,
        "config_version": 1,
        "acknowledged_config_version": 1 if state == "ready" else 0,
        "label_id": "label-created" if label_name else "",
        "label_name": label_name,
        "replacement_conductor_id": "",
        "replacement_repo_source": {},
        "replacement_state": "",
        "replacement_binding_id": "",
        "error_code": "",
        "sanitized_reason": "",
        "updated_at": "2026-07-11T00:00:00Z",
    }


def _binding_report(binding: dict[str, Any], **overrides: Any) -> dict[str, Any]:
    return {
        "instance_id": "instance-1",
        "linear_project_id": binding["linear_project_id"],
        "project_slug": binding["project_slug"],
        "agent_app_user_id": binding["agent_app_user_id"],
        "binding_config_version": binding["config_version"],
        "repo_source": binding["repo_source"],
        "process_status": "stopped",
        **overrides,
    }


def _replace_row(target: dict[str, Any]):
    async def replace(row: dict[str, Any]) -> None:
        target.clear()
        target.update(row)

    return replace


def _claim_unbind(target: dict[str, Any], *, blocked: bool = False) -> AsyncMock:
    async def claim(
        _binding_id: str,
        _user_id: str,
        _conductor_id: str,
        *,
        replacement_conductor_id: str,
        replacement_repo_source: dict[str, Any],
        updated_at: str,
    ) -> tuple[dict[str, Any], bool]:
        if blocked:
            return dict(target), False
        target.update(
            state="pending_unbind",
            config_version=int(target.get("config_version") or 0) + 1,
            error_code="",
            sanitized_reason="",
            updated_at=updated_at,
        )
        if replacement_conductor_id:
            target.update(
                replacement_conductor_id=replacement_conductor_id,
                replacement_repo_source=replacement_repo_source,
                replacement_state="pending_unbind",
                replacement_binding_id="",
            )
        return dict(target), True

    return AsyncMock(side_effect=claim)


def _complete_unbind(target: dict[str, Any]) -> AsyncMock:
    async def complete(
        _binding_id: str,
        *,
        conductor_id: str,
        expected_state: str,
        expected_config_version: int,
        acknowledged_config_version: int,
        updated_at: str,
    ) -> dict[str, Any] | None:
        if (
            target["conductor_id"] != conductor_id
            or target["state"] != expected_state
            or target["config_version"] != expected_config_version
        ):
            return None
        target.update(
            state="unbound",
            active=False,
            acknowledged_config_version=acknowledged_config_version,
            process_status="",
            error_code="",
            sanitized_reason="",
            updated_at=updated_at,
        )
        return dict(target)

    return AsyncMock(side_effect=complete)


def _record_unbind_error(target: dict[str, Any]) -> AsyncMock:
    async def record(
        _binding_id: str,
        *,
        conductor_id: str,
        expected_state: str,
        expected_config_version: int,
        error_code: str,
        sanitized_reason: str,
        updated_at: str,
    ) -> dict[str, Any] | None:
        if (
            target["conductor_id"] != conductor_id
            or target["state"] != expected_state
            or target["config_version"] != expected_config_version
        ):
            return None
        target.update(
            error_code=error_code,
            sanitized_reason=sanitized_reason,
            updated_at=updated_at,
        )
        return dict(target)

    return AsyncMock(side_effect=record)


class ProjectLabelGateway:
    def __init__(self, *, existing_label_id: str = "", fail_operation: str = "") -> None:
        self.existing_label_id = existing_label_id
        self.fail_operation = fail_operation
        self.calls: list[tuple[str, dict[str, Any]]] = []

    async def __call__(
        self,
        _installation: dict[str, Any],
        *,
        query: str,
        variables: dict[str, Any],
        operation_name: str,
    ) -> dict[str, Any]:
        assert query
        self.calls.append((operation_name, dict(variables)))
        if operation_name == self.fail_operation:
            raise LinearGraphQLRequestError(
                "linear_graphql_failed",
                "Linear rejected the project label operation",
                retryable=False,
            )
        if operation_name == "ManagedProjectLabelLookup":
            nodes = (
                [{"id": self.existing_label_id, "name": variables["name"]}]
                if self.existing_label_id
                else []
            )
            return {"projectLabels": {"nodes": nodes}}
        if operation_name == "ManagedProjectLabelCreate":
            return {
                "projectLabelCreate": {
                    "success": True,
                    "projectLabel": {"id": "label-created", "name": variables["name"]},
                }
            }
        if operation_name == "ManagedProjectAddLabel":
            return {"projectAddLabel": {"success": True}}
        if operation_name == "ManagedProjectLabelUpdate":
            return {
                "projectLabelUpdate": {
                    "success": True,
                    "projectLabel": {
                        "id": variables["labelId"],
                        "name": variables["name"],
                    },
                }
            }
        if operation_name == "ManagedProjectRemoveLabel":
            return {"projectRemoveLabel": {"success": True}}
        if operation_name == "ManagedProjectLabelDelete":
            return {"projectLabelDelete": {"success": True}}
        raise AssertionError(f"unexpected Linear operation: {operation_name}")


@asynccontextmanager
async def _pg_binding_context(
    database_url: str,
    conductors: list[tuple[str, str, str]],
) -> AsyncIterator[tuple[PgStore, Any, dict[str, str]]]:
    store = await PgStore.connect(database_url)
    try:
        await store.migrate()
        await store.create_user(
            USER_ID,
            email="operator@example.com",
            password_hash="password-hash",
            created_at="2026-07-11T00:00:00Z",
        )
        app = create_app(
            secure_cookies=False,
            secret_key="test-secret",
            store=store,
        )
        app.state.podium.user_for_session = AsyncMock(return_value={"id": USER_ID})
        application = await app.state.podium.stage_custom_linear_application(
            USER_ID,
            client_id="linear-client",
            client_secret="linear-secret",
        )
        await app.state.podium.save_linear_installation_record(
            {
                **INSTALLATION,
                "application_config_id": application["id"],
                "application_config_version": application["version"],
                "application_source": application["source"],
                "state": "ready",
                "access_token": "linear-access-token",
                "refresh_token": "linear-refresh-token",
                "token_type": "Bearer",
                "actor": "app",
                "scope": ["read", "write", "app:assignable"],
                "linear_organization_id": "organization-1",
                "projects": [
                    {"id": "project-alpha", "name": "Alpha", "slug_id": "ALPHA"}
                ],
                "created_at": "2026-07-11T00:00:00Z",
                "updated_at": "2026-07-11T00:00:00Z",
            }
        )
        await app.state.podium.select_linear_projects(USER_ID, ["project-alpha"])
        tokens: dict[str, str] = {}
        for conductor_id, name, public_id in conductors:
            token = f"{conductor_id}-token"
            tokens[conductor_id] = token
            await store.upsert_runtime_group({"id": f"group-{conductor_id}"})
            await store.upsert_conductor(
                {
                    **_conductor(conductor_id, name, public_id=public_id),
                    "runtime_token_hash": hash_secret(token),
                    "proxy_token_hash": hash_secret(f"{conductor_id}-proxy-token"),
                    "created_at": "2026-07-11T00:00:00Z",
                }
            )
            await app.state.podium.set_presence(conductor_id)
        yield store, app, tokens
    finally:
        await store.close()


def _label_ack_context(
    *,
    existing_label_id: str = "",
    fail_operation: str = "",
) -> tuple[Any, dict[str, Any], ProjectLabelGateway]:
    current = _binding(state="pending_ack")
    gateway = ProjectLabelGateway(
        existing_label_id=existing_label_id,
        fail_operation=fail_operation,
    )
    store = SimpleNamespace(
        list_project_bindings_for_conductor=AsyncMock(
            side_effect=lambda _conductor_id: [dict(current)]
        ),
        get_runtime=AsyncMock(return_value=_conductor("runtime-1", "Beethoven")),
        upsert_project_binding=AsyncMock(side_effect=_replace_row(current)),
        get_project_binding_replacement_for_new_binding=AsyncMock(return_value=None),
    )
    state = _state(store)
    state.get_active_linear_installation = AsyncMock(return_value=INSTALLATION)
    state.linear_graphql_for_installation = gateway
    state.complete_project_replacement = AsyncMock()
    state._mark_onboarding = AsyncMock()
    return state, current, gateway


@pytest.mark.asyncio
async def test_conductor_identity_reservation_is_case_insensitive_and_generated_ids_are_unique() -> None:
    conductors: list[dict[str, Any]] = []

    async def save_conductor(row: dict[str, Any]) -> None:
        conductors.append(dict(row))

    store = SimpleNamespace(
        list_conductors_for_user=AsyncMock(side_effect=lambda _user_id: list(conductors)),
        list_runtime_groups=AsyncMock(return_value=[]),
        list_all_conductors=AsyncMock(side_effect=lambda: list(conductors)),
        upsert_runtime_group=AsyncMock(),
        upsert_conductor=AsyncMock(side_effect=save_conductor),
    )
    state = _state(store)

    named = await state.reserve_conductor(USER_ID, "Beethoven")
    with pytest.raises(ConductorIdentityError) as duplicate:
        await state.reserve_conductor(USER_ID, "beethoven")
    automatic = [
        await state.reserve_conductor(USER_ID),
        await state.reserve_conductor(USER_ID),
    ]

    assert named["name"] == "Beethoven"
    assert named["enrollment_state"] == "pending"
    assert duplicate.value.code == "conductor_name_taken"
    assert len({row["name"].casefold() for row in automatic}) == 2
    public_ids = {named["public_id"], *(row["public_id"] for row in automatic)}
    assert len(public_ids) == 3
    assert all(re.fullmatch(r"[a-z0-9]{6}", public_id) for public_id in public_ids)


@pytest.mark.asyncio
async def test_binding_requires_online_conductor_and_emits_exact_configuration() -> None:
    conductor = _conductor("runtime-1", "Mozart")
    store = SimpleNamespace(
        list_project_bindings_for_conductor=AsyncMock(return_value=[]),
        get_active_project_binding_for_project=AsyncMock(return_value=None),
        create_project_binding=AsyncMock(
            side_effect=lambda binding, **_kwargs: (binding, "")
        ),
    )
    state = _state(store)
    state.conductor_for_user = AsyncMock(return_value=conductor)
    state.is_runtime_online = AsyncMock(side_effect=[False, True])
    state.list_selected_linear_projects = AsyncMock(
        return_value=[
            {
                "linear_project_id": "project-alpha",
                "project_name": "Alpha",
                "project_slug": "ALPHA",
            }
        ]
    )
    state.get_active_linear_installation = AsyncMock(return_value=INSTALLATION)
    state.enqueue_runtime_command = AsyncMock()

    with pytest.raises(ProjectBindingError) as offline:
        await state.bind_conductor_project(
            USER_ID,
            conductor["id"],
            linear_project_id="project-alpha",
            repository={"mode": "local_path", "value": "/repo/a"},
        )
    binding = await state.bind_conductor_project(
        USER_ID,
        conductor["id"],
        linear_project_id="project-alpha",
        repository={"mode": "local_path", "value": "/repo/a"},
    )

    assert offline.value.code == "conductor_offline"
    assert binding["state"] == "pending_ack"
    assert binding["acknowledged_config_version"] == 0
    assert binding["repo_source"] == {"type": "local_path", "value": "/repo/a"}
    state.enqueue_runtime_command.assert_awaited_once_with(
        conductor["id"],
        {
            "type": "project.configure",
            "binding_id": binding["id"],
            "config_version": 1,
            "linear_project_id": "project-alpha",
            "project_slug": "ALPHA",
            "project_name": "Alpha",
            "agent_app_user_id": "agent-alpha",
            "repository": {"mode": "local_path", "value": "/repo/a"},
        },
    )


@pytest.mark.asyncio
async def test_binding_ack_enforces_one_project_per_conductor_and_one_conductor_per_project() -> None:
    conductor = _conductor("runtime-1", "Bach")
    existing = _binding("runtime-existing")
    store = SimpleNamespace(
        list_project_bindings_for_conductor=AsyncMock(side_effect=[[existing], []]),
        get_active_project_binding_for_project=AsyncMock(return_value=existing),
    )
    state = _state(store)
    state.conductor_for_user = AsyncMock(return_value=conductor)
    state.is_runtime_online = AsyncMock(return_value=True)
    state.list_selected_linear_projects = AsyncMock(
        return_value=[{"linear_project_id": "project-alpha"}]
    )

    with pytest.raises(ProjectBindingError) as conductor_conflict:
        await state.bind_conductor_project(
            USER_ID,
            conductor["id"],
            linear_project_id="project-alpha",
            repository={"mode": "local_path", "value": "/repo/a"},
        )
    with pytest.raises(ProjectBindingError) as project_conflict:
        await state.bind_conductor_project(
            USER_ID,
            conductor["id"],
            linear_project_id="project-alpha",
            repository={"mode": "local_path", "value": "/repo/a"},
        )

    report_store = SimpleNamespace(
        get_runtime=AsyncMock(return_value=conductor),
        list_conductors_for_user=AsyncMock(return_value=[conductor]),
        upsert_conductor=AsyncMock(),
    )
    report_state = _state(report_store)
    report = await report_state.apply_runtime_report(
        conductor["id"],
        {"bindings": [{"instance_id": "one"}, {"instance_id": "two"}]},
    )

    assert conductor_conflict.value.code == "conductor_already_bound"
    assert project_conflict.value.code == "linear_project_already_bound"
    assert report["status"] == "rejected"
    assert report["error_code"] == "multiple_project_bindings"


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("existing_label_id", "expected_operations"),
    [
        (
            "",
            [
                "ManagedProjectLabelLookup",
                "ManagedProjectLabelCreate",
                "ManagedProjectAddLabel",
            ],
        ),
        (
            "label-existing",
            ["ManagedProjectLabelLookup", "ManagedProjectAddLabel"],
        ),
    ],
    ids=["create-label", "reuse-label"],
)
async def test_binding_ack_owns_one_exact_idempotent_managed_label(
    existing_label_id: str,
    expected_operations: list[str],
) -> None:
    state, current, gateway = _label_ack_context(existing_label_id=existing_label_id)
    report = _binding_report(current)

    ready = await state.acknowledge_project_binding("runtime-1", report)
    repeated = await state.acknowledge_project_binding("runtime-1", report)

    expected_label_id = existing_label_id or "label-created"
    assert ready["state"] == "ready"
    assert ready["label_id"] == expected_label_id
    assert ready["label_name"] == "symphony:conductor/Beethoven-abc123"
    assert repeated["label_id"] == expected_label_id
    assert [operation for operation, _variables in gateway.calls] == expected_operations
    add_label_variables = next(
        variables
        for operation, variables in gateway.calls
        if operation == "ManagedProjectAddLabel"
    )
    assert add_label_variables == {
        "projectId": "project-alpha",
        "labelId": expected_label_id,
    }


@pytest.mark.asyncio
async def test_label_sync_failure_is_returned_persisted_and_logged(
    postgres_database_url: str,
    caplog: pytest.LogCaptureFixture,
) -> None:
    caplog.set_level("INFO")
    conductors = [
        ("runtime-old", "Bach", "abc123"),
        ("runtime-new", "Mozart", "def456"),
    ]
    async with _pg_binding_context(
        postgres_database_url,
        conductors,
    ) as (store, app, tokens):
        old = {
            **_binding(
                "runtime-old",
                binding_id="binding-old",
                state="unbound",
                active=False,
            ),
            "replacement_conductor_id": "runtime-new",
            "replacement_repo_source": {"type": "local_path", "value": "/repo/a"},
            "replacement_state": "pending_ack",
            "replacement_binding_id": "binding-new",
        }
        current = _binding(
            "runtime-new",
            binding_id="binding-new",
            state="pending_ack",
        )
        current["acknowledged_config_version"] = 0
        await store.upsert_project_binding(old)
        await store.upsert_project_binding(current)
        app.state.podium.linear_graphql_for_installation = ProjectLabelGateway(
            fail_operation="ManagedProjectLabelCreate"
        )

        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app),
            base_url="http://podium.test",
        ) as client:
            report = await client.post(
                "/api/v1/runtime/report",
                headers={"Authorization": f"Bearer {tokens['runtime-new']}"},
                json={"bindings": [_binding_report(current)]},
            )
            runtimes = await client.get("/api/v1/runtimes")
            replacement = await client.get(
                "/api/v1/conductors/runtime-new/binding-replacement"
            )

        failed_binding = await store.get_project_binding("binding-new")
        failed_replacement = await store.get_project_binding("binding-old")

    assert report.status_code == 409
    assert report.json()["error"]["code"] == "linear_project_label_sync_failed"
    assert failed_binding is not None
    assert (
        failed_binding["state"],
        failed_binding["error_code"],
        failed_binding["sanitized_reason"],
    ) == (
        "failed",
        "linear_project_label_sync_failed",
        "Linear project label operation failed",
    )
    assert failed_replacement is not None
    assert (
        failed_replacement["replacement_state"],
        failed_replacement["error_code"],
    ) == ("failed", "linear_project_label_sync_failed")
    assert runtimes.status_code == 200
    runtime = next(
        row
        for row in runtimes.json()["conductors"]
        if row["conductor_id"] == "runtime-new"
    )
    assert runtime["bindings"][0]["state"] == "failed"
    assert runtime["bindings"][0]["error_code"] == "linear_project_label_sync_failed"
    assert replacement.status_code == 200
    assert replacement.json()["replacement"]["state"] == "failed"
    assert replacement.json()["replacement"]["error_code"] == (
        "linear_project_label_sync_failed"
    )
    assert re.search(
        r"event=project_binding_failed .*error_code=linear_project_label_sync_failed",
        caplog.text,
    )
    assert re.search(
        r"event=project_replacement_failed .*error_code=linear_project_label_sync_failed",
        caplog.text,
    )


@pytest.mark.asyncio
async def test_rename_updates_label_once_preserves_identity_and_rejects_duplicate_name() -> None:
    conductor = _conductor("runtime-1", "Ravel")
    other = _conductor("runtime-2", "Mozart", public_id="def456")
    current = _binding(
        label_name="symphony:conductor/Ravel-abc123",
    )
    gateway = ProjectLabelGateway()
    conductors = {row["id"]: row for row in (conductor, other)}

    async def save_conductor(row: dict[str, Any]) -> None:
        conductors[str(row["id"])] = dict(row)

    store = SimpleNamespace(
        list_conductors_for_user=AsyncMock(
            side_effect=lambda _user_id: [dict(row) for row in conductors.values()]
        ),
        list_project_bindings_for_conductor=AsyncMock(
            side_effect=lambda _conductor_id: [dict(current)]
        ),
        upsert_project_binding=AsyncMock(side_effect=_replace_row(current)),
        upsert_conductor=AsyncMock(side_effect=save_conductor),
    )
    state = _state(store)
    state.get_active_linear_installation = AsyncMock(return_value=INSTALLATION)
    state.linear_graphql_for_installation = gateway

    renamed = await state.rename_conductor(USER_ID, conductor["id"], "Mahler")
    repeated = await state.rename_conductor(USER_ID, conductor["id"], "Mahler")
    with pytest.raises(ConductorIdentityError) as duplicate:
        await state.rename_conductor(USER_ID, conductor["id"], "mozart")

    assert renamed["name"] == "Mahler"
    assert renamed["public_id"] == conductor["public_id"]
    assert repeated == renamed
    assert current["label_name"] == "symphony:conductor/Mahler-abc123"
    assert [operation for operation, _variables in gateway.calls] == [
        "ManagedProjectLabelUpdate"
    ]
    assert duplicate.value.code == "conductor_name_taken"


@pytest.mark.asyncio
async def test_rename_label_failure_preserves_identity_and_surfaces_durable_error(
    caplog: pytest.LogCaptureFixture,
) -> None:
    conductor = _conductor("runtime-1", "Ravel")
    current = _binding(label_name="symphony:conductor/Ravel-abc123")
    gateway = ProjectLabelGateway(fail_operation="ManagedProjectLabelUpdate")
    store = SimpleNamespace(
        list_conductors_for_user=AsyncMock(return_value=[conductor]),
        list_project_bindings_for_conductor=AsyncMock(return_value=[current]),
        upsert_project_binding=AsyncMock(side_effect=_replace_row(current)),
        upsert_conductor=AsyncMock(),
    )
    state = _state(store)
    state.get_active_linear_installation = AsyncMock(return_value=INSTALLATION)
    state.linear_graphql_for_installation = gateway

    with pytest.raises(ConductorIdentityError) as raised:
        await state.rename_conductor(USER_ID, conductor["id"], "Mahler")

    assert raised.value.code == "linear_project_label_rename_failed"
    assert conductor["name"] == "Ravel"
    assert current["state"] == "ready"
    assert current["label_name"] == "symphony:conductor/Ravel-abc123"
    assert current["error_code"] == "linear_project_label_rename_failed"
    assert current["sanitized_reason"] == "Linear project label rename failed"
    store.upsert_conductor.assert_not_awaited()
    assert "event=linear_project_label_rename_failed" in caplog.text


@pytest.mark.asyncio
async def test_unbind_waits_for_ack_removes_label_and_is_idempotent(
    caplog: pytest.LogCaptureFixture,
) -> None:
    caplog.set_level("INFO", logger="podium.podium_project_bindings")
    current = _binding(label_name="symphony:conductor/Bach-abc123")
    gateway = ProjectLabelGateway()
    group = {
        "id": "group-runtime-1",
        "project_slug": "ALPHA",
        "linear_agent_app_user_id": "agent-alpha",
        "project_binding_id": current["id"],
    }
    store = SimpleNamespace(
        list_project_bindings_for_conductor=AsyncMock(
            side_effect=lambda _conductor_id: [dict(current)]
        ),
        claim_project_unbind=_claim_unbind(current),
        upsert_project_binding=AsyncMock(side_effect=_replace_row(current)),
        complete_project_unbind=_complete_unbind(current),
        record_project_unbind_error=_record_unbind_error(current),
        get_project_binding=AsyncMock(side_effect=lambda _binding_id: dict(current)),
        get_runtime=AsyncMock(return_value={"runtime_group_id": group["id"]}),
        get_runtime_group=AsyncMock(return_value=group),
        upsert_runtime_group=AsyncMock(),
    )
    state = _state(store)
    state.conductor_for_user = AsyncMock(return_value=_conductor("runtime-1", "Bach"))
    state.enqueue_runtime_command = AsyncMock()
    state.get_active_linear_installation = AsyncMock(return_value=INSTALLATION)
    state.linear_graphql_for_installation = gateway

    pending, changed = await state.begin_project_unbind(USER_ID, "runtime-1")
    unbound = await state.acknowledge_project_unbind(
        "runtime-1",
        {
            "unbound_binding_id": pending["id"],
            "unbound_config_version": pending["config_version"],
        },
    )
    repeated, repeated_changed = await state.begin_project_unbind(USER_ID, "runtime-1")

    assert changed is True
    state.enqueue_runtime_command.assert_not_awaited()
    assert unbound["state"] == "unbound"
    assert unbound["active"] is False
    assert repeated == unbound
    assert repeated_changed is False
    assert gateway.calls == [
        (
            "ManagedProjectRemoveLabel",
            {"projectId": "project-alpha", "labelId": "label-created"},
        ),
        ("ManagedProjectLabelDelete", {"labelId": "label-created"}),
    ]
    cleared_group = store.upsert_runtime_group.await_args.args[0]
    assert cleared_group["project_binding_id"] == ""
    assert "event=project_unbind_requested" in caplog.text
    assert "event=project_unbound" in caplog.text


@pytest.mark.asyncio
async def test_unbind_failures_remain_routable_and_visible(
    caplog: pytest.LogCaptureFixture,
) -> None:
    ready = _binding(label_name="symphony:conductor/Bach-abc123")
    blocked_store = SimpleNamespace(
        list_project_bindings_for_conductor=AsyncMock(return_value=[ready]),
        claim_project_unbind=_claim_unbind(ready, blocked=True),
        upsert_project_binding=AsyncMock(),
    )
    blocked_state = _state(blocked_store)
    blocked_state.conductor_for_user = AsyncMock(
        return_value=_conductor("runtime-1", "Bach")
    )
    blocked_state.enqueue_runtime_command = AsyncMock()

    with pytest.raises(ProjectBindingError) as active_work:
        await blocked_state.begin_project_unbind(USER_ID, "runtime-1")

    pending = {**ready, "state": "pending_unbind", "config_version": 2}
    gateway = ProjectLabelGateway(fail_operation="ManagedProjectRemoveLabel")
    failure_store = SimpleNamespace(
        get_project_binding=AsyncMock(side_effect=lambda _binding_id: dict(pending)),
        upsert_project_binding=AsyncMock(side_effect=_replace_row(pending)),
        record_project_unbind_error=_record_unbind_error(pending),
    )
    failure_state = _state(failure_store)
    failure_state.get_active_linear_installation = AsyncMock(return_value=INSTALLATION)
    failure_state.linear_graphql_for_installation = gateway

    with pytest.raises(ProjectBindingError) as label_failure:
        await failure_state.acknowledge_project_unbind(
            "runtime-1",
            {
                "unbound_binding_id": pending["id"],
                "unbound_config_version": pending["config_version"],
            },
        )

    assert active_work.value.code == "managed_runs_active"
    assert label_failure.value.code == "linear_project_label_remove_failed"
    assert pending["active"] is True
    assert pending["state"] == "pending_unbind"
    assert pending["error_code"] == "linear_project_label_remove_failed"
    assert pending["sanitized_reason"] == "Linear project label removal failed"
    assert "event=project_unbind_blocked" in caplog.text
    assert "event=linear_project_label_remove_failed" in caplog.text


@pytest.mark.asyncio
async def test_replacement_moves_ownership_only_after_new_binding_is_ready(
    postgres_database_url: str,
    caplog: pytest.LogCaptureFixture,
) -> None:
    caplog.set_level("INFO", logger="podium.podium_project_replacements")
    conductors = [
        ("runtime-old", "Bach", "abc123"),
        ("runtime-new", "Mozart", "def456"),
    ]
    async with _pg_binding_context(
        postgres_database_url,
        conductors,
    ) as (store, app, tokens):
        old = _binding("runtime-old", binding_id="binding-old")
        old["repo_source"] = {"type": "local_path", "value": "/repo/old"}
        await store.upsert_project_binding(old)
        app.state.podium.linear_graphql_for_installation = ProjectLabelGateway()

        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app),
            base_url="http://podium.test",
        ) as client:
            started = await client.post(
                "/api/v1/conductors/runtime-new/binding-replacement",
                json={
                    "replace_conductor_id": "runtime-old",
                    "linear_project_id": "project-alpha",
                    "repository": {"mode": "local_path", "value": "/repo/new"},
                },
            )
            pending_old = await store.get_project_binding("binding-old")
            assert pending_old is not None
            unconfigure = await store.next_runtime_command("runtime-old", after_id=0)
            assert unconfigure is not None
            old_report = await client.post(
                "/api/v1/runtime/report",
                headers={"Authorization": f"Bearer {tokens['runtime-old']}"},
                json={
                    "unbound_binding_id": "binding-old",
                    "unbound_config_version": pending_old["config_version"],
                },
            )
            linked_old = await store.get_project_binding("binding-old")
            assert linked_old is not None
            new_binding = await store.get_project_binding(
                linked_old["replacement_binding_id"]
            )
            assert new_binding is not None
            configure = await store.next_runtime_command("runtime-new", after_id=0)
            assert configure is not None
            new_report = await client.post(
                "/api/v1/runtime/report",
                headers={"Authorization": f"Bearer {tokens['runtime-new']}"},
                json={"bindings": [_binding_report(new_binding)]},
            )
            replacement = await client.get(
                "/api/v1/conductors/runtime-new/binding-replacement"
            )

            await store.commit_linear_reconciliation_page(
                new_binding["id"],
                expected_state=None,
                expected_installation_id=str(new_binding["installation_id"]),
                expected_agent_app_user_id=str(new_binding["agent_app_user_id"]),
                state={"binding_id": new_binding["id"]},
                observations=[],
                dispatches=[{
                    "dispatch_id": "dispatch-new-owner",
                    "project_binding_id": new_binding["id"],
                    "user_id": USER_ID,
                    "issue_id": "issue-1",
                    "issue_identifier": "ALPHA-1",
                    "intake_key": "linear-issue:issue-1:epoch:1",
                    "workspace_id": USER_ID,
                    "project_slug": "ALPHA",
                    "agent_app_user_id": "agent-alpha",
                    "status": "queued",
                    "created_at": "2026-07-11T02:00:00Z",
                }],
            )
            old_lease = await client.post(
                "/api/v1/runtime/dispatches/lease",
                headers={"Authorization": f"Bearer {tokens['runtime-old']}"},
            )
            new_lease = await client.post(
                "/api/v1/runtime/dispatches/lease",
                headers={"Authorization": f"Bearer {tokens['runtime-new']}"},
            )

        final_old = await store.get_project_binding("binding-old")
        final_new = await store.get_project_binding(new_binding["id"])

    assert started.status_code == 202
    assert started.json()["replacement"]["state"] == "pending_unbind"
    assert old_report.status_code == 200
    assert old_report.json()["binding_state"] == "unbound"
    assert linked_old["replacement_state"] == "pending_ack"
    assert linked_old["replacement_binding_id"] == new_binding["id"]
    assert new_report.status_code == 200
    assert new_report.json()["binding_state"] == "ready"
    assert replacement.status_code == 200
    assert replacement.json()["replacement"]["state"] == "ready"
    assert final_old is not None and final_old["replacement_state"] == "ready"
    assert final_old["active"] is False
    assert final_new is not None and final_new["state"] == "ready"
    assert final_new["active"] is True
    assert [unconfigure["command"]["type"], configure["command"]["type"]] == [
        "project.unconfigure",
        "project.configure",
    ]
    assert old_lease.status_code == 200 and old_lease.json()["dispatch"] is None
    assert new_lease.status_code == 200
    assert new_lease.json()["dispatch"]["dispatch_id"] == "dispatch-new-owner"
    assert "event=project_replacement_started" in caplog.text
    assert "event=project_replacement_completed" in caplog.text


@pytest.mark.asyncio
async def test_replacement_rejects_active_work_and_competing_target() -> None:
    old = _binding("runtime-old", binding_id="binding-old")
    target = _conductor("runtime-new", "Mozart", public_id="def456")
    store = SimpleNamespace(
        get_active_project_binding_for_project=AsyncMock(return_value=old),
        list_project_bindings_for_conductor=AsyncMock(return_value=[]),
    )
    state = _state(store)
    state.conductor_for_user = AsyncMock(return_value=target)
    state.is_runtime_online = AsyncMock(return_value=True)
    state.begin_project_unbind = AsyncMock(
        side_effect=ProjectBindingError(
            "managed_runs_active",
            "Managed Runs must finish before unbinding",
        )
    )

    with pytest.raises(ProjectBindingError) as active_work:
        await state.start_project_replacement(
            USER_ID,
            target["id"],
            old_conductor_id="runtime-old",
            linear_project_id="project-alpha",
            repository={"mode": "local_path", "value": "/repo/new"},
        )

    competing_old = {
        **old,
        "replacement_conductor_id": "runtime-first-target",
        "replacement_state": "pending_unbind",
    }
    competing_store = SimpleNamespace(
        get_active_project_binding_for_project=AsyncMock(return_value=competing_old)
    )
    competing_state = _state(competing_store)
    with pytest.raises(ProjectReplacementError) as competing:
        await competing_state.start_project_replacement(
            USER_ID,
            "runtime-second-target",
            old_conductor_id="runtime-old",
            linear_project_id="project-alpha",
            repository={"mode": "local_path", "value": "/repo/new"},
        )

    assert active_work.value.code == "managed_runs_active"
    assert competing.value.code == "replacement_in_progress"
