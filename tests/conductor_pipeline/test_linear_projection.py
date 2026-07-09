from __future__ import annotations

from .conftest import *  # noqa: F403

def test_human_wait_and_linear_projection_records_are_durable(tmp_path: Path) -> None:
    store = ConductorPipelineStore(tmp_path)
    store.apply_runtime_config(RuntimeConfigEnvelope("group-1", 1, _policy(1)))
    store.commit_plan(_proposal())

    wait = store.create_human_wait("a", reason="LINEAR_SYNC_CONFLICT", child_issue_id="child-1")
    projection = store.record_linear_projection(
        node_id="a",
        linear_issue_id="issue-a",
        metadata={"graph_id": "graph-1", "node_id": "a", "conductor_revision": 1},
    )

    assert store.list_human_waits()[0]["status"] == "waiting"
    assert wait["child_issue_id"] == "child-1"
    assert projection["linear_issue_id"] == "issue-a"
    assert store.resume_human_wait(wait["wait_id"], resolution="conflict resolved")["status"] == "resolved"
    assert store.list_human_waits()[0]["resolution"] == "conflict resolved"


def test_pipeline_view_filters_stale_linear_projections_and_refreshes_operator_status(tmp_path: Path) -> None:
    store = ConductorPipelineStore(tmp_path)
    store.apply_runtime_config(RuntimeConfigEnvelope("group-1", 1, _policy(1)))
    store.commit_plan(_proposal())
    stale = store.record_linear_projection(
        node_id="old-root",
        linear_issue_id="old-root",
        metadata={
            "graph_id": "graph-old",
            "node_id": "old-root",
            "conductor_revision": 1,
            "operator_status": "running_plan",
        },
    )
    current = store.record_linear_projection(
        node_id="a",
        linear_issue_id="issue-a",
        metadata={
            "graph_id": "graph-1",
            "node_id": "a",
            "gate_snapshot_hash": store.get_node("a").gate_snapshot_hash,
            "conductor_revision": 1,
            "operator_status": "verifying",
        },
    )
    store.update_node_state("a", GraphNodeState.VERIFY_PASSED, verify_score=3)

    projections = store.pipeline_view().to_dict()["linear_projections"]

    assert [projection["projection_id"] for projection in projections] == [current["projection_id"]]
    assert stale["projection_id"] not in {projection["projection_id"] for projection in projections}
    assert projections[0]["metadata"]["operator_status"] == "verify_passed"
    assert projections[0]["metadata"]["gate_snapshot_hash"] == store.get_node("a").gate_snapshot_hash
    assert [projection["projection_id"] for projection in store.list_linear_projections()] == [current["projection_id"]]


async def test_pipeline_linear_projector_creates_node_issue_with_gate_and_metadata(tmp_path: Path) -> None:
    store = ConductorPipelineStore(tmp_path)
    store.apply_runtime_config(RuntimeConfigEnvelope("group-1", 1, _policy(1)))
    store.commit_plan(_proposal())

    class Tracker:
        def __init__(self) -> None:
            self.children: list[dict[str, object]] = []
            self.updated: list[tuple[str, str, str]] = []
            self.relations: list[tuple[str, str, str]] = []

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
                "identifier": f"ENG-{len(self.children) + 10}",
                "title": title,
                "description": description,
                "labels": list(label_names),
                "parent_issue_id": parent_issue_id,
                "delegate_id": delegate_id,
            }
            self.children.append(child)
            return child

        async def update_issue_description_marker_block(self, issue_id: str, marker_name: str, block: str) -> dict[str, object]:
            self.updated.append((issue_id, marker_name, block))
            return {"success": True}

        async def ensure_issue_relation(self, *, issue_id: str, related_issue_id: str, relation_type: str) -> dict[str, object]:
            self.relations.append((issue_id, related_issue_id, relation_type))
            return {"success": True}

    tracker = Tracker()
    projector = PipelineLinearProjector(store=store, tracker=tracker, root_issue_id="root-linear", delegate_id="agent-1")

    projected = await projector.reconcile_once()

    projection = store.list_linear_projections()[0]
    assert projected == 3
    assert len(tracker.children) == 2
    assert tracker.children[0]["parent_issue_id"] == "root-linear"
    assert tracker.children[0]["delegate_id"] == "agent-1"
    assert "performer:type/pipeline-node" in tracker.children[0]["labels"]
    assert tracker.updated[0][1] == "SYMPHONY PIPELINE NODE"
    block = tracker.updated[0][2]
    assert "graph_id: graph-1" in block
    assert "node_id: a" in block
    assert "plan_attempt_id: plan-1" in block
    assert f"gate_snapshot_hash: {store.get_node('a').gate_snapshot_hash}" in block
    assert "verification_procedure:" in block
    assert projection["node_id"] == "a"
    assert projection["linear_issue_id"] == "child-1"
    assert projection["metadata"]["conductor_revision"] == 1
    assert tracker.relations == [("child-1", "child-2", "blocks")]


async def test_pipeline_linear_projector_refreshes_operator_status_after_state_change(tmp_path: Path) -> None:
    store = ConductorPipelineStore(tmp_path)
    store.apply_runtime_config(RuntimeConfigEnvelope("group-1", 1, _policy(1)))
    store.commit_plan(_proposal())

    class Tracker:
        def __init__(self) -> None:
            self.children: list[dict[str, object]] = [
                {
                    "id": "child-a",
                    "description": "```yaml\nsymphony:\n  node_id: a\n```",
                    "labels": ["performer:type/pipeline-node"],
                    "parent_issue_id": "root",
                }
            ]
            self.description_blocks: dict[str, str] = {}

        async def fetch_child_issues(self, parent_issue_id: str, *, label_name: str | None = None) -> list[dict[str, object]]:
            return [
                child
                for child in self.children
                if child.get("parent_issue_id") == parent_issue_id
                and (label_name is None or label_name in child.get("labels", []))
            ]

        async def update_issue_description_marker_block(self, issue_id: str, marker_name: str, block: str) -> dict[str, object]:
            self.description_blocks[issue_id] = block
            return {"success": True}

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
                "description": description,
                "labels": list(label_names),
                "parent_issue_id": parent_issue_id,
                "title": title,
                "delegate_id": delegate_id,
            }
            self.children.append(child)
            return child

        async def ensure_issue_relation(self, *, issue_id: str, related_issue_id: str, relation_type: str) -> dict[str, object]:
            return {"success": True}

    tracker = Tracker()
    projector = PipelineLinearProjector(store=store, tracker=tracker, root_issue_id="root")
    store.update_node_state("a", GraphNodeState.VERIFYING)
    await projector.reconcile_once()
    assert store.list_linear_projections()[0]["metadata"]["operator_status"] == "verifying"

    store.update_node_state("a", GraphNodeState.VERIFY_PASSED, verify_score=3)
    await projector.reconcile_once()

    projection = store.list_linear_projections()[0]
    assert projection["metadata"]["operator_status"] == "verify_passed"
    assert "operator_status: verify_passed" in tracker.description_blocks["child-a"]


async def test_pipeline_linear_projector_surfaces_workflow_transition_failure(tmp_path: Path) -> None:
    store = ConductorPipelineStore(tmp_path)
    store.apply_runtime_config(RuntimeConfigEnvelope("group-1", 1, _policy(1)))
    store.commit_plan(_proposal())

    class Tracker:
        async def fetch_child_issues(self, parent_issue_id: str, *, label_name: str | None = None) -> list[dict[str, object]]:
            return [
                {
                    "id": "child-a",
                    "description": "```yaml\nsymphony:\n  node_id: a\n```",
                    "labels": ["performer:type/pipeline-node"],
                    "parent_issue_id": "root-linear",
                }
            ]

        async def update_issue_description_marker_block(self, issue_id: str, marker_name: str, block: str) -> dict[str, object]:
            return {"success": True}

        async def create_child_issue_for(
            self,
            *,
            parent_issue_id: str,
            title: str,
            description: str,
            label_names: list[str],
            delegate_id: str | None = None,
        ) -> dict[str, object]:
            return {"id": "child-b", "description": description}

        async def transition_issue_by_state_target(
            self, issue_id: str, *, names: list[str], state_type: str
        ) -> dict[str, object]:
            return {"success": False, "issue_id": issue_id, "state": "Backlog", "reason": "state_not_found"}

    projector = PipelineLinearProjector(store=store, tracker=Tracker(), root_issue_id="root-linear")

    with pytest.raises(Exception, match="linear_workflow_transition_failed"):
        await projector.reconcile_once()


async def test_linear_projection_failure_is_persisted_and_projected_to_root_status(tmp_path: Path) -> None:
    data_root = tmp_path / "conductor-data"
    repo = tmp_path / "repo"
    repo.mkdir()
    conductor_store = ConductorStore(data_root)
    instance_dir = data_root / "instances" / "inst-1"
    conductor_store.save_instance(
        InstanceRecord.create(
            id="inst-1",
            name="Alpha",
            repo_source_type="local_path",
            repo_source_value=str(repo),
            resolved_repo_path=str(repo),
            instance_dir=str(instance_dir),
            workspace_root=str(instance_dir / "workspace" / "repo"),
            persistence_path=str(instance_dir / "state" / "performer.json"),
            log_path=str(instance_dir / "logs" / "performer.log"),
            http_port=8801,
            linear_project="ENG",
            linear_filters={"linear_agent_app_user_id": "agent-1"},
        )
    )
    service = ConductorService(
        store=conductor_store,
        data_root=data_root,
        runtime_manager=ConductorRuntimeManager(command="performer"),
    )
    service.pipeline_store.apply_runtime_config(RuntimeConfigEnvelope("group-1", 1, _policy(1)))
    service.pipeline_store.commit_plan(_proposal())

    class Tracker:
        def __init__(self) -> None:
            self.comments: list[dict[str, str]] = []

        async def fetch_child_issues(self, parent_issue_id: str, *, label_name: str | None = None) -> list[dict[str, object]]:
            return [
                {
                    "id": "child-a",
                    "description": "```yaml\nsymphony:\n  node_id: a\n```",
                    "labels": ["performer:type/pipeline-node"],
                    "parent_issue_id": "root-linear",
                }
            ]

        async def update_issue_description_marker_block(self, issue_id: str, marker_name: str, block: str) -> dict[str, object]:
            return {"success": True}

        async def create_child_issue_for(
            self,
            *,
            parent_issue_id: str,
            title: str,
            description: str,
            label_names: list[str],
            delegate_id: str | None = None,
        ) -> dict[str, object]:
            return {"id": "child-b", "description": description}

        async def transition_issue_by_state_target(
            self, issue_id: str, *, names: list[str], state_type: str
        ) -> dict[str, object]:
            return {"success": False, "issue_id": issue_id, "state": "Backlog", "reason": "state_not_found"}

        async def comment_issue(self, issue_id: str, body: str) -> dict[str, object]:
            self.comments.append({"issue_id": issue_id, "body": body})
            return {"success": True, "comment_id": f"comment-{len(self.comments)}"}

        async def update_issue_comment(self, comment_id: str, body: str) -> dict[str, object]:
            self.comments.append({"issue_id": "root", "body": body})
            return {"success": True, "comment_id": comment_id}

    tracker = Tracker()
    service.repository_handoff_tracker_factory = lambda _instance: tracker  # type: ignore[method-assign]

    projected = await service.reconcile_linear_pipeline_projections_once()

    assert projected == 1
    health = service.pipeline_store.linear_projection_health()
    assert health["healthy"] is False
    assert "linear_workflow_transition_failed" in health["last_projection_error"]
    root_status_comments = [comment["body"] for comment in tracker.comments if comment["issue_id"] == "root"]
    assert root_status_comments
    assert "projection_healthy: false" in root_status_comments[-1]
    assert "last_projection_error:" in root_status_comments[-1]


async def test_linear_projection_comment_rejection_is_persisted_as_unhealthy(tmp_path: Path) -> None:
    data_root = tmp_path / "conductor-data"
    repo = tmp_path / "repo"
    repo.mkdir()
    conductor_store = ConductorStore(data_root)
    instance_dir = data_root / "instances" / "inst-1"
    conductor_store.save_instance(
        InstanceRecord.create(
            id="inst-1",
            name="Alpha",
            repo_source_type="local_path",
            repo_source_value=str(repo),
            resolved_repo_path=str(repo),
            instance_dir=str(instance_dir),
            workspace_root=str(instance_dir / "workspace" / "repo"),
            persistence_path=str(instance_dir / "state" / "performer.json"),
            log_path=str(instance_dir / "logs" / "performer.log"),
            http_port=8801,
            linear_project="ENG",
            linear_filters={"linear_agent_app_user_id": "agent-1"},
        )
    )
    service = ConductorService(
        store=conductor_store,
        data_root=data_root,
        runtime_manager=ConductorRuntimeManager(command="performer"),
    )
    service.pipeline_store.apply_runtime_config(RuntimeConfigEnvelope("group-1", 1, _policy(1)))
    service.pipeline_store.commit_plan(_proposal())

    class Tracker:
        async def fetch_child_issues(self, parent_issue_id: str, *, label_name: str | None = None) -> list[dict[str, object]]:
            return []

        async def comment_issue(self, issue_id: str, body: str) -> dict[str, object]:
            return {"success": False, "reason": "api_unavailable"}

    service.repository_handoff_tracker_factory = lambda _instance: Tracker()  # type: ignore[method-assign]

    projected = await service.reconcile_linear_pipeline_projections_once()

    assert projected == 0
    health = service.pipeline_store.linear_projection_health()
    assert health["healthy"] is False
    assert "linear_projection_comment_create_failed" in health["last_projection_error"]
    assert "api_unavailable" in health["last_projection_error"]


async def test_pipeline_linear_projector_posts_agent_status_comment_activity_and_workflow(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setenv("SYMPHONY_DEBUG_PROJECTION", "1")
    store = ConductorPipelineStore(tmp_path)
    store.apply_runtime_config(RuntimeConfigEnvelope("group-1", 1, _policy(1)))
    store.commit_plan(_proposal())
    store.record_dispatch_context("root", {"issue_id": "root-linear", "agent_session_id": "11111111-1111-4111-8111-111111111111"})
    store.record_linear_projection(
        node_id="a",
        linear_issue_id="child-a",
        metadata={"graph_id": "graph-1", "node_id": "a", "conductor_revision": 1},
    )
    lease = store.start_attempt(RuntimeMode.EXECUTE, node_id="a", attempt_id="exec-1", now=datetime.now(timezone.utc))
    store.record_attempt_process_pid("exec-1", 4321)

    class Tracker:
        def __init__(self) -> None:
            self.children: list[dict[str, object]] = [
                {
                    "id": "child-a",
                    "description": "```yaml\nsymphony:\n  node_id: a\n```",
                    "labels": ["performer:type/pipeline-node"],
                    "parent_issue_id": "root-linear",
                    "state": {"name": "Todo"},
                }
            ]
            self.description_blocks: dict[str, str] = {}
            self.comments: list[dict[str, object]] = []
            self.updated_comments: list[tuple[str, str]] = []
            self.activities: list[dict[str, object]] = []
            self.transitions: list[tuple[str, str]] = []

        async def fetch_child_issues(self, parent_issue_id: str, *, label_name: str | None = None) -> list[dict[str, object]]:
            return [
                child
                for child in self.children
                if child.get("parent_issue_id") == parent_issue_id
                and (label_name is None or label_name in child.get("labels", []))
            ]

        async def update_issue_description_marker_block(self, issue_id: str, marker_name: str, block: str) -> dict[str, object]:
            self.description_blocks[issue_id] = block
            return {"success": True}

        async def comment_issue(self, issue_id: str, body: str) -> dict[str, object]:
            comment = {"id": f"comment-{len(self.comments) + 1}", "issue_id": issue_id, "body": body}
            self.comments.append(comment)
            return {"success": True, "comment_id": comment["id"]}

        async def update_issue_comment(self, comment_id: str, body: str) -> dict[str, object]:
            self.updated_comments.append((comment_id, body))
            for comment in self.comments:
                if comment["id"] == comment_id:
                    comment["body"] = body
            return {"success": True, "comment_id": comment_id}

        async def agent_activity_create(
            self,
            *,
            agent_session_id: str,
            content: dict[str, object],
        ) -> dict[str, object]:
            self.activities.append(
                {
                    "agent_session_id": agent_session_id,
                    "activity_type": content.get("type"),
                    "body": content.get("body"),
                    "content": content,
                }
            )
            return {"success": True, "activity_id": f"activity-{len(self.activities)}"}

        async def transition_issue_by_state_target(
            self, issue_id: str, *, names: list[str], state_type: str
        ) -> dict[str, object]:
            target = names[0] if names else ""
            self.transitions.append((issue_id, target))
            return {"success": True, "issue_id": issue_id, "state": target}

        async def ensure_issue_relation(self, *, issue_id: str, related_issue_id: str, relation_type: str) -> dict[str, object]:
            return {"success": True}

        async def create_child_issue_for(self, **kwargs: object) -> dict[str, object]:
            child = {
                "id": f"child-{len(self.children) + 1}",
                "description": kwargs.get("description"),
                "labels": list(kwargs.get("label_names") or []),
                "parent_issue_id": kwargs.get("parent_issue_id"),
                "title": kwargs.get("title"),
            }
            self.children.append(child)
            return child

    tracker = Tracker()
    projector = PipelineLinearProjector(store=store, tracker=tracker, root_issue_id="root-linear", delegate_id="agent-1")

    projected = await projector.reconcile_once()

    assert projected >= 3
    root_status = next(comment for comment in tracker.comments if comment["issue_id"] == "root-linear")
    assert "exec-1" in str(root_status["body"])
    assert lease.lease_id in str(root_status["body"])
    assert "<!-- SYMPHONY" not in str(root_status["body"])
    assert 'process_pid: "4321"' in tracker.description_blocks["child-a"]
    assert "attempts:" in tracker.description_blocks["child-a"]
    running_activity = next(activity for activity in tracker.activities if "running execute" in str(activity["body"]))
    assert running_activity["agent_session_id"] == "11111111-1111-4111-8111-111111111111"
    assert running_activity["activity_type"] == "thought"
    assert ("child-a", "In Progress") in tracker.transitions


async def test_pipeline_linear_projector_projects_attempt_comment_by_attempt_id(tmp_path: Path) -> None:
    store = ConductorPipelineStore(tmp_path)
    store.apply_runtime_config(RuntimeConfigEnvelope("group-1", 1, _policy(1)))
    store.commit_plan(_proposal())
    now = datetime(2026, 7, 6, tzinfo=timezone.utc)
    completed_at = now + timedelta(seconds=154)
    lease = store.start_attempt(RuntimeMode.EXECUTE, node_id="a", attempt_id="exec-1", now=now, ttl_seconds=300)
    assert store.complete_attempt_with_fencing(
        ExecuteAttemptResult(
            attempt_id="exec-1",
            node_id="a",
            status=AttemptState.FAILED,
            graph_revision=1,
            policy_revision=1,
            gate_snapshot_hash=store.get_node("a").gate_snapshot_hash or "",
            lease_id=lease.lease_id,
            fencing_token=lease.fencing_token,
            verification_input={},
            error="token=secret crashed",
            thread_id="thread-1",
            kind="codex",
        ),
        at=completed_at,
    )

    class Tracker:
        def __init__(self) -> None:
            self.comments: list[dict[str, object]] = []
            self.updated_comments: list[tuple[str, str]] = []

        async def fetch_child_issues(self, parent_issue_id: str, *, label_name: str | None = None) -> list[dict[str, object]]:
            return [{"id": "child-a", "description": "node_id: a", "labels": ["performer:type/pipeline-node"]}]

        async def update_issue_description_marker_block(self, issue_id: str, marker_name: str, block: str) -> dict[str, object]:
            return {"success": True}

        async def update_issue_comment_marker_block(self, issue_id: str, marker_name: str, block: str) -> dict[str, object]:
            raise AssertionError("attempt comments must not use body markers")

        async def comment_issue(self, issue_id: str, body: str) -> dict[str, object]:
            comment = {"id": f"comment-{len(self.comments) + 1}", "issue_id": issue_id, "body": body}
            self.comments.append(comment)
            return {"success": True, "comment_id": comment["id"]}

        async def update_issue_comment(self, comment_id: str, body: str) -> dict[str, object]:
            self.updated_comments.append((comment_id, body))
            for comment in self.comments:
                if comment["id"] == comment_id:
                    comment["body"] = body
            return {"success": True, "comment_id": comment_id}

        async def create_child_issue_for(self, **kwargs: object) -> dict[str, object]:
            return {"id": "child-b", "description": kwargs.get("description")}

    tracker = Tracker()
    projector = PipelineLinearProjector(store=store, tracker=tracker, root_issue_id="root-linear")

    await projector.reconcile_once()
    await projector.reconcile_once()

    attempt_comments = [
        comment
        for comment in tracker.comments
        if comment["issue_id"] == "child-a" and "Execute Attempt" in str(comment["body"])
    ]
    assert len(attempt_comments) == 1
    assert any(body == str(attempt_comments[0]["body"]) for _comment_id, body in tracker.updated_comments)
    block = str(attempt_comments[0]["body"])
    assert "<!-- SYMPHONY ATTEMPT" not in block
    assert "🟣 Execute Attempt" in block
    assert "❌ Status: failed" in block
    assert "⏱️  Duration: 2m 34s" in block
    assert "🧩 Kind: codex" in block
    assert "🔗 Thread: thread-1" in block
    assert "⏱️  Completed: 2026-07-06T00:02:34Z" in block
    assert "ID: exec-1" in block
    assert "⚠️ Error: token=[REDACTED] crashed" in block
    assert store.get_attempt("exec-1").thread_id == "thread-1"
    assert store.get_attempt("exec-1").kind == "codex"
    projection_comment = store.get_linear_projection_comment("attempt:exec-1")
    assert projection_comment is not None
    assert projection_comment["comment_id"] == attempt_comments[0]["id"]
    assert projection_comment["linear_issue_id"] == "child-a"


async def test_pipeline_linear_projector_posts_need_human_instruction_comment(tmp_path: Path) -> None:
    store = ConductorPipelineStore(tmp_path)
    store.apply_runtime_config(RuntimeConfigEnvelope("group-1", 1, _policy(1)))
    store.commit_plan(_proposal())
    store.update_node_state("a", GraphNodeState.NEED_HUMAN, human_reason=HumanEscalationReason.CREDENTIAL_REQUIRED)

    class Tracker:
        def __init__(self) -> None:
            self.comments: list[dict[str, object]] = []
            self.transitions: list[tuple[str, tuple[str, ...], str]] = []

        async def fetch_child_issues(self, parent_issue_id: str, *, label_name: str | None = None) -> list[dict[str, object]]:
            return [{"id": "child-a", "description": "node_id: a", "labels": ["performer:type/pipeline-node"]}]

        async def update_issue_description_marker_block(self, issue_id: str, marker_name: str, block: str) -> dict[str, object]:
            return {"success": True}

        async def update_issue_comment_marker_block(self, issue_id: str, marker_name: str, block: str) -> dict[str, object]:
            raise AssertionError("need-human comments must not use body markers")

        async def comment_issue(self, issue_id: str, body: str) -> dict[str, object]:
            comment = {"id": f"comment-{len(self.comments) + 1}", "issue_id": issue_id, "body": body}
            self.comments.append(comment)
            return {"success": True, "comment_id": comment["id"]}

        async def update_issue_comment(self, comment_id: str, body: str) -> dict[str, object]:
            return {"success": True, "comment_id": comment_id, "body": body}

        async def transition_issue_by_state_target(
            self, issue_id: str, *, names: list[str], state_type: str
        ) -> dict[str, object]:
            self.transitions.append((issue_id, tuple(names), state_type))
            return {"success": True}

        async def create_child_issue_for(self, **kwargs: object) -> dict[str, object]:
            return {"id": "child-b", "description": kwargs.get("description")}

    tracker = Tracker()
    projector = PipelineLinearProjector(store=store, tracker=tracker, root_issue_id="root-linear")

    await projector.reconcile_once()

    assert ("child-a", ("Blocked", "Needs Human", "Need Human"), "") in tracker.transitions
    instruction = next(comment for comment in tracker.comments if comment["issue_id"] == "child-a")
    body = str(instruction["body"])
    assert "<!-- SYMPHONY NEED HUMAN" not in body
    assert "reason: CREDENTIAL_REQUIRED" in body
    assert "Add the missing information as a comment on this issue." in body
    assert "Commenting alone will not resume Symphony." in body
    assert "Move this issue out of the need_human state to resume." in body


async def test_pipeline_linear_projector_marks_root_issue_for_planning_node(tmp_path: Path) -> None:
    store = ConductorPipelineStore(tmp_path)
    store.apply_runtime_config(RuntimeConfigEnvelope("group-1", 1, _policy(1)))
    coordinator = PipelineCoordinator(store=store, runtime_manager=object())
    coordinator.accept_dispatch(
        {
            "issue_id": "root-linear",
            "issue_identifier": "ENG-1",
            "title": "Delegated root",
        },
        instance_id="inst-1",
    )

    class Tracker:
        def __init__(self) -> None:
            self.created: list[dict[str, object]] = []
            self.updated: list[tuple[str, str, str]] = []

        async def fetch_child_issues(self, parent_issue_id: str, *, label_name: str | None = None) -> list[dict[str, object]]:
            return []

        async def create_child_issue_for(self, **kwargs: object) -> dict[str, object]:
            self.created.append(dict(kwargs))
            return {"id": "unexpected-child"}

        async def update_issue_description_marker_block(self, issue_id: str, marker_name: str, block: str) -> dict[str, object]:
            self.updated.append((issue_id, marker_name, block))
            return {"success": True}

    tracker = Tracker()
    projector = PipelineLinearProjector(store=store, tracker=tracker, root_issue_id="root-linear")

    projected = await projector.reconcile_once()

    projection = store.list_linear_projections()[0]
    assert projected == 1
    assert tracker.created == []
    assert tracker.updated[0][0] == "root-linear"
    assert tracker.updated[0][1] == "SYMPHONY PIPELINE NODE"
    assert "graph_id: graph-root-linear" in tracker.updated[0][2]
    assert "node_id: root-linear" in tracker.updated[0][2]
    assert "gate_snapshot_hash:" in tracker.updated[0][2]
    assert projection["node_id"] == "root-linear"
    assert projection["linear_issue_id"] == "root-linear"
    assert projection["metadata"]["conductor_revision"] == 1


async def test_pipeline_linear_projector_reuses_local_projection_when_remote_marker_missing(tmp_path: Path) -> None:
    store = ConductorPipelineStore(tmp_path)
    store.apply_runtime_config(RuntimeConfigEnvelope("group-1", 1, _policy(1)))
    store.commit_plan(_proposal())
    store.record_linear_projection(
        node_id="a",
        linear_issue_id="existing-a",
        metadata={"graph_id": "graph-1", "node_id": "a", "conductor_revision": 1},
    )
    store.record_linear_projection(
        node_id="b",
        linear_issue_id="existing-b",
        metadata={"graph_id": "graph-1", "node_id": "b", "conductor_revision": 1},
    )

    class Tracker:
        def __init__(self) -> None:
            self.created = 0
            self.updated: list[str] = []
            self.relations: list[tuple[str, str, str]] = []

        async def fetch_child_issues(self, parent_issue_id: str, *, label_name: str | None = None) -> list[dict[str, object]]:
            return []

        async def create_child_issue_for(self, **kwargs: object) -> dict[str, object]:
            self.created += 1
            return {"id": f"new-{self.created}"}

        async def update_issue_description_marker_block(self, issue_id: str, marker_name: str, block: str) -> dict[str, object]:
            self.updated.append(issue_id)
            return {"success": True}

        async def ensure_issue_relation(self, *, issue_id: str, related_issue_id: str, relation_type: str) -> dict[str, object]:
            self.relations.append((issue_id, related_issue_id, relation_type))
            return {"success": True}

    tracker = Tracker()
    projector = PipelineLinearProjector(store=store, tracker=tracker, root_issue_id="root-linear")

    projected = await projector.reconcile_once()

    assert projected == 3
    assert tracker.created == 0
    assert tracker.updated == ["existing-a", "existing-b"]
    assert tracker.relations == [("existing-a", "existing-b", "blocks")]


async def test_pipeline_linear_projector_projects_nested_node_issues_under_parent_node(tmp_path: Path) -> None:
    store = ConductorPipelineStore(tmp_path)
    gate_root = _gate("root")
    gate_parent = _gate("parent")
    gate_child = _gate("child")
    store.commit_plan(
        PlanProposal(
            graph_id="graph-1",
            plan_attempt_id="plan-1",
            root_node_id="root",
            nodes=[
                GraphNode(
                    node_id="root",
                    title="Root",
                    state=GraphNodeState.PLANNED,
                    issue_id="root-linear",
                    gate_snapshot_hash=gate_root.hash,
                ),
                GraphNode(
                    node_id="parent",
                    title="Parent",
                    state=GraphNodeState.PLANNED,
                    parent_node_id="root",
                    gate_snapshot_hash=gate_parent.hash,
                ),
                GraphNode(
                    node_id="child",
                    title="Child",
                    state=GraphNodeState.READY,
                    parent_node_id="parent",
                    gate_snapshot_hash=gate_child.hash,
                ),
            ],
            blocks=[],
            gates=[gate_root, gate_parent, gate_child],
            entry_node_ids=["root", "parent", "child"],
            exit_node_ids=["root", "parent", "child"],
        )
    )

    class Tracker:
        def __init__(self) -> None:
            self.children: list[dict[str, object]] = []

        async def fetch_child_issues(self, parent_issue_id: str, *, label_name: str | None = None) -> list[dict[str, object]]:
            return [
                child
                for child in self.children
                if child.get("parent_issue_id") == parent_issue_id
                and (label_name is None or label_name in child.get("labels", []))
            ]

        async def create_child_issue_for(self, **kwargs: object) -> dict[str, object]:
            child = {
                "id": f"issue-{len(self.children) + 1}",
                "description": kwargs.get("description"),
                "labels": list(kwargs.get("label_names") or []),
                "parent_issue_id": kwargs.get("parent_issue_id"),
                "title": kwargs.get("title"),
            }
            self.children.append(child)
            return child

        async def update_issue_description_marker_block(self, issue_id: str, marker_name: str, block: str) -> dict[str, object]:
            return {"success": True}

    tracker = Tracker()
    projector = PipelineLinearProjector(store=store, tracker=tracker, root_issue_id="root-linear")

    await projector.reconcile_once()

    parent_issue = next(child for child in tracker.children if child["title"] == "Parent")
    child_issue = next(child for child in tracker.children if child["title"] == "Child")
    assert parent_issue["parent_issue_id"] == "root-linear"
    assert child_issue["parent_issue_id"] == parent_issue["id"]


async def test_pipeline_linear_projector_ingests_human_added_blocks_as_new_graph_revision(tmp_path: Path) -> None:
    store = ConductorPipelineStore(tmp_path)
    gate_a = _gate("a")
    gate_b = _gate("b")
    store.commit_plan(
        PlanProposal(
            graph_id="graph-1",
            plan_attempt_id="plan-1",
            root_node_id="root",
            nodes=[
                GraphNode(node_id="a", title="A", state=GraphNodeState.READY, gate_snapshot_hash=gate_a.hash),
                GraphNode(node_id="b", title="B", state=GraphNodeState.READY, gate_snapshot_hash=gate_b.hash),
            ],
            blocks=[],
            gates=[gate_a, gate_b],
            entry_node_ids=["a", "b"],
            exit_node_ids=["a", "b"],
        )
    )

    class Tracker:
        async def fetch_child_issues(self, parent_issue_id: str, *, label_name: str | None = None) -> list[dict[str, object]]:
            return [
                {
                    "id": "issue-a",
                    "description": "node_id: a",
                    "labels": ["performer:type/pipeline-node"],
                    "relations": [{"type": "blocks", "relatedIssue": {"id": "issue-b"}}],
                },
                {
                    "id": "issue-b",
                    "description": "node_id: b",
                    "labels": ["performer:type/pipeline-node"],
                    "relations": [],
                },
            ]

    projector = PipelineLinearProjector(store=store, tracker=Tracker(), root_issue_id="root-linear")

    ingested = await projector.ingest_human_linear_changes_once()

    assert ingested == 1
    assert store.current_graph_revision() == 2
    assert store.blockers_for("b") == ["a"]
    assert store.get_node("a").state is GraphNodeState.READY
    assert store.get_node("b").state is GraphNodeState.READY


async def test_pipeline_linear_projector_resumes_need_human_only_from_state_flip(tmp_path: Path) -> None:
    store = ConductorPipelineStore(tmp_path)
    store.commit_plan(_proposal())
    wait = store.create_human_wait(
        "a",
        reason=HumanEscalationReason.CREDENTIAL_REQUIRED.value,
        details={"mode": RuntimeMode.EXECUTE.value, "error": "missing API key"},
    )
    assert store.get_node("a").state is GraphNodeState.NEED_HUMAN

    class Tracker:
        async def fetch_child_issues(self, parent_issue_id: str, *, label_name: str | None = None) -> list[dict[str, object]]:
            return [
                {
                    "id": "issue-a",
                    "description": "node_id: a",
                    "labels": ["performer:type/pipeline-node"],
                    "relations": [],
                    "state": {"name": "In Progress", "type": "started"},
                    "comments": [{"body": "credentials are in the environment"}],
                },
                {
                    "id": "issue-b",
                    "description": "node_id: b",
                    "labels": ["performer:type/pipeline-node"],
                    "relations": [],
                    "state": {"name": "Todo", "type": "unstarted"},
                },
            ]

    projector = PipelineLinearProjector(store=store, tracker=Tracker(), root_issue_id="root-linear")

    ingested = await projector.ingest_human_linear_changes_once()

    resolved_wait = next(item for item in store.list_human_waits() if item["wait_id"] == wait["wait_id"])
    assert ingested == 1
    assert resolved_wait["status"] == "resolved"
    assert "state flip" in resolved_wait["resolution"]
    assert store.get_node("a").state is GraphNodeState.READY


async def test_pipeline_linear_projector_ignores_need_human_comments_without_state_flip(tmp_path: Path) -> None:
    store = ConductorPipelineStore(tmp_path)
    store.commit_plan(_proposal())
    wait = store.create_human_wait(
        "a",
        reason=HumanEscalationReason.CREDENTIAL_REQUIRED.value,
        details={"mode": RuntimeMode.EXECUTE.value},
    )

    class Tracker:
        async def fetch_child_issues(self, parent_issue_id: str, *, label_name: str | None = None) -> list[dict[str, object]]:
            return [
                {
                    "id": "issue-a",
                    "description": "node_id: a",
                    "labels": ["performer:type/pipeline-node"],
                    "relations": [],
                    "state": {"name": "Blocked", "type": "started"},
                    "comments": [{"body": "I added the credentials; please continue"}],
                },
                {
                    "id": "issue-b",
                    "description": "node_id: b",
                    "labels": ["performer:type/pipeline-node"],
                    "relations": [],
                    "state": {"name": "Todo", "type": "unstarted"},
                },
            ]

    projector = PipelineLinearProjector(store=store, tracker=Tracker(), root_issue_id="root-linear")

    ingested = await projector.ingest_human_linear_changes_once()

    unresolved_wait = next(item for item in store.list_human_waits() if item["wait_id"] == wait["wait_id"])
    assert ingested == 0
    assert unresolved_wait["status"] == "waiting"
    assert store.get_node("a").state is GraphNodeState.NEED_HUMAN


def test_merge_human_added_blocks_is_union_only_and_idempotent(tmp_path: Path) -> None:
    store = ConductorPipelineStore(tmp_path)
    gate_a = _gate("a")
    gate_b = _gate("b")
    gate_c = _gate("c")
    store.commit_plan(
        PlanProposal(
            graph_id="graph-1",
            plan_attempt_id="plan-1",
            root_node_id="root",
            nodes=[
                GraphNode(node_id="a", title="A", state=GraphNodeState.READY, gate_snapshot_hash=gate_a.hash),
                GraphNode(node_id="b", title="B", state=GraphNodeState.READY, gate_snapshot_hash=gate_b.hash),
                GraphNode(node_id="c", title="C", state=GraphNodeState.READY, gate_snapshot_hash=gate_c.hash),
            ],
            blocks=[("a", "b")],
            gates=[gate_a, gate_b, gate_c],
            entry_node_ids=["a", "c"],
            exit_node_ids=["b", "c"],
        )
    )

    revision = store.merge_human_added_blocks([("b", "c")], reason="human_linear_blocks_ingested")

    assert revision is not None
    assert revision.revision == 2
    assert store.current_blocks() == [("a", "b"), ("b", "c")]

    assert store.merge_human_added_blocks([("b", "c")], reason="human_linear_blocks_ingested") is None
    assert store.current_graph_revision() == 2
    assert store.current_blocks() == [("a", "b"), ("b", "c")]


async def test_pipeline_linear_projector_does_not_clear_local_blocks_when_remote_relations_are_absent(tmp_path: Path) -> None:
    store = ConductorPipelineStore(tmp_path)
    store.commit_plan(_proposal())

    class Tracker:
        async def fetch_child_issues(self, parent_issue_id: str, *, label_name: str | None = None) -> list[dict[str, object]]:
            return [
                {
                    "id": "issue-a",
                    "description": "node_id: a",
                    "labels": ["performer:type/pipeline-node"],
                    "relations": [],
                },
                {
                    "id": "issue-b",
                    "description": "node_id: b",
                    "labels": ["performer:type/pipeline-node"],
                    "relations": [],
                },
            ]

    projector = PipelineLinearProjector(store=store, tracker=Tracker(), root_issue_id="root-linear")

    ingested = await projector.ingest_human_linear_changes_once()

    assert ingested == 0
    assert store.current_graph_revision() == 1
    assert store.blockers_for("b") == ["a"]


async def test_pipeline_linear_projector_ignores_stale_blocks_from_superseded_nodes(tmp_path: Path) -> None:
    store = ConductorPipelineStore(tmp_path)
    gate_a = _gate("a")
    gate_b = _gate("b")
    store.commit_plan(
        PlanProposal(
            graph_id="graph-1",
            plan_attempt_id="plan-1",
            root_node_id="a",
            nodes=[
                GraphNode(node_id="a", title="A", state=GraphNodeState.REPLANNING, gate_snapshot_hash=gate_a.hash),
                GraphNode(node_id="b", title="B", state=GraphNodeState.PLANNED, gate_snapshot_hash=gate_b.hash),
            ],
            blocks=[("a", "b")],
            gates=[gate_a, gate_b],
            entry_node_ids=["a"],
            exit_node_ids=["b"],
        )
    )
    gate_a2 = _gate("a2")
    store.replace_node_with_subgraph(
        "a",
        PlanProposal(
            graph_id="graph-1",
            plan_attempt_id="plan-2",
            root_node_id="a2",
            nodes=[GraphNode(node_id="a2", title="A2", state=GraphNodeState.PLANNED, gate_snapshot_hash=gate_a2.hash)],
            blocks=[],
            gates=[gate_a2],
            entry_node_ids=["a2"],
            exit_node_ids=["a2"],
        ),
    )

    class Tracker:
        async def fetch_child_issues(self, parent_issue_id: str, *, label_name: str | None = None) -> list[dict[str, object]]:
            return [
                {
                    "id": "issue-a",
                    "description": "node_id: a",
                    "labels": ["performer:type/pipeline-node"],
                    "relations": [{"type": "blocks", "relatedIssue": {"id": "issue-b"}}],
                },
                {
                    "id": "issue-b",
                    "description": "node_id: b",
                    "labels": ["performer:type/pipeline-node"],
                    "relations": [],
                },
            ]

    projector = PipelineLinearProjector(store=store, tracker=Tracker(), root_issue_id="root-linear")

    ingested = await projector.ingest_human_linear_changes_once()

    assert ingested == 0
    assert store.current_graph_revision() == 2
    assert store.get_node("a").state is GraphNodeState.SUPERSEDED
    assert store.blockers_for("b") == ["a2"]


async def test_pipeline_linear_projector_preserves_replacement_blocks_not_yet_reflected_by_linear(
    tmp_path: Path,
) -> None:
    store = ConductorPipelineStore(tmp_path)
    gate_alpha = _gate("alpha")
    gate_target = _gate("target")
    gate_downstream = _gate("downstream")
    store.commit_plan(
        PlanProposal(
            graph_id="graph-1",
            plan_attempt_id="plan-1",
            root_node_id="alpha",
            nodes=[
                GraphNode(node_id="alpha", title="Alpha", state=GraphNodeState.EXECUTING, gate_snapshot_hash=gate_alpha.hash),
                GraphNode(node_id="target", title="Target", state=GraphNodeState.REPLANNING, gate_snapshot_hash=gate_target.hash),
                GraphNode(node_id="downstream", title="Downstream", state=GraphNodeState.PLANNED, gate_snapshot_hash=gate_downstream.hash),
            ],
            blocks=[("alpha", "downstream"), ("target", "downstream")],
            gates=[gate_alpha, gate_target, gate_downstream],
            entry_node_ids=["alpha", "target"],
            exit_node_ids=["downstream"],
        )
    )
    gate_replacement = _gate("target-replacement")
    store.replace_node_with_subgraph(
        "target",
        PlanProposal(
            graph_id="graph-1",
            plan_attempt_id="plan-2",
            root_node_id="target-replacement",
            nodes=[
                GraphNode(
                    node_id="target-replacement",
                    title="Target replacement",
                    state=GraphNodeState.READY,
                    gate_snapshot_hash=gate_replacement.hash,
                )
            ],
            blocks=[],
            gates=[gate_replacement],
            entry_node_ids=["target-replacement"],
            exit_node_ids=["target-replacement"],
        ),
    )
    assert store.blockers_for("downstream") == ["alpha", "target-replacement"]

    class Tracker:
        async def fetch_child_issues(self, parent_issue_id: str, *, label_name: str | None = None) -> list[dict[str, object]]:
            return [
                {
                    "id": "issue-alpha",
                    "description": "node_id: alpha",
                    "labels": ["performer:type/pipeline-node"],
                    "relations": [{"type": "blocks", "relatedIssue": {"id": "issue-downstream"}}],
                },
                {
                    "id": "issue-target",
                    "description": "node_id: target",
                    "labels": ["performer:type/pipeline-node"],
                    "relations": [],
                },
                {
                    "id": "issue-target-replacement",
                    "description": "node_id: target-replacement",
                    "labels": ["performer:type/pipeline-node"],
                    "relations": [],
                },
                {
                    "id": "issue-downstream",
                    "description": "node_id: downstream",
                    "labels": ["performer:type/pipeline-node"],
                    "relations": [],
                },
            ]

    projector = PipelineLinearProjector(store=store, tracker=Tracker(), root_issue_id="root-linear")

    ingested = await projector.ingest_human_linear_changes_once()

    assert ingested == 0
    assert store.current_graph_revision() == 2
    assert store.blockers_for("downstream") == ["alpha", "target-replacement"]


async def test_pipeline_linear_projector_does_not_clear_blocks_when_root_issue_endpoint_is_not_a_child(
    tmp_path: Path,
) -> None:
    store = ConductorPipelineStore(tmp_path)
    gate_root = _gate("root-linear")
    gate_child = _gate("child-node")
    store.commit_plan(
        PlanProposal(
            graph_id="graph-1",
            plan_attempt_id="plan-1",
            root_node_id="root-linear",
            nodes=[
                GraphNode(
                    node_id="root-linear",
                    title="Root",
                    state=GraphNodeState.READY,
                    issue_id="root-linear",
                    gate_snapshot_hash=gate_root.hash,
                ),
                GraphNode(
                    node_id="child-node",
                    title="Child",
                    state=GraphNodeState.PLANNED,
                    gate_snapshot_hash=gate_child.hash,
                ),
            ],
            blocks=[("root-linear", "child-node")],
            gates=[gate_root, gate_child],
            entry_node_ids=["root-linear"],
            exit_node_ids=["child-node"],
        )
    )

    class Tracker:
        async def fetch_child_issues(self, parent_issue_id: str, *, label_name: str | None = None) -> list[dict[str, object]]:
            return [
                {
                    "id": "child-issue",
                    "description": "node_id: child-node",
                    "labels": ["performer:type/pipeline-node"],
                    "relations": [],
                }
            ]

    projector = PipelineLinearProjector(store=store, tracker=Tracker(), root_issue_id="root-linear")

    ingested = await projector.ingest_human_linear_changes_once()

    assert ingested == 0
    assert store.current_graph_revision() == 1
    assert store.blockers_for("child-node") == ["root-linear"]


