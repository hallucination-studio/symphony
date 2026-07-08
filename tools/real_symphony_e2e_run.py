from __future__ import annotations

import argparse
import asyncio
import json
import os
import shutil
import sqlite3
import subprocess
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from real_symphony_e2e_analysis import (
    analyze_plan_artifacts,
    appendix_exit_bar_audit,
    appendix_feature_score_audit,
    audit_expected_failure_run,
    build_agent_session_webhook_payload,
    build_instance_payload,
    linear_webhook_signature,
    pipeline_has_conflict_escalation_evidence,
    pipeline_integrations_terminal,
    pipeline_nodes_terminal,
)
from real_symphony_e2e_common import (
    DEFAULT_PROJECT_SLUG,
    Evidence,
    ManagedProcess,
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
    fetch_linear_issue_tree,
    fetch_linear_viewer,
    resolve_project,
    wait_for_linear_delegate_visible,
)
from real_symphony_e2e_wait import wait_for_run
from performer_api.config import sanitize_codex_config_template
from real_codex_connectivity_probe import run_probe as run_real_codex_connectivity_probe


CODEX_HOME_SEED_FILES = ("config.toml", "auth.json", "version.json", "models_cache.json")
CODEX_HOME_SEED_ENV = "SYMPHONY_E2E_CODEX_HOME_SEED"
DEFAULT_E2E_HARD_TURN_TIMEOUT_MS = 900_000
E2E_STAGE_ORDER = (
    "00-archive-old-issues",
    "01-preflight",
    "02-connectivity",
    "03-services-and-runtime",
    "04-dispatch-and-plan",
    "05-plan-offline-analysis",
    "06-graph-shape",
    "07-scheduler-capacity",
    "08-execute-verify",
    "09-replan-recovery",
    "10-integration",
    "11-final-acceptance",
)
DEPENDENT_RUNTIME_STAGES_AFTER_PLAN = (
    "06-graph-shape",
    "07-scheduler-capacity",
    "08-execute-verify",
    "09-replan-recovery",
    "10-integration",
    "11-final-acceptance",
)


def build_runtime_config_payload(
    *,
    runtime_group_id: str,
    version: int,
    model: str | None = None,
    codex_home_source: str | None = None,
    codex_settings: dict[str, Any] | None = None,
    pipeline_scenario: str = "basic",
) -> dict[str, Any]:
    settings = dict(codex_settings or {})
    model_name = (model or os.environ.get("SYMPHONY_E2E_CODEX_MODEL") or "").strip()
    if model_name:
        settings["model"] = model_name
    if codex_home_source:
        settings["codex_home_source"] = codex_home_source
    by_mode = {"plan": 1, "execute": 1, "verify": 1}
    if pipeline_scenario in {"parallel", "integration-conflict", "overall-dod"}:
        by_mode["execute"] = 2
    execute_settings = dict(settings)
    if pipeline_scenario in {"runtime-wait", "overall-dod"}:
        execute_settings["emit_runtime_wait_probe"] = True
        execute_settings["runtime_wait_probe_seconds"] = 90
    verify_settings: dict[str, Any] = {}
    if pipeline_scenario in {"replan", "overall-dod"}:
        verify_settings["force_first_verify_failure_for_replan"] = True
    return {
        "runtime_group_id": runtime_group_id,
        "version": version,
        "scheduler_policy": {
            "policy_id": f"policy-{runtime_group_id}",
            "version": version,
            "effective_at": utc_now(),
            "capacity": {"global": 3, "by_mode": by_mode},
            "dependency_policy": "verify_passed",
            "max_rework_attempts": 1,
        },
        "profiles": {
            "plan": {
                "name": "codex-plan",
                "backend": "codex",
                "mode": "plan",
                "settings": dict(settings),
            },
            "execute": {
                "name": "codex-execute",
                "backend": "codex",
                "mode": "execute",
                "settings": execute_settings,
            },
            "verify": {
                "name": "local-verifier",
                "backend": "local-verifier",
                "mode": "verify",
                "settings": verify_settings,
            },
        },
    }


async def run(args: argparse.Namespace) -> dict[str, Any]:
    token = os.environ.get("LINEAR_API_KEY", "").strip()
    if not token:
        raise RuntimeError("LINEAR_API_KEY is required")
    root = args.out.resolve()
    root.mkdir(parents=True, exist_ok=True)
    evidence = Evidence(root / "real-symphony-e2e-report.json")
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
    staged_codex_home = stage_codex_home_seed(
        source=e2e_codex_home_seed_source(),
        destination=root / "codex-home-source",
    )
    env["SYMPHONY_E2E_CODEX_HOME_SOURCE"] = str(staged_codex_home)
    evidence.check(
        "runtime-config:codex-home-source-staged",
        (staged_codex_home / "config.toml").is_file() and (staged_codex_home / "auth.json").is_file(),
        copied_files=sorted(path.name for path in staged_codex_home.iterdir() if path.is_file()),
    )
    evidence.checkpoint(
        "01-preflight",
        {
            "status": "completed" if not evidence.data.get("failures") else "failed",
            "checks": [check for check in evidence.data.get("checks", []) if isinstance(check, dict)][-1:],
            "failures": [failure for failure in evidence.data.get("failures", []) if isinstance(failure, dict)][-1:],
        },
    )
    if getattr(args, "codex_connectivity_probe", False):
        connected = await run_codex_connectivity_probe(
            evidence=evidence,
            root=root,
            staged_codex_home=staged_codex_home,
            args=args,
        )
        if not connected:
            _checkpoint_and_block_after_stage(
                evidence,
                "02-connectivity",
                reason="codex_connectivity_probe_failed",
                blocked_stages=_stages_after("02-connectivity"),
            )
            evidence.data["completed_at"] = utc_now()
            evidence.write()
            return evidence.data
    if getattr(args, "codex_planner_shaped_probe", False):
        connected = await run_codex_planner_shaped_probe(
            evidence=evidence,
            root=root,
            staged_codex_home=staged_codex_home,
            args=args,
        )
        if not connected:
            _checkpoint_and_block_after_stage(
                evidence,
                "02-connectivity",
                reason="codex_planner_shaped_probe_failed",
                blocked_stages=_stages_after("02-connectivity"),
            )
            evidence.data["completed_at"] = utc_now()
            evidence.write()
            return evidence.data
    evidence.checkpoint(
        "02-connectivity",
        {
            "status": "completed",
            "checks": [
                check
                for check in evidence.data.get("checks", [])
                if isinstance(check, dict) and str(check.get("name") or "").startswith("codex-connectivity:")
            ],
        },
    )
    bin_dir = Path.cwd() / ".venv" / "bin"
    run_id = datetime.now(timezone.utc).strftime("%Y%m%d%H%M%S") + "-" + uuid.uuid4().hex[:6]
    run_id = f"symphony-e2e-matrix-{run_id}"
    pipeline_scenario = _pipeline_scenario(args)
    permission_approval_probe = _effective_permission_approval_probe(args)
    workspace_id = f"real-workspace-{run_id}"
    webhook_secret = f"webhook-{uuid.uuid4().hex}"
    evidence.data["run_id"] = run_id
    evidence.data["pipeline_scenario"] = pipeline_scenario
    evidence.write()
    evidence.check(
        "pipeline-scenario:selected",
        pipeline_scenario in {"basic", "parallel", "replan", "integration-conflict", "runtime-wait", "overall-dod"},
        scenario=pipeline_scenario,
        permission_approval_probe=permission_approval_probe,
    )
    if pipeline_scenario == "overall-dod":
        _run_appendix_pytest_hardening_probes(evidence, env=env)

    for name, command in {
        "podium-help": [str(bin_dir / "podium"), "--help"],
        "conductor-help": [str(bin_dir / "conductor"), "--help"],
        "performer-help": [str(bin_dir / "performer"), "--help"],
    }.items():
        run_cmd(name, command, evidence, env=env)

    fixture = make_fixture_repo(root / "fixture-repo")
    _prepare_pipeline_scenario_fixture(fixture, pipeline_scenario)

    podium_port = allocate_port()
    conductor_port = allocate_port()
    data_root = root / "conductor-data"
    podium_env = dict(env)
    podium_env["LINEAR_WEBHOOK_SECRET"] = webhook_secret
    podium_env["PODIUM_LINEAR_ACCESS_TOKEN"] = token
    processes: list[ManagedProcess] = []
    try:
        podium = start_process(
            "podium",
            [
                str(bin_dir / "podium"),
                "api",
                "--host",
                "127.0.0.1",
                "--port",
                str(podium_port),
            ],
            env=podium_env,
            stdout_path=root / "podium.log",
        )
        processes.append(podium)
        status, body = await wait_for_http_ready(api_url(podium_port, "/"))
        evidence.check("podium-api:/", status == 200, status=status, body=body)
        for path in ["/api/v1/health"]:
            status, body = http_json("GET", api_url(podium_port, path))
            evidence.check(f"podium-api:{path}", status == 200, status=status, body=body)

        viewer = await fetch_linear_viewer(token)
        linear_project = await resolve_project(token, args.project_slug)
        evidence.data["linear_project"] = {
            "requested": args.project_slug,
            "slugId": linear_project["slugId"],
            "name": linear_project.get("name"),
        }
        agent_app_user_id = os.environ.get("LINEAR_AGENT_APP_USER_ID", "").strip()
        if not agent_app_user_id and not args.simulate_agent_webhook:
            raise RuntimeError(
                "LINEAR_AGENT_APP_USER_ID is required for real custom-agent delegation. "
                "Set it to the Linear app user's id."
            )
        agent_app_user_id = agent_app_user_id or "real-e2e-agent-app-user"
        evidence.data["linear_agent_app_user_id"] = agent_app_user_id
        evidence.check(
            "linear-agent:app-user-selected",
            bool(agent_app_user_id),
            source="LINEAR_AGENT_APP_USER_ID" if os.environ.get("LINEAR_AGENT_APP_USER_ID", "").strip() else "simulated-default",
            viewer={key: viewer.get(key) for key in ["id", "name", "email"]},
        )
        status, enrollment_body = http_json(
            "POST",
            api_url(podium_port, "/api/v1/runtime/enrollment-tokens"),
            {
                "runtime_group_id": f"group-{run_id}",
                "linear_workspace_id": workspace_id,
                "project_slug": linear_project["slugId"],
                "linear_agent_app_user_id": agent_app_user_id,
                "pipeline_profile": "gated-task" if args.pipeline_gates else "default",
            },
        )
        evidence.check("podium-api:/api/v1/runtime/enrollment-tokens", status == 200, status=status, body=enrollment_body)
        status, enrolled_runtime = http_json(
            "POST",
            api_url(podium_port, "/api/v1/runtime/enroll"),
            {"enrollment_token": enrollment_body.get("enrollment_token") if isinstance(enrollment_body, dict) else ""},
        )
        evidence.check(
            "podium-api:/api/v1/runtime/enroll",
            status == 200
            and bool(enrolled_runtime.get("runtime_id"))
            and bool(enrolled_runtime.get("runtime_token"))
            and bool(enrolled_runtime.get("proxy_token")),
            status=status,
            body={key: bool(enrolled_runtime.get(key)) for key in ["runtime_id", "runtime_token", "proxy_token"]},
        )

        conductor = start_process(
            "conductor",
            [str(bin_dir / "conductor"), "--port", str(conductor_port), "--data-root", str(data_root)],
            env=env,
            stdout_path=root / "conductor.log",
        )
        processes.append(conductor)
        status, body = await wait_for_http_ready(api_url(conductor_port, "/"))
        evidence.check("conductor-api:/", status == 200, status=status, body=body)
        status, body = http_json(
            "PATCH",
            api_url(conductor_port, "/api/settings"),
            {
                "podium_url": f"http://127.0.0.1:{podium_port}",
                "podium_runtime_id": enrolled_runtime["runtime_id"],
                "podium_runtime_token": enrolled_runtime["runtime_token"],
                "podium_proxy_token": enrolled_runtime["proxy_token"],
                "podium_ws_url": enrolled_runtime["websocket_url"],
                "runtime_group_id": enrolled_runtime["runtime_group_id"],
                "managed_mode": True,
            },
        )
        evidence.check(
            "conductor-api:/api/settings PATCH",
            status == 200
            and body["settings"]["linear_application_connected"]
            and body["settings"]["podium_runtime_token_configured"]
            and body["settings"]["podium_proxy_token_configured"]
            and body["settings"]["managed_mode"],
            status=status,
            body=body["settings"],
        )
        for method, path, payload in [
            ("GET", "/api/settings", None),
            ("GET", "/api/pipeline", None),
            ("GET", "/api/instances", None),
            ("POST", "/api/repo/inspect", {"repo_source_type": "local_path", "repo_source_value": str(fixture)}),
            ("POST", "/api/repo/clone", {"repo_url": "https://example.invalid/repo.git", "target_path": str(root / "non-empty-clone")}),
        ]:
            if path == "/api/repo/clone":
                (root / "non-empty-clone").mkdir(exist_ok=True)
                (root / "non-empty-clone" / "keep.txt").write_text("keep\n", encoding="utf-8")
            status, body = http_json(method, api_url(conductor_port, path), payload)
            evidence.check(f"conductor-api:{method} {path}", status in {200, 201}, status=status, body=body)
        status, body = http_json("POST", api_url(conductor_port, "/api/pipeline"), {"nodes": []})
        evidence.check(
            "appendix:s0b-view-read-only",
            status in {404, 405},
            status=status,
            body=body,
        )

        linear = await create_linear_issue(
            token,
            args.project_slug,
            run_id,
            delegate_id=agent_app_user_id if not args.simulate_agent_webhook else None,
            description=_pipeline_scenario_issue_description(pipeline_scenario, run_id),
        )
        if not args.simulate_agent_webhook:
            linear["issue"] = await delegate_linear_issue(token, linear["issue"]["id"], agent_app_user_id)
            linear["issue"] = await wait_for_linear_delegate_visible(
                token,
                linear["issue"]["id"],
                agent_app_user_id,
            )
        issue_path = root / "business-issue.json"
        issue_path.write_text(json.dumps(linear, indent=2, sort_keys=True), encoding="utf-8")
        evidence.artifact("business_issue", issue_path)
        evidence.check(
            "linear-agent:issue-left-human-assignee-unchanged",
            ((linear["issue"].get("assignee") or {}).get("id")) != agent_app_user_id,
            expected_agent_app_user_id=agent_app_user_id,
            actual_assignee=linear["issue"].get("assignee"),
        )
        evidence.check(
            "linear-agent:issue-delegated-to-custom-agent",
            args.simulate_agent_webhook or ((linear["issue"].get("delegate") or {}).get("id") == agent_app_user_id),
            expected_agent_app_user_id=agent_app_user_id,
            actual_delegate=linear["issue"].get("delegate"),
            simulated=args.simulate_agent_webhook,
        )
        payload = build_instance_payload(
            run_id=run_id,
            fixture=fixture,
            project_slug=linear["project"]["slugId"],
            agent_app_user_id=agent_app_user_id,
            pipeline_gates=args.pipeline_gates,
            simulate_agent_webhook=args.simulate_agent_webhook,
        )
        evidence.check(
            "linear-agent:simulated-webhook-mode-does-not-verify-real-delegate",
            not args.simulate_agent_webhook or "linear_agent_app_user_id" not in payload["linear_filters"],
            simulated=args.simulate_agent_webhook,
            linear_filters=sorted(payload["linear_filters"].keys()),
        )
        status, body = http_json("POST", api_url(conductor_port, "/api/instances"), payload)
        evidence.check("conductor-api:POST /api/instances", status == 201, status=status)
        instance = body["instance"]
        instance_id = instance["id"]
        for method, path, payload in [
            ("GET", f"/api/instances/{instance_id}", None),
            ("GET", f"/api/instances/{instance_id}/runtime", None),
            ("GET", f"/api/instances/{instance_id}/logs", None),
            ("GET", f"/api/instances/{instance_id}/logs?tail=5&order=desc", None),
        ]:
            status, body = http_json(method, api_url(conductor_port, path), payload)
            evidence.check(f"conductor-api:{method} {path}", status == 200, status=status)
        instance_path = root / "instance.json"
        instance_path.write_text(json.dumps(instance, indent=2, sort_keys=True), encoding="utf-8")
        evidence.artifact("instance", instance_path)

        # Conductor daemon restart recovery while stopped: metadata must survive.
        conductor.stop()
        processes.remove(conductor)
        conductor = start_process(
            "conductor",
            [str(bin_dir / "conductor"), "--port", str(conductor_port), "--data-root", str(data_root)],
            env=env,
            stdout_path=root / "conductor-restarted.log",
        )
        processes.append(conductor)
        await wait_for_http_ready(api_url(conductor_port, "/"))
        status, body = http_json("GET", api_url(conductor_port, f"/api/instances/{instance_id}"))
        evidence.check("conductor-daemon:restart-recovers-instance-metadata", status == 200 and body["instance"]["id"] == instance_id, status=status, process_status=body.get("instance", {}).get("process_status"))

        runtime_config = build_runtime_config_payload(
            runtime_group_id=enrolled_runtime["runtime_group_id"],
            version=1,
            codex_home_source="$SYMPHONY_E2E_CODEX_HOME_SOURCE",
            codex_settings=_codex_settings_from_args(args),
            pipeline_scenario=getattr(args, "pipeline_scenario", "basic"),
        )
        status, body = http_json(
            "POST",
            api_url(podium_port, "/api/v1/runtime/config"),
            runtime_config,
            headers={"Authorization": f"Bearer {enrolled_runtime['runtime_token']}"},
        )
        pushed_config = body.get("config") if isinstance(body, dict) and isinstance(body.get("config"), dict) else {}
        evidence.check(
            "runtime-config:podium-pushed",
            status == 200
            and pushed_config.get("version") == runtime_config["version"]
            and sorted((pushed_config.get("profiles") or {}).keys()) == ["execute", "plan", "verify"],
            status=status,
            body=body,
        )
        status, body = http_json(
            "POST",
            api_url(podium_port, "/api/v1/runtime/config"),
            runtime_config,
            headers={"Authorization": f"Bearer {enrolled_runtime['runtime_token']}"},
        )
        evidence.check(
            "appendix:s0a-stale-policy-rejected",
            status == 409 and ((body or {}).get("error") or {}).get("code") == "stale_runtime_config",
            status=status,
            body=body,
        )
        invalid_backend_config = json.loads(json.dumps(runtime_config))
        invalid_backend_config["version"] = int(runtime_config.get("version") or 1) + 1
        invalid_backend_config["scheduler_policy"]["version"] = invalid_backend_config["version"]
        invalid_backend_config["profiles"]["execute"]["backend"] = "local-verifier"
        invalid_backend_config["profiles"]["execute"]["name"] = "ineligible-execute"
        status, body = http_json(
            "POST",
            api_url(podium_port, "/api/v1/runtime/config"),
            invalid_backend_config,
            headers={"Authorization": f"Bearer {enrolled_runtime['runtime_token']}"},
        )
        evidence.check(
            "appendix:s0c-ineligible-backend-refused-before-dispatch",
            status == 400
            and "runtime_profile_backend_unsupported:execute:local-verifier" in str(((body or {}).get("error") or {}).get("details")),
            status=status,
            body=body,
        )
        evidence.checkpoint(
            "03-services-and-runtime",
            {
                "status": "completed" if not evidence.data.get("failures") else "failed",
                "checks": [
                    check
                    for check in evidence.data.get("checks", [])
                    if isinstance(check, dict)
                    and (
                        str(check.get("name") or "").startswith("podium-api:")
                        or str(check.get("name") or "").startswith("conductor-api:")
                        or str(check.get("name") or "").startswith("runtime-config:")
                        or str(check.get("name") or "").startswith("appendix:s0")
                    )
                ],
                "failures": [failure for failure in evidence.data.get("failures", []) if isinstance(failure, dict)],
            },
        )

        lowered_policy_task: asyncio.Task[dict[str, Any]] | None = None
        if pipeline_scenario == "overall-dod":
            lowered_policy_task = asyncio.create_task(
                _lower_policy_during_parallel_execute_probe(
                    podium_port=podium_port,
                    conductor_port=conductor_port,
                    runtime_token=enrolled_runtime["runtime_token"],
                    runtime_config=runtime_config,
                    timeout_seconds=min(max(args.stage_timeout, 30), 180),
                )
            )

        webhook_payload = build_agent_session_webhook_payload(
            linear=linear,
            workspace_id=workspace_id,
            agent_app_user_id=agent_app_user_id,
            simulate_agent_webhook=args.simulate_agent_webhook,
        )
        pipeline_intent = _pipeline_scenario_intent(pipeline_scenario)
        if pipeline_intent:
            webhook_payload["pipeline_intent"] = pipeline_intent
        raw_webhook = json.dumps(webhook_payload).encode()
        status, body = http_json(
            "POST",
            api_url(podium_port, "/api/v1/linear/webhooks/agent-session"),
            raw_webhook,
            headers={"Linear-Signature": linear_webhook_signature(webhook_secret, raw_webhook)},
        )
        evidence.check(
            "podium-api:/api/v1/linear/webhooks/agent-session queues-dispatch",
            status == 200 and body.get("queued") == 1,
            status=status,
            body=body,
        )
        dispatch_instance_status = 0
        dispatch_instance_body: dict[str, Any] = {}
        deadline = time.monotonic() + 20
        while time.monotonic() < deadline:
            dispatch_instance_status, dispatch_instance_body = http_json(
                "GET", api_url(conductor_port, f"/api/instances/{instance_id}")
            )
            process_status = dispatch_instance_body.get("instance", {}).get("process_status")
            if dispatch_instance_status == 200 and process_status in {"running", "exited"}:
                break
            await asyncio.sleep(0.5)
        evidence.check(
            "conductor-dispatch:agent-session-starts-one-shot",
            dispatch_instance_status == 200
            and dispatch_instance_body.get("instance", {}).get("process_status") in {"running", "exited"},
            status=dispatch_instance_status,
            process_status=dispatch_instance_body.get("instance", {}).get("process_status")
            if isinstance(dispatch_instance_body, dict)
            else None,
        )
        instance = dispatch_instance_body["instance"]

        run_result = await wait_for_run(
            token=token,
            issue_id=linear["issue"]["id"],
            instance=instance,
            conductor_port=conductor_port,
            evidence=evidence,
            timeout_seconds=args.timeout,
            stage_timeout_seconds=args.stage_timeout,
            permission_approval_probe=permission_approval_probe,
            crash_recovery_probe=args.crash_recovery_probe or pipeline_scenario == "overall-dod",
            crash_after_policy_revision=(int(runtime_config.get("version") or 1) + 1)
            if pipeline_scenario == "overall-dod"
            else None,
            continue_after_human_resume=pipeline_scenario == "overall-dod",
            expected_failure=args.expected_failure,
        )
        evidence.checkpoint(
            "04-dispatch-and-plan",
            {
                "status": "completed" if _latest_pipeline_runtime_failure(evidence) is None else "failed",
                "checks": [
                    check
                    for check in evidence.data.get("checks", [])
                    if isinstance(check, dict)
                    and (
                        str(check.get("name") or "").startswith("stage:")
                        or str(check.get("name") or "").startswith("pipeline-runtime-error:")
                        or str(check.get("name") or "").startswith("human-action:")
                    )
                ],
                "failures": [failure for failure in evidence.data.get("failures", []) if isinstance(failure, dict)],
                "samples": (run_result.get("samples") or [])[-3:],
            },
        )
        if _handle_pipeline_runtime_blocker(
            evidence=evidence,
            root=root,
            data_root=data_root,
            instance_id=instance_id,
            run_result=run_result,
        ):
            evidence.data["completed_at"] = utc_now()
            evidence.write()
            return evidence.data
        if permission_approval_probe:
            check_names = {check.get("name") for check in evidence.data.get("checks", []) if check.get("passed")}
            human_resume_covered = {
                "human-action:conductor-pipeline-awaiting-human",
                "human-action:parent-comment-does-not-resume",
                "human-action:linear-child-complete",
                "human-action:managed-push-resume",
                "human-action:resume-observed-after-push",
            }.issubset(check_names)
            evidence.check(
                "runtime-error:permission-approval-covered",
                human_resume_covered,
                covered=sorted(name for name in check_names if str(name).startswith("human-action:")),
                human_resume_covered=human_resume_covered,
            )
        if pipeline_scenario == "overall-dod" or args.crash_recovery_probe:
            check_names = {check.get("name") for check in evidence.data.get("checks", []) if check.get("passed")}
            evidence.check(
                "appendix:s0a-crashed-worker-lease-reclaimed",
                "crash-recovery:covered" in check_names,
                covered=sorted(name for name in check_names if str(name).startswith("crash-recovery:")),
            )
        if lowered_policy_task is not None:
            lowered_policy = await lowered_policy_task
            lowered_policy_details = {key: value for key, value in lowered_policy.items() if key != "passed"}
            evidence.check(
                "appendix:s0a-lowered-limit-no-preempt",
                bool(lowered_policy.get("passed")),
                **lowered_policy_details,
            )
        issue = run_result["issue"]
        result_path = Path(run_result["result_path"])
        last_sample = (run_result.get("samples") or [{}])[-1]
        pipeline_leases = [
            lease for lease in last_sample.get("pipeline_leases", []) if isinstance(lease, dict)
        ] if isinstance(last_sample, dict) else []
        pipeline_nodes = (
            [node for node in last_sample.get("pipeline_nodes", []) if isinstance(node, dict)]
            if isinstance(last_sample, dict)
            else []
        )
        if pipeline_scenario == "overall-dod":
            live_refresh = _pipeline_live_refresh_evidence(run_result.get("samples") or [])
            live_refresh_details = {key: value for key, value in live_refresh.items() if key != "passed"}
            evidence.check(
                "appendix:s0b-pipeline-live-refresh",
                bool(live_refresh.get("passed")),
                **live_refresh_details,
            )
        pipeline_terminal = pipeline_nodes_terminal(
            pipeline_nodes,
            terminal_states={"verify_passed", "failed", "superseded"},
        )
        expected_failure = args.expected_failure != "none"
        if permission_approval_probe:
            evidence.check(
                "runtime-error:blocked-cleared-after-approval",
                _permission_probe_block_cleared(last_sample),
                pipeline_human_actions=last_sample.get("pipeline_human_actions") if isinstance(last_sample, dict) else [],
                pipeline_leases=pipeline_leases,
            )
        elif expected_failure:
            tree = await fetch_linear_issue_tree(token, linear["issue"]["id"])
            tree_path = root / "final-issue-tree.json"
            tree_path.write_text(json.dumps(tree, indent=2, sort_keys=True), encoding="utf-8")
            evidence.artifact("final_issue_tree", tree_path)
            failure_audit = audit_expected_failure_run(run_result, tree, expected=args.expected_failure)
            failure_audit_path = root / "expected-failure-audit.json"
            failure_audit_path.write_text(json.dumps(failure_audit, indent=2, sort_keys=True), encoding="utf-8")
            evidence.artifact("expected_failure_audit", failure_audit_path)
            evidence.check(
                f"expected-failure:{args.expected_failure}",
                bool(failure_audit.get("pass")),
                audit=failure_audit,
            )
        else:
            if args.pipeline_gates:
                evidence.check(
                    "real-flow:linear-pipeline-projected",
                    True,
                    identifier=issue["identifier"],
                    state=issue["state"],
                )
            else:
                evidence.check(
                    "real-flow:linear-done",
                    issue["state"]["type"] in {"completed", "canceled"},
                    identifier=issue["identifier"],
                    state=issue["state"],
                )
            evidence.check(
                "real-flow:linear-agent-app-user-dispatched",
                args.simulate_agent_webhook or ((issue.get("delegate") or {}).get("id") == agent_app_user_id),
                expected_agent_app_user_id=agent_app_user_id,
                actual_delegate=issue.get("delegate"),
                actual_assignee=issue.get("assignee"),
                simulated=args.simulate_agent_webhook,
            )
            evidence.check("real-flow:workspace-result", result_path.exists(), path=str(result_path))
            evidence.check(
                "real-flow:no-active-pipeline-leases",
                not pipeline_leases,
                pipeline_leases=pipeline_leases,
            )
            evidence.check(
                "real-flow:pipeline-finalized",
                pipeline_terminal,
                pipeline_nodes=pipeline_nodes[-5:],
            )
        if args.pipeline_gates and not expected_failure:
            pipeline_view = await _wait_for_final_pipeline_view(
                conductor_port,
                timeout_seconds=min(max(args.stage_timeout, 5), 120),
                allow_human_wait=pipeline_scenario == "integration-conflict",
            )
            pipeline_path = root / "final-pipeline-view.json"
            pipeline_path.write_text(json.dumps(pipeline_view, indent=2, sort_keys=True), encoding="utf-8")
            evidence.artifact("final_pipeline_view", pipeline_path)
            if permission_approval_probe:
                tree = await fetch_linear_issue_tree(token, linear["issue"]["id"])
                tree_path = root / "final-issue-tree.json"
                tree_path.write_text(json.dumps(tree, indent=2, sort_keys=True), encoding="utf-8")
                evidence.artifact("final_issue_tree", tree_path)
                human_actions = [
                    child
                    for child in tree["children"]["nodes"]
                    if child["title"].startswith("[Human Action]")
                    or any(label["name"] == "performer:type/human-action" for label in child["labels"]["nodes"])
                ]
                evidence.check(
                    "human-action:child-type-label-visible",
                    bool(human_actions)
                    and all(
                        any(label["name"] == "performer:type/human-action" for label in child["labels"]["nodes"])
                        for child in human_actions
                    )
                    and any(child["state"]["type"] in {"completed", "canceled"} for child in human_actions),
                    human_actions=[
                        {
                            "identifier": child["identifier"],
                            "title": child["title"],
                            "state": child["state"],
                            "labels": [label["name"] for label in child["labels"]["nodes"]],
                        }
                        for child in human_actions
                    ],
                )
                _check_pipeline_scenario_acceptance(evidence, pipeline_scenario, pipeline_view)
            if _should_run_final_pipeline_stage_checks(
                permission_approval_probe=permission_approval_probe,
                pipeline_scenario=pipeline_scenario,
            ):
                nodes = [node for node in pipeline_view.get("nodes", []) if isinstance(node, dict)]
                manifests = [manifest for manifest in pipeline_view.get("manifests", []) if isinstance(manifest, dict)]
                integrations = [
                    item for item in pipeline_view.get("integration_queue", []) if isinstance(item, dict)
                ]
                projections = [
                    projection for projection in pipeline_view.get("linear_projections", []) if isinstance(projection, dict)
                ]
                evidence.check(
                    "stage:pipeline-gates-frozen",
                    bool(nodes) and all(node.get("gate_snapshot_hash") for node in nodes),
                    nodes=[
                        {
                            "node_id": node.get("node_id"),
                            "state": node.get("state"),
                            "gate_snapshot_hash": bool(node.get("gate_snapshot_hash")),
                        }
                        for node in nodes
                    ],
                )
                evidence.check(
                    "stage:pipeline-manifest-published",
                    bool(manifests) and all(int(manifest.get("score") or 0) >= 3 for manifest in manifests),
                    manifests=manifests,
                )
                evidence.check(
                    "stage:pipeline-integration-completed",
                    pipeline_integrations_terminal(pipeline_view),
                    integrations=integrations,
                )
                evidence.check(
                    "stage:pipeline-linear-projected",
                    bool(projections)
                    and _pipeline_projection_matches_current_revision(pipeline_view)
                    and all(
                        isinstance(projection.get("metadata"), dict)
                        and projection["metadata"].get("graph_id")
                        and projection["metadata"].get("node_id")
                        and projection["metadata"].get("gate_snapshot_hash")
                        and projection["metadata"].get("conductor_revision")
                        and projection["metadata"].get("operator_status")
                        for projection in projections
                    ),
                    projections=projections,
                    graph_revision=pipeline_view.get("graph_revision"),
                )
                _check_pipeline_scenario_acceptance(evidence, pipeline_scenario, pipeline_view)
                evidence.check(
                    "stage:final-pipeline-verified",
                    pipeline_nodes_terminal(
                        nodes,
                        terminal_states=(
                            {"verify_passed", "superseded", "awaiting_human"}
                            if pipeline_scenario == "integration-conflict"
                            else {"verify_passed", "superseded"}
                        ),
                    ),
                    nodes=[
                        {
                            "node_id": node.get("node_id"),
                            "state": node.get("state"),
                            "aggregate_state": node.get("aggregate_state"),
                        }
                        for node in nodes
                    ],
                )
                if pipeline_scenario == "overall-dod":
                    _check_appendix_overall_acceptance(
                        evidence,
                        pipeline_view,
                        data_root=data_root,
                        instance_id=instance_id,
                    )

        for method, path, payload in [
            ("GET", "/api/pipeline", None),
        ]:
            status, body = http_json(method, api_url(conductor_port, path), payload)
            evidence.check(f"conductor-api:{method} {path}", status == 200, status=status)
        for method, path, payload in [
            ("GET", "/api/dashboard", None),
            ("GET", "/api/issues", None),
            ("GET", "/api/issues/legacy-issue", None),
            ("POST", "/api/issues/legacy-issue/pin", {}),
            ("DELETE", "/api/issues/legacy-issue/pin", None),
            ("GET", "/api/traces", None),
            ("GET", "/api/retention", None),
            ("POST", "/api/retention/collect", {}),
        ]:
            status, body = http_json(method, api_url(conductor_port, path), payload)
            evidence.check(f"conductor-api-removed:{method} {path}", status == 404, status=status, body=body)

        if not (root / "final-issue-tree.json").exists():
            tree = await fetch_linear_issue_tree(token, linear["issue"]["id"])
            tree_path = root / "final-issue-tree.json"
            tree_path.write_text(json.dumps(tree, indent=2, sort_keys=True), encoding="utf-8")
            evidence.artifact("final_issue_tree", tree_path)
        _archive_pipeline_artifacts(evidence=evidence, root=root, data_root=data_root, instance_id=instance_id)

        if pipeline_scenario == "overall-dod":
            podium.stop()
            if podium in processes:
                processes.remove(podium)
            status, body = http_json("GET", api_url(conductor_port, "/api/pipeline"))
            offline_pipeline = body.get("pipeline") if status == 200 and isinstance(body, dict) else {}
            evidence.check(
                "appendix:s0a-podium-unreachable-local-defaults",
                status == 200
                and isinstance(offline_pipeline, dict)
                and int(offline_pipeline.get("policy_revision") or 0) >= 1,
                status=status,
                policy_revision=offline_pipeline.get("policy_revision") if isinstance(offline_pipeline, dict) else None,
            )

        if not permission_approval_probe:
            conductor.stop()
            processes.remove(conductor)
            conductor = start_process(
                "conductor",
                [str(bin_dir / "conductor"), "--port", str(conductor_port), "--data-root", str(data_root)],
                env=env,
                stdout_path=root / "conductor-live-recovered.log",
            )
            processes.append(conductor)
            await wait_for_http_ready(api_url(conductor_port, "/"))
            status, body = http_json("GET", api_url(conductor_port, f"/api/instances/{instance_id}"))
            recovered = body.get("instance", {}) if isinstance(body, dict) else {}
            evidence.check(
                "conductor-daemon:restart-recovers-completed-one-shot",
                status == 200 and recovered.get("process_status") in {"exited", "stopped"},
                status=status,
                process_status=recovered.get("process_status"),
                pid=recovered.get("pid"),
            )
        status, body = http_json("POST", api_url(conductor_port, f"/api/instances/{instance_id}/stop"), {})
        evidence.check("conductor-api:POST /api/instances/{id}/stop", status == 200, status=status)

        disposable_fixture = make_fixture_repo(root / "fixture-repo-disposable")
        disposable_payload = {
            "name": f"Disposable {run_id}",
            "repo_source_type": "local_path",
            "repo_source_value": str(disposable_fixture),
            "linear_project": linear["project"]["slugId"],
            "linear_filters": {"linear_agent_app_user_id": agent_app_user_id},
            "pipeline_profile": "default",
        }
        status, body = http_json("POST", api_url(conductor_port, "/api/instances"), disposable_payload)
        disposable_id = body.get("instance", {}).get("id") if status == 201 else None
        evidence.check("conductor-api:POST /api/instances disposable", status == 201, status=status)
        if disposable_id:
            status, body = http_json("DELETE", api_url(conductor_port, f"/api/instances/{disposable_id}"))
            evidence.check("conductor-api:DELETE /api/instances/{id}", status == 200, status=status)
    finally:
        for process in reversed(processes):
            process.stop()
    evidence.data["completed_at"] = utc_now()
    evidence.write()
    return evidence.data


def e2e_codex_home_seed_source() -> Path:
    raw_source = os.environ.get(CODEX_HOME_SEED_ENV, "").strip()
    if not raw_source:
        raise RuntimeError(
            f"{CODEX_HOME_SEED_ENV} is required and must point to a fixed copied Codex config seed. "
            "Do not point real-run E2E at the default user .codex directory."
        )
    return Path(raw_source)


def stage_codex_home_seed(*, source: Path, destination: Path) -> Path:
    source = source.expanduser().resolve()
    if source.name == ".codex":
        raise RuntimeError(f"Codex config source must be a fixed copied seed, not the default user .codex directory: {source}")
    if not source.is_dir():
        raise RuntimeError(f"Codex config source is not a directory: {source}")
    if destination.exists():
        shutil.rmtree(destination)
    destination.mkdir(parents=True)
    for relative in CODEX_HOME_SEED_FILES:
        source_path = source / relative
        if source_path.is_file():
            destination_path = destination / relative
            if relative == "config.toml":
                destination_path.write_text(
                    sanitize_codex_config_template(source_path.read_text(encoding="utf-8")),
                    encoding="utf-8",
                )
            else:
                shutil.copy2(source_path, destination_path)
    if not (destination / "config.toml").is_file():
        raise RuntimeError(f"Codex config source is missing config.toml: {source}")
    if not (destination / "auth.json").is_file():
        raise RuntimeError(f"Codex config source is missing auth.json: {source}")
    return destination


async def run_codex_connectivity_probe(
    *,
    evidence: Evidence,
    root: Path,
    staged_codex_home: Path,
    args: argparse.Namespace,
) -> bool:
    out = root / "codex-connectivity-probe.json"
    probe_args = argparse.Namespace(
        workspace=root / "codex-connectivity-workspace",
        codex_home=staged_codex_home,
        out=out,
        probe_kind="minimal",
        expected="connected",
        model=os.environ.get("SYMPHONY_E2E_CODEX_MODEL") or None,
        sdk_codex_bin=getattr(args, "sdk_codex_bin", None),
        sandbox=None,
        config_override=getattr(args, "config_override", None),
        timeout_ms=getattr(args, "codex_connectivity_timeout_ms", 45_000),
        init_max_attempts=getattr(args, "init_max_attempts", None) or 2,
        init_backoff_ms=getattr(args, "init_backoff_ms", None) or 500,
        init_backoff_max_ms=getattr(args, "init_backoff_max_ms", None) or 2_000,
        overload_max_attempts=getattr(args, "overload_max_attempts", None) or 2,
        overload_initial_delay_ms=getattr(args, "overload_initial_delay_ms", None) or 250,
        overload_max_delay_ms=getattr(args, "overload_max_delay_ms", None) or 2_000,
    )
    summary = await run_real_codex_connectivity_probe(probe_args)
    evidence.artifact("codex_connectivity_probe", out)
    status = str(summary.get("connectivity_status") or "unknown")
    evidence.check(
        "codex-connectivity:connected",
        status == "connected",
        status=status,
        outcome=summary.get("outcome"),
        error_code=summary.get("error_code"),
        http_status=summary.get("http_status"),
        output=str(out),
    )
    return status == "connected"


async def run_codex_planner_shaped_probe(
    *,
    evidence: Evidence,
    root: Path,
    staged_codex_home: Path,
    args: argparse.Namespace,
) -> bool:
    out = root / "codex-planner-shaped-probe.json"
    probe_args = argparse.Namespace(
        workspace=root / "codex-planner-shaped-workspace",
        codex_home=staged_codex_home,
        out=out,
        probe_kind="planner-shaped",
        expected="connected",
        model=os.environ.get("SYMPHONY_E2E_CODEX_MODEL") or None,
        sdk_codex_bin=getattr(args, "sdk_codex_bin", None),
        sandbox=None,
        config_override=getattr(args, "config_override", None),
        timeout_ms=getattr(args, "codex_planner_shaped_timeout_ms", 120_000),
        init_max_attempts=getattr(args, "init_max_attempts", None) or 2,
        init_backoff_ms=getattr(args, "init_backoff_ms", None) or 500,
        init_backoff_max_ms=getattr(args, "init_backoff_max_ms", None) or 2_000,
        overload_max_attempts=getattr(args, "overload_max_attempts", None) or 2,
        overload_initial_delay_ms=getattr(args, "overload_initial_delay_ms", None) or 250,
        overload_max_delay_ms=getattr(args, "overload_max_delay_ms", None) or 2_000,
    )
    summary = await run_real_codex_connectivity_probe(probe_args)
    evidence.artifact("codex_planner_shaped_probe", out)
    status = str(summary.get("connectivity_status") or "unknown")
    evidence.check(
        "codex-connectivity:planner-shaped",
        status == "connected",
        status=status,
        outcome=summary.get("outcome"),
        error_code=summary.get("error_code"),
        http_status=summary.get("http_status"),
        planner_shape_valid=summary.get("planner_shape_valid"),
        structured_present=summary.get("structured_present"),
        output=str(out),
    )
    return status == "connected"


def _codex_settings_from_args(args: argparse.Namespace) -> dict[str, Any]:
    settings: dict[str, Any] = {"hard_turn_timeout_ms": DEFAULT_E2E_HARD_TURN_TIMEOUT_MS}
    for arg_name in (
        "sdk_codex_bin",
        "init_max_attempts",
        "init_backoff_ms",
        "init_backoff_max_ms",
        "read_timeout_ms",
        "hard_turn_timeout_ms",
        "overload_max_attempts",
        "overload_initial_delay_ms",
        "overload_max_delay_ms",
    ):
        value = getattr(args, arg_name, None)
        if value is not None:
            settings[arg_name] = value
    config_overrides = getattr(args, "config_override", None)
    if config_overrides:
        settings["config_overrides"] = list(config_overrides)
    return settings


APPENDIX_PYTEST_HARDENING_PROBES: tuple[tuple[str, tuple[str, ...]], ...] = (
    (
        "appendix:s1-terminal-attempt-immutable",
        ("tests/test_conductor_pipeline.py::test_attempt_lifecycle_rejects_stale_fenced_results_and_publishes_verified_manifest",),
    ),
    (
        "appendix:s1-superseded-revision-refused",
        ("tests/test_conductor_pipeline.py::test_replan_rejects_replacement_subgraph_that_reuses_superseded_node_id",),
    ),
    (
        "appendix:s2-malformed-proposal-refused",
        (
            "tests/test_pipeline_contracts.py::test_plan_validator_rejects_cycles_missing_gates_and_incomplete_rubrics",
            "tests/test_pipeline_contracts.py::test_plan_validator_rejects_bad_or_unfrozen_gate_hashes",
        ),
    ),
    (
        "appendix:s2-gate-post-freeze-immutable",
        (
            "tests/test_conductor_pipeline.py::test_execute_attempt_cannot_start_without_frozen_gate_snapshot",
            "tests/test_conductor_pipeline.py::test_verify_attempt_cannot_start_without_frozen_gate_snapshot",
        ),
    ),
    (
        "appendix:s2-linear-idempotent-rerun",
        ("tests/test_conductor_pipeline.py::test_pipeline_coordinator_resumes_existing_root_planning_node_for_duplicate_dispatch",),
    ),
    (
        "appendix:s3-verifier-mutation-detection",
        (
            "tests/test_performer_modes.py::test_verify_mode_rejects_gate_commands_that_mutate_verification_worktree",
            "tests/test_performer_modes.py::test_verify_mode_rejects_gate_commands_that_mutate_tracked_state",
        ),
    ),
    (
        "appendix:s3-applied-tree-mismatch-rejected",
        ("tests/test_performer_modes.py::test_verify_mode_rejects_expected_result_tree_mismatch",),
    ),
    (
        "appendix:s3-expired-fencing-refused",
        ("tests/test_conductor_pipeline.py::test_attempt_lifecycle_rejects_stale_fenced_results_and_publishes_verified_manifest",),
    ),
    (
        "appendix:s4-superseded-revision-fenced",
        ("tests/test_conductor_pipeline.py::test_replan_rejects_replacement_subgraph_that_reuses_superseded_node_id",),
    ),
    (
        "appendix:s4-invalid-replan-escalates",
        ("tests/test_conductor_pipeline.py::test_replanning_validation_failure_escalates_to_human_without_failed_node",),
    ),
    (
        "appendix:linear-legitimate-blocks-edits-ingested",
        ("tests/test_conductor_pipeline.py::test_pipeline_linear_projector_ingests_human_added_blocks_as_new_graph_revision",),
    ),
)


def _run_appendix_pytest_hardening_probes(evidence: Evidence, *, env: dict[str, str]) -> None:
    python = str(Path.cwd() / ".venv" / "bin" / "python")
    for check_name, nodeids in APPENDIX_PYTEST_HARDENING_PROBES:
        command = [python, "-m", "pytest", *nodeids, "-q"]
        completed = subprocess.run(
            command,
            cwd=Path.cwd(),
            env=env,
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            timeout=120,
        )
        evidence.check(
            check_name,
            completed.returncode == 0,
            command=command,
            returncode=completed.returncode,
            output_tail=(completed.stdout or "")[-4000:],
        )


def _pipeline_live_refresh_evidence(samples: list[dict[str, Any]]) -> dict[str, Any]:
    node_state_signatures: list[tuple[tuple[str, str], ...]] = []
    active_lease_counts: list[int] = []
    for sample in samples:
        if not isinstance(sample, dict):
            continue
        nodes = [node for node in sample.get("pipeline_nodes", []) if isinstance(node, dict)]
        leases = [lease for lease in sample.get("pipeline_leases", []) if isinstance(lease, dict)]
        if nodes:
            node_state_signatures.append(
                tuple(sorted((str(node.get("node_id") or ""), str(node.get("state") or "")) for node in nodes))
            )
        active_lease_counts.append(len(leases))
    distinct_node_states = len(set(node_state_signatures))
    distinct_lease_counts = len(set(active_lease_counts))
    return {
        "passed": len(samples) >= 2 and (distinct_node_states >= 2 or distinct_lease_counts >= 2),
        "sample_count": len(samples),
        "distinct_node_state_snapshots": distinct_node_states,
        "distinct_active_lease_counts": distinct_lease_counts,
    }


async def _lower_policy_during_parallel_execute_probe(
    *,
    podium_port: int,
    conductor_port: int,
    runtime_token: str,
    runtime_config: dict[str, Any],
    timeout_seconds: int,
) -> dict[str, Any]:
    deadline = time.monotonic() + timeout_seconds
    observed_leases: list[dict[str, Any]] = []
    while time.monotonic() < deadline:
        status, body = http_json("GET", api_url(conductor_port, "/api/pipeline"), timeout=5)
        pipeline = body.get("pipeline") if status == 200 and isinstance(body, dict) else {}
        leases = [lease for lease in pipeline.get("leases", []) if isinstance(lease, dict)]
        execute_leases = [lease for lease in leases if lease.get("mode") == "execute"]
        if len(execute_leases) >= 2:
            observed_leases = execute_leases
            break
        await asyncio.sleep(1)
    if len(observed_leases) < 2:
        return {"passed": False, "reason": "parallel_execute_leases_not_observed", "observed_leases": observed_leases}
    lowered = json.loads(json.dumps(runtime_config))
    lowered["version"] = int(runtime_config.get("version") or 1) + 1
    lowered["scheduler_policy"]["version"] = lowered["version"]
    lowered["scheduler_policy"]["capacity"]["by_mode"]["execute"] = 1
    status, body = http_json(
        "POST",
        api_url(podium_port, "/api/v1/runtime/config"),
        lowered,
        headers={"Authorization": f"Bearer {runtime_token}"},
        timeout=5,
    )
    if status != 200:
        return {"passed": False, "reason": "lowered_policy_push_failed", "status": status, "body": body}
    observed_ids = {str(lease.get("lease_id") or "") for lease in observed_leases}
    latest_policy_revision = 0
    latest_execute_ids: set[str] = set()
    deadline = time.monotonic() + 30
    while time.monotonic() < deadline:
        pipeline_status, pipeline_body = http_json("GET", api_url(conductor_port, "/api/pipeline"), timeout=5)
        pipeline = pipeline_body.get("pipeline") if pipeline_status == 200 and isinstance(pipeline_body, dict) else {}
        latest_policy_revision = int(pipeline.get("policy_revision") or 0) if isinstance(pipeline, dict) else 0
        leases = [lease for lease in pipeline.get("leases", []) if isinstance(lease, dict)]
        latest_execute_ids = {str(lease.get("lease_id") or "") for lease in leases if lease.get("mode") == "execute"}
        if latest_policy_revision >= lowered["version"]:
            break
        await asyncio.sleep(1)
    return {
        "passed": latest_policy_revision >= lowered["version"] and observed_ids.issubset(latest_execute_ids),
        "lowered_version": lowered["version"],
        "latest_policy_revision": latest_policy_revision,
        "observed_execute_lease_ids": sorted(observed_ids),
        "latest_execute_lease_ids": sorted(latest_execute_ids),
    }


def _pipeline_scenario(args: argparse.Namespace) -> str:
    scenario = str(getattr(args, "pipeline_scenario", "basic") or "basic")
    allowed = {"basic", "parallel", "replan", "integration-conflict", "runtime-wait", "gate-normalization", "overall-dod"}
    return scenario if scenario in allowed else "basic"


def _effective_permission_approval_probe(args: argparse.Namespace) -> bool:
    return bool(getattr(args, "permission_approval_probe", False) or _pipeline_scenario(args) in {"runtime-wait", "overall-dod"})


def _should_run_final_pipeline_stage_checks(*, permission_approval_probe: bool, pipeline_scenario: str) -> bool:
    return not permission_approval_probe or pipeline_scenario == "overall-dod"


def _pipeline_scenario_issue_description(scenario: str, run_id: str) -> str:
    base = (
        f"Real Symphony e2e task for run {run_id}. "
        "Create SYMPHONY_REAL_E2E_RESULT.md at the workspace root, include this Linear issue identifier, "
        "say Podium, Conductor, and Performer reached Codex, and run pytest tests/test_smoke.py -q."
    )
    if scenario == "parallel":
        return (
            f"Real Symphony parallel pipeline e2e task for run {run_id}. "
            "Use node_ids hell-parallel-a, hell-parallel-b, and hell-downstream-integration. "
            "Create two independent deliverables with no dependency between them: SYMPHONY_PARALLEL_A.md and "
            "SYMPHONY_PARALLEL_B.md. Each file must include this Linear issue identifier and the words "
            "parallel execute. Also create SYMPHONY_REAL_E2E_RESULT.md and run pytest tests/test_smoke.py -q."
        )
    if scenario == "replan":
        return (
            f"Real Symphony replan pipeline e2e task for run {run_id}. "
            "Create SYMPHONY_REAL_E2E_RESULT.md with the Linear issue identifier and the words replan recovery. "
            "If verification reports a missing or incorrect result, decompose the replacement work into a fresh "
            "subtask graph and run pytest tests/test_smoke.py -q."
        )
    if scenario == "integration-conflict":
        return (
            f"Real Symphony integration conflict e2e task for run {run_id}. "
            "Use node_ids hell-parallel-a, hell-parallel-b, and hell-downstream-integration. "
            "Planner must create two independent parallel subtasks and must not add a blocks dependency between them. "
            "Each subtask must modify the already tracked file SYMPHONY_CONFLICT_SHARED.md with different content, "
            "so their verified patches overlap and the integration queue must surface the conflict through a "
            "[Human Action] child issue. At least one subtask must create SYMPHONY_REAL_E2E_RESULT.md with the Linear "
            "issue identifier and the words integration conflict. Run pytest tests/test_smoke.py -q."
        )
    if scenario == "runtime-wait":
        return (
            f"Real Symphony runtime wait e2e task for run {run_id}. "
            "Create SYMPHONY_REAL_E2E_RESULT.md with the Linear issue identifier and the words runtime wait. "
            "If the runtime asks for tool approval or operator input, Symphony must project that Runtime Wait "
            "to a [Human Action] child issue before resuming. Run pytest tests/test_smoke.py -q."
        )
    if scenario == "overall-dod":
        return (
            f"Real Symphony Appendix overall DoD e2e task for run {run_id}. "
            "Use node_ids hell-parallel-a, hell-parallel-b, and hell-downstream-integration. "
            "Planner must create two independent parallel subtasks and must not add a blocks dependency between them. "
            "Each parallel subtask must modify the already tracked file SYMPHONY_CONFLICT_SHARED.md with different "
            "content so their verified patches overlap and Symphony must surface the integration result without a "
            "silent last-writer-wins merge. At least one downstream subtask must depend on both parallel subtasks' "
            "verified upstream output. "
            "Create SYMPHONY_REAL_E2E_RESULT.md with the Linear issue identifier and the words overall dod. "
            "If verification fails, replan with a replacement subgraph that preserves the requested files and smoke "
            "test. If the runtime asks for tool approval or operator input, Symphony must project that Runtime Wait "
            "to a [Human Action] child issue before resuming. Run pytest tests/test_smoke.py -q."
        )
    return base


def _pipeline_scenario_intent(scenario: str) -> dict[str, Any]:
    if scenario not in {"parallel", "integration-conflict", "overall-dod", "gate-normalization"}:
        return {}
    intent: dict[str, Any] = {
        "required_gate_steps": [
            {"step": "pytest tests/test_smoke.py -q", "source": "appendix_harness"}
        ]
    }
    if scenario in {"parallel", "integration-conflict", "overall-dod"}:
        intent["requires_parent_aggregate"] = True
        intent["parallel_dependency_shape"] = {
            "parallel_branch_node_ids": ["hell-parallel-a", "hell-parallel-b"],
            "downstream_node_ids": ["hell-downstream-integration"],
        }
    if scenario in {"integration-conflict", "overall-dod", "gate-normalization"}:
        intent["required_gate_steps"].append(
            {"step": "test -f SYMPHONY_CONFLICT_SHARED.md", "source": "appendix_harness"}
        )
    return intent


def _prepare_pipeline_scenario_fixture(fixture: Path, scenario: str) -> None:
    if scenario not in {"integration-conflict", "overall-dod"}:
        return
    conflict_path = fixture / "SYMPHONY_CONFLICT_SHARED.md"
    conflict_path.write_text("base integration conflict fixture\n", encoding="utf-8")
    subprocess.run(["git", "add", conflict_path.name], cwd=fixture, check=True)
    subprocess.run(["git", "commit", "-q", "-m", "add integration conflict fixture"], cwd=fixture, check=True)


async def _wait_for_final_pipeline_view(
    conductor_port: int,
    *,
    timeout_seconds: int,
    allow_human_wait: bool = False,
) -> dict[str, Any]:
    deadline = time.monotonic() + timeout_seconds
    last_view: dict[str, Any] = {}
    while time.monotonic() < deadline:
        status, pipeline_body = http_json("GET", api_url(conductor_port, "/api/pipeline"))
        pipeline_view = (
            pipeline_body.get("pipeline")
            if status == 200 and isinstance(pipeline_body, dict) and isinstance(pipeline_body.get("pipeline"), dict)
            else {}
        )
        if isinstance(pipeline_view, dict):
            last_view = pipeline_view
            if _pipeline_final_view_converged(pipeline_view, allow_human_wait=allow_human_wait):
                return pipeline_view
        await asyncio.sleep(2)
    return last_view


def _pipeline_final_view_converged(pipeline_view: dict[str, Any], *, allow_human_wait: bool = False) -> bool:
    nodes = [node for node in pipeline_view.get("nodes", []) if isinstance(node, dict)]
    terminal_states = {"verify_passed", "superseded"}
    if allow_human_wait:
        terminal_states.add("awaiting_human")
    return pipeline_nodes_terminal(nodes, terminal_states=terminal_states) and _pipeline_projection_matches_current_revision(
        pipeline_view
    )


def _permission_probe_block_cleared(sample: dict[str, Any]) -> bool:
    actions = sample.get("pipeline_human_actions") if isinstance(sample, dict) else []
    if not isinstance(actions, list):
        return False
    return not [
        action
        for action in actions
        if isinstance(action, dict) and str(action.get("status") or "").lower() in {"waiting", "open"}
    ]


def _pipeline_prediction_is_conditional(pipeline_view: dict[str, Any]) -> bool:
    basis = pipeline_view.get("prediction_basis") if isinstance(pipeline_view.get("prediction_basis"), dict) else {}
    if not basis.get("graph_revision") or not basis.get("policy_revision") or not basis.get("generated_at"):
        return False
    if str(basis.get("assumption") or "") != "unknown verifies pass":
        return False
    order = pipeline_view.get("predicted_call_order")
    if not isinstance(order, list):
        return False
    return all(
        isinstance(item, dict) and str(item.get("confidence") or "") == "conditional"
        for item in order
    )


def _managed_run_avoids_global_codex_home(pipeline_view: dict[str, Any]) -> bool:
    home_codex = str(Path.home().resolve() / ".codex")
    text = json.dumps(pipeline_view, sort_keys=True, default=str)
    if home_codex in text or str(Path("~/.codex").expanduser()) in text:
        return False
    runtime_config = pipeline_view.get("runtime_config") if isinstance(pipeline_view.get("runtime_config"), dict) else {}
    profiles = runtime_config.get("profiles") if isinstance(runtime_config.get("profiles"), dict) else {}
    for profile in profiles.values():
        if not isinstance(profile, dict):
            continue
        settings = profile.get("settings") if isinstance(profile.get("settings"), dict) else {}
        source = str(settings.get("codex_home_source") or "")
        if source and not source.startswith("$"):
            return False
    return True


def _pipeline_projection_matches_current_revision(pipeline_view: dict[str, Any]) -> bool:
    try:
        graph_revision = int(pipeline_view.get("graph_revision") or 0)
    except (TypeError, ValueError):
        return False
    nodes = {
        str(node.get("node_id") or ""): node
        for node in pipeline_view.get("nodes", [])
        if isinstance(node, dict) and str(node.get("node_id") or "")
    }
    projections = [projection for projection in pipeline_view.get("linear_projections", []) if isinstance(projection, dict)]
    if graph_revision <= 0 or not nodes or not projections:
        return False
    for projection in projections:
        metadata = projection.get("metadata") if isinstance(projection.get("metadata"), dict) else {}
        node_id = str(projection.get("node_id") or metadata.get("node_id") or "")
        if node_id not in nodes:
            return False
        if str(metadata.get("node_id") or "") != node_id:
            return False
        try:
            projection_revision = int(metadata.get("conductor_revision") or 0)
        except (TypeError, ValueError):
            return False
        if projection_revision != graph_revision:
            return False
        if not metadata.get("graph_id") or not metadata.get("operator_status"):
            return False
        gate_hash = str(nodes[node_id].get("gate_snapshot_hash") or "")
        if gate_hash and metadata.get("gate_snapshot_hash") != gate_hash:
            return False
    return True


def _check_pipeline_scenario_acceptance(evidence: Evidence, scenario: str, pipeline_view: dict[str, Any]) -> None:
    if scenario == "basic":
        return
    if scenario == "parallel":
        attempts = [attempt for attempt in pipeline_view.get("attempts", []) if isinstance(attempt, dict)]
        execute_attempts = [attempt for attempt in attempts if attempt.get("mode") == "execute"]
        execute_limit = ((pipeline_view.get("capacity") or {}).get("by_mode") or {}).get("execute")
        policy_id = str(pipeline_view.get("policy_id") or "")
        policy_source = str(pipeline_view.get("policy_source") or "")
        runtime_config = pipeline_view.get("runtime_config") if isinstance(pipeline_view.get("runtime_config"), dict) else {}
        expected_policy = runtime_config.get("scheduler_policy") if isinstance(runtime_config.get("scheduler_policy"), dict) else {}
        expected_scheduler_policy_id = str(expected_policy.get("policy_id") or "")
        expected_scheduler_policy_version = _safe_int(expected_policy.get("version"))
        last_scheduler_policy_id = str(pipeline_view.get("last_scheduler_policy_id") or "")
        last_scheduler_policy_version = _safe_int(pipeline_view.get("last_scheduler_policy_version"))
        last_scheduler_policy_source = str(pipeline_view.get("last_scheduler_policy_source") or "")
        last_scheduler_tick_at = str(pipeline_view.get("last_scheduler_tick_at") or "")
        scheduler_policy_matches = (
            bool(expected_scheduler_policy_id)
            and expected_scheduler_policy_version > 0
            and last_scheduler_policy_source == "podium_pushed"
            and last_scheduler_policy_id == expected_scheduler_policy_id
            and last_scheduler_policy_version == expected_scheduler_policy_version
            and bool(last_scheduler_tick_at)
        )
        evidence.check(
            "scenario:parallel-execute-overlap",
            policy_source == "podium_pushed"
            and bool(policy_id)
            and scheduler_policy_matches
            and len(execute_attempts) >= 2
            and _attempt_intervals_overlap(execute_attempts),
            execute_attempts=[
                {
                    "attempt_id": attempt.get("attempt_id"),
                    "started_at": attempt.get("started_at"),
                    "completed_at": attempt.get("completed_at"),
                }
                for attempt in execute_attempts
            ],
            execute_limit=execute_limit,
            policy_id=policy_id,
            policy_source=policy_source,
            expected_scheduler_policy_id=expected_scheduler_policy_id,
            expected_scheduler_policy_version=expected_scheduler_policy_version,
            last_scheduler_policy_id=last_scheduler_policy_id,
            last_scheduler_policy_version=last_scheduler_policy_version,
            last_scheduler_policy_source=last_scheduler_policy_source,
            last_scheduler_tick_at=last_scheduler_tick_at,
        )
    elif scenario == "replan":
        nodes = [node for node in pipeline_view.get("nodes", []) if isinstance(node, dict)]
        evidence.check(
            "scenario:replan-replacement-subgraph",
            int(pipeline_view.get("graph_revision") or 0) > 1
            and any(node.get("state") == "superseded" or node.get("superseded_by") for node in nodes),
            graph_revision=pipeline_view.get("graph_revision"),
            nodes=[{"node_id": node.get("node_id"), "state": node.get("state"), "superseded_by": node.get("superseded_by")} for node in nodes],
        )
    elif scenario == "integration-conflict":
        waits = [wait for wait in pipeline_view.get("human_waits", []) if isinstance(wait, dict)]
        integrations = [item for item in pipeline_view.get("integration_queue", []) if isinstance(item, dict)]
        evidence.check(
            "scenario:integration-conflict-human-action",
            pipeline_has_conflict_escalation_evidence(pipeline_view),
            human_waits=waits,
            integrations=integrations,
        )
    elif scenario == "runtime-wait":
        waits = [wait for wait in pipeline_view.get("runtime_waits", []) if isinstance(wait, dict)]
        projections = [projection for projection in pipeline_view.get("linear_projections", []) if isinstance(projection, dict)]
        resolved_wait_visible = any(wait.get("wait_kind") and wait.get("child_issue_id") for wait in waits)
        evidence.check(
            "scenario:runtime-wait-projected",
            bool(waits)
            and (
                any((projection.get("metadata") or {}).get("operator_wait_kind") for projection in projections)
                or resolved_wait_visible
            ),
            runtime_waits=waits,
            projections=projections,
        )
    elif scenario == "gate-normalization":
        gate_provenance_evidence = _gate_step_provenance_evidence(pipeline_view)
        evidence.check(
            "scenario:gate-normalization-provenance",
            gate_provenance_evidence["all_steps_have_valid_source"]
            and gate_provenance_evidence["all_gates_have_authoritative_step"],
            **gate_provenance_evidence,
        )
    elif scenario == "overall-dod":
        _check_pipeline_scenario_acceptance(evidence, "parallel", pipeline_view)
        _check_pipeline_scenario_acceptance(evidence, "replan", pipeline_view)
        _check_pipeline_scenario_acceptance(evidence, "integration-conflict", pipeline_view)
        _check_pipeline_scenario_acceptance(evidence, "runtime-wait", pipeline_view)
        _check_pipeline_scenario_acceptance(evidence, "gate-normalization", pipeline_view)


def _safe_int(value: Any) -> int:
    try:
        return int(value or 0)
    except (TypeError, ValueError):
        return 0


def _check_appendix_overall_acceptance(
    evidence: Evidence,
    pipeline_view: dict[str, Any],
    *,
    data_root: Path | None = None,
    instance_id: str | None = None,
) -> None:
    home_evidence = _runtime_home_evidence(data_root=data_root, instance_id=instance_id, pipeline_view=pipeline_view)
    evidence.check(
        "appendix:s0c-distinct-mode-codex-homes",
        home_evidence["distinct_mode_homes"],
        runtime_homes=home_evidence,
    )
    evidence.check(
        "appendix:s0c-concurrent-runs-do-not-share-mode-homes",
        home_evidence["concurrent_execute_homes_distinct"],
        runtime_homes=home_evidence,
    )
    profiles = (pipeline_view.get("runtime_config") or {}).get("profiles") if isinstance(pipeline_view.get("runtime_config"), dict) else {}
    evidence.check(
        "appendix:s0c-non-codex-backend-selected",
        any(
            isinstance(profile, dict) and profile.get("backend") and profile.get("backend") != "codex"
            for profile in (profiles or {}).values()
        ),
        profiles=profiles,
    )
    evidence.check(
        "appendix:pipeline-prediction-conditional",
        _pipeline_prediction_is_conditional(pipeline_view),
        prediction_basis=pipeline_view.get("prediction_basis"),
        predicted_call_order=pipeline_view.get("predicted_call_order"),
    )
    basis = pipeline_view.get("prediction_basis") if isinstance(pipeline_view.get("prediction_basis"), dict) else {}
    evidence.check(
        "appendix:s0b-view-refreshes-after-rewrite",
        int(pipeline_view.get("graph_revision") or 0) > 1
        and int(basis.get("graph_revision") or 0) == int(pipeline_view.get("graph_revision") or 0),
        graph_revision=pipeline_view.get("graph_revision"),
        prediction_basis=basis,
    )
    parent_evidence = _parent_aggregate_evidence(pipeline_view)
    evidence.check("appendix:s1-parent-aggregate-real", parent_evidence["has_verified_parent"], **parent_evidence)
    evidence.check(
        "appendix:s1-parent-failed-child-not-passing",
        parent_evidence["failed_or_waiting_child_not_passing"],
        **parent_evidence,
    )
    downstream_evidence = _downstream_verify_gate_evidence(pipeline_view)
    evidence.check(
        "appendix:s3-downstream-gated-on-verify-passed",
        downstream_evidence["gate_observed"],
        **downstream_evidence,
    )
    overall_shape_evidence = _overall_downstream_depends_on_both_parallel_evidence(pipeline_view)
    evidence.check(
        "appendix:overall-downstream-depends-on-both-parallel-subtasks",
        overall_shape_evidence["has_downstream_with_both_parallel_blockers"],
        **overall_shape_evidence,
    )
    gate_provenance_evidence = _gate_step_provenance_evidence(pipeline_view)
    evidence.check(
        "appendix:gate-step-provenance-checkpoint",
        gate_provenance_evidence["all_steps_have_valid_source"]
        and gate_provenance_evidence["all_gates_have_authoritative_step"],
        **gate_provenance_evidence,
    )
    s4_evidence = _superseded_node_evidence(pipeline_view)
    evidence.check("appendix:s4-no-old-node-dependent-dispatch", s4_evidence["no_superseded_dispatch"], **s4_evidence)
    evidence.check(
        "appendix:no-global-codex-home",
        _managed_run_avoids_global_codex_home(pipeline_view),
        runtime_config=pipeline_view.get("runtime_config"),
    )
    evidence.check(
        "appendix:patch-conflict-reproducible-under-real-concurrency",
        pipeline_has_conflict_escalation_evidence(pipeline_view)
        and any(check.get("name") == "scenario:parallel-execute-overlap" and check.get("passed") for check in evidence.data.get("checks", [])),
        integration_queue=pipeline_view.get("integration_queue"),
    )
    evidence.check(
        "appendix:patch-downstream-never-consumes-unintegrated-output",
        pipeline_integrations_terminal(pipeline_view),
        integration_queue=pipeline_view.get("integration_queue"),
    )
    evidence.check("appendix:reconcile-findings-clean", not evidence.data.get("failures"))
    score_audit = appendix_feature_score_audit([evidence.data])
    evidence.check(
        "appendix:evidence-scores-within-hard-caps",
        bool(score_audit["within_hard_caps"]),
        audit=score_audit,
    )
    audit = appendix_exit_bar_audit([evidence.data])
    evidence.check("appendix:feature-scores-r-plus-h", audit["pass"], audit=audit)


def _runtime_home_evidence(
    *,
    data_root: Path | None,
    instance_id: str | None,
    pipeline_view: dict[str, Any],
) -> dict[str, Any]:
    attempts = [attempt for attempt in pipeline_view.get("attempts", []) if isinstance(attempt, dict)]
    homes_root = data_root / "instances" / instance_id / "runtime-homes" if data_root is not None and instance_id else None
    homes: dict[str, list[str]] = {mode: [] for mode in ("plan", "execute", "verify")}
    if homes_root is not None and homes_root.is_dir():
        for mode in homes:
            mode_root = homes_root / mode
            if not mode_root.is_dir():
                continue
            for path in sorted(mode_root.glob("*/*")):
                if path.is_dir():
                    homes[mode].append(str(path))
            for path in sorted(mode_root.iterdir()):
                if path.is_dir() and not any(Path(existing).parent == path for existing in homes[mode]):
                    if path.name in {"codex", "local-verifier"}:
                        homes[mode].append(str(path))
    execute_attempt_count = sum(1 for attempt in attempts if attempt.get("mode") == "execute")
    execute_homes = homes.get("execute", [])
    mode_home_sets = [set(paths) for paths in homes.values() if paths]
    flattened = [path for paths in homes.values() for path in paths]
    return {
        "homes_root": str(homes_root) if homes_root is not None else None,
        "homes": homes,
        "execute_attempt_count": execute_attempt_count,
        "distinct_mode_homes": bool(flattened)
        and len(flattened) == len(set(flattened))
        and not any(left & right for index, left in enumerate(mode_home_sets) for right in mode_home_sets[index + 1 :]),
        "concurrent_execute_homes_distinct": execute_attempt_count < 2
        or (len(execute_homes) >= execute_attempt_count and len(execute_homes) == len(set(execute_homes))),
    }


def _parent_aggregate_evidence(pipeline_view: dict[str, Any]) -> dict[str, Any]:
    nodes = [node for node in pipeline_view.get("nodes", []) if isinstance(node, dict)]
    children_by_parent: dict[str, list[dict[str, Any]]] = {}
    for node in nodes:
        parent = str(node.get("parent_node_id") or "")
        if parent:
            children_by_parent.setdefault(parent, []).append(node)
    verified_parent_ids: list[str] = []
    bad_parent_ids: list[str] = []
    for parent_id, children in children_by_parent.items():
        parent = next((node for node in nodes if node.get("node_id") == parent_id), None)
        if parent is None:
            continue
        parent_state = str(parent.get("aggregate_state") or parent.get("state") or "")
        child_states = {str(child.get("aggregate_state") or child.get("state") or "") for child in children}
        passing_child_states = {"verify_passed", "superseded"}
        if parent_state == "verify_passed" and child_states and all(state in passing_child_states for state in child_states):
            verified_parent_ids.append(parent_id)
        if parent_state == "verify_passed" and any(state in {"failed", "awaiting_human", "verify_failed"} for state in child_states):
            bad_parent_ids.append(parent_id)
    return {
        "has_verified_parent": bool(verified_parent_ids),
        "failed_or_waiting_child_not_passing": not bad_parent_ids,
        "verified_parent_ids": verified_parent_ids,
        "bad_parent_ids": bad_parent_ids,
        "parent_count": len(children_by_parent),
    }


def _downstream_verify_gate_evidence(pipeline_view: dict[str, Any]) -> dict[str, Any]:
    attempts = [attempt for attempt in pipeline_view.get("attempts", []) if isinstance(attempt, dict)]
    execute_attempts = [attempt for attempt in attempts if attempt.get("mode") == "execute"]
    verify_attempts = [attempt for attempt in attempts if attempt.get("mode") == "verify" and int(attempt.get("score") or 0) >= 3]
    blocks = [
        (str(edge[0]), str(edge[1]))
        for edge in pipeline_view.get("blocks", [])
        if isinstance(edge, list) and len(edge) == 2
    ]
    blockers_by_node: dict[str, set[str]] = {}
    for blocker, blocked in blocks:
        blockers_by_node.setdefault(blocked, set()).add(blocker)
    verifies_by_node: dict[str, list[dict[str, Any]]] = {}
    for attempt in verify_attempts:
        node_id = str(attempt.get("node_id") or "")
        if node_id:
            verifies_by_node.setdefault(node_id, []).append(attempt)
    downstream_execute_ids: list[str] = []
    upstream_verify_ids: set[str] = set()
    if blockers_by_node:
        for attempt in execute_attempts:
            node_id = str(attempt.get("node_id") or "")
            blockers = blockers_by_node.get(node_id, set())
            if not blockers:
                continue
            started = _parse_e2e_time(attempt.get("started_at"))
            blocker_completions: list[datetime] = []
            blocker_verify_ids: list[str] = []
            for blocker in blockers:
                blocker_verifies = verifies_by_node.get(blocker, [])
                if not blocker_verifies:
                    blocker_completions = []
                    break
                latest = max(
                    (
                        (_parse_e2e_time(verify.get("completed_at")), str(verify.get("attempt_id") or ""))
                        for verify in blocker_verifies
                        if _parse_e2e_time(verify.get("completed_at")) is not None
                    ),
                    default=None,
                    key=lambda item: item[0],
                )
                if latest is None:
                    blocker_completions = []
                    break
                blocker_completions.append(latest[0])
                blocker_verify_ids.append(latest[1])
            if started is not None and blocker_completions and started > max(blocker_completions):
                downstream_execute_ids.append(str(attempt.get("attempt_id") or ""))
                upstream_verify_ids.update(blocker_verify_ids)
    else:
        return {
            "gate_observed": False,
            "verify_passed_attempts": [attempt.get("attempt_id") for attempt in verify_attempts],
            "downstream_execute_attempts": [],
            "reason": "no_block_edges",
        }
    return {
        "gate_observed": bool(verify_attempts) and bool(downstream_execute_ids),
        "verify_passed_attempts": sorted(upstream_verify_ids)
        if upstream_verify_ids
        else [attempt.get("attempt_id") for attempt in verify_attempts],
        "downstream_execute_attempts": downstream_execute_ids,
    }


def _overall_downstream_depends_on_both_parallel_evidence(pipeline_view: dict[str, Any]) -> dict[str, Any]:
    nodes = [node for node in pipeline_view.get("nodes", []) if isinstance(node, dict)]
    blocks = [
        (str(edge[0]), str(edge[1]))
        for edge in pipeline_view.get("blocks", [])
        if isinstance(edge, list) and len(edge) == 2
    ]
    labels = {
        str(node.get("node_id") or ""): f"{node.get('node_id') or ''} {node.get('title') or ''}".lower()
        for node in nodes
    }
    parallel_node_ids = sorted(node_id for node_id, label in labels.items() if "parallel" in label)
    downstream_node_ids = sorted(
        node_id
        for node_id, label in labels.items()
        if node_id not in parallel_node_ids and ("downstream" in label or "integration" in label)
    )
    blockers_by_node: dict[str, set[str]] = {}
    for blocker, blocked in blocks:
        blockers_by_node.setdefault(blocked, set()).add(blocker)
    matching_downstream = [
        node_id
        for node_id in downstream_node_ids
        if len(blockers_by_node.get(node_id, set()).intersection(parallel_node_ids)) >= 2
    ]
    return {
        "has_downstream_with_both_parallel_blockers": bool(matching_downstream),
        "parallel_node_ids": parallel_node_ids,
        "downstream_node_ids": downstream_node_ids,
        "matching_downstream_node_ids": matching_downstream,
        "blocks": [[source, target] for source, target in blocks],
    }


def _gate_step_provenance_evidence(pipeline_view: dict[str, Any]) -> dict[str, Any]:
    valid_sources = {"issue_requirement", "appendix_harness", "planner_inferred", "system_repair"}
    authoritative_sources = {"issue_requirement", "appendix_harness", "system_repair"}
    gates = [gate for gate in pipeline_view.get("gates", []) if isinstance(gate, dict)]
    missing_source_steps: list[dict[str, Any]] = []
    invalid_source_steps: list[dict[str, Any]] = []
    gates_without_authoritative_step: list[str] = []
    for gate in gates:
        gate_id = str(gate.get("gate_id") or gate.get("task_id") or "")
        content = gate.get("content") if isinstance(gate.get("content"), dict) else {}
        steps = content.get("verification_procedure") if isinstance(content, dict) else []
        authoritative = False
        for index, step in enumerate(steps if isinstance(steps, list) else []):
            if not isinstance(step, dict):
                missing_source_steps.append({"gate_id": gate_id, "index": index, "step": step})
                continue
            source = str(step.get("source") or "")
            if not source:
                missing_source_steps.append({"gate_id": gate_id, "index": index, "step": step.get("step")})
                continue
            if source not in valid_sources:
                invalid_source_steps.append({"gate_id": gate_id, "index": index, "source": source})
                continue
            if source in authoritative_sources:
                authoritative = True
        if not authoritative:
            gates_without_authoritative_step.append(gate_id)
    return {
        "gate_count": len(gates),
        "all_steps_have_valid_source": bool(gates) and not missing_source_steps and not invalid_source_steps,
        "all_gates_have_authoritative_step": bool(gates) and not gates_without_authoritative_step,
        "missing_source_steps": missing_source_steps,
        "invalid_source_steps": invalid_source_steps,
        "gates_without_authoritative_step": gates_without_authoritative_step,
    }


def _superseded_node_evidence(pipeline_view: dict[str, Any]) -> dict[str, Any]:
    nodes = [node for node in pipeline_view.get("nodes", []) if isinstance(node, dict)]
    attempts = [attempt for attempt in pipeline_view.get("attempts", []) if isinstance(attempt, dict)]
    superseded_ids = {
        str(node.get("node_id") or "")
        for node in nodes
        if node.get("state") == "superseded" or node.get("superseded_by")
    }
    live_superseded_attempts = [
        attempt.get("attempt_id")
        for attempt in attempts
        if str(attempt.get("node_id") or "") in superseded_ids and attempt.get("state") in {"pending", "running"}
    ]
    return {
        "no_superseded_dispatch": bool(superseded_ids) and not live_superseded_attempts,
        "superseded_node_ids": sorted(superseded_ids),
        "live_superseded_attempts": live_superseded_attempts,
    }


def _attempt_intervals_overlap(attempts: list[dict[str, Any]]) -> bool:
    intervals: list[tuple[datetime, datetime]] = []
    for attempt in attempts:
        started_at = _parse_e2e_time(attempt.get("started_at"))
        completed_at = _parse_e2e_time(attempt.get("completed_at"))
        if started_at is not None and completed_at is not None:
            intervals.append((started_at, completed_at))
    for index, first in enumerate(intervals):
        for second in intervals[index + 1 :]:
            if first[0] <= second[1] and second[0] <= first[1]:
                return True
    return False


def _parse_e2e_time(value: Any) -> datetime | None:
    if not value:
        return None
    text = str(value)
    if text.endswith("Z"):
        text = text[:-1] + "+00:00"
    try:
        return datetime.fromisoformat(text)
    except ValueError:
        return None


def _archive_pipeline_artifacts(*, evidence: Evidence, root: Path, data_root: Path, instance_id: str) -> None:
    for name, path in {
        "podium_log": root / "podium.log",
        "conductor_log": root / "conductor.log",
        "conductor_restarted_log": root / "conductor-restarted.log",
        "pipeline_db": data_root / "pipeline.db",
    }.items():
        if path.exists():
            evidence.artifact(name, path)
    attempt_root = data_root / "instances" / instance_id / "state" / "pipeline"
    if not attempt_root.exists():
        return
    for attempt_dir in sorted(path for path in attempt_root.iterdir() if path.is_dir()):
        safe_attempt = attempt_dir.name.replace("/", "_")
        for filename, suffix in [
            ("attempt-request.json", "request"),
            ("attempt-result.json", "result"),
            ("attempt-result.json.applied", "result_applied"),
            ("attempt.log", "log"),
        ]:
            path = attempt_dir / filename
            if path.exists():
                evidence.artifact(f"attempt_{safe_attempt}_{suffix}", path)


def _handle_pipeline_runtime_blocker(
    *,
    evidence: Evidence,
    root: Path,
    data_root: Path,
    instance_id: str,
    run_result: dict[str, Any],
) -> bool:
    failure = _latest_pipeline_runtime_failure(evidence)
    if failure is None:
        return False
    _archive_pipeline_artifacts(evidence=evidence, root=root, data_root=data_root, instance_id=instance_id)
    if "checkpoint:04-dispatch-and-plan" not in evidence.data.get("artifacts", {}):
        evidence.checkpoint(
            "04-dispatch-and-plan",
            {
                "status": "failed",
                "failure": failure,
                "samples": (run_result.get("samples") or [])[-3:],
                "failures": [failure],
            },
        )
    plan_paths = _failed_plan_attempt_paths(data_root=data_root, instance_id=instance_id, failure=failure)
    analysis_report = analyze_plan_artifacts(
        attempt_request=plan_paths.get("request"),
        attempt_result=plan_paths.get("result"),
        dispatch_context=_dispatch_context_for_plan_attempt(data_root=data_root, plan_paths=plan_paths),
    )
    analysis_path = root / "plan-offline-analysis.json"
    analysis_path.write_text(json.dumps(analysis_report, indent=2, sort_keys=True), encoding="utf-8")
    evidence.artifact("plan_offline_analysis", analysis_path)
    evidence.checkpoint(
        "05-plan-offline-analysis",
        {
            "status": "completed" if analysis_report.get("status") == "analyzed" else "limited",
            "analysis": analysis_report,
        },
    )
    root_causes = [
        item
        for item in analysis_report.get("actionable_root_causes", [])
        if isinstance(item, dict) and item.get("code")
    ]
    if root_causes:
        existing_codes = {
            str(item.get("code") or "")
            for item in evidence.data.setdefault("actionable_root_causes", [])
            if isinstance(item, dict)
        }
        for item in root_causes:
            if str(item.get("code") or "") not in existing_codes:
                evidence.data["actionable_root_causes"].append(item)
                existing_codes.add(str(item.get("code") or ""))
    for stage in DEPENDENT_RUNTIME_STAGES_AFTER_PLAN:
        evidence.blocked(
            stage,
            blocked_by="04-dispatch-and-plan",
            reason=str(failure.get("reason") or "pipeline_runtime_error"),
            upstream_check=str(failure.get("name") or "pipeline-runtime-error:visible"),
        )
    evidence.write()
    return True


def _checkpoint_and_block_after_stage(
    evidence: Evidence,
    stage: str,
    *,
    reason: str,
    blocked_stages: tuple[str, ...] | list[str],
) -> None:
    latest_failures = [failure for failure in evidence.data.get("failures", []) if isinstance(failure, dict)]
    evidence.checkpoint(
        stage,
        {
            "status": "failed",
            "reason": reason,
            "failures": latest_failures[-3:],
        },
    )
    for blocked_stage in blocked_stages:
        evidence.blocked(blocked_stage, blocked_by=stage, reason=reason)


def _stages_after(stage: str) -> tuple[str, ...]:
    try:
        index = E2E_STAGE_ORDER.index(stage)
    except ValueError:
        return ()
    return E2E_STAGE_ORDER[index + 1 :]


def _latest_pipeline_runtime_failure(evidence: Evidence) -> dict[str, Any] | None:
    failures = [failure for failure in evidence.data.get("failures", []) if isinstance(failure, dict)]
    for failure in reversed(failures):
        if failure.get("name") == "pipeline-runtime-error:visible":
            if "reason" not in failure:
                failure = dict(failure)
                failure["reason"] = _pipeline_runtime_failure_reason(failure)
            return failure
    return None


def _pipeline_runtime_failure_reason(failure: dict[str, Any]) -> str:
    payload = failure.get("failure")
    if isinstance(payload, dict):
        kind = str(payload.get("kind") or "")
        attempts = [attempt for attempt in payload.get("attempts", []) if isinstance(attempt, dict)]
        for attempt in attempts:
            error = str(attempt.get("error") or "")
            if error:
                return error
        if kind:
            return kind
    return str(failure.get("error") or failure.get("status") or "pipeline_runtime_error")


def _failed_plan_attempt_paths(
    *,
    data_root: Path,
    instance_id: str,
    failure: dict[str, Any],
) -> dict[str, Path | None]:
    attempt_id = _failed_plan_attempt_id(failure)
    attempt_root = data_root / "instances" / instance_id / "state" / "pipeline"
    candidate_dirs: list[Path] = []
    if attempt_id:
        candidate_dirs.append(attempt_root / attempt_id)
    if attempt_root.exists():
        candidate_dirs.extend(sorted(path for path in attempt_root.iterdir() if path.is_dir()))
    seen: set[Path] = set()
    for attempt_dir in candidate_dirs:
        if attempt_dir in seen:
            continue
        seen.add(attempt_dir)
        request_path = attempt_dir / "attempt-request.json"
        result_path = attempt_dir / "attempt-result.json"
        if not result_path.exists():
            result_path = attempt_dir / "attempt-result.json.applied"
        request = _read_json_file(request_path)
        if request and str(request.get("attempt_id") or attempt_dir.name) != attempt_dir.name and attempt_id:
            continue
        if request and _looks_like_plan_request(request):
            return {
                "request": request_path if request_path.exists() else None,
                "result": result_path if result_path.exists() else None,
            }
    return {"request": None, "result": None}


def _failed_plan_attempt_id(failure: dict[str, Any]) -> str:
    payload = failure.get("failure")
    attempts = payload.get("attempts") if isinstance(payload, dict) else []
    for attempt in attempts if isinstance(attempts, list) else []:
        if not isinstance(attempt, dict):
            continue
        if str(attempt.get("mode") or "") == "plan" or str(attempt.get("attempt_id") or "").startswith("plan"):
            return str(attempt.get("attempt_id") or "")
    return ""


def _looks_like_plan_request(payload: dict[str, Any]) -> bool:
    return bool(payload.get("pipeline_intent") is not None or payload.get("root_node_id") or payload.get("issue_description"))


def _dispatch_context_for_plan_attempt(*, data_root: Path, plan_paths: dict[str, Path | None]) -> dict[str, Any]:
    request = _read_json_file(plan_paths.get("request"))
    node_id = str(request.get("node_id") or request.get("root_node_id") or "")
    if not node_id:
        return {}
    db_paths = (data_root / "pipeline" / "pipeline.db", data_root / "pipeline.db")
    row = None
    for db_path in db_paths:
        if not db_path.exists():
            continue
        try:
            with sqlite3.connect(db_path) as connection:
                row = connection.execute(
                    "SELECT payload_json FROM dispatch_context WHERE node_id = ?",
                    (node_id,),
                ).fetchone()
        except sqlite3.Error:
            row = None
        if row is not None:
            break
    if row is None:
        return {}
    try:
        payload = json.loads(str(row[0]))
    except json.JSONDecodeError:
        return {}
    return payload if isinstance(payload, dict) else {}


def _read_json_file(path: Path | None) -> dict[str, Any]:
    if path is None or not path.exists():
        return {}
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}
    return payload if isinstance(payload, dict) else {}
