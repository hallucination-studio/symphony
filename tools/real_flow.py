"""Run the single supported real Symphony flow.

The runner is deliberately the only real-flow entrypoint.  ``--phase all``
creates one run identity, executes OAuth, Linear, and Performer observations,
then evaluates the Overall gate.  A failed phase is recorded and does not
prevent later phases from collecting their own evidence.
"""

from __future__ import annotations

import argparse
from contextlib import contextmanager
from dataclasses import dataclass, field
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import re
import select
import shutil
import struct
import subprocess
import sys
import tempfile
import time
from typing import Any, Iterable
from urllib.parse import urlparse
from uuid import uuid4

import httpx
from performer_api import (
    CONTROL_PROTOCOL_VERSION,
    PerformerControlEvent,
    PerformerControlRequest,
    PerformerControlResult,
    PerformerTurnRequest,
    PerformerTurnResult,
    RuntimePolicy,
    Task,
    TURN_PROTOCOL_VERSION,
    TurnContext,
    canonical_sha256,
)

try:  # package import for pytest; top-level fallback for ``python tools/real_flow.py``
    from .linear_fixture import LinearFixture, LinearFixtureError, required_environment
except ImportError:  # pragma: no cover - exercised by the documented script entrypoint
    from linear_fixture import LinearFixture, LinearFixtureError, required_environment


_DIAGNOSTIC_PHASES = ("oauth", "linear", "performer")
_SENSITIVE_KEY = re.compile(
    r"(?i)(?:access[-_]?token|refresh[-_]?token|api[-_]?key|client[-_]?secret|"
    r"authorization|token|password|cookie|secret|credential|auth(?:entication)?)"
)
_BEARER = re.compile(r"(?i)\b(bearer|basic)\s+[^\s,;]+")
_NAMED_SECRET = re.compile(
    r"(?i)\b(access[-_]?token|refresh[-_]?token|api[-_]?key|token|password|cookie|secret|credential)"
    r"\s*[:=]\s*(?!\[REDACTED\])[^\s,;}]+"
)
_SECRET_LITERAL = re.compile(
    r"(?i)\b(?:sk-[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|"
    r"github_pat_[A-Za-z0-9_]{20,}|lin_(?:oauth|api)_[A-Za-z0-9_-]{12,})\b"
)
_GENERIC_SECRET_LITERAL = re.compile(r"(?i)(?:raw[-_ ]?secret|private[-_ ]?key|password\s*[:=]|secret\s*[:=])")
_AUTH_PATH = re.compile(r"(?i)(?:^|[/\\])auth\.json(?:$|[/\\])")
_CODEX_HOME_PATH = re.compile(r"(?i)(?:^|[/\\])\.codex(?:$|[/\\])")
_BROWSER_OBSERVATION_MAX_BYTES = 4 * 1024 * 1024
_CONTROL_METADATA_MAX_BYTES = 256 * 1024
_PERFORMER_SEED_FILES = ("config.toml", "auth.json", "version.json", "models_cache.json")
_PERFORMER_ENV_KEYS = ("HOME", "PATH", "LANG", "LC_ALL", "TMPDIR", "CODEX_SDK_CODEX_BIN")
_REAL_EXECUTION_POLICY = {
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
_REAL_TURN_POLICY_SHA256 = canonical_sha256({"version": 1, "mode": "real_e2e"})

# Browser evidence is deliberately a closed public projection.  This is the
# union of fields emitted by the Podium public auth/project/runtime views; an
# unknown field is rejected before it can become an accidental credential
# transport.  Nested objects use the same public vocabulary.
_BROWSER_PUBLIC_KEYS = frozenset(
    {
        "access_state", "account_hint", "acknowledged_config_version", "action_required", "active",
        "active_runs_total", "active_work_item_id", "actor", "agent_app_user_id", "app_user_id",
        "application_config_id", "application_config_version", "application_source", "auth_method",
        "backend_session_id", "binding", "binding_config_version", "binding_id", "bindings", "blocked",
        "candidate", "candidate_acknowledged_config_version", "candidate_agent_app_user_id",
        "candidate_config_version", "candidate_installation_id", "captured_at", "conductor", "conductors", "conductor_id",
        "config_format", "config_sha256", "config_version", "constraint_labels", "continuations",
        "created_at", "credential", "credential_id", "data_root", "email", "enrollment_state",
        "error_code", "expires_at", "failures", "generation", "hostname", "id", "installation_id",
        "instance_id", "issue_identifier", "label_id", "label_name", "last_heartbeat", "last_reconciliation_at",
        "last_report_at", "latest_reason", "linear_organization_id", "linear_project", "linear_project_id",
        "managed_run_profile", "managed_runs", "metadata", "metrics", "mode", "name", "next_action",
        "observations", "online", "organization_name", "organization_url_key", "parent_issue_id", "payload",
        "pending_human", "performer", "performer_binding_id", "performer_kind", "performer_profile_id",
        "plan_version", "policy_revision", "policy_sha256", "process_status", "profiles", "project",
        "project_count", "project_name", "project_slug", "projects", "public_id", "queue", "queue_depth",
        "reconciliation_error", "reconciliation_error_code", "reconciliation_next_retry_at",
        "reconciliation_retry_count", "reconciliation_state", "replacement_binding_id", "replacement_conductor_id",
        "replacement_repo_source", "replacement_state", "repository", "retryable", "revocation", "runtimes",
        "run_id", "running", "runs", "runtime", "runtime_group_id", "runtime_id", "runtime_kind",
        "runtime_profile_id", "sanitized_reason", "scope", "selected", "service_identity", "slug", "slug_id",
        "state", "status", "status_code", "tokens", "updated_at", "user", "user_id", "value", "version",
        "retries", "runtime_seconds",
        "work_items", "url", "type", "title", "description", "parent", "children", "task_id", "task",
        "gate", "rework_count", "gate_status", "state_type", "linear_state", "linear_identifier", "linear_issue_id",
        "error", "reason", "source", "workspace", "repository", "config", "profiles", "runtime_waits",
        "files_likely_touched", "passed", "commands", "command", "command_passed", "command_total", "exit_code",
        "output", "total", "score", "threshold", "manifest_count", "rubric", "provenance", "attempt_id",
        "catalog", "weight", "artifact_refs", "findings", "summary", "objective", "acceptance_criteria",
        "verification_commands", "result", "turn_id", "turn_kind", "fencing_token", "lease_id",
    }
)


@dataclass
class _RunContext:
    run_id: str
    artifact_root: Path
    output_path: Path
    project_slug: str
    timeout: float
    offline: bool
    settings: dict[str, str]
    phase_reports: list[dict[str, Any]] = field(default_factory=list)


@dataclass(frozen=True)
class _HttpObservation:
    status_code: int
    payload: dict[str, Any]
    error_code: str = ""


def _normalize_key(value: str) -> str:
    return re.sub(r"(?<!^)(?=[A-Z])", "_", value).lower().replace("-", "_")


def _browser_payload_has_secret(value: Any, *, key: str = "", parent_key: str = "") -> bool:
    """Reject credential-bearing browser evidence without rejecting public auth metadata."""

    normalized = _normalize_key(key)
    forbidden = {
        "access_token",
        "refresh_token",
        "api_key",
        "client_secret",
        "authorization",
        "cookie",
        "password",
        "secret",
        "credential",
        "auth",
        "authentication",
    }
    if normalized not in _BROWSER_PUBLIC_KEYS and (normalized == "token" or normalized.endswith(("_token", "_key", "_secret", "_password", "_cookie", "_authorization"))):
        if not normalized.endswith(("_present", "_length", "_count", "_status")):
            forbidden.add(normalized)
    if normalized in {"credential", "auth", "authentication"}:
        if isinstance(value, dict) and any(
            _normalize_key(str(name)) in {"value", "raw", "secret", "token", "access_token", "refresh_token"}
            for name in value
        ):
            return True
    elif normalized in forbidden or normalized.endswith(("_access_token", "_refresh_token", "_api_key", "_client_secret")):
        return True
    if normalized == "tokens" and isinstance(value, str):
        return True
    if normalized == "value" and _normalize_key(parent_key) in {"credential", "auth", "authentication", "metadata", "token", "tokens"}:
        return True
    if isinstance(value, dict):
        return any(_browser_payload_has_secret(item, key=str(name), parent_key=normalized) for name, item in value.items())
    if isinstance(value, (list, tuple)):
        return any(_browser_payload_has_secret(item) for item in value)
    if isinstance(value, str):
        return bool(_BEARER.search(value) or _SECRET_LITERAL.search(value) or _GENERIC_SECRET_LITERAL.search(value) or _AUTH_PATH.search(value))
    return False


def _browser_payload_fields_valid(value: Any) -> bool:
    if isinstance(value, dict):
        for name, item in value.items():
            normalized = _normalize_key(str(name))
            if normalized not in _BROWSER_PUBLIC_KEYS:
                return False
            if not _browser_payload_fields_valid(item):
                return False
        return True
    if isinstance(value, (list, tuple)):
        return all(_browser_payload_fields_valid(item) for item in value)
    return True


def _browser_payload_has_forbidden_key(value: Any) -> bool:
    if isinstance(value, dict):
        for name, item in value.items():
            normalized = _normalize_key(str(name))
            if normalized in {"access_token", "refresh_token", "api_key", "client_secret", "authorization", "cookie", "password", "secret"}:
                return True
            if normalized in {"credential", "auth", "authentication"} and isinstance(item, dict):
                if any(_normalize_key(str(child)) in {"value", "raw", "secret", "token", "access_token", "refresh_token"} for child in item):
                    return True
            if _browser_payload_has_forbidden_key(item):
                return True
    elif isinstance(value, (list, tuple)):
        return any(_browser_payload_has_forbidden_key(item) for item in value)
    return False


class _BrowserObservation:
    """Read sanitized same-origin responses produced by the browser skill."""

    def __init__(self, path: str | Path, *, expected_base_url: str) -> None:
        self._observations: dict[str, _HttpObservation] = {}
        self.error_code = ""
        if not str(path).strip():
            self.error_code = "browser_session_observation_missing"
            return
        try:
            observation_path = Path(path).expanduser().resolve(strict=False)
            if observation_path.stat().st_size > _BROWSER_OBSERVATION_MAX_BYTES:
                self.error_code = "browser_session_observation_too_large"
                return
        except OSError:
            self.error_code = "browser_session_observation_path_forbidden"
            return
        if observation_path.name.lower() == "auth.json" or ".codex" in {part.lower() for part in observation_path.parts}:
            self.error_code = "browser_session_observation_path_forbidden"
            return
        try:
            raw = json.loads(observation_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            self.error_code = f"browser_session_observation_invalid:{type(exc).__name__}"
            return
        if not isinstance(raw, dict) or set(raw) - {"base_url", "captured_at", "observations"}:
            self.error_code = "browser_session_observation_invalid:top_level"
            return
        base_url = str(raw.get("base_url") or "").rstrip("/")
        if not base_url or base_url != expected_base_url.rstrip("/"):
            self.error_code = "browser_session_observation_origin_mismatch"
            return
        captured_at = str(raw.get("captured_at") or "")
        try:
            captured = datetime.fromisoformat(captured_at.replace("Z", "+00:00"))
            if captured.tzinfo is None:
                captured = captured.replace(tzinfo=timezone.utc)
            age_seconds = (datetime.now(timezone.utc) - captured).total_seconds()
        except ValueError:
            self.error_code = "browser_session_observation_invalid:captured_at"
            return
        if age_seconds < -60:
            self.error_code = "browser_session_observation_invalid:captured_at_future"
            return
        if age_seconds > 900:
            self.error_code = "browser_session_observation_stale"
            return
        rows = raw.get("observations")
        if not isinstance(rows, dict):
            self.error_code = "browser_session_observation_invalid:observations"
            return
        for route, row in rows.items():
            if not isinstance(route, str) or not isinstance(row, dict):
                self.error_code = "browser_session_observation_invalid:row"
                self._observations.clear()
                return
            if set(row) - {"status_code", "status", "payload", "error_code"}:
                self.error_code = "browser_session_observation_invalid:row_fields"
                self._observations.clear()
                return
            payload = row.get("payload") if isinstance(row.get("payload"), dict) else {}
            if _browser_payload_has_forbidden_key(payload):
                self.error_code = "browser_session_observation_contains_secret"
                self._observations.clear()
                return
            if not _browser_payload_fields_valid(payload):
                self.error_code = "browser_session_observation_invalid:payload_fields"
                self._observations.clear()
                return
            if _browser_payload_has_secret(payload):
                self.error_code = "browser_session_observation_contains_secret"
                self._observations.clear()
                return
            try:
                status_code = int(row.get("status_code", row.get("status", 0)))
            except (TypeError, ValueError):
                self.error_code = "browser_session_observation_invalid:status"
                self._observations.clear()
                return
            self._observations[route] = _HttpObservation(status_code, payload)

    def get(self, path: str) -> _HttpObservation:
        if self.error_code:
            return _HttpObservation(0, {}, self.error_code)
        return self._observations.get(path, _HttpObservation(0, {}, "browser_session_observation_missing_route"))


class _PodiumObserver:
    """Read-only Podium HTTP observer used by the real phases."""

    def __init__(self, base_url: str, *, timeout: float, browser_observation: str = "") -> None:
        self.base_url = base_url.rstrip("/")
        # A dead Podium must fail visibly within one bounded probe window.
        self.timeout = min(max(0.1, float(timeout)), 20.0)
        self.browser = _BrowserObservation(browser_observation, expected_base_url=self.base_url)

    def get(self, path: str) -> _HttpObservation:
        url = f"{self.base_url}/{path.lstrip('/')}"
        try:
            response = httpx.get(
                url,
                timeout=self.timeout,
                follow_redirects=False,
                trust_env=False,
                headers={"Accept": "application/json"},
            )
            try:
                payload = response.json()
            except ValueError:
                payload = {}
            return _HttpObservation(
                response.status_code,
                payload if isinstance(payload, dict) else {},
                "" if response.status_code else "podium_empty_response",
            )
        except (httpx.HTTPError, ValueError) as exc:
            return _HttpObservation(0, {}, f"podium_request_failed:{type(exc).__name__}")

    def post(self, path: str, payload: dict[str, Any] | None = None) -> _HttpObservation:
        url = f"{self.base_url}/{path.lstrip('/')}"
        try:
            response = httpx.post(
                url,
                timeout=self.timeout,
                follow_redirects=False,
                trust_env=False,
                headers={"Accept": "application/json", "Content-Type": "application/json"},
                json=payload or {},
            )
            try:
                body = response.json()
            except ValueError:
                body = {}
            return _HttpObservation(
                response.status_code,
                body if isinstance(body, dict) else {},
                "" if response.status_code else "podium_empty_response",
            )
        except (httpx.HTTPError, ValueError) as exc:
            return _HttpObservation(0, {}, f"podium_request_failed:{type(exc).__name__}")

    def get_authenticated(self, path: str) -> _HttpObservation:
        """Read an authenticated response without ever transporting its session cookie."""

        return self.browser.get(path)


class _ConductorObserver:
    """Read-only observer for the already-running local Conductor API."""

    def __init__(self, base_url: str, *, timeout: float) -> None:
        self.base_url = base_url.rstrip("/")
        self.timeout = min(max(0.1, float(timeout)), 20.0)
        parsed = urlparse(self.base_url)
        self.error_code = ""
        if parsed.scheme not in {"http", "https"} or not parsed.hostname:
            self.error_code = "conductor_observer_url_invalid"
        elif parsed.scheme == "http" and parsed.hostname.lower() not in {"localhost", "127.0.0.1", "::1"}:
            self.error_code = "conductor_observer_url_not_local"

    def get(self, path: str) -> _HttpObservation:
        if self.error_code:
            return _HttpObservation(0, {}, self.error_code)
        try:
            response = httpx.get(
                f"{self.base_url}/{path.lstrip('/')}",
                timeout=self.timeout,
                follow_redirects=False,
                trust_env=False,
                headers={"Accept": "application/json"},
            )
            try:
                payload = response.json()
            except ValueError:
                payload = {}
            return _HttpObservation(response.status_code, payload if isinstance(payload, dict) else {})
        except (httpx.HTTPError, ValueError) as exc:
            return _HttpObservation(0, {}, f"conductor_request_failed:{type(exc).__name__}")


def _append_check(
    checks: list[dict[str, Any]],
    failures: list[dict[str, Any]],
    *,
    name: str,
    passed: bool,
    group: str,
    error_code: str,
    reason: str,
    observations: dict[str, Any] | None = None,
    action_required: bool = False,
    retryable: bool = False,
    next_action: str = "inspect_artifacts",
) -> None:
    checks.append(
        {
            "name": name,
            "passed": bool(passed),
            "required": True,
            "observations": _sanitize_value(observations or {}),
        }
    )
    if not passed:
        failures.append(
            _failure(
                group,
                error_code,
                reason,
                action_required=action_required,
                retryable=retryable,
                next_action=next_action,
            )
        )


def _contains_sensitive_key(value: Any) -> bool:
    if isinstance(value, dict):
        return any(_SENSITIVE_KEY.search(str(key)) or _contains_sensitive_key(item) for key, item in value.items())
    if isinstance(value, (list, tuple)):
        return any(_contains_sensitive_key(item) for item in value)
    return False


@contextmanager
def _fixture_environment() -> Iterable[None]:
    """Force Linear fixture reads to use the explicit Podium app token only."""

    prior = os.environ.pop("LINEAR_API_KEY", None)
    try:
        yield
    finally:
        if prior is not None:
            os.environ["LINEAR_API_KEY"] = prior


def _sanitize_reason(value: object) -> str:
    sanitized = _sanitize_value(str(value or ""))
    return str(sanitized).replace("\r", " ").replace("\n", " ").strip()[:500]


def _sanitize_value(value: Any, *, key: str = "") -> Any:
    """Keep error categories while removing credentials and credential paths."""

    normalized_key = key.lower()
    if _SENSITIVE_KEY.search(key) and not normalized_key.endswith(("_present", "_length", "_count", "_status")):
        return "[REDACTED]"
    if isinstance(value, dict):
        return {str(name): _sanitize_value(item, key=str(name)) for name, item in value.items()}
    if isinstance(value, list):
        return [_sanitize_value(item) for item in value]
    if isinstance(value, tuple):
        return [_sanitize_value(item) for item in value]
    if isinstance(value, Path):
        return _sanitize_value(str(value), key=key)
    if isinstance(value, str):
        if _AUTH_PATH.search(value) or _CODEX_HOME_PATH.search(value):
            return "[REDACTED_PATH]"
        text = value.replace("\r", " ").replace("\n", " ")
        text = _BEARER.sub(lambda match: f"{match.group(1)} [REDACTED]", text)
        text = _NAMED_SECRET.sub(lambda match: f"{match.group(1)}=[REDACTED]", text)
        return _SECRET_LITERAL.sub("[REDACTED]", text)[:2000]
    return value


def _failure(
    group: str,
    error_code: str,
    sanitized_reason: str,
    *,
    action_required: bool = False,
    retryable: bool = False,
    next_action: str = "inspect_artifacts",
) -> dict[str, Any]:
    return {
        "group": group,
        "error_code": error_code,
        "sanitized_reason": _sanitize_reason(sanitized_reason),
        "action_required": action_required,
        "retryable": retryable,
        "next_action": next_action,
    }


def _phase_report(
    context: _RunContext,
    phase: str,
    status: str,
    *,
    checks: Iterable[dict[str, Any]] = (),
    failures: Iterable[dict[str, Any]] = (),
    blocked_by: Iterable[str] = (),
    observations: dict[str, Any] | None = None,
    artifacts: Iterable[str] = (),
) -> dict[str, Any]:
    report: dict[str, Any] = {
        "run_id": context.run_id,
        "phase": phase,
        "status": status,
        "acceptance": False,
        "checks": [dict(check) for check in checks],
        "failures": [dict(failure) for failure in failures],
        "blocked_by": list(blocked_by),
        "observations": observations or {},
        "artifacts": list(artifacts),
    }
    if status == "passed":
        report["acceptance"] = phase != "overall" or not report["failures"]
    return report


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Run the single polling Linear/Codex Symphony flow")
    parser.add_argument(
        "--phase",
        choices=("all", *_DIAGNOSTIC_PHASES),
        default=None,
        help="run the acceptance batch or one diagnostic phase",
    )
    parser.add_argument("--project-slug", default="", help="Linear project slug (or SYMPHONY_E2E_PROJECT_SLUG)")
    parser.add_argument("--out", type=Path, default=Path(".test-real-flow/report.json"))
    parser.add_argument("--timeout", type=float, default=600.0)
    parser.add_argument("--offline", action="store_true", help="validate staged runtime inputs without Linear mutations")
    return parser


def _write_report(path: Path, report: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(_sanitize_value(report), indent=2, sort_keys=True) + "\n", encoding="utf-8")


def _new_run_id() -> str:
    timestamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    return f"real-e2e-{timestamp}-{uuid4().hex[:10]}"


def _artifact_root(output_path: Path, run_id: str) -> Path:
    return output_path.parent / run_id


def _write_phase(context: _RunContext, report: dict[str, Any]) -> dict[str, Any]:
    if report.get("status") == "passed":
        checks = report.get("checks") if isinstance(report.get("checks"), list) else []
        invalid = not checks or any(not isinstance(check, dict) or (check.get("required", True) and not check.get("passed")) for check in checks)
        if invalid:
            report = {
                **report,
                "status": "failed",
                "acceptance": False,
                "failures": [
                    *report.get("failures", []),
                    _failure("evidence", "phase_report_without_required_checks", "A passed phase must include passing required checks", next_action="inspect_phase_report_generation"),
                ],
            }
    phase = str(report["phase"])
    phase_path = context.artifact_root / phase / "report.json"
    _write_report(phase_path, report)
    report = {**report, "artifacts": [*report.get("artifacts", []), str(phase_path)]}
    _write_report(phase_path, report)
    context.phase_reports.append(report)
    return report


def _write_manifest(context: _RunContext) -> None:
    manifest = {
        "run_id": context.run_id,
        "artifact_root": str(context.artifact_root),
        "project_slug": context.project_slug,
        "offline": context.offline,
        "phases": [
            {
                "phase": report.get("phase"),
                "status": report.get("status"),
                "checks": [check.get("name") for check in report.get("checks", [])],
                "failures": report.get("failures", []),
                "failure_groups": sorted({str(failure.get("group") or "") for failure in report.get("failures", []) if isinstance(failure, dict)}),
                "observations": report.get("observations", {}),
                "config_hashes": {
                    key: value
                    for key, value in (report.get("observations", {}) or {}).items()
                    if isinstance(key, str) and key.endswith(("_sha256", "_hash"))
                },
                "artifacts": report.get("artifacts", []),
            }
            for report in context.phase_reports
        ],
    }
    _write_report(context.artifact_root / "manifest.json", manifest)


def _legacy_preflight(args: argparse.Namespace) -> int:
    """Keep the pre-batch ``--offline`` command useful for staged seed setup."""

    settings = required_environment()
    project_slug = str(args.project_slug or settings["project_slug"]).strip()
    report: dict[str, Any] = {
        "started_at": datetime.now(timezone.utc).isoformat(),
        "flow": "linear-polling-plan-subissues-execute-gate",
        "offline": bool(args.offline),
        "project_slug": project_slug,
        "checks": [],
        "status": "failed",
    }

    def check(name: str, passed: bool, **details: object) -> None:
        report["checks"].append({"name": name, "passed": passed, **details})

    check("performer_control_boundary", True, required=True)
    check("podium_url", bool(settings["podium_url"]), required=not args.offline)
    check("project_slug", bool(project_slug), required=not args.offline)
    if not all(item["passed"] or not item["required"] for item in report["checks"]):
        report["error_code"] = "real_flow_preflight_failed"
        report["next_action"] = "set_linear_and_podium_environment"
        _write_report(args.out, report)
        return 2
    if args.offline:
        report["status"] = "preflight_only"
        report["next_action"] = "run_with_--phase_all_against_a_clean_test_project"
        _write_report(args.out, report)
        return 0
    report["status"] = "preflight_ready"
    report["next_action"] = "run_with_--phase_all_against_a_clean_test_project"
    _write_report(args.out, report)
    return 0


def _diagnostic_output_path(path: Path, phase: str) -> Path:
    if not path.exists():
        return path
    try:
        existing = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return path
    if isinstance(existing, dict) and existing.get("phase") == "batch":
        return path.with_name(f"{path.stem}-{phase}-diagnostic{path.suffix}")
    return path


def _context(args: argparse.Namespace, *, output_path: Path | None = None) -> _RunContext:
    settings = required_environment()
    project_slug = str(args.project_slug or settings["project_slug"]).strip()
    run_id = _new_run_id()
    output_path = output_path or args.out
    root = _artifact_root(output_path, run_id)
    root.mkdir(parents=True, exist_ok=False)
    _write_report(
        root / "inputs.json",
        {
            "run_id": run_id,
            "project_slug": project_slug,
            "podium_url_present": bool(settings["podium_url"]),
            "conductor_url_present": bool(settings.get("conductor_url")),
            "performer_control_boundary": "installed_process",
            "performer_profile_present": bool(settings.get("performer_profile_dir") and settings.get("performer_profile_name")),
            "fixture_repository_present": bool(settings.get("fixture_repository")),
            "browser_observation_present": bool(settings.get("browser_observation")),
        },
    )
    return _RunContext(
        run_id=run_id,
        artifact_root=root,
        output_path=output_path,
        project_slug=project_slug,
        timeout=float(args.timeout),
        offline=bool(args.offline),
        settings=settings,
    )


def _offline_phase(context: _RunContext, phase: str) -> dict[str, Any]:
    checks = [
        {"name": "offline_mode", "passed": False, "required": True, "observations": {"diagnostic": True}},
    ]
    return _phase_report(
        context,
        phase,
        "failed",
        checks=checks,
        failures=(
            _failure(
                "evidence",
                "offline_preflight_only",
                "offline mode validates inputs but cannot produce real phase evidence",
                next_action="rerun_without_--offline",
            ),
        ),
    )


def _run_oauth_phase(context: _RunContext) -> dict[str, Any]:
    if context.offline:
        return _offline_phase(context, "oauth")
    checks: list[dict[str, Any]] = []
    failures: list[dict[str, Any]] = []
    observations: dict[str, Any] = {}
    observer = _PodiumObserver(
        context.settings["podium_url"],
        timeout=context.timeout,
        browser_observation=context.settings.get("browser_observation", ""),
    )

    unauthenticated = observer.get("/api/v1/auth/me")
    _append_check(
        checks,
        failures,
        name="oauth_unauthenticated_rejected",
        passed=unauthenticated.status_code == 401,
        group="auth",
        error_code="oauth_unauthenticated_probe_failed",
        reason="Unauthenticated /api/v1/auth/me must return 401",
        observations={"status_code": unauthenticated.status_code, "error_code": unauthenticated.error_code},
    )

    authenticated = observer.get_authenticated("/api/v1/auth/me")
    user = authenticated.payload.get("user")
    auth_session_ok = (
        authenticated.status_code == 200
        and isinstance(user, dict)
        and bool(str(user.get("id") or "").strip())
        and bool(str(user.get("email") or "").strip())
    )
    _append_check(
        checks,
        failures,
        name="oauth_authenticated_session_observed",
        passed=auth_session_ok,
        group="auth",
        error_code="oauth_browser_session_unavailable",
        reason="The existing signed-in browser session was not available to the observer",
        observations={
            "status_code": authenticated.status_code,
            "user_id": user.get("id") if isinstance(user, dict) else "",
            "user_email_present": bool(user.get("email")) if isinstance(user, dict) else False,
        },
        action_required=True,
        next_action="reuse_existing_signed_in_browser_session",
    )
    observations["user"] = {
        "id": user.get("id") if isinstance(user, dict) else "",
        "email_present": bool(user.get("email")) if isinstance(user, dict) else False,
    }

    installations = observer.get_authenticated("/api/v1/linear/installations")
    active = installations.payload.get("active")
    active_ok = (
        installations.status_code == 200
        and isinstance(active, dict)
        and str(active.get("state") or "") == "active"
        and bool(str(active.get("id") or "").strip())
        and bool(str(active.get("linear_organization_id") or "").strip())
        and bool(str(active.get("app_user_id") or "").strip())
        and str(active.get("reconciliation_state") or "").lower() in {"", "active", "healthy", "ready", "ok"}
        and not str(active.get("error_code") or "").strip()
    )
    installation_error = "linear_reauthorization_required" if not active_ok else ""
    _append_check(
        checks,
        failures,
        name="oauth_active_installation_healthy",
        passed=active_ok,
        group="auth",
        error_code=installation_error or "oauth_installation_unavailable",
        reason="An active Linear installation is required; reauthorization is never started by the runner",
        observations={
            "status_code": installations.status_code,
            "installation_id": active.get("id") if isinstance(active, dict) else "",
            "organization_id": active.get("linear_organization_id") if isinstance(active, dict) else "",
            "app_user_id": active.get("app_user_id") if isinstance(active, dict) else "",
            "state": active.get("state") if isinstance(active, dict) else "",
            "reconciliation_state": active.get("reconciliation_state") if isinstance(active, dict) else "",
        },
        action_required=True,
        next_action="reauthorize_the_existing_linear_installation_externally" if not active_ok else "continue",
    )
    observations["installation"] = {
        "id": active.get("id") if isinstance(active, dict) else "",
        "organization_id": active.get("linear_organization_id") if isinstance(active, dict) else "",
        "app_user_id": active.get("app_user_id") if isinstance(active, dict) else "",
        "state": active.get("state") if isinstance(active, dict) else "",
        "reconciliation_state": active.get("reconciliation_state") if isinstance(active, dict) else "",
    }
    _append_check(
        checks,
        failures,
        name="oauth_installation_response_sanitized",
        passed=not _contains_sensitive_key(installations.payload),
        group="redaction",
        error_code="oauth_installation_response_contains_secret_field",
        reason="Podium installation responses must not contain tokens, cookies, or client secrets",
        observations={"status_code": installations.status_code},
        next_action="inspect_podium_response_sanitization",
    )

    projects = observer.get_authenticated("/api/v1/linear/projects")
    project_rows = projects.payload.get("projects")
    project_rows = project_rows if isinstance(project_rows, list) else []
    selected_project = next(
        (row for row in project_rows if isinstance(row, dict) and str(row.get("slug") or row.get("slug_id") or "") == context.project_slug),
        None,
    )
    _append_check(
        checks,
        failures,
        name="oauth_selected_project_visible",
        passed=(
            projects.status_code == 200
            and isinstance(selected_project, dict)
            and bool(str(selected_project.get("id") or "").strip())
            and bool(str(selected_project.get("slug") or selected_project.get("slug_id") or "").strip())
        ),
        group="binding",
        error_code="selected_project_not_visible",
        reason="The configured project slug must be present in the authenticated Podium project list",
        observations={
            "status_code": projects.status_code,
            "project_id": selected_project.get("id") if isinstance(selected_project, dict) else "",
            "project_slug": context.project_slug,
        },
        next_action="select_the_existing_project_without_mutating_member_ids",
    )
    observations["selected_project"] = {
        "id": selected_project.get("id") if isinstance(selected_project, dict) else "",
        "slug": selected_project.get("slug") if isinstance(selected_project, dict) else "",
        "slug_id": selected_project.get("slug_id") if isinstance(selected_project, dict) else "",
    }

    missing_state = observer.get("/api/v1/linear/oauth/callback")
    invalid_state = observer.get(f"/api/v1/linear/oauth/callback?state={uuid4().hex}")
    for name, response in (("oauth_callback_missing_state_rejected", missing_state), ("oauth_callback_invalid_state_rejected", invalid_state)):
        _append_check(
            checks,
            failures,
            name=name,
            passed=response.status_code == 400,
            group="auth",
            error_code="oauth_callback_negative_probe_failed",
            reason="OAuth callback negative probes must fail closed with HTTP 400",
            observations={"status_code": response.status_code, "error_code": response.error_code},
            next_action="inspect_oauth_callback_state_validation",
        )

    return _phase_report(
        context,
        "oauth",
        "passed" if not failures else "failed",
        checks=checks,
        failures=failures,
        observations=observations,
    )


def _run_linear_phase(context: _RunContext) -> dict[str, Any]:
    """Exercise the direct Linear fixture without Podium, OAuth, or Conductor."""

    if context.offline:
        return _offline_phase(context, "linear")
    checks: list[dict[str, Any]] = []
    failures: list[dict[str, Any]] = []
    observations: dict[str, Any] = {}
    fixture: LinearFixture | None = None
    project: dict[str, Any] | None = None
    state: dict[str, str] | None = None
    parent: dict[str, Any] | None = None

    with _fixture_environment():
        try:
            fixture = LinearFixture.from_environment(timeout=min(max(context.timeout, 0.1), 20.0))
            viewer = fixture.graphql("query { viewer { id } }")
            viewer_id = ((viewer.get("viewer") or {}).get("id") if isinstance(viewer.get("viewer"), dict) else "")
            _append_check(
                checks,
                failures,
                name="linear_fixture_viewer_visible",
                passed=bool(viewer_id),
                group="linear",
                error_code="linear_fixture_failed",
                reason="The configured Linear fixture token must read viewer identity",
                observations={"viewer_id_present": bool(viewer_id), "token_present": bool(os.environ.get("PODIUM_LINEAR_APP_ACCESS_TOKEN"))},
                next_action="fix_podium_linear_app_access_token",
            )
        except Exception as exc:
            _append_check(
                checks,
                failures,
                name="linear_fixture_viewer_visible",
                passed=False,
                group="linear",
                error_code="linear_fixture_failed",
                reason=_sanitize_reason(exc),
                observations={"token_present": bool(os.environ.get("PODIUM_LINEAR_APP_ACCESS_TOKEN"))},
                next_action="fix_podium_linear_app_access_token",
            )

        if fixture is not None:
            try:
                project = fixture.project(context.project_slug)
                _append_check(
                    checks,
                    failures,
                    name="linear_fixture_project_visible",
                    passed=bool(project.get("id")) and bool((project.get("team") or {}).get("id")),
                    group="linear",
                    error_code="linear_project_not_found",
                    reason="The configured project slug must be visible to the direct Linear fixture token",
                    observations={"project_id": project.get("id"), "project_slug": project.get("slug"), "team_id": (project.get("team") or {}).get("id")},
                    next_action="fix_linear_project_scope",
                )
            except Exception as exc:
                _append_check(
                    checks,
                    failures,
                    name="linear_fixture_project_visible",
                    passed=False,
                    group="linear",
                    error_code="linear_project_not_found",
                    reason=_sanitize_reason(exc),
                    next_action="fix_linear_project_scope",
                )
        else:
            _append_check(
                checks,
                failures,
                name="linear_fixture_project_visible",
                passed=False,
                group="linear",
                error_code="linear_fixture_unavailable",
                reason="Project lookup requires a working direct Linear fixture credential",
                next_action="fix_podium_linear_app_access_token",
            )

        if fixture is not None and project is not None:
            try:
                state = _select_backlog_state(fixture.workflow_states(str((project.get("team") or {}).get("id") or "")))
                _append_check(
                    checks,
                    failures,
                    name="linear_fixture_backlog_state_unambiguous",
                    passed=True,
                    group="linear",
                    error_code="linear_fixture_state_ambiguous",
                    reason="Exactly one backlog or fallback unstarted state is required",
                    observations={"state_id": state.get("id"), "state_type": state.get("type")},
                )
            except Exception as exc:
                _append_check(
                    checks,
                    failures,
                    name="linear_fixture_backlog_state_unambiguous",
                    passed=False,
                    group="linear",
                    error_code="linear_fixture_state_ambiguous",
                    reason=_sanitize_reason(exc),
                    next_action="fix_linear_project_scope",
                )
        else:
            _append_check(
                checks,
                failures,
                name="linear_fixture_backlog_state_unambiguous",
                passed=False,
                group="linear",
                error_code="linear_fixture_state_unavailable",
                reason="Workflow-state lookup requires a visible Linear project",
                next_action="fix_linear_project_scope",
            )

        if fixture is not None and project is not None and state is not None:
            try:
                parent = fixture.create_parent_issue(
                    team_id=str((project.get("team") or {}).get("id") or ""),
                    project_id=str(project.get("id") or ""),
                    state_id=str(state.get("id") or ""),
                    title=f"Symphony real E2E fixture {context.run_id}",
                    description="Direct Linear phase fixture. It is intentionally not delegated and does not exercise Podium.",
                )
                _append_check(
                    checks,
                    failures,
                    name="linear_fixture_parent_created",
                    passed=bool(parent.get("id")) and parent.get("parent") is None,
                    group="linear",
                    error_code="linear_issue_create_failed",
                    reason="The direct Linear fixture must create one explicit root issue",
                    observations={"issue_id": parent.get("id"), "issue_identifier": parent.get("identifier"), "parent_is_null": parent.get("parent") is None},
                    next_action="fix_linear_write_scope",
                )
            except Exception as exc:
                _append_check(
                    checks,
                    failures,
                    name="linear_fixture_parent_created",
                    passed=False,
                    group="linear",
                    error_code="linear_issue_create_failed",
                    reason=_sanitize_reason(exc),
                    next_action="fix_linear_write_scope",
                )
        else:
            _append_check(
                checks,
                failures,
                name="linear_fixture_parent_created",
                passed=False,
                group="linear",
                error_code="linear_parent_prerequisite_missing",
                reason="Parent creation requires direct Linear viewer, project, and workflow-state access",
                next_action="repair_linear_fixture_access",
            )

        if fixture is not None and parent is not None and parent.get("id"):
            try:
                fetched = fixture.issue(str(parent["id"]))
                children = fixture.children(str(parent["id"]))
                child_parents_explicit = all(
                    isinstance(child, dict)
                    and isinstance(child.get("parent"), dict)
                    and bool(child["parent"].get("id"))
                    and bool(child["parent"].get("identifier"))
                    for child in children
                )
                tree_ok = fetched.get("parent") is None and child_parents_explicit
                _append_check(
                    checks,
                    failures,
                    name="linear_fixture_parent_tree_explicit",
                    passed=tree_ok,
                    group="linear",
                    error_code="linear_parent_tree_mismatch",
                    reason="The fixture root must have parent null and every returned child must expose explicit parent identity",
                    observations={"parent_is_null": fetched.get("parent") is None, "child_count": len(children), "child_parents_explicit": child_parents_explicit},
                    next_action="inspect_linear_fixture_parent_fields",
                )
            except Exception as exc:
                _append_check(
                    checks,
                    failures,
                    name="linear_fixture_parent_tree_explicit",
                    passed=False,
                    group="linear",
                    error_code="linear_issue_read_failed",
                    reason=_sanitize_reason(exc),
                    next_action="fix_linear_read_scope",
                )
        else:
            _append_check(
                checks,
                failures,
                name="linear_fixture_parent_tree_explicit",
                passed=False,
                group="linear",
                error_code="linear_parent_tree_unavailable",
                reason="Parent tree reads require a successfully created direct Linear fixture issue",
                next_action="fix_linear_write_scope",
            )

    observations["project"] = {
        "id": project.get("id") if isinstance(project, dict) else "",
        "slug": (
            project.get("slug") or project.get("slugId")
            if isinstance(project, dict)
            else context.project_slug
        ),
        "team_id": (project.get("team") or {}).get("id") if isinstance(project, dict) else "",
    }
    observations["parent"] = {
        "id": parent.get("id") if isinstance(parent, dict) else "",
        "identifier": parent.get("identifier") if isinstance(parent, dict) else "",
    }
    return _phase_report(
        context,
        "linear",
        "passed" if not failures else "failed",
        checks=checks,
        failures=failures,
        observations=observations,
    )
def _select_backlog_state(states: list[dict[str, str]]) -> dict[str, str]:
    backlog = [state for state in states if state.get("type") == "backlog"]
    if not backlog:
        backlog = [state for state in states if state.get("type") == "unstarted"]
    if len(backlog) != 1:
        raise ValueError("linear_fixture_state_ambiguous")
    return backlog[0]


def _select_started_state(states: list[dict[str, str]]) -> dict[str, str]:
    started = [state for state in states if state.get("type") == "started"]
    if len(started) != 1:
        raise ValueError("linear_fixture_started_state_ambiguous")
    return started[0]


def _git_workspace(path: Path) -> None:
    path.mkdir(parents=True, exist_ok=True)
    subprocess.run(
        ["git", "init", "--quiet", str(path)],
        check=True,
        capture_output=True,
        text=True,
        timeout=10,
    )
    (path / "README.md").write_text("Symphony real E2E disposable workspace.\n", encoding="utf-8")
    subprocess.run(
        ["git", "-C", str(path), "add", "--", "README.md"],
        check=True,
        capture_output=True,
        text=True,
        timeout=10,
    )


def _artifact_paths(paths: Any) -> list[str]:
    return [
        str(path)
        for path in (
            getattr(paths, "request", None),
            getattr(paths, "result", None),
            getattr(paths, "log", None),
        )
        if isinstance(path, Path) and path.exists()
    ]


def _artifact_has_secret(paths: Iterable[str]) -> bool:
    for raw_path in paths:
        path = Path(raw_path)
        if path.name == "auth.json" or _AUTH_PATH.search(str(path)) or _CODEX_HOME_PATH.search(str(path)):
            return True
        if not path.is_file():
            return True
        try:
            if path.stat().st_size > 8 * 1024 * 1024:
                return True
        except OSError:
            return True
        try:
            content = path.read_text(encoding="utf-8", errors="replace")
        except OSError:
            return True
        if (
            _SECRET_LITERAL.search(content)
            or _BEARER.search(content)
            or _NAMED_SECRET.search(content)
            or re.search(r"(?i)authorization\s*[:=]", content)
            or _AUTH_PATH.search(content)
            or _CODEX_HOME_PATH.search(content)
            or re.search(
                r"(?i)\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b",
                content,
            )
        ):
            return True
    return False


_OVERALL_FIXTURES: dict[str, dict[str, str]] = {
    "success": {
        "verify_success.py": "raise SystemExit(0)\n",
    },
    "rework": {
        "verify_once.py": (
            "from pathlib import Path\n"
            "counter = Path('.e2e/state/verify-count')\n"
            "counter.parent.mkdir(parents=True, exist_ok=True)\n"
            "count = int(counter.read_text() or '0') if counter.exists() else 0\n"
            "counter.write_text(str(count + 1))\n"
            "raise SystemExit(1 if count == 0 else 0)\n"
        ),
    },
    "block": {
        "verify_always_fail.py": "raise SystemExit(1)\n",
    },
    "runtime_wait": {
        "ask_for_input.py": (
            "from pathlib import Path\n"
            "if not Path('.e2e/input-approved').exists():\n"
            "    input('SYMPHONY_REAL_E2E_INPUT:')\n"
            "print('input-approved')\n"
        ),
    },
}


def _prepare_overall_fixtures(root: Path) -> tuple[dict[str, Path], list[str]]:
    fixture_paths: dict[str, Path] = {}
    artifacts: list[str] = []
    fixture_root = root / "fixtures"
    for scenario, files in _OVERALL_FIXTURES.items():
        scenario_root = fixture_root / scenario
        (scenario_root / ".e2e" / "state").mkdir(parents=True, exist_ok=True)
        _git_workspace(scenario_root)
        (scenario_root / ".gitignore").write_text(".e2e/state/\n.e2e/input-approved\n", encoding="utf-8")
        fixture_paths[scenario] = scenario_root
        for name, content in files.items():
            path = scenario_root / ".e2e" / name
            path.write_text(content, encoding="utf-8")
            artifacts.append(str(path))
    return fixture_paths, artifacts


def _fixture_contract_ok(paths: dict[str, Path]) -> bool:
    expected = {
        "success": (".e2e/verify_success.py", "python .e2e/verify_success.py"),
        "rework": (".e2e/verify_once.py", "python .e2e/verify_once.py"),
        "block": (".e2e/verify_always_fail.py", "python .e2e/verify_always_fail.py"),
        "runtime_wait": (".e2e/ask_for_input.py", "python .e2e/ask_for_input.py"),
    }
    for name, (relative, command) in expected.items():
        root = paths.get(name)
        if root is None or not (root / ".git").is_dir():
            return False
        script = root / relative
        expected_content = _OVERALL_FIXTURES[name].get(Path(relative).name)
        if not script.is_file() or expected_content is None:
            return False
        try:
            if script.read_text(encoding="utf-8") != expected_content:
                return False
        except OSError:
            return False
        if command != f"python {relative}":
            return False
    return True


def _materialize_fixture_repository(context: _RunContext, fixture_paths: dict[str, Path]) -> tuple[bool, str, str]:
    """Copy the exact verifier scripts into the explicitly approved disposable repo."""

    raw = str(context.settings.get("fixture_repository") or "").strip()
    if not raw:
        return False, "", "fixture_repository_not_configured"
    try:
        repository = Path(raw).expanduser().resolve()
    except OSError:
        return False, "", "fixture_repository_path_invalid"
    if not repository.is_dir() or not (repository / ".git").is_dir() or repository == context.artifact_root.resolve():
        return False, "", "fixture_repository_not_git"
    target_root = repository / ".e2e"
    try:
        target_root.mkdir(parents=True, exist_ok=True)
        ignore_path = target_root / ".gitignore"
        ignore_content = "state/\ninput-approved\n"
        if ignore_path.exists() and ignore_path.read_text(encoding="utf-8") != ignore_content:
            return False, "", "fixture_repository_file_conflict"
        if not ignore_path.exists():
            ignore_path.write_text(ignore_content, encoding="utf-8")
        for scenario, source_root in fixture_paths.items():
            for source in (source_root / ".e2e").iterdir():
                if not source.is_file() or source.name == ".gitignore":
                    continue
                target = target_root / source.name
                if target.exists() and target.read_text(encoding="utf-8") != source.read_text(encoding="utf-8"):
                    return False, "", "fixture_repository_file_conflict"
                if not target.exists():
                    shutil.copy2(source, target)
        (target_root / "state").mkdir(parents=True, exist_ok=True)
    except (OSError, UnicodeError):
        return False, "", "fixture_repository_materialization_failed"
    return True, str(repository), ""


class _PerformerDiagnosticError(RuntimeError):
    def __init__(self, code: str, reason: str) -> None:
        super().__init__(reason)
        self.code = code


def _installed_performer_command() -> tuple[str, ...]:
    sibling = Path(sys.executable).with_name("performer")
    if sibling.is_file() and os.access(sibling, os.X_OK):
        return (str(sibling),)
    return (sys.executable, "-m", "performer.cli")


@contextmanager
def _staged_performer_environment(context: _RunContext) -> Iterable[dict[str, str]]:
    raw_seed = str(context.settings.get("codex_seed") or "").strip()
    try:
        seed = Path(raw_seed).expanduser().resolve(strict=True)
    except OSError as exc:
        raise _PerformerDiagnosticError(
            "performer_seed_unavailable",
            "The approved staged Performer seed is unavailable.",
        ) from exc
    default_codex_home = (Path.home() / ".codex").resolve(strict=False)
    if not seed.is_dir() or seed == default_codex_home:
        raise _PerformerDiagnosticError(
            "performer_seed_forbidden",
            "The real diagnostic requires an explicit staged seed outside the default provider home.",
        )
    missing = [name for name in ("config.toml", "auth.json") if not (seed / name).is_file()]
    if missing:
        raise _PerformerDiagnosticError(
            "performer_seed_incomplete",
            "The approved staged Performer seed is missing a required file.",
        )

    with tempfile.TemporaryDirectory(prefix=f"symphony-{context.run_id}-") as temporary:
        staged = Path(temporary) / "backend-context"
        staged.mkdir(mode=0o700)
        for name in _PERFORMER_SEED_FILES:
            source = seed / name
            if source.is_file():
                shutil.copy2(source, staged / name)
        environment = {
            key: str(os.environ[key])
            for key in _PERFORMER_ENV_KEYS
            if os.environ.get(key)
        }
        environment["CODEX_HOME"] = str(staged)
        yield environment


def _control_frame(request: PerformerControlRequest) -> bytes:
    encoded = json.dumps(
        request.to_dict(),
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")
    if not encoded or len(encoded) > _CONTROL_METADATA_MAX_BYTES:
        raise _PerformerDiagnosticError(
            "performer_control_request_invalid",
            "The Performer control request exceeded its bounded frame.",
        )
    return struct.pack(">I", len(encoded)) + encoded


def _read_control_result(
    process: subprocess.Popen[bytes],
    request: PerformerControlRequest,
    *,
    timeout: float,
    frames: list[dict[str, Any]],
) -> PerformerControlResult:
    if process.stdout is None:
        raise _PerformerDiagnosticError(
            "performer_control_start_failed",
            "The Performer control process did not expose stdout.",
        )
    deadline = time.monotonic() + max(0.1, timeout)
    while True:
        remaining = deadline - time.monotonic()
        if remaining <= 0 or not select.select([process.stdout], [], [], remaining)[0]:
            raise _PerformerDiagnosticError(
                "performer_control_timeout",
                "The Performer control process did not return before the diagnostic deadline.",
            )
        line = process.stdout.readline()
        if not line:
            raise _PerformerDiagnosticError(
                "performer_control_process_exited",
                "The Performer control process exited before returning a result.",
            )
        try:
            frame = json.loads(line)
        except json.JSONDecodeError as exc:
            raise _PerformerDiagnosticError(
                "performer_control_protocol_invalid",
                "The Performer control process returned invalid JSON.",
            ) from exc
        if not isinstance(frame, dict) or set(frame) != {"frame_kind", "payload"}:
            raise _PerformerDiagnosticError(
                "performer_control_protocol_invalid",
                "The Performer control process returned an invalid frame.",
            )
        payload = frame.get("payload")
        if not isinstance(payload, dict):
            raise _PerformerDiagnosticError(
                "performer_control_protocol_invalid",
                "The Performer control process returned an invalid payload.",
            )
        frames.append(_sanitize_value(frame))
        if frame.get("frame_kind") == "control.event":
            event = PerformerControlEvent.from_dict(payload)
            if event.request_id != request.request_id or event.operation != request.operation:
                raise _PerformerDiagnosticError(
                    "performer_control_protocol_invalid",
                    "The Performer control event did not match its request.",
                )
            continue
        if frame.get("frame_kind") != "control.result":
            raise _PerformerDiagnosticError(
                "performer_control_protocol_invalid",
                "The Performer control process returned an unsupported frame.",
            )
        result = PerformerControlResult.from_dict(payload)
        if result.request_id != request.request_id or result.operation != request.operation:
            raise _PerformerDiagnosticError(
                "performer_control_protocol_invalid",
                "The Performer control result did not match its request.",
            )
        return result


def _exchange_control(
    process: subprocess.Popen[bytes],
    request: PerformerControlRequest,
    *,
    timeout: float,
    frames: list[dict[str, Any]],
) -> PerformerControlResult:
    if process.stdin is None:
        raise _PerformerDiagnosticError(
            "performer_control_start_failed",
            "The Performer control process did not expose stdin.",
        )
    try:
        process.stdin.write(_control_frame(request))
        process.stdin.flush()
    except OSError as exc:
        raise _PerformerDiagnosticError(
            "performer_control_process_exited",
            "The Performer control process rejected its request.",
        ) from exc
    return _read_control_result(process, request, timeout=timeout, frames=frames)


def _stop_control_process(process: subprocess.Popen[bytes]) -> bytes:
    if process.stdin is not None:
        try:
            process.stdin.close()
        except OSError:
            pass
    try:
        process.wait(timeout=5)
    except subprocess.TimeoutExpired:
        process.terminate()
        try:
            process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait(timeout=5)
    return process.stderr.read() if process.stderr is not None else b""


def _sanitize_performer_output(value: bytes, environment: dict[str, str]) -> str:
    text = value.decode("utf-8", errors="replace")
    staged_home = environment.get("CODEX_HOME", "")
    if staged_home:
        text = text.replace(staged_home, "[REDACTED_PATH]")
    return str(_sanitize_value(text))


def _performer_turn_request(
    context: _RunContext,
    workspace: Path,
    kind: str,
    *,
    task: Task | None = None,
    thread_id: str = "",
    evidence: dict[str, Any] | None = None,
) -> PerformerTurnRequest:
    policy = RuntimePolicy.from_dict(_REAL_EXECUTION_POLICY)
    return PerformerTurnRequest(
        protocol_version=TURN_PROTOCOL_VERSION,
        context=TurnContext(
            context.run_id,
            task.id if task is not None else "",
            f"{kind}-1",
            {"plan": 1, "execute": 2, "gate": 3}[kind],
            kind,
        ),
        performer_kind="codex",
        performer_binding_id="real-e2e-binding",
        binding_generation=1,
        execution_policy=policy.to_dict(),
        execution_policy_sha256=canonical_sha256(policy.to_dict()),
        turn_policy_sha256=_REAL_TURN_POLICY_SHA256,
        workspace_path=str(workspace),
        thread_id=thread_id,
        issue_description=(
            "Exercise the installed Performer boundary in a disposable Git workspace. "
            "Return exactly one task that appends an accepted marker to README.md, "
            "touches only README.md, and verifies with git diff --check."
            if kind == "plan"
            else ""
        ),
        task=task,
        evidence=evidence,
    )


def _run_installed_turn(
    command: tuple[str, ...],
    environment: dict[str, str],
    request: PerformerTurnRequest,
    root: Path,
    *,
    timeout: float,
) -> tuple[PerformerTurnResult, list[str]]:
    root.mkdir(parents=True, exist_ok=True)
    request_path = root / "request.json"
    result_path = root / "result.json"
    log_path = root / "performer.log"
    request_path.write_text(json.dumps(request.to_dict(), sort_keys=True), encoding="utf-8")
    try:
        completed = subprocess.run(
            [
                *command,
                "--turn-request-path",
                str(request_path),
                "--turn-result-path",
                str(result_path),
            ],
            env=environment,
            check=False,
            capture_output=True,
            timeout=max(0.1, timeout),
        )
    except (OSError, subprocess.SubprocessError) as exc:
        raise _PerformerDiagnosticError(
            "performer_turn_invocation_failed",
            "The installed Performer turn process could not complete.",
        ) from exc
    log_path.write_text(
        json.dumps(
            _sanitize_value(
                {
                    "exit_code": completed.returncode,
                    "stdout": _sanitize_performer_output(completed.stdout, environment),
                    "stderr": _sanitize_performer_output(completed.stderr, environment),
                }
            ),
            sort_keys=True,
        ),
        encoding="utf-8",
    )
    if completed.returncode != 0 or not result_path.is_file():
        raise _PerformerDiagnosticError(
            "performer_turn_failed",
            "The installed Performer turn process failed without a valid result.",
        )
    try:
        payload = json.loads(result_path.read_text(encoding="utf-8"))
        result = PerformerTurnResult.from_dict(payload)
    except (OSError, json.JSONDecodeError, TypeError, ValueError) as exc:
        raise _PerformerDiagnosticError(
            "performer_turn_result_invalid",
            "The installed Performer turn result failed validation.",
        ) from exc
    mismatch = request.context.mismatch_reason(result.context)
    if mismatch is not None:
        raise _PerformerDiagnosticError(mismatch, "The installed Performer turn result was stale.")
    return result, [str(request_path), str(result_path), str(log_path)]


def _run_performer_phase(context: _RunContext) -> dict[str, Any]:
    if context.offline:
        return _offline_phase(context, "performer")

    checks: list[dict[str, Any]] = []
    failures: list[dict[str, Any]] = []
    artifacts: list[str] = []
    observations: dict[str, Any] = {
        "boundary": "installed_performer_control_and_turn_processes",
        "provider_owned_state_in_conductor": False,
    }
    performer_root = context.artifact_root / "performer"
    workspace = performer_root / "workspace"
    turns_root = performer_root / "turns"
    control_frames_path = performer_root / "control-frames.json"
    control_log_path = performer_root / "control.log"
    performer_root.mkdir(parents=True, exist_ok=True)
    _git_workspace(workspace)
    command = _installed_performer_command()
    current_check = "performer_control_status"

    try:
        with _staged_performer_environment(context) as environment:
            try:
                process = subprocess.Popen(
                    [*command, "control", "--performer-kind", "codex"],
                    env=environment,
                    stdin=subprocess.PIPE,
                    stdout=subprocess.PIPE,
                    stderr=subprocess.PIPE,
                    bufsize=0,
                )
            except OSError as exc:
                raise _PerformerDiagnosticError(
                    "performer_control_start_failed",
                    "The installed Performer control process could not start.",
                ) from exc

            control_frames: list[dict[str, Any]] = []
            control_stderr = b""
            phase_completed = False
            try:
                status_request = PerformerControlRequest(
                    protocol_version=CONTROL_PROTOCOL_VERSION,
                    request_id="real-status-1",
                    operation="performer.status",
                    performer_kind="codex",
                    arguments={},
                    secret_input=None,
                )
                status = _exchange_control(
                    process,
                    status_request,
                    timeout=context.timeout,
                    frames=control_frames,
                )
                capabilities = status.capabilities
                status_ok = (
                    status.status == "succeeded"
                    and capabilities is not None
                    and capabilities.check_supported
                    and set(capabilities.turn_kinds) == {"plan", "execute", "gate"}
                    and status.account is not None
                    and status.account.status == "authenticated"
                )
                if not status_ok:
                    raise _PerformerDiagnosticError(
                        "performer_status_not_ready",
                        "The installed Performer status did not expose the required authenticated capabilities.",
                    )
                _append_check(
                    checks,
                    failures,
                    name=current_check,
                    passed=True,
                    group="performer",
                    error_code="performer_status_not_ready",
                    reason="The installed Performer status was unavailable.",
                    observations={
                        "performer_kind": capabilities.performer_kind,
                        "capability_version": capabilities.capability_version,
                        "account_status": status.account.status,
                    },
                )

                current_check = "performer_manual_check"
                policy = RuntimePolicy.from_dict(_REAL_EXECUTION_POLICY)
                policy_hash = canonical_sha256(policy.to_dict())
                check_request = PerformerControlRequest(
                    protocol_version=CONTROL_PROTOCOL_VERSION,
                    request_id="real-check-1",
                    operation="performer.check",
                    performer_kind="codex",
                    arguments={
                        "binding_generation": 1,
                        "execution_policy": policy.to_dict(),
                        "execution_policy_sha256": policy_hash,
                    },
                    secret_input=None,
                )
                checked = _exchange_control(
                    process,
                    check_request,
                    timeout=context.timeout,
                    frames=control_frames,
                )
                check_ok = (
                    checked.status == "succeeded"
                    and checked.check is not None
                    and checked.check.status == "passed"
                    and checked.readiness is not None
                    and checked.readiness.is_compatible(
                        performer_kind="codex",
                        binding_generation=1,
                        capability_version=capabilities.capability_version,
                        execution_policy_sha256=policy_hash,
                    )
                )
                if not check_ok:
                    readiness_error = (
                        checked.readiness.error
                        if checked.readiness is not None
                        else None
                    )
                    adapter_reason = (
                        _sanitize_reason(readiness_error.sanitized_reason)
                        if readiness_error is not None
                        else ""
                    )
                    raise _PerformerDiagnosticError(
                        "performer_check_failed",
                        (
                            f"The installed Performer manual Check failed: {adapter_reason}"
                            if adapter_reason
                            else "The installed Performer manual Check did not produce compatible readiness."
                        ),
                    )
                observations["execution_policy_sha256"] = policy_hash
                _append_check(
                    checks,
                    failures,
                    name=current_check,
                    passed=True,
                    group="performer",
                    error_code="performer_check_failed",
                    reason="The installed Performer manual Check failed.",
                    observations={
                        "status": checked.check.status,
                        "readiness": checked.readiness.status,
                        "execution_policy_sha256": policy_hash,
                    },
                )

                current_check = "performer_plan_turn"
                plan_request = _performer_turn_request(context, workspace, "plan")
                plan_result, plan_artifacts = _run_installed_turn(
                    command,
                    environment,
                    plan_request,
                    turns_root / "plan",
                    timeout=context.timeout,
                )
                artifacts.extend(plan_artifacts)
                if plan_result.plan is None or len(plan_result.plan.tasks) != 1:
                    raise _PerformerDiagnosticError(
                        "performer_plan_invalid",
                        "The real diagnostic plan must contain exactly one bounded task.",
                    )
                task = plan_result.plan.tasks[0]
                if task.files_likely_touched != ["README.md"] or task.verification_commands != ["git diff --check"]:
                    raise _PerformerDiagnosticError(
                        "performer_plan_scope_invalid",
                        "The real diagnostic plan exceeded its disposable README.md scope.",
                    )
                _append_check(
                    checks,
                    failures,
                    name=current_check,
                    passed=True,
                    group="performer",
                    error_code="performer_plan_invalid",
                    reason="The installed Performer plan turn failed.",
                    observations={"task_count": 1, "thread_id_present": bool(plan_result.thread_id)},
                )

                current_check = "performer_execute_turn"
                execute_request = _performer_turn_request(
                    context,
                    workspace,
                    "execute",
                    task=task,
                    thread_id=plan_result.thread_id,
                )
                execute_result, execute_artifacts = _run_installed_turn(
                    command,
                    environment,
                    execute_request,
                    turns_root / "execute",
                    timeout=context.timeout,
                )
                artifacts.extend(execute_artifacts)
                if execute_result.execute_result is None or execute_result.execute_result.status != "ready_for_gate":
                    raise _PerformerDiagnosticError(
                        "performer_execute_failed",
                        "The installed Performer execute turn did not reach the Gate.",
                    )
                _append_check(
                    checks,
                    failures,
                    name=current_check,
                    passed=True,
                    group="performer",
                    error_code="performer_execute_failed",
                    reason="The installed Performer execute turn failed.",
                    observations={"changed_files": execute_result.execute_result.changed_files},
                )

                verification = subprocess.run(
                    ["git", "-C", str(workspace), "diff", "--check"],
                    check=False,
                    capture_output=True,
                    text=True,
                    timeout=10,
                )
                evidence = {
                    "commands": [
                        {
                            "command": "git diff --check",
                            "passed": verification.returncode == 0,
                            "exit_code": verification.returncode,
                            "output": _sanitize_reason(verification.stdout or verification.stderr or "ok"),
                        }
                    ]
                }
                if verification.returncode != 0:
                    raise _PerformerDiagnosticError(
                        "performer_verification_failed",
                        "The disposable workspace verification command failed.",
                    )

                current_check = "performer_gate_turn"
                gate_request = _performer_turn_request(
                    context,
                    workspace,
                    "gate",
                    task=task,
                    thread_id=execute_result.thread_id,
                    evidence=evidence,
                )
                gate_result, gate_artifacts = _run_installed_turn(
                    command,
                    environment,
                    gate_request,
                    turns_root / "gate",
                    timeout=context.timeout,
                )
                artifacts.extend(gate_artifacts)
                if gate_result.gate_result is None or not gate_result.gate_result.passed:
                    raise _PerformerDiagnosticError(
                        "performer_gate_failed",
                        "The installed Performer Gate turn did not pass.",
                    )
                _append_check(
                    checks,
                    failures,
                    name=current_check,
                    passed=True,
                    group="performer",
                    error_code="performer_gate_failed",
                    reason="The installed Performer Gate turn failed.",
                    observations={
                        "score": gate_result.gate_result.score,
                        "threshold": gate_result.gate_result.threshold,
                    },
                )
                phase_completed = True
            finally:
                control_stderr = _stop_control_process(process)
                _write_report(control_frames_path, {"frames": control_frames})
                control_log_path.write_text(
                    _sanitize_performer_output(control_stderr, environment),
                    encoding="utf-8",
                )
                artifacts.extend((str(control_frames_path), str(control_log_path)))
                if process.returncode not in {0, None} and phase_completed:
                    raise _PerformerDiagnosticError(
                        "performer_control_process_exited",
                        "The installed Performer control process exited unsuccessfully.",
                    )
    except _PerformerDiagnosticError as exc:
        _append_check(
            checks,
            failures,
            name=current_check,
            passed=False,
            group="performer",
            error_code=exc.code,
            reason=str(exc),
            action_required=True,
            next_action="inspect_performer_diagnostic_artifacts",
        )
    except Exception as exc:
        _append_check(
            checks,
            failures,
            name=current_check,
            passed=False,
            group="performer",
            error_code="performer_diagnostic_failed",
            reason=_sanitize_reason(exc),
            action_required=True,
            next_action="inspect_performer_diagnostic_artifacts",
        )

    artifacts_ok = bool(artifacts) and not _artifact_has_secret(artifacts)
    _append_check(
        checks,
        failures,
        name="performer_artifacts_secret_free",
        passed=artifacts_ok,
        group="security",
        error_code="performer_artifact_secret_detected",
        reason="A Performer diagnostic artifact was missing or contained secret/provider-home material.",
        observations={"artifact_count": len(artifacts)},
        action_required=not artifacts_ok,
        next_action="remove_secret_or_private_path_from_performer_artifacts",
    )
    observations.update(
        {
            "control_process_started": any(check["name"] == "performer_control_status" and check["passed"] for check in checks),
            "manual_check_passed": any(check["name"] == "performer_manual_check" and check["passed"] for check in checks),
            "turn_kinds_completed": [
                kind
                for kind in ("plan", "execute", "gate")
                if any(check["name"] == f"performer_{kind}_turn" and check["passed"] for check in checks)
            ],
        }
    )
    return _phase_report(
        context,
        "performer",
        "passed" if not failures else "failed",
        checks=checks,
        failures=failures,
        observations=observations,
        artifacts=artifacts,
    )


def _overall_isolated_fencing_probes(root: Path) -> tuple[dict[str, bool], list[str]]:
    """Exercise duplicate/stale transitions through the real Conductor store boundary.

    These probes intentionally use a fresh store and the public transition methods.  They
    are evidence for fencing/idempotency only; they never stand in for a Linear/Codex run.
    """

    from conductor.models import StaleAttemptError
    from conductor.store import ConductorStore
    from performer_api.workflow import Plan, Task

    probe_root = root / "fencing-probes"
    probe_root.mkdir(parents=True, exist_ok=True)
    store = ConductorStore(probe_root)
    task = Task(
        id="fence-task",
        title="fencing probe",
        objective="exercise the durable result boundary",
        acceptance_criteria=["duplicate results do not advance state twice"],
        verification_commands=["true"],
        files_likely_touched=["README.md"],
    )
    plan = Plan(summary="fencing probe", tasks=[task])

    duplicate_run = store.create_run("parent-duplicate", "E2E-DUP", instance_id="probe")
    store.save_plan(duplicate_run["run_id"], plan)
    execute = store.start_task(duplicate_run["run_id"], task.id)
    store.record_execute(duplicate_run["run_id"], execute["attempt_id"], execute["fencing_token"], ready_for_gate=True)
    gate = store.start_gate(duplicate_run["run_id"], task.id)
    first = store.record_gate(
        duplicate_run["run_id"], gate["attempt_id"], gate["fencing_token"],
        passed=True, score=4, threshold=3, command_passed=1, command_total=1,
        evidence={"probe": "duplicate"},
    )
    duplicate = store.record_gate(
        duplicate_run["run_id"], gate["attempt_id"], gate["fencing_token"],
        passed=True, score=4, threshold=3, command_passed=1, command_total=1,
        evidence={"probe": "duplicate"},
    )
    with store.connect() as connection:
        evidence_count = int(connection.execute("SELECT COUNT(*) FROM gate_evidence WHERE run_id = ?", (duplicate_run["run_id"],)).fetchone()[0])
    duplicate_ok = first == duplicate and evidence_count == 1 and store.get_run(duplicate_run["run_id"])["state"] == "done"

    stale_run = store.create_run("parent-stale", "E2E-STALE", instance_id="probe")
    store.save_plan(stale_run["run_id"], plan)
    stale = store.start_task(stale_run["run_id"], task.id)
    store.record_runtime_wait(
        stale_run["run_id"], stale["attempt_id"], stale["fencing_token"],
        kind="approval_requested", reason="stale probe",
    )
    store.resume_runtime_wait(stale_run["run_id"])
    current = store.start_task(stale_run["run_id"], task.id)
    stale_rejected = False
    try:
        store.record_execute(
            stale_run["run_id"], stale["attempt_id"], stale["fencing_token"], ready_for_gate=True,
        )
    except StaleAttemptError:
        stale_rejected = True
    current_task = store.get_task(stale_run["run_id"], task.id) or {}
    stale_ok = stale_rejected and current["attempt_id"] != stale["attempt_id"] and current_task.get("state") == "in_progress"

    evidence_path = probe_root / "evidence.json"
    _write_report(
        evidence_path,
        {
            "duplicate": {"passed": duplicate_ok, "gate_evidence_count": evidence_count, "run_state": store.get_run(duplicate_run["run_id"])["state"]},
            "stale": {"passed": stale_ok, "stale_rejected": stale_rejected, "current_attempt_id": current["attempt_id"]},
        },
    )
    return {"duplicate": duplicate_ok, "stale": stale_ok}, [str(evidence_path)]


def _overall_conductor_run(
    conductor: _ConductorObserver,
    parent_issue_id: str,
    *,
    timeout: float,
    wait_for_runtime_wait_resolution: bool = False,
) -> tuple[dict[str, Any] | None, list[dict[str, Any]], _HttpObservation]:
    deadline = time.monotonic() + max(timeout, 0.1)
    history: list[dict[str, Any]] = []
    latest = _HttpObservation(0, {})
    matched: dict[str, Any] | None = None
    while time.monotonic() <= deadline:
        latest = conductor.get("/api/managed-runs")
        payload = latest.payload.get("managed_runs") if isinstance(latest.payload, dict) else None
        rows = payload.get("runs") if isinstance(payload, dict) else None
        if isinstance(rows, list):
            candidate = next(
                (row for row in rows if isinstance(row, dict) and str(row.get("parent_issue_id") or "") == parent_issue_id),
                None,
            )
            if candidate is not None:
                matched = candidate
                snapshot = {
                    "state": str(candidate.get("state") or ""),
                    "latest_reason": str(candidate.get("latest_reason") or ""),
                    "run_id": str(candidate.get("run_id") or ""),
                    "plan_version": int(candidate.get("plan_version") or 0),
                    "runtime_waits": candidate.get("runtime_waits") if isinstance(candidate.get("runtime_waits"), list) else [],
                    "tasks": candidate.get("tasks") if isinstance(candidate.get("tasks"), list) else [],
                }
                if not history or snapshot != history[-1]:
                    history.append(snapshot)
                has_open_runtime_wait = any(
                    isinstance(wait, dict) and wait.get("state") == "open"
                    for wait in snapshot["runtime_waits"]
                )
                if snapshot["state"] in {"done", "blocked", "failed"} and not (
                    wait_for_runtime_wait_resolution and has_open_runtime_wait
                ):
                    break
        time.sleep(min(0.25, max(0.0, deadline - time.monotonic())))
    return matched, history, latest


def _overall_task_rows(run: dict[str, Any] | None) -> list[dict[str, Any]]:
    tasks = run.get("tasks") if isinstance(run, dict) and isinstance(run.get("tasks"), list) else []
    return [task for task in tasks if isinstance(task, dict)]


def _overall_plan_contract_ok(name: str, run: dict[str, Any] | None) -> bool:
    expected = {
        scenario: (f"python .e2e/{next(iter(files))}", f".e2e/{next(iter(files))}")
        for scenario, files in _OVERALL_FIXTURES.items()
    }
    plan = run.get("plan") if isinstance(run, dict) else None
    tasks = plan.get("tasks") if isinstance(plan, dict) else None
    if name not in expected or not isinstance(tasks, list) or len(tasks) != 1:
        return False
    task = tasks[0]
    if not isinstance(task, dict):
        return False
    command, file_scope = expected[name]
    return task.get("verification_commands") == [command] and task.get(
        "files_likely_touched"
    ) == [file_scope]


def _linear_issue_state_name(issue: dict[str, Any] | None) -> str:
    state = issue.get("state") if isinstance(issue, dict) else None
    if isinstance(state, dict):
        state = state.get("name") or state.get("type")
    return str(state or "").strip().lower()


def _overall_resume_runtime_wait(
    run: dict[str, Any] | None,
    fixture: LinearFixture,
    repository: Path,
    started_state: dict[str, str],
) -> tuple[bool, str]:
    waits = run.get("runtime_waits") if isinstance(run, dict) else None
    open_waits = [
        wait
        for wait in (waits if isinstance(waits, list) else [])
        if isinstance(wait, dict) and wait.get("state") == "open"
    ]
    if not open_waits:
        return False, "runtime_wait_not_observed"
    wait = open_waits[-1]
    if str(wait.get("kind") or "") != "tool_input_required":
        return False, "runtime_wait_stimulus_unavailable"
    wait_issue_id = str(wait.get("linear_issue_id") or "")
    state_id = str(started_state.get("id") or "")
    if not wait_issue_id or not state_id:
        return False, "runtime_wait_projection_missing"
    try:
        marker = repository / ".e2e" / "input-approved"
        marker.parent.mkdir(parents=True, exist_ok=True)
        marker.write_text("approved\n", encoding="utf-8")
        fixture.transition_issue(wait_issue_id, state_id)
    except (LinearFixtureError, OSError):
        return False, "runtime_wait_reopen_failed"
    return True, ""


def _overall_conductor_binding_ready(
    conductor: _ConductorObserver,
    context: _RunContext,
    execution_policy_sha256: str,
) -> tuple[bool, dict[str, Any]]:
    instances_response = conductor.get("/api/instances")
    instances = (
        instances_response.payload.get("instances")
        if isinstance(instances_response.payload, dict)
        else None
    )
    instance = instances[0] if isinstance(instances, list) and len(instances) == 1 else None
    expected_repository = str(context.settings.get("fixture_repository") or "").strip()
    workspace_matches = False
    if isinstance(instance, dict) and expected_repository:
        try:
            workspace_matches = Path(str(instance.get("workspace_root") or "")).resolve() == Path(
                expected_repository
            ).expanduser().resolve()
        except OSError:
            workspace_matches = False

    managed_response = conductor.get("/api/managed-runs")
    control = (
        managed_response.payload.get("performer_control")
        if isinstance(managed_response.payload, dict)
        else None
    )
    control = control if isinstance(control, dict) else {}
    policy_matches = bool(execution_policy_sha256) and str(
        control.get("execution_policy_sha256") or ""
    ) == execution_policy_sha256
    passed = bool(
        instances_response.status_code == 200
        and managed_response.status_code == 200
        and isinstance(instance, dict)
        and str(instance.get("linear_project") or "") == context.project_slug
        and str(instance.get("process_status") or "") == "running"
        and workspace_matches
        and control.get("status") == "ready"
        and control.get("last_check_status") == "passed"
        and policy_matches
    )
    return passed, {
        "instance_count": len(instances) if isinstance(instances, list) else 0,
        "instance_id": str(instance.get("id") or "") if isinstance(instance, dict) else "",
        "project_matches": bool(
            isinstance(instance, dict)
            and str(instance.get("linear_project") or "") == context.project_slug
        ),
        "workspace_matches": workspace_matches,
        "process_running": bool(
            isinstance(instance, dict) and instance.get("process_status") == "running"
        ),
        "performer_ready": control.get("status") == "ready",
        "manual_check_passed": control.get("last_check_status") == "passed",
        "policy_matches": policy_matches,
    }


def _overall_scenario_passed(name: str, run: dict[str, Any] | None, history: list[dict[str, Any]], issue: dict[str, Any] | None, children: list[dict[str, Any]]) -> bool:
    if not isinstance(run, dict):
        return False
    state = str(run.get("state") or "")
    tasks = _overall_task_rows(run)
    if name == "success":
        return state == "done" and bool(issue and _linear_issue_state_name(issue) in {"done", "completed"}) and bool(tasks) and all(str(task.get("state") or "") == "done" for task in tasks) and all(_linear_issue_state_name(child) in {"done", "completed"} for child in children)
    if name == "rework":
        return state == "done" and bool(tasks) and any(int(task.get("rework_count") or 0) == 1 for task in tasks)
    if name == "block":
        return state == "blocked" and str(run.get("latest_reason") or "").startswith("gate_failed") and bool(tasks) and any(str(task.get("state") or "") == "blocked" and int(task.get("rework_count") or 0) >= 1 for task in tasks)
    if name == "runtime_wait":
        wait_index = next(
            (
                index
                for index, snapshot in enumerate(history)
                if any(
                    isinstance(wait, dict) and wait.get("state") == "open"
                    for wait in snapshot.get("runtime_waits", [])
                )
            ),
            None,
        )
        if wait_index is None:
            return False
        return any(
            str(snapshot.get("state") or "") in {"planning", "executing", "done"}
            and not any(
                isinstance(wait, dict) and wait.get("state") == "open"
                for wait in snapshot.get("runtime_waits", [])
            )
            for snapshot in history[wait_index + 1 :]
        )
    return False


def _run_overall_phase(context: _RunContext, prerequisites: list[dict[str, Any]]) -> dict[str, Any]:
    failed = [str(report.get("phase")) for report in prerequisites if report.get("status") != "passed"]
    same_run = all(str(report.get("run_id") or "") == context.run_id for report in prerequisites)
    metadata_required = not failed and any(bool(report.get("checks")) for report in prerequisites)
    metadata_failures: list[str] = []
    execution_policy_sha256 = ""
    if metadata_required:
        report_by_phase = {str(report.get("phase") or ""): report for report in prerequisites}
        oauth_project = (report_by_phase.get("oauth", {}).get("observations") or {}).get("selected_project") or {}
        linear_project = (report_by_phase.get("linear", {}).get("observations") or {}).get("project") or {}
        performer_observations = report_by_phase.get("performer", {}).get("observations") or {}
        oauth_project_id = str(oauth_project.get("id") or "")
        linear_project_id = str(linear_project.get("id") or "")
        oauth_project_slug = str(oauth_project.get("slug") or oauth_project.get("slug_id") or "")
        linear_project_slug = str(linear_project.get("slug") or linear_project.get("slug_id") or "")
        if (
            not oauth_project_id
            or oauth_project_id != linear_project_id
            or oauth_project_slug != context.project_slug
            or linear_project_slug != context.project_slug
        ):
            metadata_failures.append("project_identity")
        execution_policy_sha256 = str(
            performer_observations.get("execution_policy_sha256") or ""
        )
        if re.fullmatch(r"[0-9a-f]{64}", execution_policy_sha256) is None:
            metadata_failures.append("execution_policy_identity")
    if failed or not same_run or metadata_failures:
        blocked = [*failed, "run_identity"] if not same_run else [*failed]
        blocked.extend(metadata_failures)
        return _phase_report(
            context,
            "overall",
            "skipped",
            blocked_by=blocked,
            failures=(_failure("evidence", "overall_prerequisite_failed", f"overall MVP is blocked by: {', '.join(blocked)}", next_action="fix_root_causes_then_run_a_fresh_phase_all_batch"),),
        )
    checks: list[dict[str, Any]] = []
    failures: list[dict[str, Any]] = []
    fixture_paths, artifacts = _prepare_overall_fixtures(context.artifact_root)
    contract_ok = _fixture_contract_ok(fixture_paths)
    _append_check(checks, failures, name="overall_fixture_plan_contract", passed=contract_ok, group="evidence", error_code="fixture_plan_contract_mismatch", reason="Overall fixtures must contain the exact bounded verification scripts", observations={"fixture_count": len(fixture_paths)}, next_action="repair_overall_fixture_scripts")

    probe_results, probe_artifacts = _overall_isolated_fencing_probes(context.artifact_root)
    _append_check(checks, failures, name="overall_duplicate_result_idempotent", passed=probe_results["duplicate"], group="fence", error_code="duplicate_result_changed_state", reason="The Conductor result boundary must apply an accepted result only once", observations={"probe": "isolated_conductor_store"}, next_action="inspect_duplicate_result_fencing")
    _append_check(checks, failures, name="overall_stale_result_rejected", passed=probe_results["stale"], group="fence", error_code="stale_result_changed_state", reason="A stale attempt must not change the current task", observations={"probe": "isolated_conductor_store"}, next_action="inspect_stale_attempt_fencing")

    observer = _PodiumObserver(context.settings["podium_url"], timeout=context.timeout, browser_observation=context.settings.get("browser_observation", ""))
    managed_runs = observer.get_authenticated("/api/v1/managed-runs")
    conductor_url = context.settings.get("conductor_url", "").strip()
    conductor = _ConductorObserver(conductor_url, timeout=context.timeout) if conductor_url else None
    binding_ok = False
    binding_observation: dict[str, Any] = {"conductor_url_present": bool(conductor_url)}
    if conductor is not None and not conductor.error_code:
        binding_ok, binding_observation = _overall_conductor_binding_ready(
            conductor,
            context,
            execution_policy_sha256,
        )
    _append_check(
        checks,
        failures,
        name="overall_conductor_binding_ready",
        passed=binding_ok,
        group="binding",
        error_code="overall_conductor_binding_mismatch",
        reason="Overall requires one running Conductor bound to the selected project, repository, and compatible checked policy.",
        observations=binding_observation,
        action_required=True,
        next_action="bind_and_check_the_selected_conductor_instance",
    )
    if binding_ok:
        artifacts.extend(probe_artifacts)
    observations: dict[str, Any] = {
        "fixture_root": str(context.artifact_root / "fixtures"),
        "managed_runs_status_code": managed_runs.status_code,
        "conductor_error_code": conductor.error_code if conductor else "conductor_observer_missing",
        "cleanup": "retained_for_audit",
        "scenarios": {},
    }

    scenario_names = ("success", "rework", "block", "runtime_wait")
    scenario_issues: dict[str, dict[str, Any]] = {}
    repository_ok = True
    repository_path = ""
    if conductor_url:
        repository_ok, repository_path, repository_error = _materialize_fixture_repository(context, fixture_paths)
        _append_check(
            checks,
            failures,
            name="overall_fixture_repository_materialized",
            passed=repository_ok,
            group="binding",
            error_code=repository_error or "fixture_repository_materialization_failed",
            reason="Overall verifier scripts must be present in the explicitly approved disposable Conductor repository",
            observations={"repository_configured": bool(context.settings.get("fixture_repository")), "repository_present": bool(repository_path)},
            action_required=True,
            next_action="set_symphony_e2e_fixture_repository_to_the_bound_disposable_git_workspace",
        )
    fixture: LinearFixture | None = None
    project: dict[str, Any] | None = None
    state: dict[str, str] | None = None
    started_state: dict[str, str] | None = None
    app_user_id = ""
    if binding_ok and conductor is not None:
        installation = observer.get_authenticated("/api/v1/linear/installations")
        active = installation.payload.get("active") if isinstance(installation.payload, dict) else None
        app_user_id = str(active.get("app_user_id") or "") if isinstance(active, dict) else ""
        if installation.status_code == 200 and isinstance(active, dict) and str(active.get("state") or "") == "active" and app_user_id and not str(active.get("error_code") or "").strip():
            with _fixture_environment():
                try:
                    fixture = LinearFixture.from_environment(timeout=min(max(context.timeout, 0.1), 20.0))
                    project = fixture.project(context.project_slug)
                    workflow_states = fixture.workflow_states(
                        str((project.get("team") or {}).get("id") or "")
                    )
                    state = _select_backlog_state(workflow_states)
                    started_state = _select_started_state(workflow_states)
                except (LinearFixtureError, ValueError):
                    fixture = None
        if repository_ok and fixture is not None and project is not None and state is not None:
            for name in scenario_names:
                script = next(iter(_OVERALL_FIXTURES[name]))
                command = f"python .e2e/{script}"
                description = (
                    f"Symphony real-e2e scenario={name}. Execute exactly `{command}`. "
                    f"The verification file scope is `.e2e/{script}`; do not edit the verifier."
                )
                try:
                    issue = fixture.create_parent_issue(
                        team_id=str((project.get("team") or {}).get("id") or ""),
                        project_id=str(project.get("id") or ""), state_id=str(state["id"]),
                        title=f"[Symphony real-e2e {context.run_id}] {name}", description=description,
                        delegate_id=app_user_id,
                    )
                    scenario_issues[name] = issue
                except LinearFixtureError as exc:
                    observations["scenarios"][name] = {"error_code": _sanitize_reason(exc)}

    if binding_ok and conductor is not None and scenario_issues:
        with _fixture_environment():
            for name in scenario_names:
                issue = scenario_issues.get(name)
                if issue is None:
                    check_name = {"success": "overall_success_closure", "rework": "overall_gate_rework_block", "block": "overall_gate_rework_block", "runtime_wait": "overall_runtime_wait_resumable"}[name]
                    _append_check(checks, failures, name=check_name, passed=False, group="workflow", error_code="overall_scenario_issue_create_failed", reason=f"The real {name} scenario issue was not created.", observations=observations["scenarios"].get(name, {}), action_required=True, next_action="inspect_linear_fixture_issue_creation")
                    continue
                run, history, latest = _overall_conductor_run(conductor, str(issue.get("id") or ""), timeout=context.timeout)
                plan_contract_ok = _overall_plan_contract_ok(name, run)
                runtime_wait_resumed = False
                runtime_wait_error = ""
                if (
                    name == "runtime_wait"
                    and plan_contract_ok
                    and fixture is not None
                    and started_state is not None
                    and repository_path
                ):
                    runtime_wait_resumed, runtime_wait_error = _overall_resume_runtime_wait(
                        run,
                        fixture,
                        Path(repository_path),
                        started_state,
                    )
                    if runtime_wait_resumed:
                        resumed_run, resumed_history, latest = _overall_conductor_run(
                            conductor,
                            str(issue.get("id") or ""),
                            timeout=context.timeout,
                            wait_for_runtime_wait_resolution=True,
                        )
                        run = resumed_run or run
                        for snapshot in resumed_history:
                            if not history or snapshot != history[-1]:
                                history.append(snapshot)
                children: list[dict[str, Any]] = []
                current_issue = issue
                if fixture is not None:
                    try:
                        current_issue = fixture.issue(str(issue.get("id") or ""))
                        children = fixture.children(str(issue.get("id") or ""))
                    except LinearFixtureError:
                        children = []
                passed = plan_contract_ok and (
                    name != "runtime_wait" or runtime_wait_resumed
                ) and _overall_scenario_passed(
                    name,
                    run,
                    history,
                    current_issue,
                    children,
                )
                observations["scenarios"][name] = {
                    "parent_issue_id": issue.get("id"), "identifier": issue.get("identifier"),
                    "run_id": run.get("run_id") if isinstance(run, dict) else "",
                    "state": run.get("state") if isinstance(run, dict) else "",
                    "history_states": [snapshot.get("state") for snapshot in history],
                    "children": len(children), "status_code": latest.status_code,
                    "plan_contract_ok": plan_contract_ok,
                    "runtime_wait_resumed": runtime_wait_resumed,
                    "runtime_wait_error": runtime_wait_error,
                }
                check_name = {"success": "overall_success_closure", "rework": "overall_gate_rework_block", "block": "overall_gate_rework_block", "runtime_wait": "overall_runtime_wait_resumable"}[name]
                error_code = (
                    "fixture_plan_contract_mismatch"
                    if not plan_contract_ok
                    else runtime_wait_error or "overall_scenario_not_observed"
                )
                _append_check(checks, failures, name=check_name, passed=passed, group="workflow", error_code=error_code, reason=f"Real {name} scenario did not reach its required durable state", observations=observations["scenarios"][name], action_required=True, next_action="inspect_conductor_managed_run_and_linear_projection")
    else:
        for name in scenario_names:
            check_name = {"success": "overall_success_closure", "rework": "overall_gate_rework_block", "block": "overall_gate_rework_block", "runtime_wait": "overall_runtime_wait_resumable"}[name]
            _append_check(checks, failures, name=check_name, passed=False, group="workflow", error_code="overall_product_evidence_unavailable", reason="A real delegated issue and enrolled Conductor are required; no fixture success is inferred", observations={"conductor_url_present": bool(conductor_url), "scenario": name}, action_required=True, next_action="restore_oauth_linear_fixture_and_enrolled_conductor")

    redaction_ok = not _browser_payload_has_secret(managed_runs.payload)
    _append_check(checks, failures, name="overall_redaction_parity", passed=redaction_ok, group="redaction", error_code="overall_runtime_artifact_secret_detected", reason="Managed-run evidence must remain sanitized across Podium and Conductor surfaces", observations={"managed_runs_status_code": managed_runs.status_code}, next_action="inspect_runtime_report_redaction")
    return _phase_report(context, "overall", "passed" if not failures else "failed", checks=checks, failures=failures, observations=observations, artifacts=sorted(set(artifacts)))


def _run_phase_safely(context: _RunContext, phase: str) -> dict[str, Any]:
    runners = {
        "oauth": _run_oauth_phase,
        "linear": _run_linear_phase,
        "performer": _run_performer_phase,
    }
    try:
        return runners[phase](context)
    except Exception as exc:
        return _phase_report(
            context,
            phase,
            "failed",
            failures=(_failure("evidence", "real_flow_phase_failed", f"{type(exc).__name__}: {_sanitize_reason(exc)}", next_action=f"inspect_{phase}_phase_artifacts"),),
        )


def _archive_conductor_evidence(context: _RunContext) -> list[str]:
    """Archive the enrolled local Conductor's sanitized API evidence for this batch."""

    conductor_url = str(context.settings.get("conductor_url") or "").strip()
    if not conductor_url:
        return []
    observer = _ConductorObserver(conductor_url, timeout=context.timeout)
    if observer.error_code:
        return []
    artifacts: list[str] = []
    instances = observer.get("/api/instances")
    instance_rows = instances.payload.get("instances") if isinstance(instances.payload, dict) else []
    if not isinstance(instance_rows, list):
        instance_rows = []
    for row in instance_rows:
        if not isinstance(row, dict) or not str(row.get("id") or ""):
            continue
        instance_id = str(row["id"])
        logs = observer.get(f"/api/instances/{instance_id}/logs")
        path = context.artifact_root / "logs" / "conductor" / f"{instance_id}.json"
        _write_report(path, {"instance_id": instance_id, "status_code": logs.status_code, "payload": logs.payload, "error_code": logs.error_code})
        artifacts.append(str(path))
    managed = observer.get("/api/managed-runs")
    path = context.artifact_root / "logs" / "conductor" / "managed-runs.json"
    _write_report(path, {"status_code": managed.status_code, "payload": managed.payload, "error_code": managed.error_code})
    artifacts.append(str(path))
    return artifacts


def run(args: argparse.Namespace) -> int:
    # Calls without --phase are the intentionally retained local preflight.
    phase = getattr(args, "phase", None)
    if phase is None:
        return _legacy_preflight(args)
    output_path = _diagnostic_output_path(args.out, phase) if phase != "all" else args.out
    context = _context(args, output_path=output_path)
    try:
        if phase == "all":
            prerequisites = [_write_phase(context, _run_phase_safely(context, name)) for name in _DIAGNOSTIC_PHASES]
            try:
                overall_report = _run_overall_phase(context, prerequisites)
            except Exception as exc:
                overall_report = _phase_report(
                    context,
                    "overall",
                    "failed",
                    failures=(_failure("evidence", "real_flow_overall_failed", f"{type(exc).__name__}: {_sanitize_reason(exc)}", next_action="inspect_overall_phase_artifacts"),),
                )
            overall = _write_phase(context, overall_report)
            reports = [*prerequisites, overall]
            archived_artifacts = _archive_conductor_evidence(context)
            status = "passed" if all(report.get("status") == "passed" for report in reports) else "failed"
            batch = {
                "run_id": context.run_id,
                "phase": "batch",
                "status": status,
                "acceptance": status == "passed",
                "artifact_root": str(context.artifact_root),
                "artifacts": archived_artifacts,
                "phases": reports,
            }
            _write_manifest(context)
            _write_report(context.output_path, batch)
            return 0 if status == "passed" else 2

        report = _write_phase(context, _run_phase(phase, context))
        _write_manifest(context)
        _write_report(context.output_path, report)
        return 0 if report.get("status") == "passed" else 2
    except Exception as exc:  # the report must exist for operator-visible failures
        failure = _failure(
            "evidence",
            "real_flow_unhandled",
            f"{type(exc).__name__}: {_sanitize_reason(exc)}",
            next_action="inspect_runner_failure_artifacts",
        )
        report = {
            "run_id": context.run_id,
            "phase": "batch" if phase == "all" else phase,
            "status": "failed",
            "acceptance": False,
            "artifact_root": str(context.artifact_root),
            "failures": [failure],
            "phases": context.phase_reports,
        }
        _write_manifest(context)
        _write_report(context.output_path, report)
        print(f"real_flow failed: {type(exc).__name__}: {_sanitize_reason(exc)}", file=sys.stderr)
        return 1


def _run_phase(phase: str, context: _RunContext) -> dict[str, Any]:
    runners = {
        "oauth": _run_oauth_phase,
        "linear": _run_linear_phase,
        "performer": _run_performer_phase,
    }
    runner = runners.get(phase)
    if runner is None:
        raise ValueError(f"unsupported_phase:{phase}")
    return runner(context)


def main(argv: list[str] | None = None) -> int:
    parsed = _parser().parse_args(argv)
    try:
        return run(parsed)
    except Exception as exc:
        _write_report(
            parsed.out,
            {
                "status": "failed",
                "error_code": "real_flow_unhandled",
                "sanitized_reason": _sanitize_reason(exc),
            },
        )
        print(f"real_flow failed: {type(exc).__name__}: {_sanitize_reason(exc)}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
