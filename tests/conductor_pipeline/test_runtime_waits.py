from __future__ import annotations

from .conftest import *  # noqa: F403

async def test_background_coordination_projects_pipeline_graph_to_linear(tmp_path: Path) -> None:
    data_root = tmp_path / "conductor-data"
    store = ConductorStore(data_root)
    instance_dir = data_root / "instances" / "inst-1"
    repo = tmp_path / "repo"
    repo.mkdir()
    store.save_instance(
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

    class Tracker:
        def __init__(self) -> None:
            self.children: list[dict[str, object]] = []
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
                "title": title,
                "description": description,
                "labels": list(label_names),
                "parent_issue_id": parent_issue_id,
                "delegate_id": delegate_id,
            }
            self.children.append(child)
            return child

        async def update_issue_description_marker_block(self, issue_id: str, marker_name: str, block: str) -> dict[str, object]:
            return {"success": True}

        async def ensure_issue_relation(self, *, issue_id: str, related_issue_id: str, relation_type: str) -> dict[str, object]:
            self.relations.append((issue_id, related_issue_id, relation_type))
            return {"success": True}

    tracker = Tracker()
    service = ConductorService(
        store=store,
        data_root=data_root,
        runtime_manager=ConductorRuntimeManager(command="performer"),
    )
    service.repository_handoff_tracker_factory = lambda instance: tracker
    service.pipeline_store.apply_runtime_config(
        RuntimeConfigEnvelope(
            "group-1",
            1,
            SchedulerPolicy(
                policy_id="policy-no-dispatch",
                version=1,
                effective_at="2026-07-06T00:00:00Z",
                capacity=SchedulerCapacity(global_limit=0),
            ),
        )
    )
    service.pipeline_store.commit_plan(_proposal())

    result = await service.coordinate_background_once()

    assert result["linear_pipeline_projections"] == 3
    assert len(tracker.children) == 2
    assert tracker.children[0]["parent_issue_id"] == "root"
    assert tracker.children[0]["delegate_id"] == "agent-1"
    assert tracker.relations == [("child-1", "child-2", "blocks")]
    assert len(service.pipeline_store.list_linear_projections()) == 2


async def test_background_coordination_projects_runtime_wait_signal_to_linear_node(tmp_path: Path) -> None:
    data_root = tmp_path / "conductor-data"
    store = ConductorStore(data_root)
    instance_dir = data_root / "instances" / "inst-1"
    repo = tmp_path / "repo"
    repo.mkdir()
    instance = InstanceRecord.create(
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
    store.save_instance(instance)

    class Tracker:
        def __init__(self) -> None:
            self.children: list[dict[str, object]] = []
            self.description_blocks: dict[str, str] = {}

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
                "title": title,
                "description": description,
                "labels": list(label_names),
                "parent_issue_id": parent_issue_id,
                "delegate_id": delegate_id,
            }
            self.children.append(child)
            return child

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
    service = ConductorService(
        store=store,
        data_root=data_root,
        runtime_manager=ConductorRuntimeManager(command="performer"),
    )
    service.repository_handoff_tracker_factory = lambda instance: tracker
    service.pipeline_store.apply_runtime_config(
        RuntimeConfigEnvelope(
            "group-1",
            1,
            SchedulerPolicy(
                policy_id="policy-no-dispatch",
                version=1,
                effective_at="2026-07-06T00:00:00Z",
                capacity=SchedulerCapacity(global_limit=0),
            ),
        )
    )
    service.pipeline_store.commit_plan(_proposal())
    service.pipeline_store.start_attempt(
        RuntimeMode.EXECUTE,
        node_id="a",
        attempt_id="exec-wait",
        now=datetime(2026, 7, 6, tzinfo=timezone.utc),
    )
    log_path = instance_dir / "logs" / "performer-000001.log"
    log_path.parent.mkdir(parents=True, exist_ok=True)
    (instance_dir / "logs" / "current.log").write_text(str(log_path), encoding="utf-8")
    codex_event = {
        "event": "performer_attempt_event",
        "mode": "execute",
        "attempt_id": "exec-wait",
        "node_id": "a",
        "codex_event": "sdk_approval_requested",
        "message": "waiting for command approval token=secret-token",
        "command": "pytest -q token=secret-token",
    }
    log_path.write_text(
        "event=performer_stream stream=stdout mode=execute attempt_request_path=req "
        f"attempt_result_path=res message={json.dumps(codex_event, sort_keys=True)}\n",
        encoding="utf-8",
    )

    result = await service.coordinate_background_once()

    assert result["pipeline_runtime_waits_observed"] == 1
    assert result["pipeline_human_actions_created"] == 0
    runtime_waits = service.pipeline_store.list_runtime_waits()
    assert runtime_waits[0]["wait_kind"] == "approval_requested"
    assert runtime_waits[0]["attempt_id"] == "exec-wait"
    assert not runtime_waits[0]["child_issue_id"]
    assert "secret-token" not in json.dumps(runtime_waits)
    human_actions = [child for child in tracker.children if "performer:type/human-action" in child.get("labels", [])]
    assert human_actions == []
    pipeline_nodes = [child for child in tracker.children if "performer:type/pipeline-node" in child.get("labels", [])]
    node_description = tracker.description_blocks[str(pipeline_nodes[0]["id"])]
    assert "runtime_wait:" in node_description
    assert "operator_status: waiting_for_runtime_input" in node_description
    assert "approval_requested" in node_description
    assert "exec-wait" in node_description
    assert "secret-token" not in node_description
    assert service.pipeline_store.pipeline_view().to_dict()["runtime_waits"][0]["node_id"] == "a"


async def test_background_coordination_projects_tool_input_wait_as_operator_visible_state(tmp_path: Path) -> None:
    data_root = tmp_path / "conductor-data"
    store = ConductorStore(data_root)
    instance_dir = data_root / "instances" / "inst-1"
    repo = tmp_path / "repo"
    repo.mkdir()
    instance = InstanceRecord.create(
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
    store.save_instance(instance)

    class Tracker:
        def __init__(self) -> None:
            self.children: list[dict[str, object]] = []
            self.description_blocks: dict[str, str] = {}

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
                "title": title,
                "description": description,
                "labels": list(label_names),
                "parent_issue_id": parent_issue_id,
                "delegate_id": delegate_id,
            }
            self.children.append(child)
            return child

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
    service = ConductorService(
        store=store,
        data_root=data_root,
        runtime_manager=ConductorRuntimeManager(command="performer"),
    )
    service.repository_handoff_tracker_factory = lambda instance: tracker
    service.pipeline_store.apply_runtime_config(
        RuntimeConfigEnvelope(
            "group-1",
            1,
            SchedulerPolicy(
                policy_id="policy-no-dispatch",
                version=1,
                effective_at="2026-07-06T00:00:00Z",
                capacity=SchedulerCapacity(global_limit=0),
            ),
        )
    )
    service.pipeline_store.commit_plan(_proposal())
    service.pipeline_store.start_attempt(
        RuntimeMode.EXECUTE,
        node_id="a",
        attempt_id="exec-tool-input",
        now=datetime(2026, 7, 6, tzinfo=timezone.utc),
    )
    log_path = instance_dir / "logs" / "performer-000001.log"
    log_path.parent.mkdir(parents=True, exist_ok=True)
    (instance_dir / "logs" / "current.log").write_text(str(log_path), encoding="utf-8")
    codex_event = {
        "event": "performer_attempt_event",
        "mode": "execute",
        "attempt_id": "exec-tool-input",
        "node_id": "a",
        "codex_event": "tool_input_requested",
        "message": "waiting for tool input from sandbox",
    }
    log_path.write_text(
        "event=performer_stream stream=stdout mode=execute attempt_request_path=req "
        f"attempt_result_path=res message={json.dumps(codex_event, sort_keys=True)}\n",
        encoding="utf-8",
    )

    result = await service.coordinate_background_once()

    assert result["pipeline_runtime_waits_observed"] == 1
    assert result["pipeline_human_actions_created"] == 0
    wait = service.pipeline_store.list_runtime_waits()[0]
    assert wait["wait_kind"] == "tool_input_requested"
    assert wait["attempt_id"] == "exec-tool-input"
    assert not wait["child_issue_id"]
    human_actions = [child for child in tracker.children if "performer:type/human-action" in child.get("labels", [])]
    assert human_actions == []
    pipeline_nodes = [child for child in tracker.children if "performer:type/pipeline-node" in child.get("labels", [])]
    node_description = tracker.description_blocks[str(pipeline_nodes[0]["id"])]
    assert "operator_status: waiting_for_runtime_input" in node_description
    assert "operator_wait_kind:" in node_description
    assert "tool_input_requested" in node_description


async def test_background_coordination_surfaces_linear_projection_failures(tmp_path: Path) -> None:
    data_root = tmp_path / "conductor-data"
    store = ConductorStore(data_root)
    instance_dir = data_root / "instances" / "inst-1"
    repo = tmp_path / "repo"
    repo.mkdir()
    instance = InstanceRecord.create(
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
    store.save_instance(instance)
    service = ConductorService(
        store=store,
        data_root=data_root,
        runtime_manager=ConductorRuntimeManager(command="performer"),
    )
    service.repository_handoff_tracker_factory = lambda _instance: (_ for _ in ()).throw(
        RuntimeError("Authorization: Bearer linear-secret failed")
    )
    service.pipeline_store.apply_runtime_config(
        RuntimeConfigEnvelope(
            "group-1",
            1,
            SchedulerPolicy(
                policy_id="policy-no-dispatch",
                version=1,
                effective_at="2026-07-06T00:00:00Z",
                capacity=SchedulerCapacity(global_limit=0),
            ),
        )
    )
    service.pipeline_store.commit_plan(_proposal())

    result = await service.coordinate_background_once()

    projection_findings = [
        finding
        for finding in result["reconcile_findings"]
        if finding["event"] == "linear_pipeline_projection_failed"
    ]
    assert projection_findings
    assert projection_findings[0]["instance_id"] == "inst-1"
    assert projection_findings[0]["error_type"] == "RuntimeError"
    assert "Authorization: [REDACTED]" in projection_findings[0]["sanitized_reason"]
    assert "linear-secret" not in json.dumps(result["reconcile_findings"])
    log_text = Path(instance.log_path).read_text(encoding="utf-8")
    assert "event=linear_pipeline_projection_failed" in log_text
    assert "Authorization: [REDACTED]" in log_text
    assert "linear-secret" not in log_text


async def test_background_coordination_ingests_linear_pipeline_blocks(tmp_path: Path) -> None:
    data_root = tmp_path / "conductor-data"
    store = ConductorStore(data_root)
    instance_dir = data_root / "instances" / "inst-1"
    repo = tmp_path / "repo"
    repo.mkdir()
    store.save_instance(
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

    gate_a = _gate("a")
    gate_b = _gate("b")
    service = ConductorService(
        store=store,
        data_root=data_root,
        runtime_manager=ConductorRuntimeManager(command="performer"),
    )
    service.pipeline_store.apply_runtime_config(
        RuntimeConfigEnvelope(
            "group-1",
            1,
            SchedulerPolicy(
                policy_id="policy-no-dispatch",
                version=1,
                effective_at="2026-07-06T00:00:00Z",
                capacity=SchedulerCapacity(global_limit=0),
            ),
        )
    )
    service.pipeline_store.commit_plan(
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
                    "parent_issue_id": parent_issue_id,
                    "relations": [{"type": "blocks", "relatedIssue": {"id": "issue-b"}}],
                },
                {
                    "id": "issue-b",
                    "description": "node_id: b",
                    "labels": ["performer:type/pipeline-node"],
                    "parent_issue_id": parent_issue_id,
                    "relations": [],
                },
            ]

        async def update_issue_description_marker_block(self, issue_id: str, marker_name: str, block: str) -> dict[str, object]:
            return {"success": True}

        async def ensure_issue_relation(self, *, issue_id: str, related_issue_id: str, relation_type: str) -> dict[str, object]:
            return {"success": True}

    service.repository_handoff_tracker_factory = lambda instance: Tracker()

    result = await service.coordinate_background_once()

    assert result["linear_pipeline_ingestions"] == 1
    assert service.pipeline_store.current_graph_revision() == 2
    assert service.pipeline_store.blockers_for("b") == ["a"]


async def test_background_coordination_creates_linear_human_action_for_integration_conflict(tmp_path: Path) -> None:
    data_root = tmp_path / "conductor-data"
    store = ConductorStore(data_root)
    instance_dir = data_root / "instances" / "inst-1"
    repo = tmp_path / "repo"
    repo.mkdir()
    subprocess.run(["git", "init"], cwd=repo, check=True, capture_output=True, text=True)
    subprocess.run(["git", "config", "user.email", "test@example.com"], cwd=repo, check=True)
    subprocess.run(["git", "config", "user.name", "Test User"], cwd=repo, check=True)
    (repo / "README.md").write_text("before\n", encoding="utf-8")
    subprocess.run(["git", "add", "README.md"], cwd=repo, check=True)
    subprocess.run(["git", "commit", "-m", "base"], cwd=repo, check=True, capture_output=True, text=True)
    store.save_instance(
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
                "id": f"human-child-{len(self.children) + 1}",
                "title": title,
                "description": description,
                "labels": list(label_names),
                "parent_issue_id": parent_issue_id,
                "delegate_id": delegate_id,
            }
            self.children.append(child)
            return child

        async def update_issue_description_marker_block(self, issue_id: str, marker_name: str, block: str) -> dict[str, object]:
            return {"success": True}

        async def ensure_issue_relation(self, *, issue_id: str, related_issue_id: str, relation_type: str) -> dict[str, object]:
            return {"success": True}

    tracker = Tracker()
    service = ConductorService(
        store=store,
        data_root=data_root,
        runtime_manager=ConductorRuntimeManager(command="performer"),
    )
    service.repository_handoff_tracker_factory = lambda instance: tracker
    service.pipeline_store.apply_runtime_config(
        RuntimeConfigEnvelope(
            "group-1",
            1,
            SchedulerPolicy(
                policy_id="policy-no-dispatch",
                version=1,
                effective_at="2026-07-06T00:00:00Z",
                capacity=SchedulerCapacity(global_limit=0),
            ),
        )
    )
    service.pipeline_store.commit_plan(_proposal())
    gate_hash = service.pipeline_store.get_node("a").gate_snapshot_hash or ""
    missing_patch = tmp_path / "missing.patch"
    manifest = TaskOutputManifest(
        node_id="a",
        verify_attempt_id="verify-conflict",
        gate_snapshot_hash=gate_hash,
        score=3,
        code={
            "base_revision": subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=repo, text=True).strip(),
            "patch_uri": f"file://{missing_patch}",
            "patch_hash": "sha256:patch",
            "expected_result_tree": "tree",
        },
    )
    service.pipeline_store.publish_task_output_manifest(manifest)
    service.pipeline_store.enqueue_integration(manifest)

    result = await service.coordinate_background_once()

    waits = service.pipeline_store.list_human_waits()
    human_children = [child for child in tracker.children if "performer:type/human-action" in child.get("labels", [])]
    assert result["pipeline_integrations_processed"] == 1
    assert result["pipeline_human_actions_created"] == 0
    assert human_children == []
    assert not waits[0]["child_issue_id"]
    assert waits[0]["reason"] == "LINEAR_SYNC_CONFLICT"


async def test_background_coordination_resumes_completed_linear_human_action(tmp_path: Path) -> None:
    data_root = tmp_path / "conductor-data"
    store = ConductorStore(data_root)
    instance_dir = data_root / "instances" / "inst-1"
    repo = tmp_path / "repo"
    repo.mkdir()
    store.save_instance(
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
            linear_filters={"labels": ["codex"]},
        )
    )
    service = ConductorService(
        store=store,
        data_root=data_root,
        runtime_manager=ConductorRuntimeManager(command="performer"),
    )
    service.pipeline_store.apply_runtime_config(
        RuntimeConfigEnvelope(
            "group-1",
            1,
            SchedulerPolicy(
                policy_id="policy-no-dispatch",
                version=1,
                effective_at="2026-07-06T00:00:00Z",
                capacity=SchedulerCapacity(global_limit=0),
            ),
        )
    )
    service.pipeline_store.commit_plan(_proposal())
    wait = service.pipeline_store.create_human_wait(
        "a",
        reason="LINEAR_SYNC_CONFLICT",
        child_issue_id="human-child-1",
        details={"integration_id": "integration-a-verify-1"},
    )

    class Tracker:
        async def fetch_child_issues(self, parent_issue_id: str, *, label_name: str | None = None) -> list[dict[str, object]]:
            return [
                {
                    "id": "human-child-1",
                    "labels": ["performer:type/human-action"],
                    "state": "Done",
                    "state_type": "completed",
                    "description": "conflict resolved",
                }
            ]

    service.repository_handoff_tracker_factory = lambda instance: Tracker()

    result = await service.coordinate_background_once()

    waits = service.pipeline_store.list_human_waits()
    assert result["pipeline_human_actions_completed"] == 1
    assert waits[0]["wait_id"] == wait["wait_id"]
    assert waits[0]["status"] == "resolved"
    assert waits[0]["resolution"] == "Linear human action human-child-1 completed."


async def test_background_coordination_resumes_completed_non_conflict_human_action(tmp_path: Path) -> None:
    data_root = tmp_path / "conductor-data"
    store = ConductorStore(data_root)
    instance_dir = data_root / "instances" / "inst-1"
    repo = tmp_path / "repo"
    repo.mkdir()
    store.save_instance(
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
            linear_filters={"labels": ["codex"]},
        )
    )
    service = ConductorService(
        store=store,
        data_root=data_root,
        runtime_manager=ConductorRuntimeManager(command="performer"),
    )
    service.pipeline_store.apply_runtime_config(RuntimeConfigEnvelope("group-1", 1, _policy(1)))
    service.pipeline_store.commit_plan(_proposal())
    wait = service.pipeline_store.create_human_wait(
        "a",
        reason="PLAN_INVALID",
        child_issue_id="human-child-1",
        details={"attempt_id": "plan-invalid"},
    )

    class Tracker:
        async def fetch_child_issues(self, parent_issue_id: str, *, label_name: str | None = None) -> list[dict[str, object]]:
            return [
                {
                    "id": "human-child-1",
                    "labels": ["performer:type/human-action"],
                    "state": "Done",
                    "state_type": "completed",
                    "description": "plan fixed",
                }
            ]

    service.repository_handoff_tracker_factory = lambda instance: Tracker()

    completed = await service.reconcile_completed_pipeline_human_actions_once()

    node = service.pipeline_store.get_node("a")
    waits = service.pipeline_store.list_human_waits()
    assert completed == 1
    assert waits[0]["wait_id"] == wait["wait_id"]
    assert waits[0]["status"] == "resolved"
    assert node.state is GraphNodeState.REPLANNING
    assert node.human_reason is None


async def test_podium_human_answered_command_without_completed_child_does_not_resume_wait(tmp_path: Path) -> None:
    service = ConductorService(
        store=ConductorStore(tmp_path / "conductor-data"),
        data_root=tmp_path / "conductor-data",
        runtime_manager=ConductorRuntimeManager(command="performer"),
    )
    service.pipeline_store.apply_runtime_config(RuntimeConfigEnvelope("group-1", 1, _policy(1)))
    service.pipeline_store.commit_plan(_proposal())
    wait = service.pipeline_store.create_human_wait(
        "a",
        reason="LINEAR_SYNC_CONFLICT",
        child_issue_id="human-child-1",
        details={"integration_id": "integration-a-verify-1"},
    )

    result = await service.handle_podium_ws_command(
        {
            "type": "human.answered",
            "wait_id": wait["wait_id"],
            "child_issue_id": "human-child-1",
            "human_response": "resume from parent command",
        }
    )

    waits = service.pipeline_store.list_human_waits()
    assert result == {"status": "ignored", "reason": "completed_child_required", "wait_id": wait["wait_id"]}
    assert waits[0]["status"] == "waiting"
    assert service.pipeline_store.get_node("a").state is GraphNodeState.NEED_HUMAN


async def test_unresolved_human_action_child_emits_reconcile_finding(tmp_path: Path) -> None:
    data_root = tmp_path / "conductor-data"
    store = ConductorStore(data_root)
    repo = tmp_path / "repo"
    repo.mkdir()
    store.save_instance(
        InstanceRecord.create(
            id="inst-1",
            name="Alpha",
            repo_source_type="local_path",
            repo_source_value=str(repo),
            resolved_repo_path=str(repo),
            instance_dir=str(data_root / "instances" / "inst-1"),
            workspace_root=str(data_root / "instances" / "inst-1" / "workspace" / "repo"),
            persistence_path=str(data_root / "instances" / "inst-1" / "state" / "performer.json"),
            log_path=str(data_root / "instances" / "inst-1" / "logs" / "performer.log"),
            http_port=8801,
            linear_project="ENG",
            linear_filters={"labels": ["codex"]},
        )
    )
    service = ConductorService(
        store=store,
        data_root=data_root,
        runtime_manager=ConductorRuntimeManager(command="performer"),
    )
    service.pipeline_store.apply_runtime_config(RuntimeConfigEnvelope("group-1", 1, _policy(1)))
    service.pipeline_store.commit_plan(_proposal())
    wait = service.pipeline_store.create_human_wait(
        "a",
        reason="LINEAR_SYNC_CONFLICT",
        child_issue_id="human-child-1",
        details={"integration_id": "integration-a-verify-1"},
    )

    class Tracker:
        async def fetch_child_issues(self, parent_issue_id: str, *, label_name: str | None = None) -> list[dict[str, object]]:
            return [
                {
                    "id": "human-child-1",
                    "labels": ["performer:type/human-action"],
                    "state": "Todo",
                    "state_type": "unstarted",
                    "description": "still open",
                }
            ]

    service.repository_handoff_tracker_factory = lambda instance: Tracker()
    service._pipeline_reconcile_findings = []

    completed = await service.reconcile_completed_pipeline_human_actions_once()

    assert completed == 0
    assert service.pipeline_store.list_human_waits()[0]["status"] == "waiting"
    assert service._pipeline_reconcile_findings == [
        {
            "event": "pipeline_human_wait_unresolved",
            "severity": "warning",
            "error_type": "RuntimeError",
            "sanitized_reason": "human action child is not completed",
            "action_required": "complete_human_action_child",
            "retryable": True,
            "instance_id": "inst-1",
            "issue_project": "ENG",
            "wait_id": wait["wait_id"],
            "node_id": "a",
            "child_issue_id": "human-child-1",
            "reason": "LINEAR_SYNC_CONFLICT",
        }
    ]


async def test_missing_human_action_child_emits_reconcile_finding(tmp_path: Path) -> None:
    data_root = tmp_path / "conductor-data"
    store = ConductorStore(data_root)
    repo = tmp_path / "repo"
    repo.mkdir()
    store.save_instance(
        InstanceRecord.create(
            id="inst-1",
            name="Alpha",
            repo_source_type="local_path",
            repo_source_value=str(repo),
            resolved_repo_path=str(repo),
            instance_dir=str(data_root / "instances" / "inst-1"),
            workspace_root=str(data_root / "instances" / "inst-1" / "workspace" / "repo"),
            persistence_path=str(data_root / "instances" / "inst-1" / "state" / "performer.json"),
            log_path=str(data_root / "instances" / "inst-1" / "logs" / "performer.log"),
            http_port=8801,
            linear_project="ENG",
            linear_filters={"labels": ["codex"]},
        )
    )
    service = ConductorService(
        store=store,
        data_root=data_root,
        runtime_manager=ConductorRuntimeManager(command="performer"),
    )
    service.pipeline_store.apply_runtime_config(RuntimeConfigEnvelope("group-1", 1, _policy(1)))
    service.pipeline_store.commit_plan(_proposal())
    wait = service.pipeline_store.create_human_wait(
        "a",
        reason="PLAN_INVALID",
        child_issue_id="human-child-missing",
        details={"attempt_id": "plan-invalid"},
    )

    class Tracker:
        async def fetch_child_issues(self, parent_issue_id: str, *, label_name: str | None = None) -> list[dict[str, object]]:
            return []

    service.repository_handoff_tracker_factory = lambda instance: Tracker()
    service._pipeline_reconcile_findings = []

    completed = await service.reconcile_completed_pipeline_human_actions_once()

    assert completed == 0
    assert service.pipeline_store.list_human_waits()[0]["status"] == "waiting"
    assert service._pipeline_reconcile_findings == [
        {
            "event": "pipeline_human_wait_unresolved",
            "severity": "warning",
            "error_type": "RuntimeError",
            "sanitized_reason": "human action child was not returned by Linear",
            "action_required": "recreate_or_complete_human_action_child",
            "retryable": True,
            "instance_id": "inst-1",
            "issue_project": "ENG",
            "wait_id": wait["wait_id"],
            "node_id": "a",
            "child_issue_id": "human-child-missing",
            "reason": "PLAN_INVALID",
        }
    ]


