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
import sys
from typing import Any, Iterable
from uuid import uuid4

import httpx

try:  # package import for pytest; top-level fallback for ``python tools/real_flow.py``
    from .linear_fixture import LinearFixture, LinearFixtureError, required_environment
except ImportError:  # pragma: no cover - exercised by the documented script entrypoint
    from linear_fixture import LinearFixture, LinearFixtureError, required_environment


_DIAGNOSTIC_PHASES = ("oauth", "linear", "performer")
_SENSITIVE_KEY = re.compile(
    r"(?i)(?:access[-_]?token|refresh[-_]?token|api[-_]?key|client[-_]?secret|"
    r"authorization|password|cookie|secret|credential|auth(?:entication)?)"
)
_BEARER = re.compile(r"(?i)\b(bearer|basic)\s+[^\s,;]+")
_SECRET_LITERAL = re.compile(
    r"(?i)\b(?:sk-[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|"
    r"github_pat_[A-Za-z0-9_]{20,}|lin_(?:oauth|api)_[A-Za-z0-9_-]{12,})\b"
)
_AUTH_PATH = re.compile(r"(?i)(?:^|[/\\])auth\.json(?:$|[/\\])")
_CODEX_HOME_PATH = re.compile(r"(?i)(?:^|[/\\])\.codex(?:$|[/\\])")


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


class _PodiumObserver:
    """Read-only Podium HTTP observer used by the real phases."""

    def __init__(self, base_url: str, *, timeout: float) -> None:
        self.base_url = base_url.rstrip("/")
        # A dead Podium must fail visibly within one bounded probe window.
        self.timeout = min(max(0.1, float(timeout)), 20.0)

    def get(self, path: str) -> _HttpObservation:
        url = f"{self.base_url}/{path.lstrip('/')}"
        try:
            response = httpx.get(
                url,
                timeout=self.timeout,
                follow_redirects=False,
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

    if _SENSITIVE_KEY.search(key):
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

    seed = Path(settings["codex_seed"]).expanduser() if settings["codex_seed"] else None
    check("staged_codex_seed", bool(seed and seed.is_dir() and seed.name != ".codex"), required=True)
    check("podium_url", bool(settings["podium_url"]), required=not args.offline)
    check("project_slug", bool(project_slug), required=not args.offline)
    if not all(item["passed"] or not item["required"] for item in report["checks"]):
        report["error_code"] = "real_flow_preflight_failed"
        report["next_action"] = "stage_codex_home_and_set_linear_podium_environment"
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


def _context(args: argparse.Namespace) -> _RunContext:
    settings = required_environment()
    project_slug = str(args.project_slug or settings["project_slug"]).strip()
    run_id = _new_run_id()
    root = _artifact_root(args.out, run_id)
    root.mkdir(parents=True, exist_ok=False)
    _write_report(
        root / "inputs.json",
        {
            "run_id": run_id,
            "project_slug": project_slug,
            "podium_url_present": bool(settings["podium_url"]),
            "codex_seed_name": Path(settings["codex_seed"]).name if settings["codex_seed"] else "",
        },
    )
    return _RunContext(
        run_id=run_id,
        artifact_root=root,
        output_path=args.out,
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
    observer = _PodiumObserver(context.settings["podium_url"], timeout=context.timeout)

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

    authenticated = observer.get("/api/v1/auth/me")
    user = authenticated.payload.get("user")
    auth_session_ok = authenticated.status_code == 200 and isinstance(user, dict)
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

    installations = observer.get("/api/v1/linear/installations")
    active = installations.payload.get("active")
    active_ok = installations.status_code == 200 and isinstance(active, dict) and str(active.get("state") or "") == "active"
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

    projects = observer.get("/api/v1/linear/projects")
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
        passed=projects.status_code == 200 and selected_project is not None,
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

    runtimes = observer.get("/api/v1/runtimes")
    runtime_rows = runtimes.payload.get("runtimes")
    conductor_rows = runtimes.payload.get("conductors")
    has_runtime = bool(runtime_rows or conductor_rows)
    _append_check(
        checks,
        failures,
        name="oauth_existing_runtime_enrolled",
        passed=runtimes.status_code == 200 and has_runtime,
        group="binding",
        error_code="runtime_not_enrolled",
        reason="OAuth phase reuses one enrolled runtime and never creates a replacement",
        observations={"status_code": runtimes.status_code, "runtime_count": len(runtime_rows or []) if isinstance(runtime_rows, list) else 0},
        next_action="enroll_one_conductor_then_rerun_the_batch",
    )

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
    if context.offline:
        return _offline_phase(context, "linear")
    checks: list[dict[str, Any]] = []
    failures: list[dict[str, Any]] = []
    observations: dict[str, Any] = {}
    observer = _PodiumObserver(context.settings["podium_url"], timeout=context.timeout)
    fixture: LinearFixture | None = None
    project: dict[str, Any] | None = None
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
                reason="The staged Linear fixture credential must read viewer data",
                observations={"viewer_id": viewer_id, "token_present": True},
                next_action="fix_podium_linear_app_access_token",
            )
        except LinearFixtureError as exc:
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
                observations["project"] = {
                    "id": project.get("id"),
                    "team_id": (project.get("team") or {}).get("id"),
                    "slug": project.get("slugId"),
                }
                _append_check(
                    checks,
                    failures,
                    name="linear_fixture_project_visible",
                    passed=True,
                    group="linear",
                    error_code="linear_project_not_found",
                    reason="The configured Linear project must be readable",
                    observations=observations["project"],
                )
            except LinearFixtureError as exc:
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
                reason="Project lookup cannot run until the fixture credential is readable",
                next_action="fix_podium_linear_app_access_token",
            )

        state = None
        if fixture is not None and project is not None:
            team_id = str((project.get("team") or {}).get("id") or "")
            try:
                states = fixture.workflow_states(team_id)
                state = _select_backlog_state(states)
                _append_check(
                    checks,
                    failures,
                    name="linear_fixture_backlog_state_unambiguous",
                    passed=True,
                    group="linear",
                    error_code="linear_fixture_state_ambiguous",
                    reason="Exactly one backlog/unstarted state must be selected",
                    observations={"state_id": state["id"], "state_type": state["type"]},
                )
            except (LinearFixtureError, ValueError) as exc:
                _append_check(
                    checks,
                    failures,
                    name="linear_fixture_backlog_state_unambiguous",
                    passed=False,
                    group="linear",
                    error_code="linear_fixture_state_ambiguous",
                    reason=_sanitize_reason(exc),
                    next_action="choose_one_disposable_backlog_state",
                )
        else:
            _append_check(
                checks,
                failures,
                name="linear_fixture_backlog_state_unambiguous",
                passed=False,
                group="linear",
                error_code="linear_fixture_state_unavailable",
                reason="Workflow state lookup requires a readable project",
                next_action="fix_linear_project_scope",
            )

        active_installation = observer.get("/api/v1/linear/installations")
        active = active_installation.payload.get("active")
        app_user_id = str(active.get("app_user_id") or "") if isinstance(active, dict) else ""
        if fixture is not None and project is not None and state is not None and app_user_id:
            try:
                parent = fixture.create_parent_issue(
                    team_id=str((project.get("team") or {}).get("id") or ""),
                    project_id=str(project.get("id") or ""),
                    state_id=str(state["id"]),
                    title=f"[Symphony real-e2e {context.run_id}] Linear dispatch probe",
                    description="Diagnostic fixture only. Do not manually transition this issue.",
                    delegate_id=app_user_id,
                )
                _append_check(
                    checks,
                    failures,
                    name="linear_fixture_parent_created",
                    passed=True,
                    group="linear",
                    error_code="linear_issue_create_failed",
                    reason="A disposable parent issue must be created through the fixture helper",
                    observations={"issue_id": parent.get("id"), "identifier": parent.get("identifier")},
                )
            except LinearFixtureError as exc:
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
                reason="Parent creation requires a readable project, state, and existing app user",
                next_action="repair_oauth_installation_and_fixture_access",
            )

        if fixture is not None and parent is not None:
            try:
                issue = fixture.issue(str(parent["id"]))
                children = fixture.children(str(parent["id"]))
                issue_parent_ok = issue.get("parent") is None
                child_parent_ok = all(
                    isinstance(child.get("parent"), dict)
                    and child["parent"].get("id") == parent.get("id")
                    and child["parent"].get("identifier") == parent.get("identifier")
                    for child in children
                )
                _append_check(
                    checks,
                    failures,
                    name="linear_fixture_parent_tree_explicit",
                    passed=issue_parent_ok and child_parent_ok,
                    group="linear",
                    error_code="linear_parent_tree_mismatch",
                    reason="Parent and child reads must include explicit parent fields",
                    observations={"child_count": len(children), "parent_is_null": issue_parent_ok},
                    next_action="inspect_linear_fixture_parent_fields",
                )
            except LinearFixtureError as exc:
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
                reason="Parent tree reads require a successfully created disposable issue",
                next_action="fix_linear_write_scope",
            )

    health = observer.get("/api/v1/health")
    _append_check(
        checks,
        failures,
        name="podium_health_and_reconciliation",
        passed=health.status_code == 200 and health.payload.get("status") == "ok",
        group="linear",
        error_code="podium_reconciliation_unhealthy",
        reason="Podium health must be ok after its reconciliation loop starts",
        observations={"status_code": health.status_code, "status": health.payload.get("status"), "error_code": health.error_code},
        retryable=True,
        next_action="inspect_podium_linear_reconciliation_log",
    )

    selected_projects = observer.get("/api/v1/linear/projects")
    _append_check(
        checks,
        failures,
        name="podium_selected_project_visible",
        passed=selected_projects.status_code == 200,
        group="binding",
        error_code="podium_selected_project_unavailable",
        reason="Podium must expose the already selected project without changing it",
        observations={"status_code": selected_projects.status_code, "project_slug": context.project_slug},
        next_action="reuse_the_existing_authenticated_podium_session",
    )

    runtime_list = observer.get("/api/v1/runtimes")
    _append_check(
        checks,
        failures,
        name="podium_runtime_identity_visible",
        passed=runtime_list.status_code == 200,
        group="binding",
        error_code="runtime_identity_unavailable",
        reason="An enrolled runtime identity is required for dispatch routing",
        observations={"status_code": runtime_list.status_code},
        next_action="reuse_one_enrolled_runtime",
    )

    dispatch_probe = observer.post("/api/v1/runtime/dispatches/lease")
    _append_check(
        checks,
        failures,
        name="podium_dispatch_lease_probe",
        passed=False,
        group="binding",
        error_code="dispatch_probe_credentials_unavailable",
        reason="The dispatch lease probe requires the enrolled runtime bearer and never uses the Linear fixture token",
        observations={"status_code": dispatch_probe.status_code, "error_code": dispatch_probe.error_code},
        action_required=True,
        next_action="run_the_lease_probe_from_the_enrolled_conductor",
    )

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


def _run_performer_phase(context: _RunContext) -> dict[str, Any]:
    if context.offline:
        return _offline_phase(context, "performer")
    return _phase_report(
        context,
        "performer",
        "blocked",
        failures=(
            _failure(
                "provider",
                "performer_observation_not_started",
                "Performer phase requires a fresh isolated runtime and the staged Codex seed",
                action_required=True,
                next_action="start_isolated_conductor_and_run_performer_turns",
            ),
        ),
    )


def _run_overall_phase(context: _RunContext, prerequisites: list[dict[str, Any]]) -> dict[str, Any]:
    failed = [str(report.get("phase")) for report in prerequisites if report.get("status") != "passed"]
    if failed:
        return _phase_report(
            context,
            "overall",
            "skipped",
            blocked_by=failed,
            failures=(
                _failure(
                    "evidence",
                    "overall_prerequisite_failed",
                    f"overall MVP is blocked by: {', '.join(failed)}",
                    next_action="fix_root_causes_then_run_a_fresh_phase_all_batch",
                ),
            ),
        )
    return _phase_report(
        context,
        "overall",
        "blocked",
        failures=(
            _failure(
                "workflow",
                "overall_observation_not_started",
                "Overall MVP fixtures require all three real prerequisite phases",
                next_action="run_a_fresh_phase_all_batch",
            ),
        ),
    )


def run(args: argparse.Namespace) -> int:
    # Calls without --phase are the intentionally retained local preflight.
    phase = getattr(args, "phase", None)
    if phase is None:
        return _legacy_preflight(args)
    context = _context(args)
    try:
        if phase == "all":
            prerequisites = [
                _write_phase(context, _run_oauth_phase(context)),
                _write_phase(context, _run_linear_phase(context)),
                _write_phase(context, _run_performer_phase(context)),
            ]
            overall = _write_phase(context, _run_overall_phase(context, prerequisites))
            reports = [*prerequisites, overall]
            status = "passed" if all(report.get("status") == "passed" for report in reports) else "failed"
            batch = {
                "run_id": context.run_id,
                "phase": "batch",
                "status": status,
                "acceptance": status == "passed",
                "artifact_root": str(context.artifact_root),
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
