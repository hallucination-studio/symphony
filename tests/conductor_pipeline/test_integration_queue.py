from __future__ import annotations

from .conftest import *  # noqa: F403

def test_integration_conflict_creates_human_wait_and_pauses_node(tmp_path: Path) -> None:
    store = ConductorPipelineStore(tmp_path)
    store.apply_runtime_config(RuntimeConfigEnvelope("group-1", 1, _policy(1)))
    store.commit_plan(_proposal())
    gate_hash = store.get_node("a").gate_snapshot_hash or ""
    manifest = TaskOutputManifest(
        node_id="a",
        verify_attempt_id="verify-1",
        gate_snapshot_hash=gate_hash,
        score=3,
        code={"patch_hash": "sha256:patch"},
    )
    store.update_node_state("a", GraphNodeState.VERIFY_PASSED, verify_score=3)
    store.publish_task_output_manifest(manifest)
    queued = store.enqueue_integration(manifest)

    completed = store.complete_integration(
        queued["integration_id"],
        status="conflict",
        error="patch conflict",
    )

    node = store.get_node("a")
    waits = store.list_human_waits()
    assert completed["status"] == "conflict"
    assert completed["error"] == "patch conflict"
    assert node.state is GraphNodeState.NEED_HUMAN
    assert node.human_reason is not None
    assert node.human_reason.value == "LINEAR_SYNC_CONFLICT"
    assert waits[0]["node_id"] == "a"
    assert waits[0]["reason"] == "LINEAR_SYNC_CONFLICT"
    assert waits[0]["status"] == "waiting"
    assert waits[0]["details"]["integration_id"] == queued["integration_id"]
    assert waits[0]["details"]["error"] == "patch conflict"


def test_resolving_legacy_integration_conflict_wait_marks_queue_resolved_only(tmp_path: Path) -> None:
    store = ConductorPipelineStore(tmp_path)
    store.apply_runtime_config(RuntimeConfigEnvelope("group-1", 1, _policy(1)))
    store.commit_plan(_proposal())
    gate_hash = store.get_node("a").gate_snapshot_hash or ""
    manifest = TaskOutputManifest(
        node_id="a",
        verify_attempt_id="verify-1",
        gate_snapshot_hash=gate_hash,
        score=3,
        code={"patch_hash": "sha256:patch"},
    )
    store.update_node_state("a", GraphNodeState.VERIFY_PASSED, verify_score=3)
    store.publish_task_output_manifest(manifest)
    queued = store.enqueue_integration(manifest)
    store.complete_integration(queued["integration_id"], status="conflict", error="patch conflict")
    wait = store.list_human_waits()[0]
    scheduler = PipelineScheduler(store)

    assert scheduler.is_dependency_satisfied("a") is False
    assert scheduler.promote_ready_nodes() == []

    resumed = store.resume_human_wait(wait["wait_id"], resolution="conflict resolved")

    node = store.get_node("a")
    integration = store.list_integration_queue()[0]
    assert resumed["status"] == "resolved"
    assert node.state is GraphNodeState.VERIFY_PASSED
    assert node.human_reason is None
    assert integration["status"] == "resolved"
    assert integration["completed_at"]
    assert integration["error"] == "patch conflict"
    assert integration["human_resolution"] == "conflict resolved"
    assert scheduler.is_dependency_satisfied("a") is False
    assert scheduler.promote_ready_nodes() == []
    assert scheduler.dispatchable_nodes(RuntimeMode.EXECUTE) == []


def test_process_queued_integration_applies_patch_and_records_integrated_revision(tmp_path: Path) -> None:
    repo = tmp_path / "repo"
    repo.mkdir()
    subprocess.run(["git", "init"], cwd=repo, check=True, capture_output=True, text=True)
    subprocess.run(["git", "config", "user.email", "test@example.com"], cwd=repo, check=True)
    subprocess.run(["git", "config", "user.name", "Test User"], cwd=repo, check=True)
    (repo / "README.md").write_text("before\n", encoding="utf-8")
    subprocess.run(["git", "add", "README.md"], cwd=repo, check=True)
    subprocess.run(["git", "commit", "-m", "base"], cwd=repo, check=True, capture_output=True, text=True)
    base_revision = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=repo, text=True).strip()
    (repo / "README.md").write_text("after\n", encoding="utf-8")
    subprocess.run(["git", "add", "README.md"], cwd=repo, check=True)
    patch = subprocess.check_output(["git", "diff", "--binary", "--cached"], cwd=repo, text=True)
    expected_tree = subprocess.check_output(["git", "write-tree"], cwd=repo, text=True).strip()
    subprocess.run(["git", "reset", "--hard", "HEAD"], cwd=repo, check=True, capture_output=True, text=True)
    patch_path = tmp_path / "patch.diff"
    patch_path.write_text(patch, encoding="utf-8")
    patch_hash = "sha256:" + hashlib.sha256(patch.encode("utf-8")).hexdigest()
    store = ConductorPipelineStore(tmp_path / "store")
    store.apply_runtime_config(RuntimeConfigEnvelope("group-1", 1, _policy(1)))
    store.commit_plan(_proposal())
    gate_hash = store.get_node("a").gate_snapshot_hash or ""
    manifest = TaskOutputManifest(
        node_id="a",
        verify_attempt_id="verify-1",
        gate_snapshot_hash=gate_hash,
        score=3,
        code={
                "base_revision": base_revision,
                "patch_uri": f"file://{patch_path}",
                "patch_hash": patch_hash,
                "expected_result_tree": expected_tree,
            },
        )
    store.publish_task_output_manifest(manifest)
    store.enqueue_integration(manifest)

    class Instance:
        log_path = str(tmp_path / "inst-1" / "logs" / "performer.log")

    processed = store.process_queued_integrations(repo, instance=Instance())

    completed = store.list_integration_queue()[0]
    updated_manifest = store.list_task_output_manifests()[0]
    assert processed == 1
    assert completed["status"] == "integrated"
    assert completed["integrated_revision"]
    assert updated_manifest.code["integrated_revision"] == completed["integrated_revision"]
    assert (repo / "README.md").read_text(encoding="utf-8") == "after\n"
    assert subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=repo, text=True).strip() == completed["integrated_revision"]
    log_text = Path(Instance.log_path).read_text(encoding="utf-8")
    assert "event=pipeline_integration_completed" in log_text
    assert "node_id=a" in log_text
    assert "attempt_id=verify-1" in log_text
    assert "mode=verify" in log_text
    assert "graph_revision=1" in log_text
    assert "policy_revision=1" in log_text
    assert "integration_id=integration-a-verify-1" in log_text
    assert f"integrated_revision={completed['integrated_revision']}" in log_text


def test_process_queued_integration_merges_verified_commit_manifest(tmp_path: Path) -> None:
    repo = tmp_path / "repo"
    repo.mkdir()
    subprocess.run(["git", "init"], cwd=repo, check=True, capture_output=True, text=True)
    subprocess.run(["git", "config", "user.email", "test@example.com"], cwd=repo, check=True)
    subprocess.run(["git", "config", "user.name", "Test User"], cwd=repo, check=True)
    (repo / "README.md").write_text("before\n", encoding="utf-8")
    subprocess.run(["git", "add", "README.md"], cwd=repo, check=True)
    subprocess.run(["git", "commit", "-m", "base"], cwd=repo, check=True, capture_output=True, text=True)
    base_revision = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=repo, text=True).strip()

    workspace = tmp_path / "workspace"
    subprocess.run(["git", "clone", "--quiet", str(repo), str(workspace)], check=True)
    subprocess.run(["git", "config", "user.email", "test@example.com"], cwd=workspace, check=True)
    subprocess.run(["git", "config", "user.name", "Test User"], cwd=workspace, check=True)
    (workspace / "RESULT.md").write_text("verified commit output\n", encoding="utf-8")
    subprocess.run(["git", "add", "RESULT.md"], cwd=workspace, check=True)
    subprocess.run(["git", "commit", "-m", "execute node a"], cwd=workspace, check=True, capture_output=True, text=True)
    commit_sha = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=workspace, text=True).strip()

    store = ConductorPipelineStore(tmp_path / "pipeline")
    store.apply_runtime_config(RuntimeConfigEnvelope("group-1", 1, _policy(1)))
    store.commit_plan(_proposal())
    manifest = TaskOutputManifest(
        node_id="a",
        verify_attempt_id="verify-1",
        gate_snapshot_hash=store.get_node("a").gate_snapshot_hash or "",
        score=3,
        code={
            "base_revision": base_revision,
            "workspace_path": str(workspace),
            "repository_path": str(repo),
            "branch_name": "symphony/a",
            "commit_sha": commit_sha,
        },
    )
    store.publish_task_output_manifest(manifest)
    store.enqueue_integration(manifest)

    assert store.process_queued_integrations(repo) == 1

    completed = store.list_integration_queue()[0]
    updated_manifest = store.integrated_manifest_for_node("a")
    assert completed["status"] == "integrated"
    assert completed["integrated_revision"]
    assert updated_manifest is not None
    assert updated_manifest.code["integrated_revision"] == completed["integrated_revision"]
    assert (repo / "RESULT.md").read_text(encoding="utf-8") == "verified commit output\n"


def test_process_queued_integrations_preserves_prior_integrated_patches(tmp_path: Path) -> None:
    repo = tmp_path / "repo"
    repo.mkdir()
    subprocess.run(["git", "init"], cwd=repo, check=True, capture_output=True, text=True)
    subprocess.run(["git", "config", "user.email", "test@example.com"], cwd=repo, check=True)
    subprocess.run(["git", "config", "user.name", "Test User"], cwd=repo, check=True)
    (repo / "alpha.txt").write_text("alpha before\n", encoding="utf-8")
    (repo / "beta.txt").write_text("beta before\n", encoding="utf-8")
    subprocess.run(["git", "add", "alpha.txt", "beta.txt"], cwd=repo, check=True)
    subprocess.run(["git", "commit", "-m", "base"], cwd=repo, check=True, capture_output=True, text=True)
    base_revision = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=repo, text=True).strip()

    patches: list[tuple[str, str, str]] = []
    for name, content in (("alpha", "alpha after\n"), ("beta", "beta after\n")):
        target = repo / f"{name}.txt"
        original = target.read_text(encoding="utf-8")
        target.write_text(content, encoding="utf-8")
        subprocess.run(["git", "add", target.name], cwd=repo, check=True)
        patch = subprocess.check_output(["git", "diff", "--binary", "--cached"], cwd=repo, text=True)
        expected_tree = subprocess.check_output(["git", "write-tree"], cwd=repo, text=True).strip()
        subprocess.run(["git", "reset", "--hard", base_revision], cwd=repo, check=True, capture_output=True, text=True)
        target.write_text(original, encoding="utf-8")
        patch_path = tmp_path / f"{name}.diff"
        patch_path.write_text(patch, encoding="utf-8")
        patches.append((name, f"file://{patch_path}", expected_tree))

    store = ConductorPipelineStore(tmp_path / "store")
    store.apply_runtime_config(RuntimeConfigEnvelope("group-1", 1, _policy(1)))
    store.commit_plan(_proposal())
    gate_hash = store.get_node("a").gate_snapshot_hash or ""
    for index, (name, patch_uri, expected_tree) in enumerate(patches, start=1):
        patch_text = Path(patch_uri.removeprefix("file://")).read_text(encoding="utf-8")
        manifest = TaskOutputManifest(
            node_id="a",
            verify_attempt_id=f"verify-{name}",
            gate_snapshot_hash=gate_hash,
            score=3,
            code={
                "base_revision": base_revision,
                "patch_uri": patch_uri,
                "patch_hash": "sha256:" + hashlib.sha256(patch_text.encode("utf-8")).hexdigest(),
                "expected_result_tree": expected_tree,
            },
        )
        store.publish_task_output_manifest(manifest)
        store.enqueue_integration(manifest)

    processed = store.process_queued_integrations(repo)

    queue = store.list_integration_queue()
    assert processed == 2
    assert [item["status"] for item in queue] == ["integrated", "integrated"]
    assert queue[0]["integrated_revision"] != queue[1]["integrated_revision"]
    assert (repo / "alpha.txt").read_text(encoding="utf-8") == "alpha after\n"
    assert (repo / "beta.txt").read_text(encoding="utf-8") == "beta after\n"
    assert subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=repo, text=True).strip() == queue[1]["integrated_revision"]


def test_process_queued_integrations_detects_overlapping_verified_patch_conflict(tmp_path: Path) -> None:
    repo = tmp_path / "repo"
    repo.mkdir()
    subprocess.run(["git", "init"], cwd=repo, check=True, capture_output=True, text=True)
    subprocess.run(["git", "config", "user.email", "test@example.com"], cwd=repo, check=True)
    subprocess.run(["git", "config", "user.name", "Test User"], cwd=repo, check=True)
    (repo / "README.md").write_text("before\n", encoding="utf-8")
    subprocess.run(["git", "add", "README.md"], cwd=repo, check=True)
    subprocess.run(["git", "commit", "-m", "base"], cwd=repo, check=True, capture_output=True, text=True)
    base_revision = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=repo, text=True).strip()

    patches: dict[str, tuple[str, str, str]] = {}
    for node_id, content in (("a", "after from a\n"), ("b", "after from b\n")):
        (repo / "README.md").write_text(content, encoding="utf-8")
        subprocess.run(["git", "add", "README.md"], cwd=repo, check=True)
        patch = subprocess.check_output(["git", "diff", "--binary", "--cached"], cwd=repo, text=True)
        expected_tree = subprocess.check_output(["git", "write-tree"], cwd=repo, text=True).strip()
        subprocess.run(["git", "reset", "--hard", base_revision], cwd=repo, check=True, capture_output=True, text=True)
        patch_path = tmp_path / f"{node_id}.diff"
        patch_path.write_text(patch, encoding="utf-8")
        patches[node_id] = (
            f"file://{patch_path}",
            "sha256:" + hashlib.sha256(patch.encode("utf-8")).hexdigest(),
            expected_tree,
        )

    gate_a = _gate("a")
    gate_b = _gate("b")
    store = ConductorPipelineStore(tmp_path / "store")
    store.apply_runtime_config(RuntimeConfigEnvelope("group-1", 1, _policy(1)))
    store.commit_plan(
        PlanProposal(
            graph_id="graph-1",
            plan_attempt_id="plan-1",
            root_node_id="a",
            nodes=[
                GraphNode(node_id="a", title="A", state=GraphNodeState.VERIFY_PASSED, gate_snapshot_hash=gate_a.hash),
                GraphNode(node_id="b", title="B", state=GraphNodeState.VERIFY_PASSED, gate_snapshot_hash=gate_b.hash),
            ],
            blocks=[],
            gates=[gate_a, gate_b],
            entry_node_ids=["a", "b"],
            exit_node_ids=["a", "b"],
        )
    )
    for node_id in ("a", "b"):
        patch_uri, patch_hash, expected_tree = patches[node_id]
        manifest = TaskOutputManifest(
            node_id=node_id,
            verify_attempt_id=f"verify-{node_id}",
            gate_snapshot_hash=store.get_node(node_id).gate_snapshot_hash or "",
            score=3,
            code={
                "base_revision": base_revision,
                "patch_uri": patch_uri,
                "patch_hash": patch_hash,
                "expected_result_tree": expected_tree,
            },
        )
        store.publish_task_output_manifest(manifest)
        store.enqueue_integration(manifest)

    processed = store.process_queued_integrations(repo)

    queue = store.list_integration_queue()
    waits = store.list_human_waits()
    assert processed == 2
    assert queue[0]["node_id"] == "a"
    assert queue[0]["status"] == "integrated"
    assert queue[0]["integrated_revision"]
    assert queue[1]["node_id"] == "b"
    assert queue[1]["status"] == "conflict"
    assert queue[1]["error"]
    assert (repo / "README.md").read_text(encoding="utf-8") == "after from a\n"
    assert store.get_node("b").state is GraphNodeState.NEED_HUMAN
    assert store.get_node("b").human_reason is HumanEscalationReason.LINEAR_SYNC_CONFLICT
    assert waits[0]["node_id"] == "b"
    assert waits[0]["reason"] == "LINEAR_SYNC_CONFLICT"
    assert waits[0]["details"]["integration_id"] == queue[1]["integration_id"]


def test_process_queued_integration_recovers_after_commit_before_queue_update(tmp_path: Path) -> None:
    repo = tmp_path / "repo"
    repo.mkdir()
    subprocess.run(["git", "init"], cwd=repo, check=True, capture_output=True, text=True)
    subprocess.run(["git", "config", "user.email", "test@example.com"], cwd=repo, check=True)
    subprocess.run(["git", "config", "user.name", "Test User"], cwd=repo, check=True)
    (repo / "README.md").write_text("before\n", encoding="utf-8")
    subprocess.run(["git", "add", "README.md"], cwd=repo, check=True)
    subprocess.run(["git", "commit", "-m", "base"], cwd=repo, check=True, capture_output=True, text=True)
    base_revision = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=repo, text=True).strip()
    (repo / "README.md").write_text("after\n", encoding="utf-8")
    subprocess.run(["git", "add", "README.md"], cwd=repo, check=True)
    patch = subprocess.check_output(["git", "diff", "--binary", "--cached"], cwd=repo, text=True)
    expected_tree = subprocess.check_output(["git", "write-tree"], cwd=repo, text=True).strip()
    subprocess.run(["git", "reset", "--hard", "HEAD"], cwd=repo, check=True, capture_output=True, text=True)
    patch_path = tmp_path / "patch.diff"
    patch_path.write_text(patch, encoding="utf-8")
    store = ConductorPipelineStore(tmp_path / "store")
    store.apply_runtime_config(RuntimeConfigEnvelope("group-1", 1, _policy(1)))
    store.commit_plan(_proposal())
    manifest = TaskOutputManifest(
        node_id="a",
        verify_attempt_id="verify-1",
        gate_snapshot_hash=store.get_node("a").gate_snapshot_hash or "",
        score=3,
        code={
            "base_revision": base_revision,
            "patch_uri": f"file://{patch_path}",
            "patch_hash": "sha256:" + hashlib.sha256(patch.encode("utf-8")).hexdigest(),
            "expected_result_tree": expected_tree,
        },
    )
    store.publish_task_output_manifest(manifest)
    store.enqueue_integration(manifest)

    committed_revision = store._integrate_manifest_patch(repo, "verify-1")
    assert store.list_integration_queue()[0]["status"] == "queued"

    processed = store.process_queued_integrations(repo)

    queue = store.list_integration_queue()[0]
    updated_manifest = store.list_task_output_manifests()[0]
    assert processed == 1
    assert queue["status"] == "integrated"
    assert queue["integrated_revision"] == committed_revision
    assert updated_manifest.code["integrated_revision"] == committed_revision
    assert (repo / "README.md").read_text(encoding="utf-8") == "after\n"


def test_process_queued_integration_rejects_patch_hash_mismatch(tmp_path: Path) -> None:
    repo = tmp_path / "repo"
    repo.mkdir()
    subprocess.run(["git", "init"], cwd=repo, check=True, capture_output=True, text=True)
    subprocess.run(["git", "config", "user.email", "test@example.com"], cwd=repo, check=True)
    subprocess.run(["git", "config", "user.name", "Test User"], cwd=repo, check=True)
    (repo / "README.md").write_text("before\n", encoding="utf-8")
    subprocess.run(["git", "add", "README.md"], cwd=repo, check=True)
    subprocess.run(["git", "commit", "-m", "base"], cwd=repo, check=True, capture_output=True, text=True)
    base_revision = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=repo, text=True).strip()
    (repo / "README.md").write_text("after\n", encoding="utf-8")
    subprocess.run(["git", "add", "README.md"], cwd=repo, check=True)
    patch = subprocess.check_output(["git", "diff", "--binary", "--cached"], cwd=repo, text=True)
    expected_tree = subprocess.check_output(["git", "write-tree"], cwd=repo, text=True).strip()
    subprocess.run(["git", "reset", "--hard", "HEAD"], cwd=repo, check=True, capture_output=True, text=True)
    patch_path = tmp_path / "patch.diff"
    patch_path.write_text(patch, encoding="utf-8")
    store = ConductorPipelineStore(tmp_path / "store")
    store.apply_runtime_config(RuntimeConfigEnvelope("group-1", 1, _policy(1)))
    store.commit_plan(_proposal())
    manifest = TaskOutputManifest(
        node_id="a",
        verify_attempt_id="verify-1",
        gate_snapshot_hash=store.get_node("a").gate_snapshot_hash or "",
        score=3,
        code={
            "base_revision": base_revision,
            "patch_uri": f"file://{patch_path}",
            "patch_hash": "sha256:wrong",
            "expected_result_tree": expected_tree,
        },
    )
    store.publish_task_output_manifest(manifest)
    store.enqueue_integration(manifest)

    class Instance:
        log_path = str(tmp_path / "inst-1" / "logs" / "performer.log")

    processed = store.process_queued_integrations(repo, instance=Instance())

    completed = store.list_integration_queue()[0]
    assert processed == 1
    assert completed["status"] == "conflict"
    assert completed["error"] == "patch_hash_mismatch"
    assert (repo / "README.md").read_text(encoding="utf-8") == "before\n"
    log_text = Path(Instance.log_path).read_text(encoding="utf-8")
    assert "event=pipeline_integration_conflicted" in log_text
    assert "node_id=a" in log_text
    assert "attempt_id=verify-1" in log_text
    assert "mode=verify" in log_text
    assert "graph_revision=1" in log_text
    assert "policy_revision=1" in log_text
    assert "integration_id=integration-a-verify-1" in log_text
    assert "error_type=ValueError" in log_text
    assert "sanitized_reason=patch_hash_mismatch" in log_text
    assert "action_required=LINEAR_SYNC_CONFLICT" in log_text


def test_process_queued_integration_rolls_back_repository_on_tree_mismatch(tmp_path: Path) -> None:
    repo = tmp_path / "repo"
    repo.mkdir()
    subprocess.run(["git", "init"], cwd=repo, check=True, capture_output=True, text=True)
    subprocess.run(["git", "config", "user.email", "test@example.com"], cwd=repo, check=True)
    subprocess.run(["git", "config", "user.name", "Test User"], cwd=repo, check=True)
    (repo / "README.md").write_text("before\n", encoding="utf-8")
    subprocess.run(["git", "add", "README.md"], cwd=repo, check=True)
    subprocess.run(["git", "commit", "-m", "base"], cwd=repo, check=True, capture_output=True, text=True)
    base_revision = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=repo, text=True).strip()
    (repo / "README.md").write_text("after\n", encoding="utf-8")
    subprocess.run(["git", "add", "README.md"], cwd=repo, check=True)
    patch = subprocess.check_output(["git", "diff", "--binary", "--cached"], cwd=repo, text=True)
    subprocess.run(["git", "reset", "--hard", "HEAD"], cwd=repo, check=True, capture_output=True, text=True)
    patch_path = tmp_path / "patch.diff"
    patch_path.write_text(patch, encoding="utf-8")
    store = ConductorPipelineStore(tmp_path / "store")
    store.apply_runtime_config(RuntimeConfigEnvelope("group-1", 1, _policy(1)))
    store.commit_plan(_proposal())
    manifest = TaskOutputManifest(
        node_id="a",
        verify_attempt_id="verify-1",
        gate_snapshot_hash=store.get_node("a").gate_snapshot_hash or "",
        score=3,
        code={
            "base_revision": base_revision,
            "patch_uri": f"file://{patch_path}",
            "patch_hash": "sha256:" + hashlib.sha256(patch.encode("utf-8")).hexdigest(),
            "expected_result_tree": "not-the-result-tree",
        },
    )
    store.publish_task_output_manifest(manifest)
    store.enqueue_integration(manifest)

    processed = store.process_queued_integrations(repo)

    completed = store.list_integration_queue()[0]
    assert processed == 1
    assert completed["status"] == "conflict"
    assert completed["error"] == "integrated tree mismatch"
    assert subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=repo, text=True).strip() == base_revision
    assert subprocess.check_output(["git", "status", "--short"], cwd=repo, text=True) == ""
    assert (repo / "README.md").read_text(encoding="utf-8") == "before\n"


async def test_background_coordination_processes_queued_pipeline_integrations(tmp_path: Path) -> None:
    repo = tmp_path / "repo"
    repo.mkdir()
    subprocess.run(["git", "init"], cwd=repo, check=True, capture_output=True, text=True)
    subprocess.run(["git", "config", "user.email", "test@example.com"], cwd=repo, check=True)
    subprocess.run(["git", "config", "user.name", "Test User"], cwd=repo, check=True)
    (repo / "README.md").write_text("before\n", encoding="utf-8")
    subprocess.run(["git", "add", "README.md"], cwd=repo, check=True)
    subprocess.run(["git", "commit", "-m", "base"], cwd=repo, check=True, capture_output=True, text=True)
    base_revision = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=repo, text=True).strip()
    (repo / "README.md").write_text("after\n", encoding="utf-8")
    subprocess.run(["git", "add", "README.md"], cwd=repo, check=True)
    patch = subprocess.check_output(["git", "diff", "--binary", "--cached"], cwd=repo, text=True)
    expected_tree = subprocess.check_output(["git", "write-tree"], cwd=repo, text=True).strip()
    subprocess.run(["git", "reset", "--hard", "HEAD"], cwd=repo, check=True, capture_output=True, text=True)
    patch_path = tmp_path / "patch.diff"
    patch_path.write_text(patch, encoding="utf-8")
    patch_hash = "sha256:" + hashlib.sha256(patch.encode("utf-8")).hexdigest()
    data_root = tmp_path / "conductor-data"
    store = ConductorStore(data_root)
    instance_dir = data_root / "instances" / "inst-1"
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
                policy_id="policy-integrations-only",
                version=1,
                effective_at="2026-07-06T00:00:00Z",
                capacity=SchedulerCapacity(global_limit=0),
            ),
        )
    )
    service.pipeline_store.commit_plan(_proposal())
    manifest = TaskOutputManifest(
        node_id="a",
        verify_attempt_id="verify-1",
        gate_snapshot_hash=service.pipeline_store.get_node("a").gate_snapshot_hash or "",
        score=3,
        code={
            "base_revision": base_revision,
            "patch_uri": f"file://{patch_path}",
            "patch_hash": patch_hash,
            "expected_result_tree": expected_tree,
        },
    )
    service.pipeline_store.publish_task_output_manifest(manifest)
    service.pipeline_store.enqueue_integration(manifest)

    result = await service.coordinate_background_once()

    queue = service.pipeline_store.list_integration_queue()
    assert result["pipeline_integrations_processed"] == 1
    assert queue[0]["status"] == "integrated"
    assert (repo / "README.md").read_text(encoding="utf-8") == "after\n"


async def test_background_coordination_reclaims_expired_pipeline_leases(tmp_path: Path) -> None:
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
    now = datetime(2026, 7, 6, tzinfo=timezone.utc)
    service.pipeline_store.start_attempt(RuntimeMode.EXECUTE, node_id="a", attempt_id="exec-expired", now=now, ttl_seconds=1)

    result = await service.coordinate_background_once()

    assert result["pipeline_leases_reclaimed"] == 1
    assert service.pipeline_store.active_lease("a", RuntimeMode.EXECUTE) is None


