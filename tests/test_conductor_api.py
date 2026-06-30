from __future__ import annotations

import asyncio
import json
import struct
import zlib
from pathlib import Path

import pytest

from symphony.conductor_api import ConductorApiServer
from symphony.conductor_service import ConductorService
from symphony.conductor_store import ConductorStore
from symphony.ops_models import IssueRecord, OpsSnapshot, RunRecord, TraceEvent
from symphony.ops_store import OpsStore


def make_service(tmp_path: Path) -> ConductorService:
    return ConductorService(
        store=ConductorStore(tmp_path / "conductor-data"),
        data_root=tmp_path / "conductor-data",
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
async def test_web_shell_serves_new_ops_console_assets(tmp_path: Path) -> None:
    service = make_service(tmp_path)
    server = ConductorApiServer(service)
    await server.start(port=0)
    try:
        assert server.port is not None

        status, headers, body = await request(server.port, "GET", "/")

        assert status == 200
        assert headers["content-type"].startswith("text/html")
        html = body.decode()
        assert "<!doctype html>" in html.lower()
        assert "Conductor Ops Console" in html
        assert '/assets/app.css' in html
        assert '/assets/app.js' in html
        assert "Issues" in html
        assert "Runs" in html
        assert "Retention" in html
        assert 'id="app-shell"' in html
        assert "/api/dashboard" in html

        status, headers, body = await request(server.port, "GET", "/assets/app.css")
        assert status == 200
        assert headers["content-type"].startswith("text/css")
        assert b"#app-shell" in body

        status, headers, body = await request(server.port, "GET", "/assets/app.js")
        assert status == 200
        assert headers["content-type"].startswith("text/javascript")
        assert b"/api/issues" in body

        status, headers, body = await request(server.port, "GET", "/assets/lib/api.js")
        assert status == 200
        assert headers["content-type"].startswith("text/javascript")
        assert b"getJSON" in body

        status, headers, body = await request(server.port, "GET", "/favicon.ico")

        assert status == 200
        assert headers["content-type"].startswith("image/x-icon")
        assert body.startswith(b"\x00\x00\x01\x00")
        assert len(body) > 100
        pixels = ico_png_pixels(body)
        assert pixels[(16, 8)] == (251, 247, 241, 255)
        assert pixels[(24, 6)] == (215, 177, 132, 255)
        assert pixels[(16, 22)] == (215, 177, 132, 255)
    finally:
        await server.stop()


@pytest.mark.asyncio
async def test_web_shell_mentions_issue_first_ops_views(tmp_path: Path) -> None:
    service = make_service(tmp_path)
    server = ConductorApiServer(service)
    await server.start(port=0)
    try:
        assert server.port is not None

        status, _, body = await request(server.port, "GET", "/")
        html = body.decode()

        assert status == 200
        assert "Issue → Run → Attempt → Turn → Trace" in html
        assert "Active Issues" in html
        assert "Total Tokens" in html
        assert "Estimated Cost" in html

        status, headers, body = await request(server.port, "GET", "/assets/views/issues.js")
        assert status == 200
        assert headers["content-type"].startswith("text/javascript")
        assert b"renderIssuesView" in body

        status, headers, body = await request(server.port, "GET", "/assets/views/runs.js")
        assert status == 200
        assert headers["content-type"].startswith("text/javascript")
        assert b"renderRunsView" in body
    finally:
        await server.stop()


@pytest.mark.asyncio
async def test_web_shell_mentions_trace_and_retention_surfaces(tmp_path: Path) -> None:
    service = make_service(tmp_path)
    server = ConductorApiServer(service)
    await server.start(port=0)
    try:
        assert server.port is not None

        status, _, body = await request(server.port, "GET", "/")
        html = body.decode()

        assert status == 200
        assert "Trace Viewer" in html
        assert "Retention" in html
        assert "Pinned Issues" in html

        status, headers, body = await request(server.port, "GET", "/assets/views/trace.js")
        assert status == 200
        assert headers["content-type"].startswith("text/javascript")
        assert b"renderTraceView" in body

        status, headers, body = await request(server.port, "GET", "/assets/views/ops.js")
        assert status == 200
        assert headers["content-type"].startswith("text/javascript")
        assert b"renderRetentionView" in body
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
        assert json.loads(body) == {"settings": {"linear_api_key_configured": False}}

        status, _, body = await request(
            server.port,
            "PATCH",
            "/api/settings",
            {"linear_api_key": "linear-token"},
        )

        assert status == 200
        assert json.loads(body) == {"settings": {"linear_api_key_configured": True}}

        status, _, body = await request(server.port, "GET", "/api/settings")

        assert status == 200
        assert json.loads(body) == {"settings": {"linear_api_key_configured": True}}
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


def ico_png_pixels(body: bytes) -> dict[tuple[int, int], tuple[int, int, int, int]]:
    image_offset = struct.unpack_from("<I", body, 18)[0]
    png = body[image_offset:]
    assert png.startswith(b"\x89PNG\r\n\x1a\n")
    cursor = 8
    width = height = 0
    compressed = bytearray()
    while cursor < len(png):
        length = struct.unpack_from(">I", png, cursor)[0]
        chunk_type = png[cursor + 4 : cursor + 8]
        data = png[cursor + 8 : cursor + 8 + length]
        cursor += 12 + length
        if chunk_type == b"IHDR":
            width, height = struct.unpack_from(">II", data)
        elif chunk_type == b"IDAT":
            compressed.extend(data)
        elif chunk_type == b"IEND":
            break
    raw = zlib.decompress(bytes(compressed))
    pixels: dict[tuple[int, int], tuple[int, int, int, int]] = {}
    stride = 1 + width * 4
    for y in range(height):
        row = raw[y * stride : (y + 1) * stride]
        assert row[0] == 0
        for x in range(width):
            offset = 1 + x * 4
            pixels[(x, y)] = tuple(row[offset : offset + 4])  # type: ignore[assignment]
    return pixels


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
