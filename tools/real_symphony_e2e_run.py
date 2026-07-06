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
    build_agent_session_webhook_payload,
    build_instance_payload,
    linear_webhook_signature,
)
from real_symphony_e2e_common import (
    DEFAULT_PROJECT_SLUG,
    Evidence,
    ManagedProcess,
    allocate_port,
    api_url,
    http_json,
    make_fixture_repo,
    patch_e2e_gate_mode,
    patch_workflow,
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
    wait_for_linear_delegate_visible,
)
from real_symphony_e2e_wait import wait_for_run

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
    bin_dir = Path.cwd() / ".venv" / "bin"
    run_id = datetime.now(timezone.utc).strftime("%Y%m%d%H%M%S") + "-" + uuid.uuid4().hex[:6]
    run_id = f"symphony-e2e-matrix-{run_id}"
    workspace_id = f"real-workspace-{run_id}"
    webhook_secret = f"webhook-{uuid.uuid4().hex}"
    evidence.data["run_id"] = run_id
    evidence.write()

    for name, command in {
        "podium-help": [str(bin_dir / "podium"), "--help"],
        "conductor-help": [str(bin_dir / "conductor"), "--help"],
        "performer-help": [str(bin_dir / "performer"), "--help"],
    }.items():
        run_cmd(name, command, evidence, env=env)

    fixture = make_fixture_repo(root / "fixture-repo")

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
                "project_slug": args.project_slug,
                "linear_agent_app_user_id": agent_app_user_id,
                "workflow_profile": "gated-task" if args.acceptance_gates else "task",
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
            ("GET", "/api/dashboard", None),
            ("GET", "/api/instances", None),
            ("GET", "/api/templates/workflow-profiles", None),
            ("POST", "/api/repo/inspect", {"repo_source_type": "local_path", "repo_source_value": str(fixture)}),
            ("POST", "/api/repo/clone", {"repo_url": "https://example.invalid/repo.git", "target_path": str(root / "non-empty-clone")}),
        ]:
            if path == "/api/repo/clone":
                (root / "non-empty-clone").mkdir(exist_ok=True)
                (root / "non-empty-clone" / "keep.txt").write_text("keep\n", encoding="utf-8")
            status, body = http_json(method, api_url(conductor_port, path), payload)
            evidence.check(f"conductor-api:{method} {path}", status in {200, 201}, status=status, body=body)

        linear = await create_linear_issue(
            token,
            args.project_slug,
            run_id,
            delegate_id=agent_app_user_id if not args.simulate_agent_webhook else None,
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
            acceptance_gates=args.acceptance_gates,
            simulate_agent_webhook=args.simulate_agent_webhook,
        )
        evidence.check(
            "linear-agent:simulated-webhook-mode-does-not-verify-real-delegate",
            not args.simulate_agent_webhook or "linear_agent_app_user_id" not in payload["linear_filters"],
            simulated=args.simulate_agent_webhook,
            linear_filters=sorted(payload["linear_filters"].keys()),
        )
        status, body = http_json("POST", api_url(conductor_port, "/api/instances/preview-workflow"), payload)
        evidence.check("conductor-api:POST /api/instances/preview-workflow", status == 200, status=status)
        status, body = http_json("POST", api_url(conductor_port, "/api/instances"), payload)
        evidence.check("conductor-api:POST /api/instances", status == 201, status=status)
        instance = body["instance"]
        instance_id = instance["id"]
        for method, path, payload in [
            ("GET", f"/api/instances/{instance_id}", None),
            ("POST", f"/api/instances/{instance_id}/generate-workflow", {}),
            ("GET", f"/api/instances/{instance_id}/runtime", None),
            ("GET", f"/api/instances/{instance_id}/logs", None),
            ("GET", f"/api/instances/{instance_id}/logs?tail=5&order=desc", None),
        ]:
            status, body = http_json(method, api_url(conductor_port, path), payload)
            evidence.check(f"conductor-api:{method} {path}", status == 200, status=status)
        workflow = patch_workflow(
            Path(instance["workflow_path"]),
            acceptance_gates=args.acceptance_gates,
            permission_approval_probe=args.permission_approval_probe,
            sdk_codex_bin=args.sdk_codex_bin,
            init_max_attempts=args.init_max_attempts,
            init_backoff_ms=args.init_backoff_ms,
            init_backoff_max_ms=args.init_backoff_max_ms,
            read_timeout_ms=args.read_timeout_ms,
            hard_turn_timeout_ms=args.hard_turn_timeout_ms,
            overload_max_attempts=args.overload_max_attempts,
            overload_initial_delay_ms=args.overload_initial_delay_ms,
            overload_max_delay_ms=args.overload_max_delay_ms,
            config_overrides=args.config_override,
        )
        if args.acceptance_gates:
            workflow = patch_e2e_gate_mode(workflow, gate_mode=args.e2e_gate_mode)
        status, body = http_json("POST", api_url(conductor_port, f"/api/instances/{instance_id}/validate-workflow"), {"workflow_content": workflow})
        evidence.check(f"conductor-api:POST /api/instances/{instance_id}/validate-workflow patched", status == 200, status=status)
        status, body = http_json("PATCH", api_url(conductor_port, f"/api/instances/{instance_id}"), {"workflow_content": workflow})
        evidence.check("conductor-api:PATCH /api/instances/{id}", status == 200, status=status)
        instance = body["instance"]
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

        webhook_payload = build_agent_session_webhook_payload(
            linear=linear,
            workspace_id=workspace_id,
            agent_app_user_id=agent_app_user_id,
            simulate_agent_webhook=args.simulate_agent_webhook,
        )
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
            permission_approval_probe=args.permission_approval_probe,
            crash_recovery_probe=args.crash_recovery_probe,
            expected_failure=args.expected_failure,
        )
        if args.permission_approval_probe:
            check_names = {check.get("name") for check in evidence.data.get("checks", []) if check.get("passed")}
            human_resume_covered = {
                "human-action:conductor-phase-awaiting-human",
                "human-action:parent-comment-does-not-resume",
                "human-action:linear-child-complete",
                "human-action:managed-push-resume",
                "human-action:resume-observed-after-push",
            }.issubset(check_names)
            evidence.check(
                "runtime-error:permission-approval-covered",
                (
                    "runtime-error:blocked-visible" in check_names
                    and "runtime-error:linear-human-approved-resume" in check_names
                )
                or human_resume_covered,
                covered=sorted(name for name in check_names if str(name).startswith("runtime-error:")),
                human_resume_covered=human_resume_covered,
            )
        issue = run_result["issue"]
        ops = run_result["ops"]
        state = run_result["state"]
        result_path = Path(run_result["result_path"])
        run_statuses = [run.get("status") for run in ops.get("runs", {}).values()]
        phase_runs = [
            run
            for sample in run_result.get("samples", [])
            for run in sample.get("phase_runs", [])
            if isinstance(run, dict)
        ]
        phase_terminal = bool(
            phase_runs
            and all(
                run.get("phase") in {"done", "failed"} or run.get("status") in {"completed", "failed"}
                for run in phase_runs
            )
        )
        expected_failure = args.expected_failure != "none"
        if args.permission_approval_probe:
            evidence.check("runtime-error:blocked-cleared-after-approval", not state.get("blocked"), state=state)
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
                "real-flow:no-active-runtime-state",
                not state.get("sessions")
                and not state.get("retry_attempts")
                and not state.get("continuations")
                and not state.get("blocked"),
                state=state,
            )
            evidence.check(
                "real-flow:ops-finalized",
                phase_terminal or (bool(run_statuses) and all(status != "running" for status in run_statuses)),
                run_statuses=run_statuses,
                phase_runs=phase_runs[-5:],
            )
        if args.acceptance_gates and not expected_failure:
            tree = await fetch_linear_issue_tree(token, linear["issue"]["id"])
            tree_path = root / "final-issue-tree.json"
            tree_path.write_text(json.dumps(tree, indent=2, sort_keys=True), encoding="utf-8")
            evidence.artifact("final_issue_tree", tree_path)
            issue_labels = [label["name"] for label in tree["labels"]["nodes"]]
            children = tree["children"]["nodes"]
            if args.permission_approval_probe:
                human_actions = [
                    child
                    for child in children
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
            if args.permission_approval_probe:
                children = []
            if not args.permission_approval_probe:
                gates = [
                    child
                    for child in children
                    if any(label["name"] == "performer:type/gate" for label in child["labels"]["nodes"])
                ]
                evidence_issues = [
                    grandchild
                    for gate in gates
                    for grandchild in gate["children"]["nodes"]
                    if any(label["name"] == "performer:type/evidence" for label in grandchild["labels"]["nodes"])
                ]
                evidence.check(
                    "stage:gate_created",
                    bool(gates),
                    gates=[{"identifier": gate["identifier"], "state": gate["state"]} for gate in gates],
                )
                evidence.check(
                    "stage:evidence_created",
                    bool(evidence_issues),
                    evidence=[{"identifier": item["identifier"], "state": item["state"]} for item in evidence_issues],
                )
                evidence.check(
                    "stage:final_done",
                    tree["state"]["type"] in {"completed", "canceled"}
                    and all(gate["state"]["type"] in {"completed", "canceled"} for gate in gates)
                    and all(item["state"]["type"] in {"completed", "canceled"} for item in evidence_issues),
                    issue_state=tree["state"],
                    gates=[{"identifier": gate["identifier"], "state": gate["state"]} for gate in gates],
                    evidence=[{"identifier": item["identifier"], "state": item["state"]} for item in evidence_issues],
                )
                gate_failed = any(
                    any(label["name"] == "performer:gate/failed" for label in node["labels"]["nodes"])
                    for node in [tree, *gates]
                )
                gate_comments = "\n".join(
                    comment["body"]
                    for gate in gates
                    for comment in gate["comments"]["nodes"]
                )
                evidence.check(
                    "acceptance:gate-child-created",
                    bool(gates),
                    gates=[{"identifier": gate["identifier"], "state": gate["state"]} for gate in gates],
                )
                evidence.check(
                    "acceptance:evidence-child-created",
                    bool(evidence_issues),
                    evidence=[{"identifier": item["identifier"], "state": item["state"]} for item in evidence_issues],
                )
                evidence.check(
                    "acceptance:gate-passed-visible",
                    "performer:gate/passed" in issue_labels and not gate_failed and "Acceptance score:" in gate_comments,
                    labels=issue_labels,
                    gate_failed=gate_failed,
                )
                delegated_acceptance_issues = [*gates, *evidence_issues]
                evidence.check(
                    "acceptance:all-gate-and-evidence-issues-delegated",
                    bool(delegated_acceptance_issues)
                    and all((item.get("delegate") or {}).get("id") == agent_app_user_id for item in delegated_acceptance_issues),
                    expected_agent_app_user_id=agent_app_user_id,
                    issues=[
                        {
                            "identifier": item["identifier"],
                            "delegate": item.get("delegate"),
                        }
                        for item in delegated_acceptance_issues
                    ],
                )

        for method, path, payload in [
            ("GET", "/api/issues", None),
            ("GET", "/api/runs", None),
            ("GET", "/api/traces", None),
            ("GET", "/api/retention", None),
            ("POST", "/api/retention/collect", {}),
        ]:
            status, body = http_json(method, api_url(conductor_port, path), payload)
            evidence.check(f"conductor-api:{method} {path}", status == 200, status=status)
        if ops.get("issues"):
            ops_issue_id = next(iter(ops["issues"].keys()))
            for method, path in [
                ("GET", f"/api/issues/{ops_issue_id}"),
                ("POST", f"/api/issues/{ops_issue_id}/pin"),
                ("DELETE", f"/api/issues/{ops_issue_id}/pin"),
            ]:
                status, body = http_json(method, api_url(conductor_port, path), {} if method == "POST" else None)
                evidence.check(f"conductor-api:{method} {path}", status == 200, status=status)
        if ops.get("runs"):
            ops_run_id = next(iter(ops["runs"].keys()))
            status, body = http_json("GET", api_url(conductor_port, f"/api/runs/{ops_run_id}"))
            evidence.check("conductor-api:GET /api/runs/{id}", status == 200, status=status)

        if not args.permission_approval_probe:
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
            "linear_filters": {"linear_agent_app_user_id": agent_app_user_id, "active_states": ["Todo"]},
            "workflow_profile": "task",
            "workflow_inputs": {},
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
