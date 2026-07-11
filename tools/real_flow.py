"""Run the one supported real Symphony flow.

This replaces the retired scenario/observer/auditor tree.  The runner performs
strict preflight before mutating Linear and writes a small report on every exit.
The actual services are started by the operator so the tool cannot silently
fall back to fake Codex or the user's default ``~/.codex`` home.
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path
import sys
from datetime import datetime, timezone
import re

from linear_fixture import LinearFixture, LinearFixtureError, required_environment


def _sanitize_reason(value: object) -> str:
    text = str(value or "").replace("\r", " ").replace("\n", " ").strip()
    text = re.sub(r"(?i)\b(bearer|basic)\s+[^\s,;]+", r"\1 [REDACTED]", text)
    return text[:500]


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Run the single polling Linear/Codex Symphony flow")
    parser.add_argument("--project-slug", default="", help="Linear project slug (or SYMPHONY_E2E_PROJECT_SLUG)")
    parser.add_argument("--out", type=Path, default=Path(".test-real-flow/report.json"))
    parser.add_argument("--timeout", type=float, default=600.0)
    parser.add_argument("--offline", action="store_true", help="validate staged runtime inputs without Linear mutations")
    return parser


def _write_report(path: Path, report: dict[str, object]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def run(args: argparse.Namespace) -> int:
    settings = required_environment()
    project_slug = str(args.project_slug or settings["project_slug"]).strip()
    report: dict[str, object] = {
        "started_at": datetime.now(timezone.utc).isoformat(),
        "flow": "linear-polling-plan-subissues-execute-gate",
        "offline": bool(args.offline),
        "project_slug": project_slug,
        "checks": [],
        "status": "failed",
    }

    def check(name: str, passed: bool, **details: object) -> None:
        cast = report["checks"]
        assert isinstance(cast, list)
        cast.append({"name": name, "passed": passed, **details})

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
        report["next_action"] = "run_without_--offline_against_a_clean_test_project"
        _write_report(args.out, report)
        return 0

    try:
        fixture = LinearFixture.from_environment(timeout=args.timeout)
        project = fixture.project(project_slug)
        check("linear_project_visible", True, project_id=project.get("id"), team_id=(project.get("team") or {}).get("id"))
    except LinearFixtureError as exc:
        report["error_code"] = "linear_fixture_failed"
        report["sanitized_reason"] = _sanitize_reason(exc)
        report["next_action"] = "fix_linear_credentials_or_project_scope"
        _write_report(args.out, report)
        return 2

    # Dispatch and service observation are intentionally explicit operator steps:
    # the runner must never claim a gate passed without reading the product-owned
    # Podium/Conductor report and Linear child tree.
    report["status"] = "preflight_ready"
    report["next_action"] = "start_podium_and_conductor_then_run_the_delegated_parent"
    _write_report(args.out, report)
    return 0


def main(argv: list[str] | None = None) -> int:
    parsed = _parser().parse_args(argv)
    try:
        return run(parsed)
    except Exception as exc:  # the report must exist for operator-visible failures
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
