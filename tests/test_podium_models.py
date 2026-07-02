from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest

from podium.models import (
    ConnectionState,
    LinearConnectionStatus,
    OnboardingProgress,
    OnboardingStep,
    RepositoryMapping,
    RepositoryMappingMode,
    RunStatus,
    RunSummary,
    RuntimeRecord,
    SessionIdentity,
    SmokeCheckResult,
    SmokeCheckStatus,
    ValidationState,
)


def test_session_identity_roundtrips_through_dict() -> None:
    identity = SessionIdentity(workspace_id="ws-1", user_id="u-1", app_user_id="app-1")
    restored = SessionIdentity.from_dict(identity.to_dict())
    assert restored == identity


def test_linear_connection_status_never_includes_tokens() -> None:
    installation = {
        "workspace_id": "ws-1",
        "access_token": "secret-access",
        "refresh_token": "secret-refresh",
        "scope": "read,write",
        "app_user_id": "app-1",
        "expires_at": None,
    }
    status = LinearConnectionStatus.from_installation(installation)
    payload = status.to_dict()
    assert "secret-access" not in str(payload)
    assert "secret-refresh" not in str(payload)
    assert "access_token" not in payload
    assert "refresh_token" not in payload
    assert payload["state"] == ConnectionState.CONNECTED.value
    assert payload["scope"] == "read,write"


def test_linear_connection_status_marks_expired_installation() -> None:
    past = (datetime.now(timezone.utc) - timedelta(hours=1)).isoformat().replace("+00:00", "Z")
    status = LinearConnectionStatus.from_installation(
        {"workspace_id": "ws-1", "expires_at": past}
    )
    assert status.state == ConnectionState.EXPIRED
    assert status.health == "expired"


def test_onboarding_progress_roundtrips_through_dict() -> None:
    progress = OnboardingProgress(
        current_step=OnboardingStep.SCOPE_SELECTION,
        completed_steps=[OnboardingStep.LINEAR_CONNECT],
        next_action="Pick your teams",
        metadata={"foo": "bar"},
    )
    restored = OnboardingProgress.from_dict(progress.to_dict())
    assert restored == progress


def test_repository_mapping_roundtrips_through_dict() -> None:
    mapping = RepositoryMapping(
        mode=RepositoryMappingMode.GIT_URL,
        value="https://github.com/acme/repo.git",
        validation_state=ValidationState.VALID,
    )
    restored = RepositoryMapping.from_dict(mapping.to_dict())
    assert restored == mapping


def test_runtime_record_roundtrips_through_dict() -> None:
    record = RuntimeRecord(
        runtime_id="rt-1",
        online=True,
        last_heartbeat="2026-01-01T00:00:00Z",
        version="1.2.3",
    )
    restored = RuntimeRecord.from_dict(record.to_dict())
    assert restored == record


def test_smoke_check_result_roundtrips_through_dict() -> None:
    result = SmokeCheckResult(
        status=SmokeCheckStatus.PASSED,
        checks=[{"name": "linear", "passed": True}],
        recommendations=["All good"],
        timestamp="2026-01-01T00:00:00Z",
    )
    restored = SmokeCheckResult.from_dict(result.to_dict())
    assert restored == result


def test_run_summary_roundtrips_through_dict() -> None:
    summary = RunSummary(
        run_id="run-1",
        issue_identifier="ENG-1",
        runtime_id="rt-1",
        status=RunStatus.SUCCESS,
        started_at="2026-01-01T00:00:00Z",
        completed_at="2026-01-01T00:01:00Z",
        duration_seconds=60.0,
    )
    restored = RunSummary.from_dict(summary.to_dict())
    assert restored == summary
