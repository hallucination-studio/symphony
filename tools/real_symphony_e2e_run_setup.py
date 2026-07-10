from __future__ import annotations

import argparse
import json
import secrets
import uuid
from datetime import datetime, timezone
from pathlib import Path

from real_symphony_e2e_acceptance import (
    _effective_permission_approval_probe,
    _pipeline_scenario,
    _pipeline_scenario_issue_description,
    _prepare_pipeline_scenario_fixture,
    _run_appendix_pytest_hardening_probes,
)
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
from real_symphony_e2e_linear import (
    create_linear_issue,
    delegate_linear_issue,
    wait_for_linear_delegate_visible,
)
from real_symphony_e2e_linear_fixture import verify_linear_fixture_access
from real_symphony_e2e_podium import (
    PodiumSession,
    authorize_default_application,
    managed_runtime_env,
    podium_managed_env,
    podium_runtime_from_env,
    require_local_port_available,
    select_linear_project,
)
from real_symphony_e2e_podium_denial import verify_denied_authorization
from real_symphony_e2e_podium_evidence import archive_and_validate_podium_bootstrap
from real_symphony_e2e_podium_runtime import (
    bind_conductor,
    execute_install_command,
    reserve_conductor,
    validate_enrollment_result,
    validate_unbound_conductor,
    verify_second_binding_rejected,
    wait_for_runtime_online,
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
from real_symphony_e2e_run_environment import (
    linear_fixture_token as _linear_fixture_token,
    runtime_env as _runtime_env,
)
from real_symphony_e2e_run_state import E2ERunState


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
    token = _linear_fixture_token()
    runtime_env = _runtime_env()
    podium_base_url, podium_port = podium_runtime_from_env(runtime_env)
    root = args.out.resolve()
    root.mkdir(parents=True, exist_ok=True)
    run_id = "symphony-e2e-matrix-" + datetime.now(timezone.utc).strftime("%Y%m%d%H%M%S") + "-" + uuid.uuid4().hex[:6]
    staged_codex_home = stage_e2e_codex_home_seed(source=e2e_codex_home_seed_source())
    try:
        state = E2ERunState(
            args=args,
            token=token,
            agent_app_user_id="",
            root=root,
            evidence=Evidence(root / "real-symphony-e2e-report.json"),
            env=runtime_env,
            bin_dir=Path.cwd() / ".venv" / "bin",
            run_id=run_id,
            pipeline_scenario=_pipeline_scenario(args),
            permission_approval_probe=_effective_permission_approval_probe(args),
            workspace_id="",
            fixture=root / "fixture-repo",
            podium_port=podium_port,
            podium_base_url=podium_base_url,
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
    if not await verify_linear_fixture_access(
        state.token,
        state.args.project_slug,
        state.evidence,
    ):
        _checkpoint_and_block_after_stage(
            state.evidence,
            "02-connectivity",
            reason="linear_fixture_preflight_failed",
            blocked_stages=_stages_after("02-connectivity"),
        )
        state.evidence.data["completed_at"] = utc_now()
        state.evidence.write()
        return False
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
    require_local_port_available(state.podium_port)
    state.postgres_container = await start_e2e_postgres_if_needed(state.root, state.env, state.evidence)
    podium_env = podium_managed_env(
        state.env,
        database_url=str(state.env.get("PODIUM_DATABASE_URL") or ""),
        podium_base_url=state.podium_base_url,
        secret_key=secrets.token_urlsafe(32),
    )
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
    state.podium_session = PodiumSession(f"http://127.0.0.1:{state.podium_port}")
    user, installation = await authorize_default_application(
        state.podium_session,
        root=state.root,
        evidence=state.evidence,
        timeout_seconds=int(getattr(state.args, "oauth_timeout", 300)),
    )
    state.workspace_id = str(user["id"])
    state.installation = installation
    state.agent_app_user_id = str(installation.get("app_user_id") or "")
    await verify_denied_authorization(
        state.podium_session,
        active_installation_id=str(installation["id"]),
        root=state.root,
        evidence=state.evidence,
        timeout_seconds=int(getattr(state.args, "oauth_timeout", 300)),
    )
    state.linear_project = await select_linear_project(
        state.podium_session,
        state.args.project_slug,
        state.evidence,
    )
    state.evidence.data["linear_project"] = dict(state.linear_project)
    state.evidence.data["linear_agent_app_user_id"] = state.agent_app_user_id
    state.enrollment_reservation = await reserve_conductor(state.podium_session, state.evidence)


async def start_conductor_and_configure(state: E2ERunState) -> None:
    conductor_env = managed_runtime_env(state.env)
    conductor = start_process(
        "conductor",
        [str(state.bin_dir / "conductor"), "--port", str(state.conductor_port), "--data-root", str(state.data_root)],
        env=conductor_env,
        stdout_path=state.root / "conductor.log",
    )
    state.processes.append(conductor)
    status, body = await wait_for_http_ready(api_url(state.conductor_port, "/"))
    state.evidence.check("conductor-api:/", status == 200, status=status, body=body)
    state.enrolled_runtime = await execute_install_command(
        state.enrollment_reservation,
        env=conductor_env,
        conductor_port=state.conductor_port,
        root=state.root,
    )
    conductor_id = str((state.enrollment_reservation.get("conductor") or {}).get("id") or "")
    state.evidence.check(
        "conductor-enrollment:generated-command-completed",
        conductor_id == str(state.enrolled_runtime.get("runtime_id") or ""),
        conductor_id=conductor_id,
        runtime_id=state.enrolled_runtime.get("runtime_id"),
    )
    validate_enrollment_result(state.enrollment_reservation, state.enrolled_runtime)
    unbound = await wait_for_runtime_online(state.podium_session, conductor_id, state.args.stage_timeout)
    validate_unbound_conductor(unbound, conductor_id)
    state.evidence.check(
        "conductor-enrollment:online-and-unbound",
        True,
        conductor_id=conductor_id,
        online=unbound.get("online"),
    )
    state.binding = await bind_conductor(
        state.podium_session,
        conductor_id=conductor_id,
        project_id=str(state.linear_project["id"]),
        repository=state.fixture,
        evidence=state.evidence,
        timeout_seconds=state.args.stage_timeout,
    )
    await verify_second_binding_rejected(
        state.podium_session,
        conductor_id=conductor_id,
        project_id=str(state.linear_project["id"]),
        repository=state.fixture,
        evidence=state.evidence,
    )
    state.instance_id = str(state.binding.get("instance_id") or "")
    status, body = http_json("GET", api_url(state.conductor_port, "/api/settings"))
    settings = body.get("settings", {}) if isinstance(body, dict) else {}
    state.evidence.check("conductor-api:/api/settings", status == 200 and settings.get("linear_application_connected") and settings.get("podium_runtime_token_configured") and settings.get("podium_proxy_token_configured") and settings.get("managed_mode"), status=status, body=settings)
    status, instance_body = http_json("GET", api_url(state.conductor_port, f"/api/instances/{state.instance_id}"))
    state.instance = instance_body.get("instance", {}) if isinstance(instance_body, dict) else {}
    state.evidence.check("conductor-binding:instance-created", status == 200 and state.instance.get("id") == state.instance_id, status=status, instance_id=state.instance_id)
    _smoke_conductor_api(state)
    await archive_and_validate_podium_bootstrap(
        state.podium_session,
        root=state.root,
        evidence=state.evidence,
        installation_id=str(state.installation["id"]),
        project_id=str(state.linear_project["id"]),
        conductor_id=conductor_id,
    )


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
    project_slug = str(state.linear_project.get("slug_id") or state.args.project_slug)
    state.linear = await create_linear_issue(
        state.token,
        project_slug,
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
    for method, path in [("GET", f"/api/instances/{state.instance_id}"), ("GET", f"/api/instances/{state.instance_id}/runtime"), ("GET", f"/api/instances/{state.instance_id}/logs"), ("GET", f"/api/instances/{state.instance_id}/logs?tail=5&order=desc")]:
        status, _body = http_json(method, api_url(state.conductor_port, path), None)
        state.evidence.check(f"conductor-api:{method} {path}", status == 200, status=status)
    instance_path = state.root / "instance.json"
    instance_path.write_text(json.dumps(state.instance, indent=2, sort_keys=True), encoding="utf-8")
    state.evidence.artifact("instance", instance_path)
