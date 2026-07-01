from __future__ import annotations

import asyncio
import json
from pathlib import Path

import pytest

from conductor.conductor_api import ConductorApiServer
from conductor.conductor_service import ConductorService
from conductor.conductor_store import ConductorStore
from performer_api.ops_models import IssueRecord, OpsSnapshot, RunRecord, TraceEvent
from performer_api.ops_store import OpsStore


class CapturingRuntime:
    async def start(self, instance, *, env: dict[str, str] | None = None):
        return instance.with_updates(process_status="running", pid=4242)

    async def stop(self, instance):
        return instance.with_updates(process_status="stopped", pid=None)

    async def restart(self, instance, *, env: dict[str, str] | None = None):
        return instance.with_updates(process_status="running", pid=4242)

    def runtime_snapshot(self, instance):
        return {"instance_id": instance.id, "process_status": instance.process_status, "pid": instance.pid}

    def read_logs(self, instance):
        return ""


def make_service(tmp_path: Path) -> ConductorService:
    return ConductorService(
        store=ConductorStore(tmp_path / "conductor-data"),
        data_root=tmp_path / "conductor-data",
        runtime_manager=CapturingRuntime(),
    )


def make_repo(tmp_path: Path) -> Path:
    repo = tmp_path / "repo"
    repo.mkdir()
    (repo / ".git").mkdir()
    (repo / "README.md").write_text("hello\n", encoding="utf-8")
    return repo


def write_sample_ops_snapshot(instance: dict[str, object]) -> None:
    persistence_path = Path(str(instance["persistence_path"]))
    OpsStore(persistence_path.parent / "ops.json").save(
        OpsSnapshot(
            issues={
                "issue-1": IssueRecord(
                    issue_id="issue-1",
                    issue_identifier="ENG-1",
                    title="Trace UI",
                    state="running",
                    total_turn_count=7,
                    total_tokens=188240,
                    total_estimated_cost_usd=0.97,
                    last_activity_at="2026-06-30T00:10:00Z",
                )
            },
            runs={
                "run-1": RunRecord(
                    run_id="run-1",
                    issue_id="issue-1",
                    instance_id=str(instance["id"]),
                    status="running",
                    turn_count=7,
                    total_tokens=188240,
                    last_activity_at="2026-06-30T00:10:00Z",
                )
            },
            events=[
                TraceEvent(
                    event_id="evt-1",
                    event_type="issue_dispatched",
                    timestamp="2026-06-30T00:00:00Z",
                    issue_id="issue-1",
                    run_id="run-1",
                    retention_tier="summary",
                )
            ],
        )
    )


async def request(port: int, method: str, path: str, payload: dict | None = None) -> tuple[int, dict[str, str], bytes]:
    body = json.dumps(payload).encode() if payload is not None else b""
    reader, writer = await asyncio.open_connection("127.0.0.1", port)
    writer.write(
        (
            f"{method} {path} HTTP/1.1\r\n"
            f"Host: 127.0.0.1:{port}\r\n"
            "Content-Type: application/json\r\n"
            f"Content-Length: {len(body)}\r\n"
            "Connection: close\r\n"
            "\r\n"
        ).encode()
        + body
    )
    await writer.drain()
    raw = await reader.read()
    writer.close()
    await writer.wait_closed()
    head, response_body = raw.split(b"\r\n\r\n", 1)
    lines = head.decode().split("\r\n")
    status = int(lines[0].split()[1])
    headers: dict[str, str] = {}
    for line in lines[1:]:
        if ":" in line:
            key, value = line.split(":", 1)
            headers[key.lower()] = value.strip()
    return status, headers, response_body


@pytest.mark.asyncio
async def test_api_lists_issues_runs_trace_and_retention(tmp_path: Path) -> None:
    repo = make_repo(tmp_path)
    service = make_service(tmp_path)
    server = ConductorApiServer(service)
    await server.start(port=0)
    try:
        assert server.port is not None
        status, _, body = await request(
            server.port,
            "POST",
            "/api/instances",
            {
                "name": "Alpha",
                "repo_source_type": "local_path",
                "repo_source_value": str(repo),
                "linear_project": "ENG",
                "linear_filters": {"labels": ["codex"]},
                "workflow_profile": "default",
                "workflow_inputs": {"goal": "Handle tasks"},
            },
        )
        assert status == 201
        instance = json.loads(body)["instance"]
        write_sample_ops_snapshot(instance)

        status, _, body = await request(server.port, "GET", "/api/issues")
        assert status == 200
        assert json.loads(body)["issues"][0]["issue_identifier"] == "ENG-1"

        status, _, body = await request(server.port, "GET", "/api/issues/issue-1")
        assert status == 200
        assert json.loads(body)["issue"]["metrics"]["turns"] == 7

        status, _, body = await request(server.port, "GET", "/api/runs")
        assert status == 200
        assert json.loads(body)["runs"][0]["turn_count"] == 7

        status, _, body = await request(server.port, "GET", "/api/runs/run-1")
        assert status == 200
        assert json.loads(body)["run"]["run"]["run_id"] == "run-1"

        status, _, body = await request(server.port, "GET", "/api/traces?issue_id=issue-1")
        assert status == 200
        assert json.loads(body)["events"][0]["event_type"] == "issue_dispatched"

        status, _, body = await request(server.port, "POST", "/api/issues/issue-1/pin")
        assert status == 200
        assert json.loads(body)["retention"]["pinned_issue_count"] == 1

        status, _, body = await request(server.port, "GET", "/api/retention")
        assert status == 200
        assert json.loads(body)["retention"]["pinned_issue_ids"] == ["issue-1"]

        status, _, body = await request(server.port, "POST", "/api/retention/collect")
        assert status == 200
        assert json.loads(body)["retention"]["pinned_issue_count"] == 1
    finally:
        await server.stop()


@pytest.mark.asyncio
async def test_api_creates_lists_reads_and_validates_instances(tmp_path: Path) -> None:
    repo = make_repo(tmp_path)
    service = make_service(tmp_path)
    server = ConductorApiServer(service)
    await server.start(port=0)
    try:
        assert server.port is not None
        payload = {
            "name": "Alpha",
            "repo_source_type": "local_path",
            "repo_source_value": str(repo),
            "linear_project": "ENG",
            "linear_filters": {"labels": ["codex"]},
            "workflow_profile": "default",
            "workflow_inputs": {"goal": "Handle tasks"},
        }

        status, _, body = await request(server.port, "POST", "/api/instances", payload)
        assert status == 201
        created = json.loads(body)
        instance_id = created["instance"]["id"]
        assert created["instance"]["workflow_generation_status"] == "valid"

        status, _, body = await request(server.port, "GET", "/api/instances")
        assert status == 200
        listed = json.loads(body)
        assert len(listed["instances"]) == 1
        assert "workflow_content" not in listed["instances"][0]

        status, _, body = await request(server.port, "GET", f"/api/instances/{instance_id}")
        assert status == 200
        detail = json.loads(body)
        assert detail["instance"]["workflow_content"]

        status, _, body = await request(
            server.port,
            "POST",
            f"/api/instances/{instance_id}/validate-workflow",
            {"workflow_content": "---\ntracker: [\n---"},
        )
        assert status == 200
        validation = json.loads(body)
        assert validation["validation"]["ok"] is False
    finally:
        await server.stop()


@pytest.mark.asyncio
async def test_root_reports_conductor_daemon_health(tmp_path: Path) -> None:
    service = make_service(tmp_path)
    server = ConductorApiServer(service)
    await server.start(port=0)
    try:
        assert server.port is not None

        status, headers, body = await request(server.port, "GET", "/")

        assert status == 200
        assert headers["content-type"].startswith("application/json")
        assert json.loads(body) == {"service": "conductor", "status": "ok"}
    finally:
        await server.stop()


@pytest.mark.asyncio
async def test_api_previews_instance_workflow_without_creating_instance(tmp_path: Path) -> None:
    repo = make_repo(tmp_path)
    service = make_service(tmp_path)
    server = ConductorApiServer(service)
    await server.start(port=0)
    try:
        assert server.port is not None
        payload = {
            "name": "Alpha",
            "repo_source_type": "local_path",
            "repo_source_value": str(repo),
            "linear_project": "ENG",
            "linear_filters": {"labels": ["codex"]},
            "workflow_profile": "default",
            "workflow_inputs": {"goal": ""},
        }

        status, _, body = await request(server.port, "POST", "/api/instances/preview-workflow", payload)

        assert status == 200
        preview = json.loads(body)
        instance = preview["instance"]
        assert instance["name"] == "Alpha"
        assert instance["workflow_generation_status"] == "valid"
        assert "project_slug: ENG" in preview["workflow_content"]
        assert "Instance goal: Move the Linear queue forward." in preview["workflow_content"]
        assert preview["validation"] == {"diagnostics": [], "error_code": None, "ok": True}
        assert not Path(instance["workflow_path"]).exists()

        status, _, body = await request(server.port, "GET", "/api/instances")

        assert status == 200
        assert json.loads(body)["instances"] == []
    finally:
        await server.stop()


@pytest.mark.asyncio
async def test_api_supports_conductor_settings_without_echoing_secret(tmp_path: Path) -> None:
    service = make_service(tmp_path)
    server = ConductorApiServer(service)
    await server.start(port=0)
    try:
        assert server.port is not None

        status, _, body = await request(server.port, "GET", "/api/settings")
        assert status == 200
        settings = json.loads(body)["settings"]
        assert settings["linear_api_key_configured"] is False
        assert settings["podium_url"] == ""
        assert settings["podium_token_configured"] is False
        assert settings["conductor_id"]

        status, _, body = await request(
            server.port,
            "PATCH",
            "/api/settings",
            {"linear_api_key": "linear-token"},
        )

        assert status == 200
        settings = json.loads(body)["settings"]
        assert settings["linear_api_key_configured"] is True
        assert settings["podium_token_configured"] is False

        status, _, body = await request(server.port, "GET", "/api/settings")

        assert status == 200
        assert json.loads(body)["settings"]["linear_api_key_configured"] is True
        assert b"linear-token" not in body
    finally:
        await server.stop()


@pytest.mark.asyncio
async def test_dashboard_aggregates_instance_status_and_linear_views(tmp_path: Path) -> None:
    repo_a = make_repo(tmp_path)
    repo_b = tmp_path / "repo-b"
    repo_b.mkdir()
    (repo_b / ".git").mkdir()
    (repo_b / "README.md").write_text("hello\n", encoding="utf-8")
    service = make_service(tmp_path)
    service.update_settings_json({"linear_api_key": "linear-token"})
    server = ConductorApiServer(service)
    await server.start(port=0)
    try:
        assert server.port is not None
        for name, repo, project, labels, port in [
            ("Alpha", repo_a, "ENG", ["codex", "api"], 8801),
            ("Beta", repo_b, "OPS", ["infra"], 8802),
        ]:
            status, _, body = await request(
                server.port,
                "POST",
                "/api/instances",
                {
                    "name": name,
                    "repo_source_type": "local_path",
                    "repo_source_value": str(repo),
                    "linear_project": project,
                    "linear_filters": {"labels": labels},
                    "workflow_profile": "default",
                    "workflow_inputs": {"goal": f"Handle {name} tasks"},
                    "http_port": port,
                },
            )
            assert status == 201, body.decode()

        listed_status, _, listed_body = await request(server.port, "GET", "/api/instances")
        alpha_id = json.loads(listed_body)["instances"][0]["id"]
        assert listed_status == 200

        start_status, _, _ = await request(server.port, "POST", f"/api/instances/{alpha_id}/start", {})
        assert start_status == 200

        status, _, body = await request(server.port, "GET", "/api/dashboard")

        assert status == 200
        dashboard = json.loads(body)["dashboard"]
        assert dashboard["counts"]["instances"] == 2
        assert dashboard["counts"]["running"] == 1
        assert dashboard["counts"]["workflow_draft"] == 0
        assert dashboard["counts"]["workflow_invalid"] == 0
        assert dashboard["process_statuses"] == {"running": 1, "stopped": 1}
        assert dashboard["workflow_statuses"] == {"valid": 2}
        assert dashboard["linear_views"] == [
            {"project": "ENG", "filters": {"labels": ["codex", "api"]}, "instances": 1},
            {"project": "OPS", "filters": {"labels": ["infra"]}, "instances": 1},
        ]
        assert dashboard["totals"]["tokens"] == 0
        assert dashboard["totals"]["runtime_seconds"] == 0
        assert dashboard["totals"]["failures"] == 0
        assert dashboard["totals"]["retries"] == 0
    finally:
        await server.stop()



@pytest.mark.asyncio
async def test_api_supports_runtime_actions_and_repo_inspection(tmp_path: Path) -> None:
    repo = make_repo(tmp_path)
    service = make_service(tmp_path)
    service.update_settings_json({"linear_api_key": "linear-token"})
    server = ConductorApiServer(service)
    await server.start(port=0)
    try:
        assert server.port is not None
        create_status, _, create_body = await request(
            server.port,
            "POST",
            "/api/instances",
            {
                "name": "Alpha",
                "repo_source_type": "local_path",
                "repo_source_value": str(repo),
                "linear_project": "ENG",
                "linear_filters": {"labels": ["codex"]},
                "workflow_profile": "default",
                "workflow_inputs": {"goal": "Handle tasks"},
            },
        )
        assert create_status == 201
        instance_id = json.loads(create_body)["instance"]["id"]

        status, _, body = await request(server.port, "POST", f"/api/instances/{instance_id}/start", {})
        assert status == 200
        started = json.loads(body)
        assert started["instance"]["process_status"] in {"starting", "running"}

        status, _, body = await request(server.port, "GET", f"/api/instances/{instance_id}/runtime")
        assert status == 200
        runtime = json.loads(body)
        assert runtime["runtime"]["instance_id"] == instance_id

        status, _, body = await request(server.port, "GET", f"/api/instances/{instance_id}/logs")
        assert status == 200
        logs = json.loads(body)
        assert "logs" in logs

        status, _, body = await request(server.port, "POST", f"/api/instances/{instance_id}/stop", {})
        assert status == 200
        stopped = json.loads(body)
        assert stopped["instance"]["process_status"] == "stopped"

        status, _, body = await request(
            server.port,
            "POST",
            "/api/repo/inspect",
            {"repo_source_type": "local_path", "repo_source_value": str(repo)},
        )
        assert status == 200
        inspect_payload = json.loads(body)
        assert inspect_payload["repo"]["resolved_path"] == str(repo.resolve())

        status, _, body = await request(server.port, "GET", "/api/templates/workflow-profiles")
        assert status == 200
        profiles = json.loads(body)
        assert profiles["profiles"][0]["name"] == "default"
    finally:
        await server.stop()
