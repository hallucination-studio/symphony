from __future__ import annotations

import asyncio
import json
import os
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import socket
import stat
import threading
from pathlib import Path

import pytest

from symphony.conductor_api import ConductorApiServer
from symphony.conductor_models import ConductorSettings, InstanceCreateRequest
from symphony.conductor_models import InstancePatchRequest
from symphony.conductor_service import ConductorService
from symphony.conductor_store import ConductorStore
from symphony.ops_store import OpsStore


class FakeLinearServer:
    def __init__(self) -> None:
        self._server: ThreadingHTTPServer | None = None
        self._thread: threading.Thread | None = None
        self.port: int | None = None
        self.comments: list[str] = []
        self.requests: list[dict[str, object]] = []
        self.issue_state = "Todo"
        self.issue_labels: list[dict[str, str]] = []
        self.created_labels: dict[str, str] = {}

    async def start(self) -> None:
        outer = self

        class Handler(BaseHTTPRequestHandler):
            def do_POST(self) -> None:  # noqa: N802
                length = int(self.headers.get("Content-Length", "0") or "0")
                payload = json.loads(self.rfile.read(length).decode() or "{}")
                outer.requests.append(payload)
                response = outer._graphql_response(payload.get("query") or "", payload.get("variables") or {})
                encoded = json.dumps(response, separators=(",", ":")).encode()
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(encoded)))
                self.end_headers()
                self.wfile.write(encoded)

            def log_message(self, format: str, *args: object) -> None:  # noqa: A003
                return

        self._server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.port = int(self._server.server_address[1])
        self._thread = threading.Thread(target=self._server.serve_forever, daemon=True)
        self._thread.start()

    async def stop(self) -> None:
        if self._server is None:
            return
        self._server.shutdown()
        self._server.server_close()
        if self._thread is not None:
            self._thread.join(timeout=5)
        self._server = None

    def _graphql_response(self, query: str, variables: dict[str, object]) -> dict[str, object]:
        if "SymphonyCandidateIssues" in query or "SymphonyIssuesByStates" in query:
            return {
                "data": {
                    "issues": {
                        "nodes": [self._issue_node()],
                        "pageInfo": {"hasNextPage": False, "endCursor": None},
                    }
                }
            }
        if "SymphonyIssueStates" in query:
            return {"data": {"issues": {"nodes": [self._issue_node()]}}}
        if "CurrentIssueTeam" in query:
            return {
                "data": {
                    "issue": {
                        "id": "issue-1",
                        "identifier": "ENG-1",
                        "team": {"id": "team-1", "key": "ENG", "name": "Engineering"},
                    }
                }
            }
        if "SymphonyIssueLabelContext" in query:
            return {
                "data": {
                    "issue": {
                        "id": "issue-1",
                        "identifier": "ENG-1",
                        "team": {"id": "team-1"},
                        "labels": {"nodes": list(self.issue_labels)},
                    }
                }
            }
        if "SymphonyIssueLabelByName" in query:
            name = str(variables.get("name") or "")
            nodes = []
            if name in self.created_labels:
                nodes.append({"id": self.created_labels[name], "name": name})
            return {"data": {"issueLabels": {"nodes": nodes}}}
        if "SymphonyIssueLabelCreate" in query:
            name = str(variables.get("name") or "")
            label_id = f"label-{len(self.created_labels) + 1}"
            self.created_labels[name] = label_id
            return {"data": {"issueLabelCreate": {"success": True, "issueLabel": {"id": label_id, "name": name}}}}
        if "SymphonyUpdateIssueLabels" in query:
            label_ids = list(variables.get("labelIds") or [])
            self.issue_labels = [{"id": str(label_id), "name": self._label_name(str(label_id))} for label_id in label_ids]
            return {
                "data": {
                    "issueUpdate": {
                        "success": True,
                        "issue": {"id": "issue-1", "identifier": "ENG-1", "labels": {"nodes": list(self.issue_labels)}},
                    }
                }
            }
        if "SymphonyCommentIssue" in query:
            body = str(variables.get("body") or "")
            self.comments.append(body)
            return {"data": {"commentCreate": {"success": True, "comment": {"id": f"comment-{len(self.comments)}"}}}}
        if "SymphonyTransitionIssue" in query:
            self.issue_state = "Done"
            return {
                "data": {
                    "issueUpdate": {
                        "success": True,
                        "issue": {"id": "issue-1", "identifier": "ENG-1", "state": {"name": self.issue_state}},
                    }
                }
            }
        return {"data": {}}

    def _issue_node(self) -> dict[str, object]:
        return {
            "id": "issue-1",
            "identifier": "ENG-1",
            "title": "Smoke the ops console",
            "description": "Verify end-to-end telemetry",
            "priority": 1,
            "branchName": "eng-1",
            "url": "http://linear.local/ENG-1",
            "createdAt": "2026-06-30T00:00:00Z",
            "updatedAt": "2026-06-30T00:00:00Z",
            "state": {"name": self.issue_state},
            "project": {"slugId": "ENG", "name": "Engineering"},
            "assignee": {"id": "user-1"},
            "labels": {"nodes": [{"name": "codex"}]},
            "inverseRelations": {"nodes": []},
        }

    def _label_name(self, label_id: str) -> str:
        for name, current_id in self.created_labels.items():
            if current_id == label_id:
                return name
        return label_id


def make_service(tmp_path: Path) -> ConductorService:
    store = ConductorStore(tmp_path / "conductor-data")
    return ConductorService(store=store, data_root=tmp_path / "conductor-data")


def make_repo(tmp_path: Path) -> Path:
    repo = tmp_path / "repo"
    repo.mkdir()
    (repo / ".git").mkdir()
    (repo / "README.md").write_text("hello\n", encoding="utf-8")
    return repo


def allocate_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


def make_fake_codex_script(tmp_path: Path) -> Path:
    script = tmp_path / "bin" / "codex"
    script.parent.mkdir(parents=True, exist_ok=True)
    script.write_text(
        """#!/usr/bin/env python3
import json
import sys
import time

responses = []
tool_called = False
for line in sys.stdin:
    message = json.loads(line)
    method = message.get("method")
    if method == "initialize":
        print(json.dumps({"id": message["id"], "result": {"userAgent": "fake-codex", "platformFamily": "unix", "platformOs": "linux", "codexHome": "/tmp/fake-codex"}}), flush=True)
    elif method == "initialized":
        continue
    elif method == "thread/start":
        print(json.dumps({"id": message["id"], "result": {"thread": {"id": "thr_1"}}}), flush=True)
    elif method == "turn/start":
        print(json.dumps({"id": message["id"], "result": {"turn": {"id": "turn_1"}}}), flush=True)
        print(json.dumps({"method": "thread/tokenUsage/updated", "params": {"turnId": "turn_1", "total_token_usage": {"input_tokens": 12, "output_tokens": 4, "cached_tokens": 2, "total_tokens": 18}}}), flush=True)
        print(json.dumps({"id": 77, "method": "item/tool/call", "params": {"tool": "linear_graphql", "arguments": {"query": "query CurrentIssueTeam($issueId: String!) { issue(id: $issueId) { id } }", "variables": {"issueId": "issue-1"}}}}), flush=True)
    elif message.get("id") == 77:
        tool_called = True
        print(json.dumps({"method": "turn/completed", "params": {"turn": {"id": "turn_1"}, "status": "completed"}}), flush=True)
        time.sleep(0.1)
        break

sys.exit(0 if tool_called else 1)
""",
        encoding="utf-8",
    )
    script.chmod(script.stat().st_mode | stat.S_IXUSR)
    return script


async def wait_for(condition, *, timeout: float = 10.0, interval: float = 0.05) -> None:
    deadline = asyncio.get_running_loop().time() + timeout
    while True:
        if condition():
            return
        if asyncio.get_running_loop().time() >= deadline:
            raise AssertionError("condition not met before timeout")
        await asyncio.sleep(interval)


async def request(port: int, method: str, path: str) -> tuple[int, bytes]:
    reader, writer = await asyncio.open_connection("127.0.0.1", port)
    writer.write(
        (
            f"{method} {path} HTTP/1.1\r\n"
            f"Host: 127.0.0.1:{port}\r\n"
            "Connection: close\r\n"
            "\r\n"
        ).encode()
    )
    await writer.drain()
    raw = await reader.read()
    writer.close()
    await writer.wait_closed()
    head, body = raw.split(b"\r\n\r\n", 1)
    status = int(head.decode().split("\r\n", 1)[0].split()[1])
    return status, body


@pytest.mark.asyncio
async def test_real_ops_console_flow_writes_snapshot_and_surfaces_it(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    linear = FakeLinearServer()
    await linear.start()
    try:
        repo = make_repo(tmp_path)
        fake_codex = make_fake_codex_script(tmp_path)
        monkeypatch.setenv("PATH", f"{fake_codex.parent}:{os.environ.get('PATH', '')}")

        service = make_service(tmp_path)
        service.update_settings(ConductorSettings(linear_api_key="conductor-token"))
        instance = service.create_instance(
            InstanceCreateRequest(
                name="Alpha",
                repo_source_type="local_path",
                repo_source_value=str(repo),
                linear_project="ENG",
                linear_filters={"labels": ["codex"], "active_states": ["Todo", "In Progress"]},
                workflow_profile="default",
                workflow_inputs={"goal": "Smoke the ops console"},
                http_port=allocate_port(),
            )
        )
        workflow = Path(instance.workflow_path).read_text(encoding="utf-8")
        workflow = workflow.replace("https://api.linear.app/graphql", f"http://127.0.0.1:{linear.port}/graphql")
        workflow = workflow.replace("  command: codex app-server", f"  command: {fake_codex} app-server")
        workflow = workflow.replace("agent:\n  max_concurrent_agents: 10\n  max_turns: 20\n", "agent:\n  max_concurrent_agents: 10\n  max_turns: 1\n")
        workflow = workflow.replace("server:\n", "polling:\n  interval_ms: 100\nserver:\n", 1)
        updated = service.update_instance(instance.id, InstancePatchRequest(workflow_content=workflow))

        started = await service.start_instance(updated.id)
        assert started.process_status == "running"

        ops_path = Path(updated.persistence_path).parent / "ops.json"
        try:
            await wait_for(lambda: ops_path.exists())
            await wait_for(lambda: OpsStore(ops_path).load().runs != {})
            await wait_for(lambda: OpsStore(ops_path).load().turns != {})
            await wait_for(
                lambda: any(event.event_type == "run_completed" for event in OpsStore(ops_path).load().events)
            )
        except AssertionError as exc:
            logs = service.instance_logs(updated.id)
            runtime = service.instance_runtime(updated.id)
            raise AssertionError(
                f"{exc}\nlinear requests:\n{linear.requests}\ninstance runtime:\n{runtime}\ninstance logs:\n{logs}"
            ) from exc

        snapshot = OpsStore(ops_path).load()
        assert snapshot.issues
        assert snapshot.runs
        assert snapshot.attempts
        assert snapshot.turns, {
            "attempts": {key: value.to_dict() for key, value in snapshot.attempts.items()},
            "events": [event.to_dict() for event in snapshot.events],
            "logs": service.instance_logs(updated.id),
        }
        assert any(event.event_type == "run_completed" for event in snapshot.events)
        attempt = next(iter(snapshot.attempts.values()))
        assert attempt.status == "completed"

        issues = service.list_issues()
        runs = service.list_runs()
        traces = service.list_trace_events(issue_id="issue-1", run_id=None)
        api = ConductorApiServer(service)
        await api.start(port=0)
        try:
            assert api.port is not None
            status, body = await request(api.port, "GET", "/api/issues")
            assert status == 200
            assert json.loads(body)["issues"][0]["issue_identifier"] == "ENG-1"
        finally:
            await api.stop()

        assert issues[0]["issue_identifier"] == "ENG-1"
        assert runs[0]["turn_count"] == 1
        assert any(event["event_type"] == "turn_tokens_updated" for event in traces)
        assert linear.created_labels
    finally:
        await linear.stop()
