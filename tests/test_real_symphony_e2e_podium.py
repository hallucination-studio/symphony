from __future__ import annotations

import asyncio
import json
import socket
import stat
import urllib.parse
from pathlib import Path

import httpx
import pytest

from podium.app import create_app
from podium.store import PodiumStore
from test_real_run_tools_support import load_tool


async def test_oauth_bootstrap_uses_real_session_callback_and_active_installation(tmp_path) -> None:
    tool = load_tool("real_symphony_e2e_podium")
    app = create_app(
        debug_auth=True,
        secure_cookies=False,
        secret_key="test-secret",
        store=PodiumStore(data_dir=tmp_path / "store"),
        linear_client_id="default-client",
        linear_client_secret="default-secret",
        linear_redirect_uri="http://podium.test/api/v1/linear/oauth/callback",
        podium_base_url="http://podium.test",
        linear_token_exchange=lambda code, _application: {
            "access_token": f"access-{code}",
            "refresh_token": f"refresh-{code}",
            "expires_in": 3600,
            "scope": "read write app:assignable",
            "actor": "app",
        },
        linear_installation_fetch=lambda _token: {
            "viewer": {"id": "app-user-1", "name": "Symphony", "app": True},
            "organization": {"id": "org-1", "name": "Acme", "urlKey": "acme"},
            "projects": [{"id": "project-1", "name": "Hell", "slugId": "HELL"}],
        },
    )
    transport = httpx.ASGITransport(app=app)
    session = tool.PodiumSession("http://podium.test", transport=transport)
    evidence = tool.Evidence(tmp_path / "evidence.json")
    task = asyncio.create_task(
        tool.authorize_default_application(
            session,
            root=tmp_path,
            evidence=evidence,
            timeout_seconds=2,
        )
    )
    pending = tmp_path / ".linear-authorization-url"
    for _ in range(50):
        if pending.is_file():
            break
        await asyncio.sleep(0.01)
    authorization_url = pending.read_text(encoding="utf-8")
    params = dict(urllib.parse.parse_qsl(urllib.parse.urlsplit(authorization_url).query))
    async with httpx.AsyncClient(transport=transport, base_url="http://podium.test") as callback_client:
        callback = await callback_client.get(
            "/api/v1/linear/oauth/callback",
            params={"code": "accepted", "state": params["state"]},
        )
    user, installation = await task
    await session.close()

    assert callback.status_code == 303
    assert user["id"] == "debug"
    assert installation["state"] == "ready"
    assert installation["app_user_id"] == "app-user-1"
    assert installation["scope"] == ["app:assignable", "read", "write"]
    assert not pending.exists()
    evidence_text = json.dumps(evidence.data)
    assert "access-accepted" not in evidence_text
    assert "refresh-accepted" not in evidence_text


async def test_oauth_bootstrap_rejects_non_default_application(tmp_path) -> None:
    tool = load_tool("real_symphony_e2e_podium")

    class Session:
        async def authenticate(self) -> dict[str, str]:
            return {"id": "debug"}

        async def request(self, method: str, path: str) -> dict[str, object]:
            assert (method, path) == ("GET", "/api/v1/linear/application")
            return {"application": {"source": "custom", "version": 1}}

    with pytest.raises(tool.E2EConfigurationError) as error:
        await tool.authorize_default_application(
            Session(),
            root=tmp_path,
            evidence=tool.Evidence(tmp_path / "evidence.json"),
            timeout_seconds=1,
        )

    assert error.value.error_code == "linear_default_application_not_selected"
    assert not (tmp_path / ".linear-authorization-url").exists()


async def test_oauth_bootstrap_waits_for_this_authorization_not_an_old_active_installation(tmp_path) -> None:
    tool = load_tool("real_symphony_e2e_podium")
    old = _accepted_installation(updated_at="2026-07-10T00:00:00Z", expires_at="2026-07-11T00:00:00Z")
    rotated = _accepted_installation(updated_at="2026-07-10T00:01:00Z", expires_at="2026-07-11T00:01:00Z")

    class Session:
        installation_reads = 0

        async def authenticate(self) -> dict[str, str]:
            return {"id": "debug"}

        async def request(self, method: str, path: str) -> dict[str, object]:
            if path == "/api/v1/linear/application":
                return {"application": {"source": "default", "version": 1}}
            if path == "/api/v1/linear/installations/oauth":
                return {"authorization_url": "https://linear.app/oauth/authorize?state=new"}
            assert (method, path) == ("GET", "/api/v1/linear/installations")
            self.installation_reads += 1
            active = old if self.installation_reads <= 2 else rotated
            return {"active": active, "candidate": None}

    session = Session()
    _user, installation = await tool.authorize_default_application(
        session,
        root=tmp_path,
        evidence=tool.Evidence(tmp_path / "evidence.json"),
        timeout_seconds=2,
    )

    assert session.installation_reads == 3
    assert installation["updated_at"] == rotated["updated_at"]


def test_oauth_bootstrap_rejects_incomplete_installation_identity() -> None:
    tool = load_tool("real_symphony_e2e_podium")

    with pytest.raises(tool.E2EConfigurationError) as error:
        tool.validate_active_installation(
            {
                "id": "installation-1",
                "state": "ready",
                "actor": "app",
                "scope": ["read", "write"],
                "linear_organization_id": "org-1",
                "app_user_id": "app-user-1",
                "application_source": "default",
                "project_count": 1,
            }
        )

    assert error.value.error_code == "linear_installation_acceptance_incomplete"


async def test_project_selection_fails_closed_when_podium_does_not_confirm_it(tmp_path) -> None:
    tool = load_tool("real_symphony_e2e_podium")

    class Session:
        async def request(
            self,
            method: str,
            path: str,
            payload: dict[str, object] | None = None,
        ) -> dict[str, object]:
            if method == "GET":
                return {
                    "projects": [
                        {"id": "project-1", "name": "Hell", "slug_id": "HELL", "selected": False}
                    ]
                }
            assert payload == {"project_ids": ["project-1"]}
            return {
                "projects": [
                    {"id": "project-1", "name": "Hell", "slug_id": "HELL", "selected": False}
                ]
            }

    with pytest.raises(tool.E2EConfigurationError) as error:
        await tool.select_linear_project(
            Session(),
            "HELL",
            tool.Evidence(tmp_path / "evidence.json"),
        )

    assert error.value.error_code == "linear_project_selection_unconfirmed"


def test_fixed_oauth_callback_port_must_be_available() -> None:
    tool = load_tool("real_symphony_e2e_podium")
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as occupied:
        occupied.bind(("127.0.0.1", 0))
        port = occupied.getsockname()[1]

        with pytest.raises(tool.E2EConfigurationError) as error:
            tool.require_local_port_available(port)

    assert error.value.error_code == "podium_callback_port_unavailable"


def test_authorization_url_file_is_private_even_when_replacing_an_existing_file(tmp_path) -> None:
    tool = load_tool("real_symphony_e2e_podium")
    path = tmp_path / ".linear-authorization-url"
    path.write_text("stale", encoding="utf-8")
    path.chmod(0o644)

    tool._write_private(path, "https://linear.app/oauth/authorize?state=private")

    assert stat.S_IMODE(path.stat().st_mode) == 0o600


async def test_denied_oauth_is_durable_and_preserves_active_installation(tmp_path) -> None:
    tool = load_tool("real_symphony_e2e_podium")
    denial_tool = load_tool("real_symphony_e2e_podium_denial")
    app = create_app(
        debug_auth=True,
        secure_cookies=False,
        secret_key="test-secret",
        store=PodiumStore(data_dir=tmp_path / "store"),
        linear_client_id="default-client",
        linear_client_secret="default-secret",
        linear_redirect_uri="http://podium.test/api/v1/linear/oauth/callback",
        podium_base_url="http://podium.test",
        linear_token_exchange=lambda _code, _application: {
            "access_token": "active-access",
            "refresh_token": "active-refresh",
            "expires_in": 3600,
            "scope": "read write app:assignable",
            "actor": "app",
        },
        linear_installation_fetch=lambda _token: {
            "viewer": {"id": "app-user-1", "name": "Symphony", "app": True},
            "organization": {"id": "org-1", "name": "Acme", "urlKey": "acme"},
            "projects": [{"id": "project-1", "name": "Hell", "slugId": "HELL"}],
        },
    )
    transport = httpx.ASGITransport(app=app)
    session = tool.PodiumSession("http://podium.test", transport=transport)
    evidence = tool.Evidence(tmp_path / "evidence.json")
    accepted_task = asyncio.create_task(
        tool.authorize_default_application(
            session,
            root=tmp_path,
            evidence=evidence,
            timeout_seconds=2,
        )
    )
    accepted_url = await _wait_for_url(tmp_path / ".linear-authorization-url")
    accepted_params = dict(urllib.parse.parse_qsl(urllib.parse.urlsplit(accepted_url).query))
    async with httpx.AsyncClient(transport=transport, base_url="http://podium.test") as callback_client:
        await callback_client.get(
            "/api/v1/linear/oauth/callback",
            params={"code": "accepted", "state": accepted_params["state"]},
        )
        _user, active = await accepted_task
        denied_task = asyncio.create_task(
            denial_tool.verify_denied_authorization(
                session,
                active_installation_id=active["id"],
                root=tmp_path,
                evidence=evidence,
                timeout_seconds=2,
            )
        )
        denied_url = await _wait_for_url(tmp_path / ".linear-denial-authorization-url")
        denied_params = dict(urllib.parse.parse_qsl(urllib.parse.urlsplit(denied_url).query))
        callback = await callback_client.get(
            "/api/v1/linear/oauth/callback",
            params={"error": "access_denied", "state": denied_params["state"]},
        )
        denied = await denied_task
    installations = await session.request("GET", "/api/v1/linear/installations")
    await session.close()

    assert callback.status_code == 303
    assert denied["error_code"] == "linear_oauth_denied"
    assert installations["active"]["id"] == active["id"]
    assert not (tmp_path / ".linear-denial-authorization-url").exists()


async def test_podium_api_snapshots_are_session_backed_and_redacted(tmp_path) -> None:
    tool = load_tool("real_symphony_e2e_podium_evidence")

    class Session:
        async def request(self, _method: str, path: str) -> dict[str, object]:
            return {"path": path, "access_token": "must-not-leak", "nested": {"client_secret": "hidden"}}

    evidence = tool.Evidence(tmp_path / "evidence.json")
    snapshots = await tool.archive_podium_api_snapshots(
        Session(),
        root=tmp_path,
        evidence=evidence,
        prefix="bootstrap",
    )

    assert set(snapshots) == {"managed_runs", "linear_installations", "linear_projects", "runtimes"}
    for artifact_path in evidence.data["artifacts"].values():
        text = (tmp_path / str(artifact_path).split("/")[-1]).read_text(encoding="utf-8")
        assert "must-not-leak" not in text
        assert "hidden" not in text


async def test_linear_fixture_preflight_fails_immediately_with_sanitized_auth_classification(tmp_path) -> None:
    tool = load_tool("real_symphony_e2e_linear_fixture")

    async def rejected(_token: str, _project: str) -> dict[str, object]:
        raise tool.E2EFailure(
            failure_class="credential_or_config_failure",
            error_code="linear_authentication_failed",
            sanitized_reason="Linear authentication failed",
            retryable=False,
            next_action="refresh_linear_app_access_token",
        )

    evidence = tool.Evidence(tmp_path / "evidence.json")
    accessible = await tool.verify_linear_fixture_access(
        "secret-fixture-token",
        "HELL",
        evidence,
        resolver=rejected,
    )

    assert accessible is False
    assert evidence.data["failures"][-1]["error_code"] == "linear_authentication_failed"
    assert evidence.data["failures"][-1]["next_action"] == "refresh_linear_fixture_token"
    assert "secret-fixture-token" not in evidence.out.read_text(encoding="utf-8")


async def test_early_podium_snapshots_archive_unavailable_endpoints_without_masking_primary_failure(tmp_path) -> None:
    tool = load_tool("real_symphony_e2e_podium_evidence")

    class Session:
        async def request(self, _method: str, path: str) -> dict[str, object]:
            if path == "/api/v1/linear/projects":
                raise tool.E2EConfigurationError(
                    failure_class="environment_failure",
                    error_code="linear_installation_required",
                    sanitized_reason="An active Linear installation is required",
                    retryable=False,
                    next_action="authorize_linear",
                )
            return {"path": path}

    evidence = tool.Evidence(tmp_path / "evidence.json")
    snapshots = await tool.archive_podium_api_snapshots(
        Session(),
        root=tmp_path,
        evidence=evidence,
        prefix="early-exit",
        tolerate_endpoint_errors=True,
    )

    assert snapshots["linear_projects"]["error"]["code"] == "linear_installation_required"
    assert set(evidence.data["artifacts"]) == {
        "early-exit_podium_managed_runs",
        "early-exit_podium_linear_installations",
        "early-exit_podium_linear_projects",
        "early-exit_podium_runtimes",
    }


def test_enrollment_result_must_match_reserved_conductor() -> None:
    tool = load_tool("real_symphony_e2e_podium_runtime")

    with pytest.raises(tool.E2EConfigurationError) as error:
        tool.validate_enrollment_result(
            {"conductor": {"id": "conductor-1"}},
            {
                "runtime_id": "conductor-2",
                "runtime_group_id": "group-2",
                "runtime_token": "runtime-token",
                "proxy_token": "proxy-token",
            },
        )

    assert error.value.error_code == "conductor_enrollment_identity_mismatch"


def test_enrolled_conductor_must_be_online_and_unbound_before_assignment() -> None:
    tool = load_tool("real_symphony_e2e_podium_runtime")

    tool.validate_unbound_conductor(
        {"id": "conductor-1", "online": True, "binding": None, "bindings": []},
        "conductor-1",
    )
    with pytest.raises(tool.E2EConfigurationError) as error:
        tool.validate_unbound_conductor(
            {"id": "conductor-1", "online": True, "binding": {"id": "binding-1"}},
            "conductor-1",
        )

    assert error.value.error_code == "conductor_not_initially_unbound"


async def test_ready_conductor_rejects_a_second_project_binding(tmp_path) -> None:
    tool = load_tool("real_symphony_e2e_podium_runtime")

    class Session:
        async def request(
            self,
            method: str,
            path: str,
            payload: dict[str, object],
        ) -> dict[str, object]:
            assert method == "PUT"
            assert path == "/api/v1/conductors/conductor-1/binding"
            assert payload["linear_project_id"] == "project-1-second-project-probe"
            raise tool.E2EConfigurationError(
                failure_class="environment_failure",
                error_code="conductor_already_bound",
                sanitized_reason="Conductor already has a project binding",
                retryable=False,
                next_action="inspect_podium_log",
            )

    evidence = tool.Evidence(tmp_path / "evidence.json")
    await tool.verify_second_binding_rejected(
        Session(),
        conductor_id="conductor-1",
        project_id="project-1",
        repository=tmp_path,
        evidence=evidence,
    )

    assert evidence.data["checks"][-1]["name"] == "conductor-binding:second-project-rejected"
    assert evidence.data["checks"][-1]["passed"] is True


def test_podium_bootstrap_snapshots_must_agree_on_installation_project_and_conductor() -> None:
    tool = load_tool("real_symphony_e2e_podium_evidence")
    snapshots = _podium_snapshots()

    tool.validate_podium_bootstrap_snapshots(
        snapshots,
        installation_id="installation-1",
        project_id="project-1",
        conductor_id="conductor-1",
    )
    snapshots["runtimes"]["conductors"][0]["online"] = False

    with pytest.raises(tool.E2EConfigurationError) as error:
        tool.validate_podium_bootstrap_snapshots(
            snapshots,
            installation_id="installation-1",
            project_id="project-1",
            conductor_id="conductor-1",
        )

    assert error.value.error_code == "podium_bootstrap_evidence_incomplete"


def test_podium_final_snapshot_must_contain_the_real_managed_run() -> None:
    tool = load_tool("real_symphony_e2e_podium_evidence")
    snapshots = _podium_snapshots()

    with pytest.raises(tool.E2EConfigurationError) as error:
        tool.validate_podium_final_managed_run(
            snapshots,
            issue_id="issue-2",
            issue_identifier="HELL-2",
        )

    assert error.value.error_code == "podium_managed_run_evidence_missing"

    tool.validate_podium_final_managed_run(
        snapshots,
        issue_id="issue-1",
        issue_identifier="HELL-1",
    )


def test_real_runner_archives_and_validates_podium_views_at_bootstrap_and_final() -> None:
    setup = (Path(__file__).parents[1] / "tools" / "real_symphony_e2e_run_setup.py").read_text(encoding="utf-8")
    archive = (Path(__file__).parents[1] / "tools" / "real_symphony_e2e_run_archive.py").read_text(encoding="utf-8")
    early = (Path(__file__).parents[1] / "tools" / "real_symphony_e2e_early_exit.py").read_text(encoding="utf-8")

    assert "verify_denied_authorization" in setup
    assert "validate_enrollment_result" in setup
    assert "archive_and_validate_podium_bootstrap" in setup
    assert "validate_podium_final_managed_run" in archive
    assert "archive_podium_api_snapshots" in archive
    assert "archive_podium_api_snapshots" in early


def test_real_runner_does_not_create_unbound_local_instances_directly() -> None:
    source = "\n".join(
        path.read_text(encoding="utf-8")
        for path in (Path(__file__).parents[1] / "tools").glob("real_symphony_e2e_run*.py")
    )

    assert 'api_url(state.conductor_port, "/api/instances")' not in source
    assert "verify_second_binding_rejected" in source


def _podium_snapshots() -> dict[str, dict[str, object]]:
    binding = {
        "id": "binding-1",
        "state": "ready",
        "linear_project_id": "project-1",
        "instance_id": "instance-1",
    }
    return {
        "linear_installations": {"active": {"id": "installation-1", "state": "ready"}},
        "linear_projects": {
            "projects": [
                {"id": "project-1", "slug_id": "HELL", "selected": True, "access_state": "ready"}
            ]
        },
        "runtimes": {
            "conductors": [
                {"id": "conductor-1", "online": True, "binding": dict(binding), "bindings": [dict(binding)]}
            ]
        },
        "managed_runs": {
            "conductors": [
                {
                    "conductor": {"id": "conductor-1", "online": True},
                    "project": {"id": "project-1"},
                    "binding": {"id": "binding-1", "state": "ready", "instance_id": "instance-1"},
                    "managed_runs": {
                        "runs": [
                            {
                                "run_id": "run-1",
                                "parent_issue_id": "issue-1",
                                "issue_identifier": "HELL-1",
                            }
                        ]
                    },
                }
            ]
        },
    }


def _accepted_installation(*, updated_at: str, expires_at: str) -> dict[str, object]:
    return {
        "id": "installation-1",
        "state": "ready",
        "actor": "app",
        "scope": ["app:assignable", "read", "write"],
        "linear_organization_id": "org-1",
        "organization_name": "Acme",
        "app_user_id": "app-user-1",
        "application_source": "default",
        "project_count": 1,
        "expires_at": expires_at,
        "updated_at": updated_at,
    }


async def _wait_for_url(path) -> str:
    for _ in range(100):
        if path.is_file():
            return path.read_text(encoding="utf-8")
        await asyncio.sleep(0.01)
    raise AssertionError(f"authorization URL was not written: {path}")
