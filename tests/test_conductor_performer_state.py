from __future__ import annotations

import asyncio
import json
from types import SimpleNamespace

from conductor.conductor_service import ConductorService
from conductor.store import ConductorStore
from performer_api.performer_control import (
    PerformerAccountState,
    PerformerCapabilities,
    PerformerControlError,
    PerformerControlEvent,
    PerformerControlResult,
    PerformerLoginState,
    PerformerReadinessState,
)
from performer_api.runtime_policy import canonical_sha256


POLICY_HASH = "a" * 64

EXECUTION_POLICY = {
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


def _readiness(status: str) -> PerformerReadinessState:
    error = (
        PerformerControlError(
            error_code="performer_check_failed",
            sanitized_reason="The backend Check failed.",
            action_required=True,
            retryable=False,
            attempt_number=1,
            next_action="Correct backend configuration and run Check again.",
        )
        if status == "failed"
        else None
    )
    return PerformerReadinessState(
        performer_kind="codex",
        binding_generation=7,
        capability_version=1,
        execution_policy_sha256=POLICY_HASH,
        status=status,
        last_check_status=("passed" if status == "ready" else "failed"),
        error=error,
    )


def _bound_instance(tmp_path) -> SimpleNamespace:
    return SimpleNamespace(
        linear_filters={
            "performer_kind": "codex",
            "performer_binding_id": "performer-binding-1",
            "performer_binding_generation": 7,
            "execution_policy": EXECUTION_POLICY,
            "execution_policy_sha256": canonical_sha256(EXECUTION_POLICY),
            "turn_policy_sha256": "b" * 64,
        },
        workspace_root=str(tmp_path),
        log_path=str(tmp_path / "conductor.log"),
    )


def _capabilities(version: int) -> PerformerCapabilities:
    return PerformerCapabilities(
        protocol_version=1,
        capability_version=version,
        performer_kind="codex",
        display_name="Codex",
        turn_kinds=("plan", "execute", "gate"),
        login_methods=("device_code", "api_key"),
        supports_session_delete=True,
        editable_settings=("api_base_url",),
        config_source_visible=True,
        check_supported=True,
    )


def test_store_initializes_one_generic_unchecked_performer_state(tmp_path) -> None:
    store = ConductorStore(tmp_path)

    state = store.get_performer_control_state()

    assert state == {
        "performer_kind": "",
        "binding_generation": 0,
        "capability_version": 0,
        "execution_policy_sha256": "",
        "status": "unchecked",
        "last_check_status": "none",
        "last_check_started_at": None,
        "last_check_finished_at": None,
        "error_code": None,
        "sanitized_reason": None,
        "action_required": False,
        "retryable": False,
        "attempt_number": None,
        "next_action": None,
        "updated_at": state["updated_at"],
    }


def test_store_restart_resets_current_readiness_but_keeps_last_check_evidence(tmp_path) -> None:
    store = ConductorStore(tmp_path)
    store.record_performer_readiness(
        _readiness("ready"),
        check_started_at="2026-07-13T00:00:00Z",
        check_finished_at="2026-07-13T00:00:02Z",
    )

    restarted = ConductorStore(tmp_path)
    state = restarted.get_performer_control_state()

    assert state["status"] == "unchecked"
    assert state["last_check_status"] == "passed"
    assert state["last_check_started_at"] == "2026-07-13T00:00:00Z"
    assert state["last_check_finished_at"] == "2026-07-13T00:00:02Z"
    assert state["performer_kind"] == "codex"
    assert state["binding_generation"] == 7
    assert state["execution_policy_sha256"] == POLICY_HASH


def test_identity_change_invalidates_and_clears_incompatible_check_evidence(tmp_path) -> None:
    store = ConductorStore(tmp_path)
    store.record_performer_readiness(_readiness("ready"))

    state = store.ensure_performer_control_identity(
        performer_kind="codex",
        binding_generation=8,
        capability_version=1,
        execution_policy_sha256=POLICY_HASH,
    )

    assert state["status"] == "unchecked"
    assert state["binding_generation"] == 8
    assert state["last_check_status"] == "none"
    assert state["error_code"] is None


def test_failed_readiness_persists_standard_sanitized_error_fields(tmp_path) -> None:
    store = ConductorStore(tmp_path)

    state = store.record_performer_readiness(
        _readiness("failed"),
        check_started_at="2026-07-13T00:00:00Z",
        check_finished_at="2026-07-13T00:00:02Z",
    )

    assert state["status"] == "failed"
    assert state["last_check_status"] == "failed"
    assert state["error_code"] == "performer_check_failed"
    assert state["sanitized_reason"] == "The backend Check failed."
    assert state["action_required"] is True
    assert state["retryable"] is False
    assert state["attempt_number"] == 1
    assert state["next_action"] == "Correct backend configuration and run Check again."


def test_conductor_identity_initialization_includes_capability_version(tmp_path) -> None:
    store = ConductorStore(tmp_path)
    service = ConductorService(store=store, data_root=tmp_path)
    instance = SimpleNamespace(
        linear_filters={
            "performer_kind": "codex",
            "performer_binding_id": "performer-binding-1",
            "performer_binding_generation": 7,
            "execution_policy": EXECUTION_POLICY,
            "execution_policy_sha256": canonical_sha256(EXECUTION_POLICY),
            "turn_policy_sha256": "b" * 64,
        },
        workspace_root=str(tmp_path),
    )

    service._ensure_performer_identity(instance)

    state = store.get_performer_control_state()
    assert state["capability_version"] == 1
    assert state["binding_generation"] == 7


def test_control_host_starts_only_after_project_workspace_is_bound(
    tmp_path, monkeypatch
) -> None:
    store = ConductorStore(tmp_path)
    service = ConductorService(store=store, data_root=tmp_path)
    instance = _bound_instance(tmp_path)

    class FakeCoordinator:
        def __init__(self) -> None:
            self.cwd = None
            self.is_running = False
            self.start_calls = 0

        async def start(self) -> None:
            self.start_calls += 1
            self.is_running = True

    coordinator = FakeCoordinator()
    service.performer_coordinator = coordinator
    monkeypatch.setattr(store, "list_instances", lambda: [])

    asyncio.run(service.start())

    assert coordinator.start_calls == 0
    monkeypatch.setattr(store, "list_instances", lambda: [instance])

    asyncio.run(service.ensure_performer_control_started())

    assert coordinator.start_calls == 1
    assert coordinator.cwd == instance.workspace_root


def test_status_capability_change_invalidates_previous_check_evidence(tmp_path, monkeypatch) -> None:
    store = ConductorStore(tmp_path)
    service = ConductorService(store=store, data_root=tmp_path)
    instance = _bound_instance(tmp_path)
    monkeypatch.setattr(store, "list_instances", lambda: [instance])
    service._ensure_performer_identity(instance)
    policy_hash = canonical_sha256(EXECUTION_POLICY)
    store.record_performer_readiness(
        PerformerReadinessState(
            performer_kind="codex",
            binding_generation=7,
            capability_version=1,
            execution_policy_sha256=policy_hash,
            status="ready",
            last_check_status="passed",
            error=None,
        )
    )

    state = service.apply_performer_control_result(
        PerformerControlResult(
            protocol_version=1,
            request_id="status-capability-2",
            operation="performer.status",
            status="succeeded",
            capabilities=_capabilities(2),
            readiness=PerformerReadinessState(
                performer_kind="codex",
                binding_generation=7,
                capability_version=2,
                execution_policy_sha256=policy_hash,
                status="unchecked",
                last_check_status="none",
                error=None,
            ),
            account=PerformerAccountState(status="unknown", display_label=None),
            login=PerformerLoginState(status="idle", method=None),
            configuration=None,
            check=None,
            error=None,
        )
    )

    assert state["capability_version"] == 2
    assert state["status"] == "unchecked"
    assert state["last_check_status"] == "none"


def test_login_failed_event_immediately_persists_generic_failed_readiness(
    tmp_path, monkeypatch
) -> None:
    store = ConductorStore(tmp_path)
    service = ConductorService(store=store, data_root=tmp_path)
    instance = _bound_instance(tmp_path)
    monkeypatch.setattr(store, "list_instances", lambda: [instance])
    service._ensure_performer_identity(instance)
    policy_hash = canonical_sha256(EXECUTION_POLICY)
    store.record_performer_readiness(
        PerformerReadinessState(
            performer_kind="codex",
            binding_generation=7,
            capability_version=1,
            execution_policy_sha256=policy_hash,
            status="ready",
            last_check_status="passed",
            error=None,
        )
    )

    asyncio.run(
        service._on_performer_control_event(
            PerformerControlEvent(
                protocol_version=1,
                request_id="login-terminal",
                operation="performer.login",
                sequence=2,
                event_kind="login.failed",
                message="Provider-specific failure detail",
                verification_url=None,
                user_code=None,
                expires_at=None,
            )
        )
    )

    state = store.get_performer_control_state()
    assert state["status"] == "failed"
    assert state["last_check_status"] == "passed"
    assert state["error_code"] == "performer_login_failed"
    assert state["sanitized_reason"] == "Performer device login failed."
    assert state["action_required"] is True
    assert state["retryable"] is True
    assert state["next_action"] == "Retry device login."
    log = (tmp_path / "conductor.log").read_text(encoding="utf-8")
    assert "event=performer_login_failed" in log
    assert "Provider-specific" not in log


def test_login_event_log_never_persists_device_challenge_material(
    tmp_path, monkeypatch
) -> None:
    store = ConductorStore(tmp_path)
    service = ConductorService(store=store, data_root=tmp_path)
    instance = _bound_instance(tmp_path)
    monkeypatch.setattr(store, "list_instances", lambda: [instance])
    sentinel = "ABCD-EFGH"

    asyncio.run(
        service._on_performer_control_event(
            PerformerControlEvent(
                protocol_version=1,
                request_id="login-pending",
                operation="performer.login",
                sequence=1,
                event_kind="login.pending",
                message=f"Enter device code {sentinel}",
                verification_url="https://example.test/device",
                user_code=sentinel,
                expires_at=None,
            )
        )
    )

    log = (tmp_path / "conductor.log").read_text(encoding="utf-8")
    assert "event_kind=login.pending" in log
    assert "message=Performer_device_login_pending." in log
    assert sentinel not in log


def test_status_snapshot_persists_login_failure_without_reclassifying_check(
    tmp_path, monkeypatch
) -> None:
    store = ConductorStore(tmp_path)
    service = ConductorService(store=store, data_root=tmp_path)
    instance = _bound_instance(tmp_path)
    monkeypatch.setattr(store, "list_instances", lambda: [instance])
    service._ensure_performer_identity(instance)
    policy_hash = canonical_sha256(EXECUTION_POLICY)
    store.record_performer_readiness(
        PerformerReadinessState(
            performer_kind="codex",
            binding_generation=7,
            capability_version=1,
            execution_policy_sha256=policy_hash,
            status="unchecked",
            last_check_status="passed",
            error=None,
        )
    )
    login_error = PerformerControlError(
        error_code="performer_login_failed",
        sanitized_reason="Performer device login failed.",
        action_required=True,
        retryable=True,
        attempt_number=None,
        next_action="Retry device login.",
    )

    state = service.apply_performer_control_result(
        PerformerControlResult(
            protocol_version=1,
            request_id="status-after-login-failure",
            operation="performer.status",
            status="succeeded",
            capabilities=_capabilities(1),
            readiness=PerformerReadinessState(
                performer_kind="codex",
                binding_generation=7,
                capability_version=1,
                execution_policy_sha256=policy_hash,
                status="failed",
                last_check_status="passed",
                error=login_error,
            ),
            account=PerformerAccountState(status="unknown", display_label=None),
            login=PerformerLoginState(status="failed", method="device_code"),
            configuration=None,
            check=None,
            error=None,
        )
    )

    assert state["status"] == "failed"
    assert state["last_check_status"] == "passed"
    assert state["error_code"] == "performer_login_failed"
    assert state["sanitized_reason"] == "Performer device login failed."
    assert state["action_required"] is True
    assert state["retryable"] is True
    assert state["next_action"] == "Retry device login."


def test_check_start_persists_nonready_state_before_the_backend_runs(tmp_path, monkeypatch) -> None:
    store = ConductorStore(tmp_path)
    service = ConductorService(store=store, data_root=tmp_path)
    instance = _bound_instance(tmp_path)
    monkeypatch.setattr(store, "list_instances", lambda: [instance])
    service._ensure_performer_identity(instance)
    policy_hash = canonical_sha256(EXECUTION_POLICY)
    store.record_performer_readiness(
        PerformerReadinessState(
            performer_kind="codex",
            binding_generation=7,
            capability_version=1,
            execution_policy_sha256=policy_hash,
            status="ready",
            last_check_status="passed",
            error=None,
        ),
        check_started_at="2026-07-13T00:00:00Z",
        check_finished_at="2026-07-13T00:00:02Z",
    )

    asyncio.run(service._on_performer_check_started(SimpleNamespace()))

    state = store.get_performer_control_state()
    assert state["status"] == "checking"
    assert state["last_check_status"] == "passed"
    assert state["last_check_started_at"] is not None
    assert state["last_check_finished_at"] == "2026-07-13T00:00:02Z"


def test_unstructured_performer_stderr_is_not_persisted_verbatim(tmp_path, monkeypatch) -> None:
    store = ConductorStore(tmp_path)
    service = ConductorService(store=store, data_root=tmp_path)
    instance = _bound_instance(tmp_path)
    monkeypatch.setattr(store, "list_instances", lambda: [instance])

    asyncio.run(
        service._on_performer_control_stderr(
            "sdk diagnostic X-Api-Key: sentinel-secret-value"
        )
    )

    log = (tmp_path / "conductor.log").read_text(encoding="utf-8")
    assert "sentinel-secret-value" not in log
    assert "sdk diagnostic" not in log
    assert "event=performer_control_stderr_invalid" in log


def test_closed_performer_stderr_log_retains_only_validated_fields(tmp_path, monkeypatch) -> None:
    store = ConductorStore(tmp_path)
    service = ConductorService(store=store, data_root=tmp_path)
    instance = _bound_instance(tmp_path)
    monkeypatch.setattr(store, "list_instances", lambda: [instance])
    record = {
        "event": "performer_control_operation_failed",
        "error_type": "PerformerControlError",
        "error_code": "performer_control_failed",
        "sanitized_reason": "The Performer control operation failed.",
        "action_required": True,
        "retryable": False,
        "next_action": "Correct the backend setup and retry the control operation.",
        "request_id": "request-1",
        "operation": "performer.login",
    }

    asyncio.run(service._on_performer_control_stderr(json.dumps(record)))

    log = (tmp_path / "conductor.log").read_text(encoding="utf-8")
    assert "event=performer_control_host_log" in log
    assert "request_id=request-1 operation=performer.login" in log
    assert "error_type=" not in log
