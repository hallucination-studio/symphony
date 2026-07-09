from __future__ import annotations

import argparse
import asyncio
import json
import os
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from real_symphony_e2e_analysis import (
    audit_expected_failure_run,
    build_instance_payload,
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
from real_symphony_e2e_acceptance import (
    APPENDIX_PYTEST_HARDENING_PROBES,
    _attempt_intervals_overlap,
    _check_appendix_overall_acceptance,
    _check_pipeline_scenario_acceptance,
    _downstream_verify_gate_evidence,
    _effective_permission_approval_probe,
    _gate_step_provenance_evidence,
    _lower_policy_during_parallel_execute_probe,
    _managed_run_avoids_global_codex_home,
    _overall_downstream_depends_on_both_parallel_evidence,
    _parse_e2e_time,
    _permission_probe_block_cleared,
    _pipeline_final_view_converged,
    _pipeline_linear_issue_tree_finalized,
    _pipeline_live_refresh_evidence,
    _pipeline_node_requires_gate,
    _pipeline_prediction_is_conditional,
    _pipeline_projection_matches_current_revision,
    _pipeline_scenario,
    _pipeline_scenario_intent,
    _pipeline_scenario_issue_description,
    _prepare_pipeline_scenario_fixture,
    _run_appendix_pytest_hardening_probes,
    _runtime_home_evidence,
    _safe_int,
    _should_run_final_pipeline_stage_checks,
    _superseded_node_evidence,
    _wait_for_final_pipeline_view,
    _wait_for_pipeline_linear_issue_tree_finalized,
)
from real_symphony_e2e_artifacts import (
    DEPENDENT_RUNTIME_STAGES_AFTER_PLAN,
    E2E_STAGE_ORDER,
    _archive_pipeline_artifacts,
    _checkpoint_and_block_after_stage,
    _dispatch_context_for_plan_attempt,
    _failed_plan_attempt_id,
    _failed_plan_attempt_paths,
    _handle_pipeline_runtime_blocker,
    _latest_pipeline_runtime_failure,
    _looks_like_plan_request,
    _pipeline_runtime_failure_reason,
    _read_json_file,
    _stages_after,
)
from real_symphony_e2e_preflight import (
    CODEX_HOME_SEED_ENV,
    CODEX_HOME_SEED_FILES,
    DEFAULT_E2E_HARD_TURN_TIMEOUT_MS,
    E2E_POSTGRES_IMAGE,
    _codex_settings_from_args,
    build_runtime_config_payload,
    e2e_codex_home_seed_source,
    run_codex_connectivity_probe,
    run_codex_planner_shaped_probe,
    stage_codex_home_seed,
    start_e2e_postgres_if_needed,
    stop_e2e_postgres,
)


LINEAR_AGENT_OAUTH_SCOPE = "read,write,app:assignable,app:mentionable"
# Helper modules preserve these evidence checks: "codex-connectivity:connected", "codex-connectivity:planner-shaped".
# start_e2e_postgres_if_needed performs the asyncpg.connect readiness check.



async def run(args: argparse.Namespace) -> dict[str, Any]:
    token = os.environ.get("PODIUM_LINEAR_APP_ACCESS_TOKEN", "").strip()
    if not token:
        raise RuntimeError(
            "Linear app actor token is required: set PODIUM_LINEAR_APP_ACCESS_TOKEN "
            "to an actor=app OAuth token for Symphony-authored Linear mutations"
        )
    agent_app_user_id = os.environ.get("PODIUM_LINEAR_APPLICATION_ID", "").strip()
    if not agent_app_user_id:
        raise RuntimeError(
            "PODIUM_LINEAR_APPLICATION_ID is required and must be the Linear custom-agent app user's id."
        )
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
    postgres_container = await start_e2e_postgres_if_needed(root, env, evidence)
    podium_env = dict(env)
    podium_env["PODIUM_LINEAR_APPLICATION_ID"] = agent_app_user_id
    podium_env["PODIUM_LINEAR_APP_ACCESS_TOKEN"] = token
    podium_env["PODIUM_LINEAR_POLL_INTERVAL_SECONDS"] = "1"
    podium_env["PODIUM_LINEAR_POLL_INITIAL_LOOKBACK_SECONDS"] = "0"
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
        evidence.data["linear_agent_app_user_id"] = agent_app_user_id
        evidence.check(
            "linear-agent:app-user-selected",
            bool(agent_app_user_id),
            source="PODIUM_LINEAR_APPLICATION_ID",
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
            delegate_id=agent_app_user_id,
            description=_pipeline_scenario_issue_description(pipeline_scenario, run_id),
        )
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
            ((linear["issue"].get("delegate") or {}).get("id") == agent_app_user_id),
            expected_agent_app_user_id=agent_app_user_id,
            actual_delegate=linear["issue"].get("delegate"),
        )
        payload = build_instance_payload(
            run_id=run_id,
            fixture=fixture,
            project_slug=linear["project"]["slugId"],
            agent_app_user_id=agent_app_user_id,
            pipeline_gates=args.pipeline_gates,
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

        evidence.check(
            "podium-poller:uses-delegated-linear-issue",
            True,
            scenario=pipeline_scenario,
            poller_mode=True,
            note="polling mode discovers delegated Linear issues through Linear GraphQL",
        )
        dispatch_instance_status = 0
        dispatch_instance_body: dict[str, Any] = {}
        deadline = time.monotonic() + 60
        while time.monotonic() < deadline:
            dispatch_instance_status, dispatch_instance_body = http_json(
                "GET", api_url(conductor_port, f"/api/instances/{instance_id}")
            )
            process_status = dispatch_instance_body.get("instance", {}).get("process_status")
            if dispatch_instance_status == 200 and process_status in {"running", "exited"}:
                break
            await asyncio.sleep(0.5)
        evidence.check(
            "conductor-dispatch:poller-starts-one-shot",
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
                ((issue.get("delegate") or {}).get("id") == agent_app_user_id),
                expected_agent_app_user_id=agent_app_user_id,
                actual_delegate=issue.get("delegate"),
                actual_assignee=issue.get("assignee"),
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
                executable_nodes = [node for node in nodes if _pipeline_node_requires_gate(node, nodes)]
                executable_node_ids = {str(node.get("node_id") or "") for node in executable_nodes}
                evidence.check(
                    "stage:pipeline-gates-frozen",
                    bool(executable_nodes) and all(node.get("gate_snapshot_hash") for node in executable_nodes),
                    nodes=[
                        {
                            "node_id": node.get("node_id"),
                            "state": node.get("state"),
                            "requires_gate": str(node.get("node_id") or "") in executable_node_ids,
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
                        and (
                            projection["metadata"].get("gate_snapshot_hash")
                            or str(projection.get("node_id") or projection["metadata"].get("node_id") or "")
                            not in executable_node_ids
                        )
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
                            {"verify_passed", "superseded", "need_human"}
                            if pipeline_scenario == "integration-conflict"
                            else {"verify_passed", "superseded"}
                        ),
                    ),
                    nodes=[
                        {
                            "node_id": node.get("node_id"),
                            "state": node.get("state"),
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

        tree_path = root / "final-issue-tree.json"
        final_states: dict[str, Any] | None = None
        if args.pipeline_gates and not expected_failure and not permission_approval_probe and pipeline_scenario == "replan":
            tree, final_states = await _wait_for_pipeline_linear_issue_tree_finalized(
                token=token,
                issue_id=linear["issue"]["id"],
                timeout_seconds=min(max(args.stage_timeout, 10), 120),
            )
            tree_path.write_text(json.dumps(tree, indent=2, sort_keys=True), encoding="utf-8")
            evidence.artifact("final_issue_tree", tree_path)
        elif not tree_path.exists():
            tree = await fetch_linear_issue_tree(token, linear["issue"]["id"])
            tree_path.write_text(json.dumps(tree, indent=2, sort_keys=True), encoding="utf-8")
            evidence.artifact("final_issue_tree", tree_path)
        else:
            tree = json.loads(tree_path.read_text(encoding="utf-8"))
        if final_states is not None:
            evidence.check(
                "stage:pipeline-linear-final-states",
                bool(final_states.get("passed")),
                **{key: value for key, value in final_states.items() if key != "passed"},
            )
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
        stop_e2e_postgres(postgres_container)
    evidence.data["completed_at"] = utc_now()
    evidence.write()
    return evidence.data
