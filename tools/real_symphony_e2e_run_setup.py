from __future__ import annotations

import argparse
import json
import os
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from real_symphony_e2e_acceptance import (
    _effective_permission_approval_probe,
    _pipeline_scenario,
    _pipeline_scenario_issue_description,
    _prepare_pipeline_scenario_fixture,
    _run_appendix_pytest_hardening_probes,
)
from real_symphony_e2e_analysis import build_instance_payload
from real_symphony_e2e_artifacts import _checkpoint_and_block_after_stage, _stages_after
from real_symphony_e2e_common import (
    Evidence,
    allocate_port,
    api_url,
    http_json,
    make_fixture_repo,
    run_cmd,
    start_process,
    utc_now,
    wait_for_http_ready,
)
from real_symphony_e2e_errors import E2EConfigurationError
from real_symphony_e2e_linear import (
    create_linear_issue,
    delegate_linear_issue,
    fetch_linear_viewer,
    resolve_project,
    wait_for_linear_delegate_visible,
)
from real_symphony_e2e_preflight import (
    _codex_settings_from_args,
    build_runtime_config_payload,
    cleanup_staged_codex_home,
    e2e_codex_home_seed_source,
    run_codex_connectivity_probe,
    run_codex_planner_shaped_probe,
    stage_e2e_codex_home_seed,
    start_e2e_postgres_if_needed,
)
from real_symphony_e2e_run_state import E2ERunState


def _runtime_env() -> dict[str, str]:
    env = os.environ.copy()
    env["PYTHONPATH"] = os.pathsep.join(
        [
            str(Path.cwd() / "packages" / "performer-api" / "src"),
            str(Path.cwd() / "packages" / "performer" / "src"),
            str(Path.cwd() / "packages" / "conductor" / "src"),
            str(Path.cwd() / "packages" / "podium" / "src"),
            env.get("PYTHONPATH", ""),
        ]
    )
    return env


def _linear_token_and_agent() -> tuple[str, str]:
    token = os.environ.get("PODIUM_LINEAR_APP_ACCESS_TOKEN", "").strip()
    if not token:
        raise E2EConfigurationError(
            failure_class="environment_failure",
            error_code="linear_app_access_token_required",
            sanitized_reason="Linear app actor token is required.",
            retryable=False,
            next_action="set_podium_linear_app_access_token",
        )
    agent_app_user_id = os.environ.get("PODIUM_LINEAR_APPLICATION_ID", "").strip()
    if not agent_app_user_id:
        raise E2EConfigurationError(
            failure_class="environment_failure",
            error_code="linear_application_id_required",
            sanitized_reason="PODIUM_LINEAR_APPLICATION_ID is required for the Linear custom-agent app user.",
            retryable=False,
            next_action="set_podium_linear_application_id",
        )
    return token, agent_app_user_id


def _record_codex_home_source(state: E2ERunState) -> None:
    state.env["SYMPHONY_E2E_CODEX_HOME_SOURCE"] = str(state.staged_codex_home)
    state.evidence.check(
        "runtime-config:codex-home-source-staged",
        (state.staged_codex_home / "config.toml").is_file() and (state.staged_codex_home / "auth.json").is_file(),
        copied_files=sorted(path.name for path in state.staged_codex_home.iterdir() if path.is_file()),
    )
    state.evidence.checkpoint(
        "01-preflight",
        {
            "status": "completed" if not state.evidence.data.get("failures") else "failed",
            "checks": [check for check in state.evidence.data.get("checks", []) if isinstance(check, dict)][-1:],
            "failures": [failure for failure in state.evidence.data.get("failures", []) if isinstance(failure, dict)][-1:],
        },
    )


async def build_initial_state(args: argparse.Namespace) -> E2ERunState:
    token, agent_app_user_id = _linear_token_and_agent()
    root = args.out.resolve()
    root.mkdir(parents=True, exist_ok=True)
    run_id = "symphony-e2e-matrix-" + datetime.now(timezone.utc).strftime("%Y%m%d%H%M%S") + "-" + uuid.uuid4().hex[:6]
    staged_codex_home = stage_e2e_codex_home_seed(source=e2e_codex_home_seed_source())
    try:
        state = E2ERunState(
            args=args,
            token=token,
            agent_app_user_id=agent_app_user_id,
            root=root,
            evidence=Evidence(root / "real-symphony-e2e-report.json"),
            env=_runtime_env(),
            bin_dir=Path.cwd() / ".venv" / "bin",
            run_id=run_id,
            pipeline_scenario=_pipeline_scenario(args),
            permission_approval_probe=_effective_permission_approval_probe(args),
            workspace_id=f"real-workspace-{run_id}",
            fixture=root / "fixture-repo",
            podium_port=allocate_port(),
            conductor_port=allocate_port(),
            data_root=root / "conductor-data",
            staged_codex_home=staged_codex_home,
        )
        _record_codex_home_source(state)
        state.evidence.data["run_id"] = state.run_id
        state.evidence.data["managed_run_scenario"] = state.pipeline_scenario
        state.evidence.write()
        return state
    except Exception:
        cleanup_staged_codex_home(staged_codex_home)
        raise


async def run_connectivity_preflight(state: E2ERunState) -> bool:
    probes = [
        ("codex_connectivity_probe", run_codex_connectivity_probe, "codex_connectivity_probe_failed"),
        ("codex_planner_shaped_probe", run_codex_planner_shaped_probe, "codex_planner_shaped_probe_failed"),
    ]
    for attr, probe, failure_reason in probes:
        if getattr(state.args, attr, False):
            connected = await probe(
                evidence=state.evidence,
                root=state.root,
                staged_codex_home=state.staged_codex_home,
                args=state.args,
            )
            if not connected:
                _checkpoint_and_block_after_stage(
                    state.evidence,
                    "02-connectivity",
                    reason=failure_reason,
                    blocked_stages=_stages_after("02-connectivity"),
                )
                state.evidence.data["completed_at"] = utc_now()
                state.evidence.write()
                return False
    checks = [
        check
        for check in state.evidence.data.get("checks", [])
        if isinstance(check, dict) and str(check.get("name") or "").startswith("codex-connectivity:")
    ]
    state.evidence.checkpoint("02-connectivity", {"status": "completed", "checks": checks})
    return True


def prepare_fixture_and_cli(state: E2ERunState) -> None:
    state.evidence.check(
        "managed-run-scenario:selected",
        state.pipeline_scenario in {"basic", "parallel", "replan", "integration-conflict", "runtime-wait", "gate-normalization", "overall-dod"},
        scenario=state.pipeline_scenario,
        permission_approval_probe=state.permission_approval_probe,
    )
    if state.pipeline_scenario == "overall-dod":
        _run_appendix_pytest_hardening_probes(state.evidence, env=state.env)
    for name, command in {
        "podium-help": [str(state.bin_dir / "podium"), "--help"],
        "conductor-help": [str(state.bin_dir / "conductor"), "--help"],
        "performer-help": [str(state.bin_dir / "performer"), "--help"],
    }.items():
        run_cmd(name, command, state.evidence, env=state.env)
    state.fixture = make_fixture_repo(state.fixture)
    _prepare_pipeline_scenario_fixture(state.fixture, state.pipeline_scenario)


async def start_podium_and_enroll(state: E2ERunState) -> None:
    state.postgres_container = await start_e2e_postgres_if_needed(state.root, state.env, state.evidence)
    podium_env = dict(state.env)
    podium_env["PODIUM_LINEAR_APPLICATION_ID"] = state.agent_app_user_id
    podium_env["PODIUM_LINEAR_APP_ACCESS_TOKEN"] = state.token
    podium_env["PODIUM_LINEAR_POLL_INTERVAL_SECONDS"] = "1"
    podium_env["PODIUM_LINEAR_POLL_INITIAL_LOOKBACK_SECONDS"] = "0"
    podium = start_process(
        "podium",
        [str(state.bin_dir / "podium"), "api", "--host", "127.0.0.1", "--port", str(state.podium_port)],
        env=podium_env,
        stdout_path=state.root / "podium.log",
    )
    state.processes.append(podium)
    status, body = await wait_for_http_ready(api_url(state.podium_port, "/"))
    state.evidence.check("podium-api:/", status == 200, status=status, body=body)
    status, body = http_json("GET", api_url(state.podium_port, "/api/v1/health"))
    state.evidence.check("podium-api:/api/v1/health", status == 200, status=status, body=body)
    await _enroll_runtime(state)


async def _enroll_runtime(state: E2ERunState) -> None:
    viewer = await fetch_linear_viewer(state.token)
    linear_project = await resolve_project(state.token, state.args.project_slug)
    state.evidence.data["linear_project"] = {"requested": state.args.project_slug, "slugId": linear_project["slugId"], "name": linear_project.get("name")}
    state.evidence.data["linear_agent_app_user_id"] = state.agent_app_user_id
    state.evidence.check("linear-agent:app-user-selected", bool(state.agent_app_user_id), source="PODIUM_LINEAR_APPLICATION_ID", viewer={key: viewer.get(key) for key in ["id", "name", "email"]})
    status, body = http_json(
        "POST",
        api_url(state.podium_port, "/api/v1/runtime/enrollment-tokens"),
        build_enrollment_token_payload(
            run_id=state.run_id,
            workspace_id=state.workspace_id,
            project_slug_id=linear_project["slugId"],
            agent_app_user_id=state.agent_app_user_id,
        ),
    )
    state.evidence.check("podium-api:/api/v1/runtime/enrollment-tokens", status == 200, status=status, body=body)
    status, enrolled = http_json("POST", api_url(state.podium_port, "/api/v1/runtime/enroll"), {"enrollment_token": body.get("enrollment_token") if isinstance(body, dict) else ""})
    state.enrolled_runtime = enrolled
    state.evidence.check("podium-api:/api/v1/runtime/enroll", status == 200 and bool(enrolled.get("runtime_id")) and bool(enrolled.get("runtime_token")) and bool(enrolled.get("proxy_token")), status=status, body={key: bool(enrolled.get(key)) for key in ["runtime_id", "runtime_token", "proxy_token"]})


def build_enrollment_token_payload(
    *,
    run_id: str,
    workspace_id: str,
    project_slug_id: str,
    agent_app_user_id: str,
) -> dict[str, str]:
    return {
        "runtime_group_id": f"group-{run_id}",
        "linear_workspace_id": workspace_id,
        "project_slug": project_slug_id,
        "linear_agent_app_user_id": agent_app_user_id,
    }


async def start_conductor_and_configure(state: E2ERunState) -> None:
    conductor = start_process(
        "conductor",
        [str(state.bin_dir / "conductor"), "--port", str(state.conductor_port), "--data-root", str(state.data_root)],
        env=state.env,
        stdout_path=state.root / "conductor.log",
    )
    state.processes.append(conductor)
    status, body = await wait_for_http_ready(api_url(state.conductor_port, "/"))
    state.evidence.check("conductor-api:/", status == 200, status=status, body=body)
    payload = {
        "podium_url": f"http://127.0.0.1:{state.podium_port}",
        "podium_runtime_id": state.enrolled_runtime["runtime_id"],
        "podium_runtime_token": state.enrolled_runtime["runtime_token"],
        "podium_proxy_token": state.enrolled_runtime["proxy_token"],
        "podium_ws_url": state.enrolled_runtime["websocket_url"],
        "runtime_group_id": state.enrolled_runtime["runtime_group_id"],
        "managed_mode": True,
    }
    status, body = http_json("PATCH", api_url(state.conductor_port, "/api/settings"), payload)
    settings = body.get("settings", {}) if isinstance(body, dict) else {}
    state.evidence.check("conductor-api:/api/settings PATCH", status == 200 and settings.get("linear_application_connected") and settings.get("podium_runtime_token_configured") and settings.get("podium_proxy_token_configured") and settings.get("managed_mode"), status=status, body=settings)
    _smoke_conductor_api(state)


def _smoke_conductor_api(state: E2ERunState) -> None:
    clone_target = state.root / "non-empty-clone"
    for method, path, payload in [
        ("GET", "/api/settings", None),
        ("GET", "/api/managed-runs", None),
        ("GET", "/api/instances", None),
        ("POST", "/api/repo/inspect", {"repo_source_type": "local_path", "repo_source_value": str(state.fixture)}),
        ("POST", "/api/repo/clone", {"repo_url": "https://example.invalid/repo.git", "target_path": str(clone_target)}),
    ]:
        if path == "/api/repo/clone":
            clone_target.mkdir(exist_ok=True)
            (clone_target / "keep.txt").write_text("keep\n", encoding="utf-8")
        status, body = http_json(method, api_url(state.conductor_port, path), payload)
        state.evidence.check(f"conductor-api:{method} {path}", status in {200, 201}, status=status, body=body)
    status, body = http_json("POST", api_url(state.conductor_port, "/api/managed-runs"), {"runs": []})
    state.evidence.check("appendix:s0b-managed-runs-view-read-only", status in {404, 405}, status=status, body=body)


async def create_issue_and_instance(state: E2ERunState) -> None:
    state.linear = await create_linear_issue(
        state.token,
        state.args.project_slug,
        state.run_id,
        delegate_id=state.agent_app_user_id,
        description=_pipeline_scenario_issue_description(state.pipeline_scenario, state.run_id),
    )
    state.linear["issue"] = await delegate_linear_issue(state.token, state.linear["issue"]["id"], state.agent_app_user_id)
    state.linear["issue"] = await wait_for_linear_delegate_visible(state.token, state.linear["issue"]["id"], state.agent_app_user_id)
    issue_path = state.root / "business-issue.json"
    issue_path.write_text(json.dumps(state.linear, indent=2, sort_keys=True), encoding="utf-8")
    state.evidence.artifact("business_issue", issue_path)
    state.evidence.check("linear-agent:issue-left-human-assignee-unchanged", ((state.linear["issue"].get("assignee") or {}).get("id")) != state.agent_app_user_id, expected_agent_app_user_id=state.agent_app_user_id, actual_assignee=state.linear["issue"].get("assignee"))
    state.evidence.check("linear-agent:issue-delegated-to-custom-agent", ((state.linear["issue"].get("delegate") or {}).get("id") == state.agent_app_user_id), expected_agent_app_user_id=state.agent_app_user_id, actual_delegate=state.linear["issue"].get("delegate"))
    await _create_conductor_instance(state)


async def _create_conductor_instance(state: E2ERunState) -> None:
    payload = build_instance_payload(run_id=state.run_id, fixture=state.fixture, project_slug=state.linear["project"]["slugId"], agent_app_user_id=state.agent_app_user_id, pipeline_gates=state.args.pipeline_gates)
    status, body = http_json("POST", api_url(state.conductor_port, "/api/instances"), payload)
    state.evidence.check("conductor-api:POST /api/instances", status == 201, status=status, body=body)
    if status != 201 or not isinstance(body, dict) or not isinstance(body.get("instance"), dict):
        raise RuntimeError("conductor instance creation failed")
    state.instance = body["instance"]
    state.instance_id = state.instance["id"]
    for method, path in [("GET", f"/api/instances/{state.instance_id}"), ("GET", f"/api/instances/{state.instance_id}/runtime"), ("GET", f"/api/instances/{state.instance_id}/logs"), ("GET", f"/api/instances/{state.instance_id}/logs?tail=5&order=desc")]:
        status, _body = http_json(method, api_url(state.conductor_port, path), None)
        state.evidence.check(f"conductor-api:{method} {path}", status == 200, status=status)
    instance_path = state.root / "instance.json"
    instance_path.write_text(json.dumps(state.instance, indent=2, sort_keys=True), encoding="utf-8")
    state.evidence.artifact("instance", instance_path)
