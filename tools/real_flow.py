"""Run the single supported real Symphony flow.

The runner is deliberately the only real-flow entrypoint.  ``--phase all``
creates one run identity, executes OAuth, Linear, and Performer observations,
then evaluates the Overall gate.  A failed phase is recorded and does not
prevent later phases from collecting their own evidence.
"""

from __future__ import annotations

import argparse
from dataclasses import dataclass, field
from datetime import datetime, timezone
import json
from pathlib import Path
import re
import sys
from typing import Any, Iterable
from uuid import uuid4

try:  # package import for pytest; top-level fallback for ``python tools/real_flow.py``
    from .linear_fixture import LinearFixture, LinearFixtureError, required_environment
except ImportError:  # pragma: no cover - exercised by the documented script entrypoint
    from linear_fixture import LinearFixture, LinearFixtureError, required_environment


_PHASES = ("oauth", "linear", "performer", "overall")
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
            "codex_seed_path": settings["codex_seed"],
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
    return _phase_report(
        context,
        "oauth",
        "blocked",
        checks=(),
        failures=(
            _failure(
                "auth",
                "oauth_browser_session_unavailable",
                "the existing signed-in browser session must be observed by the operator",
                action_required=True,
                next_action="reuse_existing_signed_in_browser_session",
            ),
        ),
    )


def _run_linear_phase(context: _RunContext) -> dict[str, Any]:
    if context.offline:
        return _offline_phase(context, "linear")
    return _phase_report(
        context,
        "linear",
        "blocked",
        failures=(
            _failure(
                "linear",
                "linear_observation_not_started",
                "Linear phase requires a healthy Podium process and existing OAuth installation",
                action_required=True,
                next_action="start_podium_and_reuse_existing_installation",
            ),
        ),
    )


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
