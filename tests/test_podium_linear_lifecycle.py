from __future__ import annotations

import asyncio
from contextlib import asynccontextmanager
from typing import Any

import httpx
import pytest
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

from podium.linear_installation_acceptance import LinearInstallationRejected
from podium.linear_constants import LINEAR_REQUIRED_SCOPES
from podium.podium_linear_cutover import LinearCutoverError, PodiumLinearCutoverMixin
from podium.podium_linear_installations import PodiumLinearInstallationsMixin
from podium.podium_linear_projects import PodiumLinearProjectsMixin
from podium.podium_routes_linear_oauth import _complete_callback, _save_accepted_installation
from podium.podium_routes_linear_cutover import register_linear_cutover_route
from podium.podium_state import PodiumStateBaseMixin


class LifecycleStore:
    def __init__(self) -> None:
        self.selected = [
            {
                "linear_organization_id": "organization-1",
                "linear_project_id": "project-bound",
                "project_slug": "bound",
                "project_name": "Bound",
                "access_state": "ready",
            },
            {
                "linear_organization_id": "organization-1",
                "linear_project_id": "project-unbound",
                "project_slug": "unbound",
                "project_name": "Unbound",
                "access_state": "ready",
            },
        ]
        self.bindings = [
            {"linear_project_id": "project-bound", "active": True},
        ]
        self.replacements: list[list[dict[str, Any]]] = []

    async def list_selected_linear_projects(self, _user_id: str) -> list[dict[str, Any]]:
        return list(self.selected)

    async def list_project_bindings_for_user(self, _user_id: str) -> list[dict[str, Any]]:
        return list(self.bindings)

    async def replace_selected_linear_projects(
        self,
        _user_id: str,
        projects: list[dict[str, Any]],
    ) -> list[str]:
        self.replacements.append(projects)
        self.selected = list(projects)
        return []


class LifecycleProjectState(PodiumLinearProjectsMixin):
    def __init__(self) -> None:
        self.store = LifecycleStore()
        self.review_required: list[str] = []

    async def require_linear_project_review(self, user_id: str) -> None:
        self.review_required.append(user_id)


class OnboardingStore:
    def __init__(self) -> None:
        self.row = {
            "completed_steps": [
                "linear_connect",
                "scope_selection",
                "runtime_enrollment",
            ],
            "metadata": {},
        }
        self.saved: list[tuple[str, list[str], dict[str, Any]]] = []

    async def get_onboarding_state(self, _user_id: str) -> dict[str, Any]:
        return dict(self.row)

    async def save_onboarding_state(
        self,
        user_id: str,
        completed_steps: list[str],
        metadata: dict[str, Any],
    ) -> None:
        self.saved.append((user_id, completed_steps, metadata))


class OnboardingState(PodiumStateBaseMixin):
    def __init__(self) -> None:
        self.store = OnboardingStore()


def candidate(*project_ids: str) -> dict[str, Any]:
    return {
        "linear_organization_id": "organization-1",
        "projects": [
            {"id": project_id, "name": project_id, "slug_id": project_id}
            for project_id in project_ids
        ],
    }


@pytest.mark.anyio
async def test_reauthorization_allows_missing_selected_unbound_project() -> None:
    state = LifecycleProjectState()

    await state.validate_candidate_project_access(
        "user-1",
        candidate("project-bound"),
    )


@pytest.mark.anyio
async def test_reauthorization_rejects_missing_bound_project() -> None:
    state = LifecycleProjectState()

    with pytest.raises(LinearInstallationRejected) as raised:
        await state.validate_candidate_project_access(
            "user-1",
            candidate("project-unbound"),
        )

    assert raised.value.code == "linear_bound_project_missing"
    assert state.store.replacements == []


@pytest.mark.anyio
async def test_successful_reauthorization_intersects_only_unbound_selection() -> None:
    state = LifecycleProjectState()
    state.store.selected.append(
        {
            "linear_organization_id": "organization-1",
            "linear_project_id": "project-kept",
            "project_slug": "kept",
            "project_name": "Kept",
            "access_state": "ready",
        }
    )

    replacement = state.linear_projects_for_reauthorization(
        "user-1",
        candidate("project-bound", "project-kept"),
    )

    assert [row["linear_project_id"] for row in replacement] == [
        "project-bound",
        "project-kept",
    ]
    assert state.store.replacements == []


@pytest.mark.anyio
async def test_reauthorization_requires_project_review_without_resetting_other_steps() -> None:
    state = OnboardingState()

    await state.require_linear_project_review("user-1")

    assert state.store.saved == [
        ("user-1", ["linear_connect", "runtime_enrollment"], {})
    ]


class AcceptedInstallationState:
    def __init__(
        self,
        *,
        same_identity: bool,
        blocked_projects: list[str] | None = None,
    ) -> None:
        self.same_identity = same_identity
        self.blocked_projects = blocked_projects or []
        self.saved: list[dict[str, Any]] = []
        self.reconciled: list[tuple[str, str]] = []
        self.review_required: list[str] = []
        self.active: dict[str, Any] | None = None
        self.store = self
        self.token_lock = asyncio.Lock()

    @asynccontextmanager
    async def linear_installation_token_lock(self, _installation_id: str):
        async with self.token_lock:
            yield

    async def get_active_linear_installation(
        self,
        _user_id: str,
    ) -> dict[str, Any] | None:
        return dict(self.active) if self.active is not None else None

    async def get_linear_application_config(self, _config_id: str) -> dict[str, str]:
        return {"client_id": "same-client" if self.same_identity else "old-client"}

    async def save_linear_installation_record(
        self,
        record: dict[str, Any],
        *,
        reauthorized_projects: list[dict[str, Any]] | None = None,
    ) -> list[str]:
        if reauthorized_projects is not None and self.blocked_projects:
            return list(self.blocked_projects)
        self.saved.append(dict(record))
        return []

    def linear_projects_for_reauthorization(
        self,
        user_id: str,
        record: dict[str, Any],
    ) -> list[dict[str, Any]]:
        self.reconciled.append((user_id, str(record["id"])))
        return [{"linear_project_id": "project-bound"}]

    async def require_linear_project_review(self, user_id: str) -> None:
        self.review_required.append(user_id)


@pytest.mark.anyio
@pytest.mark.parametrize(("same_identity", "expected_reconciled"), [(True, True), (False, False)])
async def test_only_immediately_activated_reauthorization_reconciles_projects(
    same_identity: bool,
    expected_reconciled: bool,
) -> None:
    state = AcceptedInstallationState(same_identity=same_identity)
    active = {
        "id": "installation-active",
        "application_config_id": "app-old",
        "linear_organization_id": "organization-1",
        "app_user_id": "app-user-1",
        "created_at": "2026-07-14T00:00:00Z",
    }
    record = {
        "id": "installation-new",
        "linear_organization_id": "organization-1",
        "app_user_id": "app-user-1" if same_identity else "app-user-2",
    }
    config = {"client_id": "same-client"}
    state.active = dict(active)

    await _save_accepted_installation(state, "user-1", active, config, record)

    assert bool(state.reconciled) is expected_reconciled
    if same_identity:
        assert state.saved[0]["id"] == "installation-active"
        assert state.reconciled == [("user-1", "installation-active")]
        assert state.review_required == ["user-1"]
    else:
        assert state.saved[0]["state"] == "draining"
        assert state.review_required == []


@pytest.mark.anyio
async def test_same_identity_reauthorization_rejects_before_replacing_active() -> None:
    state = AcceptedInstallationState(
        same_identity=True,
        blocked_projects=["project-newly-bound"],
    )
    active = {
        "id": "installation-active",
        "application_config_id": "app-old",
        "linear_organization_id": "organization-1",
        "app_user_id": "app-user-1",
        "created_at": "2026-07-14T00:00:00Z",
    }
    record = {
        "id": "installation-new",
        "linear_organization_id": "organization-1",
        "app_user_id": "app-user-1",
    }
    state.active = dict(active)

    with pytest.raises(LinearInstallationRejected) as raised:
        await _save_accepted_installation(
            state,
            "user-1",
            active,
            {"client_id": "same-client"},
            record,
        )

    assert raised.value.code == "linear_bound_project_missing"
    assert state.saved == []
    assert state.review_required == []


@pytest.mark.anyio
async def test_same_identity_reauthorization_does_not_revive_disconnected_installation() -> None:
    state = AcceptedInstallationState(same_identity=True)
    active = {
        "id": "installation-active",
        "application_config_id": "app-old",
        "linear_organization_id": "organization-1",
        "app_user_id": "app-user-1",
        "created_at": "2026-07-14T00:00:00Z",
    }
    state.active = dict(active)
    record = {
        "id": "installation-new",
        "linear_organization_id": "organization-1",
        "app_user_id": "app-user-1",
    }

    await state.token_lock.acquire()
    save = asyncio.create_task(
        _save_accepted_installation(
            state,
            "user-1",
            active,
            {"client_id": "same-client"},
            record,
        )
    )
    await asyncio.sleep(0)
    state.active = None
    state.token_lock.release()

    with pytest.raises(LinearInstallationRejected) as raised:
        await save

    assert raised.value.code == "linear_reauthorization_required"
    assert state.saved == []


class RejectedCallbackState:
    def __init__(self) -> None:
        self.active = {
            "id": "installation-active",
            "application_config_id": "application-1",
            "linear_organization_id": "organization-1",
            "app_user_id": "app-user-1",
        }
        self.saved: list[dict[str, Any]] = []
        self.connected = False

    async def get_active_linear_installation(self, _user_id: str) -> dict[str, Any]:
        return self.active

    async def validate_candidate_project_access(
        self,
        _user_id: str,
        _record: dict[str, Any],
    ) -> None:
        raise LinearInstallationRejected(
            "linear_bound_project_missing",
            "The replacement application cannot access bound Linear projects: project-bound",
        )

    async def save_linear_installation_record(self, record: dict[str, Any]) -> None:
        self.saved.append(dict(record))

    async def mark_linear_connected(self, _user_id: str) -> None:
        self.connected = True


@pytest.mark.anyio
async def test_reauthorization_rejection_leaves_active_installation_unchanged(
    caplog: pytest.LogCaptureFixture,
) -> None:
    state = RejectedCallbackState()
    active_before = dict(state.active)
    sentinel_token = "sentinel-access-token"
    sentinel_refresh_token = "sentinel-refresh-token"
    sentinel_client_secret = "sentinel-client-secret"
    sentinel_oauth_state = "sentinel-oauth-state"

    response = await _complete_callback(
        state=state,
        user_id="user-1",
        code="sentinel-code",
        code_verifier="sentinel-verifier",
        config={
            "id": "application-1",
            "version": 1,
            "source": "default",
            "client_id": "client-1",
            "client_secret": sentinel_client_secret,
            "oauth_state": sentinel_oauth_state,
        },
        linear_token_exchange=lambda *_args: {
            "access_token": sentinel_token,
            "refresh_token": sentinel_refresh_token,
            "token_type": "Bearer",
            "actor": "app",
            "scope": " ".join(sorted(LINEAR_REQUIRED_SCOPES)),
            "expires_in": 3600,
        },
        linear_installation_fetch=lambda _token: {
            "viewer": {"id": "app-user-1", "app": True},
            "organization": {
                "id": "organization-1",
                "name": "Organization",
                "urlKey": "organization",
            },
            "projects": [
                {"id": "project-other", "name": "Other", "slugId": "other"}
            ],
        },
        linear_graphql_transport=None,
        error_response=lambda *_args: pytest.fail("unexpected error response"),
    )

    assert response.status_code == 303
    assert response.headers["location"] == (
        "/setup/linear?linear=error&code=linear_bound_project_missing"
    )
    assert state.active == active_before
    assert state.connected is False
    assert state.saved[0]["state"] == "failed"
    assert state.saved[0]["active"] is False
    public = PodiumLinearInstallationsMixin.linear_installation_public(
        state,
        state.saved[0],
    )
    assert public is not None
    assert public["error_code"] == "linear_bound_project_missing"
    assert any(
        "event=podium_linear_oauth_callback_rejected" in message
        and "error_code=linear_bound_project_missing" in message
        for message in caplog.messages
    )
    visible = repr((public, response.headers, caplog.messages))
    assert "linear_bound_project_missing" in visible
    for secret in (
        sentinel_token,
        sentinel_refresh_token,
        sentinel_client_secret,
        sentinel_oauth_state,
        "sentinel-code",
        "sentinel-verifier",
    ):
        assert secret not in visible


class CutoverStore:
    def __init__(self, *, blocked_projects: list[str] | None = None) -> None:
        self.switched = False
        self.blocked_projects = blocked_projects or []
        self.token_lock = asyncio.Lock()

    @asynccontextmanager
    async def linear_installation_token_lock(self, _installation_id: str):
        async with self.token_lock:
            yield

    async def list_project_bindings_for_user(self, _user_id: str) -> list[dict[str, Any]]:
        return []

    async def switch_workspace_installation(
        self,
        _user_id: str,
        _installation_id: str,
        _app_user_id: str,
        _selected_projects: list[dict[str, Any]],
    ) -> list[str]:
        if self.blocked_projects:
            return list(self.blocked_projects)
        self.switched = True
        return []


class CutoverState(PodiumLinearCutoverMixin):
    def __init__(self) -> None:
        self.store = CutoverStore()
        self.active = {"id": "installation-active"}
        self.candidate = {
            "id": "installation-candidate",
            "app_user_id": "app-user-2",
            "state": "draining",
        }
        self.reconciled: list[tuple[str, str]] = []
        self.review_required: list[str] = []
        self.saved: list[dict[str, Any]] = []

    async def get_active_linear_installation(self, _user_id: str) -> dict[str, Any]:
        return self.candidate if self.store.switched else self.active

    async def get_candidate_linear_installation(self, _user_id: str) -> dict[str, Any]:
        return self.candidate

    async def _workspace_has_active_work(self, _user_id: str) -> bool:
        return False

    async def _retire_linear_credentials(self, _installation: dict[str, Any]) -> bool:
        return True

    def linear_projects_for_reauthorization(
        self,
        user_id: str,
        installation: dict[str, Any],
    ) -> list[dict[str, Any]]:
        self.reconciled.append((user_id, str(installation["id"])))
        return [{"linear_project_id": "project-bound"}]

    async def require_linear_project_review(self, user_id: str) -> None:
        self.review_required.append(user_id)

    async def save_linear_installation_record(self, record: dict[str, Any]) -> None:
        self.saved.append(dict(record))


@pytest.mark.anyio
async def test_candidate_cutover_reconciles_projects_only_after_switch() -> None:
    state = CutoverState()

    result = await state.advance_linear_installation_cutover("user-1")

    assert result["cutover_state"] == "switched"
    assert state.reconciled == [("user-1", "installation-candidate")]
    assert state.review_required == ["user-1"]


@pytest.mark.anyio
async def test_candidate_cutover_rejects_before_switching_active_installation(
    caplog: pytest.LogCaptureFixture,
) -> None:
    state = CutoverState()
    state.store = CutoverStore(blocked_projects=["project-newly-bound"])

    with pytest.raises(LinearCutoverError) as raised:
        await state.advance_linear_installation_cutover("user-1")

    assert raised.value.code == "linear_bound_project_missing"
    assert state.store.switched is False
    assert state.review_required == []
    assert state.saved[0]["state"] == "failed"
    assert state.saved[0]["error_code"] == "linear_bound_project_missing"
    assert state.saved[0]["action_required"] == "reauthorize"
    assert any(
        "event=podium_linear_cutover_rejected" in message
        and "error_code=linear_bound_project_missing" in message
        for message in caplog.messages
    )


@pytest.mark.anyio
async def test_candidate_cutover_does_not_switch_after_active_installation_changes() -> None:
    state = CutoverState()
    await state.store.token_lock.acquire()
    cutover = asyncio.create_task(state.advance_linear_installation_cutover("user-1"))
    await asyncio.sleep(0)
    state.active = {"id": "installation-other"}
    state.store.token_lock.release()

    with pytest.raises(LinearCutoverError) as raised:
        await cutover

    assert raised.value.code == "linear_cutover_not_available"
    assert state.store.switched is False


@pytest.mark.anyio
async def test_candidate_cutover_route_returns_safe_bound_project_error(
    caplog: pytest.LogCaptureFixture,
) -> None:
    state = CutoverState()
    state.store = CutoverStore(blocked_projects=["project-newly-bound"])
    state.candidate.update(
        {
            "access_token": "sentinel-cutover-access-token",
            "refresh_token": "sentinel-cutover-refresh-token",
        }
    )
    app = FastAPI()

    async def require_user(_request: Request) -> dict[str, str]:
        return {"id": "user-1"}

    def error_response(status: int, code: str, message: str) -> JSONResponse:
        return JSONResponse(
            {"error": {"code": code, "message": message}},
            status_code=status,
        )

    register_linear_cutover_route(
        app,
        state=state,
        require_user=require_user,
        error_response=error_response,
    )
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app, raise_app_exceptions=False),
        base_url="http://test",
    ) as client:
        response = await client.post("/api/v1/linear/installations/cutover")

    assert response.status_code == 409
    assert response.json()["error"]["code"] == "linear_bound_project_missing"
    visible = repr((response.json(), caplog.messages))
    assert "linear_bound_project_missing" in visible
    assert "sentinel-cutover-access-token" not in visible
    assert "sentinel-cutover-refresh-token" not in visible


class PreparedCutoverStore(CutoverStore):
    async def list_project_bindings_for_user(self, _user_id: str) -> list[dict[str, Any]]:
        return [
            {
                "conductor_id": "conductor-1",
                "config_version": 2,
                "candidate_installation_id": "installation-candidate",
                "candidate_config_version": 3,
                "candidate_acknowledged_config_version": 3,
            }
        ]


class PreparedCutoverState(CutoverState):
    def __init__(self) -> None:
        super().__init__()
        self.store = PreparedCutoverStore()
        self.candidate["state"] = "preparing"
        self.commands: list[tuple[str, dict[str, Any]]] = []

    async def enqueue_runtime_command(
        self,
        conductor_id: str,
        command: dict[str, Any],
    ) -> None:
        self.commands.append((conductor_id, command))


@pytest.mark.anyio
async def test_prepared_candidate_reconciles_projects_after_switch() -> None:
    state = PreparedCutoverState()

    result = await state.advance_linear_installation_cutover("user-1")

    assert result["cutover_state"] == "switched"
    assert state.reconciled == [("user-1", "installation-candidate")]
    assert state.review_required == ["user-1"]
