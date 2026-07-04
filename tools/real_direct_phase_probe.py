from __future__ import annotations

import argparse
import asyncio
import json
import os
import shutil
import subprocess
import time
import uuid
from pathlib import Path
from typing import Any

from conductor.conductor_models import ConductorSettings, InstanceCreateRequest, InstancePatchRequest
from conductor.conductor_runtime import ConductorRuntimeManager
from conductor.conductor_service import ConductorService
from conductor.conductor_store import ConductorStore
from performer_api.labels import PHASE_LABELS

from real_symphony_e2e import (
    LINEAR_ENDPOINT,
    create_linear_issue,
    fetch_linear_issue,
    linear_graphql,
    patch_workflow,
    utc_now,
)


def _make_fixture_repo(path: Path) -> Path:
    if path.exists():
        shutil.rmtree(path)
    (path / "tests").mkdir(parents=True)
    (path / "pyproject.toml").write_text('[tool.pytest.ini_options]\ntestpaths = ["tests"]\n', encoding="utf-8")
    (path / "tests" / "test_smoke.py").write_text("def test_smoke_fixture():\n    assert True\n", encoding="utf-8")
    (path / "README.md").write_text("Symphony direct phase probe fixture.\n", encoding="utf-8")
    subprocess.run(["git", "init", "-q"], cwd=path, check=True)
    subprocess.run(["git", "config", "user.email", "direct-probe@example.com"], cwd=path, check=True)
    subprocess.run(["git", "config", "user.name", "Symphony Direct Probe"], cwd=path, check=True)
    subprocess.run(["git", "add", "."], cwd=path, check=True)
    subprocess.run(["git", "commit", "-q", "-m", "base"], cwd=path, check=True)
    return path


def _patch_direct_workflow(workflow_path: Path, *, workspace_root: str) -> str:
    workflow = patch_workflow(workflow_path, acceptance_gates=False)
    workflow = workflow.replace("https://podium.example/api/v1/linear/graphql", LINEAR_ENDPOINT)
    workflow = workflow.replace("$PODIUM_PROXY_TOKEN", "$LINEAR_API_KEY")
    workflow = workflow.replace(f"  root: {workspace_root}\n", f"  root: {workspace_root}\n")
    workflow = workflow.replace("repository_handoff:\n  enabled: true\n", "repository_handoff:\n  enabled: false\n")
    workflow = workflow.replace("  max_concurrent_agents: 10\n  max_turns: 20\n", "  max_concurrent_agents: 1\n  max_turns: 1\n")
    return workflow


async def _wait_for_direct_run(
    *,
    service: ConductorService,
    instance_id: str,
    issue_id: str,
    token: str,
    timeout_seconds: int,
) -> dict[str, Any]:
    deadline = time.monotonic() + timeout_seconds
    samples: list[dict[str, Any]] = []
    direct_dispatch_seen = False
    phase_started_seen = False
    terminal_seen = False
    last_background: dict[str, Any] = {}
    while time.monotonic() < deadline:
        background = await service.coordinate_background_once()
        last_background = background
        instance = service.get_instance(instance_id)
        run = service.store.get_orchestration_run_by_issue(instance_id, issue_id)
        issue = await fetch_linear_issue(token, issue_id)
        sample = {
            "at": utc_now(),
            "background": background,
            "process_status": instance.process_status if instance else None,
            "issue_state": issue["state"],
            "run": run.to_dict() if run else None,
        }
        samples.append(sample)
        direct_dispatch_seen = direct_dispatch_seen or background.get("direct_dispatches_received", 0) > 0 or run is not None
        phase_started_seen = phase_started_seen or bool(run and run.request_path and run.result_path)
        terminal_seen = terminal_seen or bool(run and run.phase.value in {"done", "failed"})
        if terminal_seen:
            return {
                "samples": samples,
                "run": run.to_dict() if run else None,
                "issue": issue,
                "last_background": last_background,
                "direct_dispatch_seen": direct_dispatch_seen,
                "phase_started_seen": phase_started_seen,
                "terminal_seen": terminal_seen,
            }
        await asyncio.sleep(2)
    run = service.store.get_orchestration_run_by_issue(instance_id, issue_id)
    issue = await fetch_linear_issue(token, issue_id)
    return {
        "samples": samples,
        "run": run.to_dict() if run else None,
        "issue": issue,
        "last_background": last_background,
        "direct_dispatch_seen": direct_dispatch_seen,
        "phase_started_seen": phase_started_seen,
        "terminal_seen": terminal_seen,
    }


async def run(args: argparse.Namespace) -> dict[str, Any]:
    token = os.environ.get("LINEAR_API_KEY", "").strip()
    if not token:
        raise RuntimeError("LINEAR_API_KEY is required")
    out = args.out.resolve()
    out.mkdir(parents=True, exist_ok=True)
    run_id = f"direct-phase-{uuid.uuid4().hex[:8]}"
    fixture = _make_fixture_repo(out / "fixture-repo")
    linear = await create_linear_issue(token, args.project_slug, run_id)
    service = ConductorService(
        store=ConductorStore(out / "conductor-data"),
        data_root=out / "conductor-data",
        runtime_manager=ConductorRuntimeManager(),
    )
    service.update_settings(ConductorSettings(managed_mode=False))
    payload = InstanceCreateRequest(
        name=f"Direct {run_id}",
        repo_source_type="local_path",
        repo_source_value=str(fixture),
        linear_project=linear["project"]["slugId"],
        linear_filters={"active_states": ["Todo", "In Progress"]},
        workflow_profile="task",
        workflow_inputs={"goal": "Run the real Symphony direct phase probe."},
    )
    instance = service.create_instance(payload)
    workflow = _patch_direct_workflow(Path(instance.workflow_path), workspace_root=instance.workspace_root)
    instance = service.update_instance(instance.id, InstancePatchRequest(workflow_content=workflow))
    report: dict[str, Any] = {
        "started_at": utc_now(),
        "run_id": run_id,
        "issue": {
            "id": linear["issue"]["id"],
            "identifier": linear["issue"]["identifier"],
            "url": linear["issue"]["url"],
        },
        "instance": instance.to_dict(include_workflow_content=False),
        "checks": [],
        "failures": [],
    }

    def check(name: str, passed: bool, **details: Any) -> None:
        row = {"name": name, "passed": passed, **details}
        report["checks"].append(row)
        if not passed:
            report["failures"].append(row)

    try:
        result = await _wait_for_direct_run(
            service=service,
            instance_id=instance.id,
            issue_id=linear["issue"]["id"],
            token=token,
            timeout_seconds=args.timeout,
        )
        report["result"] = result
        final_run = result.get("run") or {}
        final_issue = result.get("issue") or {}
        check("direct-poll:dispatch-received", bool(result.get("direct_dispatch_seen")), run=final_run)
        check("direct-poll:phase-started", bool(result.get("phase_started_seen")), run=final_run)
        check(
            "direct-poll:terminal-phase",
            bool(result.get("terminal_seen")) and final_run.get("phase") in {"done", "failed"},
            run=final_run,
        )
        check(
            "direct-poll:linear-phase-label-visible",
            any(label["name"] in {PHASE_LABELS["completed"], PHASE_LABELS["failed"]} for label in final_issue.get("labels", {}).get("nodes", [])),
            labels=[label["name"] for label in final_issue.get("labels", {}).get("nodes", [])],
        )
        check(
            "direct-poll:no-managed-credentials",
            not service.settings().podium_proxy_token and not service.settings().managed_mode,
            settings=service.settings().to_public_dict(),
        )
    finally:
        current = service.get_instance(instance.id)
        if current is not None:
            await service.stop_instance(instance.id)
        try:
            archive = await linear_graphql(
                token,
                """
                mutation ArchiveIssue($id: String!) {
                  issueArchive(id: $id) { success entity { id } }
                }
                """,
                {"id": linear["issue"]["id"]},
            )
            report["archive"] = archive.get("issueArchive")
        except Exception as exc:
            report["archive"] = {"success": False, "error": str(exc)}
    report["completed_at"] = utc_now()
    report_path = out / "real-direct-phase-probe-report.json"
    report_path.write_text(json.dumps(report, indent=2, sort_keys=True), encoding="utf-8")
    return report


def parser() -> argparse.ArgumentParser:
    arg_parser = argparse.ArgumentParser(description="Run a real Linear direct-mode Conductor phase probe.")
    arg_parser.add_argument("--out", type=Path, default=Path(".test-real-flow/e2e-direct-phase-probe"))
    arg_parser.add_argument("--project-slug", default="8ab43179fb54")
    arg_parser.add_argument("--timeout", type=int, default=420)
    return arg_parser


def main() -> int:
    args = parser().parse_args()
    try:
        report = asyncio.run(run(args))
    except Exception as exc:
        print(f"real_direct_phase_probe failed: {exc!r}")
        return 1
    report_path = args.out / "real-direct-phase-probe-report.json"
    print(json.dumps({"report": str(report_path), "failures": len(report["failures"])}, indent=2))
    return 0 if not report["failures"] else 2


if __name__ == "__main__":
    raise SystemExit(main())
