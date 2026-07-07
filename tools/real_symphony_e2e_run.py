from __future__ import annotations

import argparse
import asyncio
import json
import os
import shutil
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


CODEX_HOME_SEED_FILES = ("config.toml", "auth.json", "version.json", "models_cache.json")
CODEX_HOME_SEED_ENV = "SYMPHONY_E2E_CODEX_HOME_SEED"
DEFAULT_E2E_HARD_TURN_TIMEOUT_MS = 180_000


def build_runtime_config_payload(
    *,
    runtime_group_id: str,
    version: int,
    model: str | None = None,
    codex_home_source: str | None = None,
    codex_settings: dict[str, Any] | None = None,
) -> dict[str, Any]:
    settings = dict(codex_settings or {})
    model_name = (model or os.environ.get("SYMPHONY_E2E_CODEX_MODEL") or "").strip()
    if model_name:
        settings["model"] = model_name
    if codex_home_source:
        settings["codex_home_source"] = codex_home_source
    return {
        "runtime_group_id": runtime_group_id,
        "version": version,
        "scheduler_policy": {
            "policy_id": f"policy-{runtime_group_id}",
            "version": version,
            "effective_at": utc_now(),
            "capacity": {"global": 3, "by_mode": {"plan": 1, "execute": 1, "verify": 1}},
            "dependency_policy": "verify_passed",
            "max_rework_attempts": 1,
        },
        "profiles": {
            mode: {
                "name": f"codex-{mode}",
                "backend": "codex",
                "mode": mode,
                "settings": dict(settings),
            }
            for mode in ["plan", "execute", "verify"]
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
        pipeline_terminal = bool(
            pipeline_nodes
            and all(str(node.get("state") or "") in {"verify_passed", "failed", "superseded"} for node in pipeline_nodes)
        )
        expected_failure = args.expected_failure != "none"
        if args.permission_approval_probe:
            evidence.check(
                "runtime-error:blocked-cleared-after-approval",
                not pipeline_leases,
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
            status, pipeline_body = http_json("GET", api_url(conductor_port, "/api/pipeline"))
            pipeline_view = (
                pipeline_body.get("pipeline")
                if status == 200 and isinstance(pipeline_body, dict) and isinstance(pipeline_body.get("pipeline"), dict)
                else {}
            )
            pipeline_path = root / "final-pipeline-view.json"
            pipeline_path.write_text(json.dumps(pipeline_view, indent=2, sort_keys=True), encoding="utf-8")
            evidence.artifact("final_pipeline_view", pipeline_path)
            if args.permission_approval_probe:
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
            if not args.permission_approval_probe:
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
                    bool(integrations) and all(item.get("status") == "integrated" for item in integrations),
                    integrations=integrations,
                )
                evidence.check(
                    "stage:pipeline-linear-projected",
                    bool(projections)
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
                )
                evidence.check(
                    "stage:final-pipeline-verified",
                    bool(nodes) and all(node.get("state") in {"verify_passed", "superseded"} for node in nodes),
                    nodes=[{"node_id": node.get("node_id"), "state": node.get("state")} for node in nodes],
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
