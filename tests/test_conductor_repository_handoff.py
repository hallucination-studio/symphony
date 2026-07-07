from __future__ import annotations

from pathlib import Path

import httpx
import pytest

from conductor.conductor_models import InstanceRecord
from conductor.conductor_linear_direct import RepositoryHandoffLinearProxy
from conductor.conductor_repository_handoff import RepositoryHandoffCoordinator
from performer_api.ops_models import OpsSnapshot, TraceEvent
from performer_api.ops_store import OpsStore


class FakeTracker:
    def __init__(self) -> None:
        self.children: list[dict[str, object]] = []
        self.comments: list[tuple[str, str]] = []
        self.updated_descriptions: list[tuple[str, str, str]] = []

    async def fetch_child_issues(self, parent_issue_id: str, *, label_name: str | None = None) -> list[dict[str, object]]:
        return [
            child
            for child in self.children
            if child.get("parent_issue_id") == parent_issue_id
            and (label_name is None or label_name in child.get("labels", []))
        ]

    async def create_child_issue_for(
        self,
        *,
        parent_issue_id: str,
        title: str,
        description: str,
        label_names: list[str],
        delegate_id: str | None = None,
    ) -> dict[str, object]:
        child = {
            "id": f"child-{len(self.children) + 1}",
            "identifier": f"ENG-{100 + len(self.children)}",
            "title": title,
            "description": description,
            "labels": list(label_names),
            "parent_issue_id": parent_issue_id,
            "delegate_id": delegate_id,
            "url": "https://linear.test/child",
        }
        self.children.append(child)
        return child

    async def update_issue_description_marker_block(
        self, issue_id: str, marker_name: str, block: str
    ) -> dict[str, object]:
        self.updated_descriptions.append((issue_id, marker_name, block))
        for child in self.children:
            if child.get("id") == issue_id:
                child["description"] = block
        return {"success": True}

    async def comment_issue(self, issue_id: str, body: str) -> dict[str, object]:
        self.comments.append((issue_id, body))
        return {"success": True}


class RecordingTransport(httpx.AsyncBaseTransport):
    def __init__(self, responses: list[dict[str, object]]) -> None:
        self.responses = responses
        self.requests: list[dict[str, object]] = []

    async def handle_async_request(self, request):
        import json

        self.requests.append({"json": json.loads(request.content.decode()), "headers": request.headers})
        return httpx.Response(200, json=self.responses.pop(0), request=request)


def make_instance(tmp_path: Path) -> InstanceRecord:
    return InstanceRecord.create(
        name="Alpha",
        repo_source_type="local_path",
        repo_source_value=str(tmp_path / "repo"),
        resolved_repo_path=str(tmp_path / "repo"),
        instance_dir=str(tmp_path / "instances" / "inst-1"),
        workspace_root=str(tmp_path / "instances" / "inst-1" / "workspace" / "repo"),
        persistence_path=str(tmp_path / "instances" / "inst-1" / "state" / "performer.json"),
        log_path=str(tmp_path / "instances" / "inst-1" / "logs" / "performer.log"),
        http_port=8801,
        linear_project="ENG",
        linear_filters={"linear_agent_app_user_id": "app-user-1", "integration_agent_mention": "@integrator"},
        id="inst-1",
    )


@pytest.mark.asyncio
async def test_repository_handoff_coordinator_creates_child_and_records_closeout_once(tmp_path: Path) -> None:
    instance = make_instance(tmp_path)
    store = OpsStore(Path(instance.persistence_path).parent / "ops.json")
    tracker = FakeTracker()
    source = TraceEvent(
        event_id="evt-1",
        event_type="repository_handoff_report.v1",
        timestamp="2026-07-05T00:00:00Z",
        issue_id="issue-1",
        run_id="run-1",
        payload={
            "issue_id": "issue-1",
            "issue_identifier": "ENG-1",
            "workspace_path": instance.workspace_root,
            "bundle": {"path": "/tmp/bundle", "changes_patch_path": "/tmp/bundle/changes.patch"},
        },
    )
    store.save(OpsSnapshot(events=[source]))
    coordinator = RepositoryHandoffCoordinator(
        ops_rows=lambda: [(instance, store, store.load())],
        tracker_factory=lambda instance: tracker,
    )

    first = await coordinator.coordinate()
    second = await coordinator.coordinate()

    snapshot = store.load()
    closeouts = [event for event in snapshot.events if event.event_type == "repository_handoff_closeout.v1"]
    assert first == {"closed_out": 1, "failed": 0, "skipped": 0}
    assert second == {"closed_out": 0, "failed": 0, "skipped": 1}
    assert len(tracker.children) == 1
    assert tracker.children[0]["delegate_id"] == "app-user-1"
    assert tracker.comments[0][0] == "issue-1"
    assert "@integrator Repository handoff is ready for ENG-1." in tracker.comments[0][1]
    assert len(closeouts) == 1
    assert closeouts[0].payload["source_event_id"] == "evt-1"


@pytest.mark.asyncio
async def test_conductor_linear_proxy_ensures_blocks_relation() -> None:
    transport = RecordingTransport(
        [
            {"data": {"issue": {"inverseRelations": {"nodes": []}}}},
            {"data": {"issue": {"relations": {"nodes": []}}}},
            {
                "data": {
                    "issueRelationCreate": {
                        "success": True,
                        "issueRelation": {
                            "id": "relation-1",
                            "type": "blocks",
                            "issue": {"id": "node-a"},
                            "relatedIssue": {"id": "node-b"},
                        },
                    }
                }
            },
        ]
    )
    proxy = RepositoryHandoffLinearProxy(endpoint="https://linear.test/graphql", api_key="token", transport=transport)  # type: ignore[arg-type]

    relation = await proxy.ensure_issue_relation(issue_id="node-a", related_issue_id="node-b", relation_type="blocks")

    assert relation["id"] == "relation-1"
    assert "inverseRelations" in transport.requests[0]["json"]["query"]
    assert "relations" in transport.requests[1]["json"]["query"]
    assert "issueRelationCreate" in transport.requests[2]["json"]["query"]
    assert transport.requests[2]["json"]["variables"] == {
        "input": {"type": "blocks", "issueId": "node-a", "relatedIssueId": "node-b"}
    }
