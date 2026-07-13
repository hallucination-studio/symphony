from __future__ import annotations

import json
from types import SimpleNamespace

import httpx
import pytest

import conductor.conductor_api as conductor_api
from conductor.conductor_api import (
    ConductorApiServer,
    _build_live_control_request,
    _live_control_failure,
)
from conductor.models import ConductorServiceError
from conductor.conductor_service import ConductorService
from conductor.models import ConductorSettings
from conductor.store import ConductorStore
from performer_api.performer_control import (
    PerformerAccountState,
    PerformerControlResult,
    PerformerLoginState,
    PerformerReadinessState,
)
from performer_api.runtime_policy import canonical_sha256


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


@pytest.mark.anyio
async def test_settings_api_derives_runtime_group_without_persisting_it(tmp_path) -> None:
    store = ConductorStore(tmp_path)
    initial = store.get_settings()
    service = ConductorService(store=store, data_root=tmp_path)
    service.update_settings(ConductorSettings(conductor_id="conductor-1"))

    status, payload = await ConductorApiServer(service)._route("GET", "/api/settings", b"")

    assert status == 200
    assert "runtime_group_id" not in initial.to_dict()
    assert initial.to_public_dict()["runtime_group_id"] == f"group_{initial.conductor_id}"
    assert payload["settings"]["runtime_group_id"] == "group_conductor-1"
    with store.connect() as connection:
        columns = {row["name"] for row in connection.execute("PRAGMA table_info(settings)")}
    assert "runtime_group_id" not in columns


@pytest.mark.anyio
@pytest.mark.parametrize("operation", ["performer.unknown"])
async def test_live_api_rejects_unknown_operations_without_service_dependency(
    operation: str,
    caplog: pytest.LogCaptureFixture,
) -> None:
    replies: list[dict[str, object]] = []

    class ServiceWithoutCredentials:
        store = SimpleNamespace(
            get_settings=lambda: SimpleNamespace(
                podium_url="https://podium.example",
                podium_runtime_token="runtime-token",
                conductor_id="conductor-1",
            )
        )

    async def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path.endswith("/runtime/live/lease"):
            return httpx.Response(
                200,
                json={
                    "request": {
                        "request_id": "request-1",
                        "lease_token": "lease-1",
                        "operation": operation,
                        "payload": {},
                        "deadline_unix_ms": 2_000_000_000_000,
                    }
                },
            )
        assert request.url.path.endswith("/runtime/live/reply")
        replies.append(json.loads(request.content))
        return httpx.Response(200, json={"status": "accepted"})

    result = await ConductorApiServer(ServiceWithoutCredentials())._poll_live_once(
        transport=httpx.MockTransport(handler)
    )

    assert result == {"status": "handled", "operation": operation}
    assert replies == [
        {
            "request_id": "request-1",
            "lease_token": "lease-1",
            "result": {
                "status": "failed",
                "error_code": "unsupported_live_operation",
                    "sanitized_reason": "The requested Performer operation is not supported.",
                "action_required": False,
                "retryable": False,
                "next_action": "Refresh Podium and retry with a supported Performer operation.",
            },
            "events": [],
        }
    ]
    assert "event=conductor_live_operation_rejected" in caplog.text
    assert "error_code=unsupported_live_operation" in caplog.text


def test_live_control_failure_does_not_reflect_untrusted_exception_text_as_error_code() -> None:
    result = _live_control_failure(
        "control-failure",
        "performer.status",
        RuntimeError("private_backend_identifier"),
    )

    assert result["error"]["error_code"] == "performer_control_protocol_invalid"
    assert "private_backend_identifier" not in str(result)


def test_live_control_failure_preserves_a_closed_service_error_code() -> None:
    result = _live_control_failure(
        "control-binding",
        "performer.status",
        ConductorServiceError(
            "performer_binding_required",
            "The active binding is missing.",
        ),
    )

    assert result["error"]["error_code"] == "performer_binding_required"


@pytest.mark.parametrize(
    "lease",
    [
        {
            "request_id": "request-1",
            "lease_token": "lease-1",
            "operation": "performer.status",
            "payload": [],
            "deadline_unix_ms": 2_000_000_000_000,
        },
        {
            "request_id": "request-1",
            "lease_token": "lease-1",
            "operation": "performer.status",
            "payload": {},
            "deadline_unix_ms": 2_000_000_000_000,
            "unexpected": "ignored",
        },
        {
            "request_id": "request-1",
            "lease_token": "lease-1",
            "operation": "performer.status",
            "payload": {},
            "deadline_unix_ms": "later",
        },
    ],
)
def test_live_control_lease_envelope_rejects_unknown_fields_and_invalid_types(lease) -> None:
    policy = {
        "version": 1,
        "model": "gpt-5.4",
        "model_provider": "openai",
        "approval_mode": "auto_review",
        "reasoning_effort": "high",
        "reasoning_summary": "auto",
        "sandbox": {"plan": "read_only", "execute": "workspace_write", "gate": "read_only"},
        "initialize_timeout_ms": 5_000,
        "turn_timeout_ms": 3_600_000,
        "initialize_max_attempts": 4,
        "overload_max_attempts": 5,
    }
    service = SimpleNamespace(
        store=SimpleNamespace(
            list_instances=lambda: [
                SimpleNamespace(
                    linear_filters={
                        "performer_kind": "codex",
                        "performer_binding_generation": 1,
                        "execution_policy": policy,
                    }
                )
            ]
        )
    )

    with pytest.raises(ValueError, match="performer_control_protocol_invalid"):
        _build_live_control_request(service, lease)


@pytest.mark.anyio
async def test_live_api_crosses_generic_control_boundary_without_returning_api_key() -> None:
    policy = {
        "version": 1,
        "model": "gpt-5.4",
        "model_provider": "openai",
        "approval_mode": "auto_review",
        "reasoning_effort": "high",
        "reasoning_summary": "auto",
        "sandbox": {"plan": "read_only", "execute": "workspace_write", "gate": "read_only"},
        "initialize_timeout_ms": 5_000,
        "turn_timeout_ms": 3_600_000,
        "initialize_max_attempts": 4,
        "overload_max_attempts": 5,
    }
    sentinel = "api-key-only-in-memory"
    replies: list[dict[str, object]] = []

    class FakeCoordinator:
        async def request(self, request, *, secret_input=None, timeout_seconds=None, event_collector=None):
            assert request.operation == "performer.login"
            assert secret_input == sentinel.encode()
            assert sentinel not in str(request.to_dict())
            return PerformerControlResult(
                protocol_version=1,
                request_id=request.request_id,
                operation=request.operation,
                status="succeeded",
                capabilities=None,
                readiness=PerformerReadinessState(
                    performer_kind="codex",
                    binding_generation=1,
                    capability_version=1,
                    execution_policy_sha256="0" * 64,
                    status="unchecked",
                    last_check_status="none",
                    error=None,
                ),
                account=PerformerAccountState(status="authenticated", display_label=None),
                login=PerformerLoginState(status="succeeded", method="api_key"),
                configuration=None,
                check=None,
                error=None,
            )

    class Service:
        performer_coordinator = FakeCoordinator()
        store = SimpleNamespace(
            get_settings=lambda: SimpleNamespace(
                podium_url="https://podium.example",
                podium_runtime_token="runtime-token",
                conductor_id="conductor-1",
            ),
            list_instances=lambda: [
                SimpleNamespace(
                    linear_filters={
                        "performer_kind": "codex",
                        "performer_binding_generation": 1,
                        "execution_policy": policy,
                        "execution_policy_sha256": canonical_sha256(policy),
                    }
                )
            ],
        )

        def apply_performer_control_result(self, _result):
            return {}

        async def ensure_performer_control_started(self) -> None:
            return None

    async def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path.endswith("/runtime/live/lease"):
            return httpx.Response(
                200,
                json={
                    "request": {
                        "request_id": "request-login",
                        "lease_token": "lease-login",
                        "operation": "performer.login",
                        "payload": {"method": "api_key", "api_key": sentinel},
                        "deadline_unix_ms": 2_000_000_000_000,
                    }
                },
            )
        replies.append(json.loads(request.content))
        return httpx.Response(200, json={"status": "accepted"})

    result = await ConductorApiServer(Service())._poll_live_once(
        transport=httpx.MockTransport(handler)
    )

    assert result == {"status": "handled", "operation": "performer.login"}
    assert sentinel not in json.dumps(replies)
    assert replies[0]["events"] == []


@pytest.mark.anyio
async def test_expired_live_lease_is_rejected_before_performer_side_effect() -> None:
    replies: list[dict[str, object]] = []

    class FakeCoordinator:
        async def request(self, *_args, **_kwargs):
            raise AssertionError("expired lease must not reach Performer")

    class Service:
        performer_coordinator = FakeCoordinator()
        store = SimpleNamespace(
            get_settings=lambda: SimpleNamespace(
                podium_url="https://podium.example",
                podium_runtime_token="runtime-token",
                conductor_id="conductor-1",
            ),
            list_instances=lambda: [
                SimpleNamespace(
                    linear_filters={
                        "performer_kind": "codex",
                        "performer_binding_generation": 1,
                        "execution_policy": {
                            "version": 1,
                            "model": "gpt-5.4",
                            "model_provider": "openai",
                            "approval_mode": "auto_review",
                            "reasoning_effort": "high",
                            "reasoning_summary": "auto",
                            "sandbox": {
                                "plan": "read_only",
                                "execute": "workspace_write",
                                "gate": "read_only",
                            },
                            "initialize_timeout_ms": 5_000,
                            "turn_timeout_ms": 3_600_000,
                            "initialize_max_attempts": 4,
                            "overload_max_attempts": 5,
                        },
                    }
                )
            ],
        )

        async def ensure_performer_control_started(self) -> None:
            raise AssertionError("expired lease must not start Performer")

        def apply_performer_control_result(self, _result):
            return {}

    async def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path.endswith("/runtime/live/lease"):
            return httpx.Response(
                200,
                json={
                    "request": {
                        "request_id": "request-expired",
                        "lease_token": "lease-expired",
                        "operation": "performer.session.delete",
                        "payload": {"action": "logout"},
                        "deadline_unix_ms": 1,
                    }
                },
            )
        replies.append(json.loads(request.content))
        return httpx.Response(200, json={"status": "accepted"})

    result = await ConductorApiServer(Service())._poll_live_once(
        transport=httpx.MockTransport(handler)
    )

    assert result == {"status": "handled", "operation": "performer.session.delete"}
    assert replies[0]["result"]["error"]["error_code"] == "performer_control_timeout"


@pytest.mark.anyio
async def test_live_lease_deadline_is_rechecked_after_lazy_control_start(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    replies: list[dict[str, object]] = []
    clock = iter((100.0, 102.0))
    monkeypatch.setattr(
        conductor_api,
        "time",
        SimpleNamespace(time=lambda: next(clock)),
    )

    class FakeCoordinator:
        async def request(self, *_args, **_kwargs):
            raise AssertionError("expired lease must not reach Performer")

    class Service:
        performer_coordinator = FakeCoordinator()
        store = SimpleNamespace(
            get_settings=lambda: SimpleNamespace(
                podium_url="https://podium.example",
                podium_runtime_token="runtime-token",
                conductor_id="conductor-1",
            ),
            list_instances=lambda: [
                SimpleNamespace(linear_filters={"performer_kind": "codex"})
            ],
        )

        async def ensure_performer_control_started(self) -> None:
            return None

        def apply_performer_control_result(self, _result):
            return {}

    async def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path.endswith("/runtime/live/lease"):
            return httpx.Response(
                200,
                json={
                    "request": {
                        "request_id": "request-start-expired",
                        "lease_token": "lease-start-expired",
                        "operation": "performer.status",
                        "payload": {},
                        "deadline_unix_ms": 101_000,
                    }
                },
            )
        replies.append(json.loads(request.content))
        return httpx.Response(200, json={"status": "accepted"})

    result = await ConductorApiServer(Service())._poll_live_once(
        transport=httpx.MockTransport(handler)
    )

    assert result == {"status": "handled", "operation": "performer.status"}
    assert replies[0]["result"]["error"]["error_code"] == "performer_control_timeout"
