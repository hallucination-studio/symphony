from __future__ import annotations

from .conductor_pipeline_store_common import *


class IntegrationApplyMixin:
    def _integrate_manifest_patch(self, repository_path: Path, verify_attempt_id: str) -> str:
        manifest = self._task_output_manifest_for_verify_attempt(verify_attempt_id)
        if manifest is None:
            raise ValueError("task output manifest not found")
        code = manifest.code
        base_revision = str(code.get("base_revision") or "").strip()
        patch_uri = str(code.get("patch_uri") or "").strip()
        expected_tree = str(code.get("expected_result_tree") or "").strip()
        patch_hash = str(code.get("patch_hash") or "").strip()
        commit_sha = str(code.get("commit_sha") or code.get("result_revision") or "").strip()
        workspace_path = str(code.get("workspace_path") or "").strip()
        if commit_sha and workspace_path:
            return self._integrate_manifest_commit(
                repository_path,
                manifest=manifest,
                commit_sha=commit_sha,
                workspace_path=Path(workspace_path),
            )
        if not base_revision or not patch_uri.startswith("file://") or not expected_tree:
            raise ValueError("manifest lacks integration inputs")
        patch_path = Path(patch_uri.removeprefix("file://"))
        if not patch_path.is_file():
            raise ValueError("integration patch unavailable")
        if patch_hash.startswith("sha256:"):
            actual_patch_hash = "sha256:" + hashlib.sha256(patch_path.read_bytes()).hexdigest()
            if actual_patch_hash != patch_hash:
                raise ValueError("patch_hash_mismatch")
        original_revision = _git(["rev-parse", "HEAD"], cwd=repository_path).strip()
        integration_base = self.current_integrated_revision(repository_path) or original_revision
        try:
            self._verify_manifest_patch_against_base(
                repository_path,
                base_revision=base_revision,
                patch_path=patch_path,
                expected_tree=expected_tree,
                verify_attempt_id=verify_attempt_id,
            )
            _git(["checkout", "--quiet", integration_base], cwd=repository_path)
            try:
                _git(["apply", "--check", str(patch_path)], cwd=repository_path)
            except Exception as apply_exc:
                try:
                    _git(["apply", "--reverse", "--check", str(patch_path)], cwd=repository_path)
                except Exception:
                    raise apply_exc
                integrated_revision = _git(["rev-parse", "HEAD"], cwd=repository_path).strip()
                self._record_integrated_revision(repository_path, integrated_revision)
                return integrated_revision
            _git(["apply", "--index", str(patch_path)], cwd=repository_path)
            _git(["write-tree"], cwd=repository_path).strip()
            _git(["commit", "--quiet", "-m", f"Integrate pipeline node {manifest.node_id}"], cwd=repository_path)
            integrated_revision = _git(["rev-parse", "HEAD"], cwd=repository_path).strip()
            self._record_integrated_revision(repository_path, integrated_revision)
            return integrated_revision
        except Exception:
            _rollback_repository(repository_path, original_revision)
            raise

    def _integrate_manifest_commit(
        self,
        repository_path: Path,
        *,
        manifest: TaskOutputManifest,
        commit_sha: str,
        workspace_path: Path,
    ) -> str:
        if not workspace_path.exists():
            raise ValueError("integration workspace unavailable")
        original_revision = _git(["rev-parse", "HEAD"], cwd=repository_path).strip()
        integration_base = self.current_integrated_revision(repository_path) or original_revision
        fetch_ref = f"refs/symphony/integration/{_safe_path_part(manifest.verify_attempt_id)}"
        try:
            _git(["checkout", "--quiet", integration_base], cwd=repository_path)
            _git(["fetch", "--quiet", str(workspace_path), f"{commit_sha}:{fetch_ref}"], cwd=repository_path)
            try:
                _git(["merge", "--no-ff", "--no-edit", fetch_ref], cwd=repository_path)
            except subprocess.CalledProcessError as exc:
                output = str(exc.output or "")
                if "Already up to date" not in output:
                    raise
            integrated_revision = _git(["rev-parse", "HEAD"], cwd=repository_path).strip()
            self._record_integrated_revision(repository_path, integrated_revision)
            return integrated_revision
        except Exception:
            _rollback_repository(repository_path, original_revision)
            raise

    def _verify_manifest_patch_against_base(
        self,
        repository_path: Path,
        *,
        base_revision: str,
        patch_path: Path,
        expected_tree: str,
        verify_attempt_id: str,
    ) -> None:
        worktree_parent = self.artifact_root / "integration-worktrees"
        worktree_parent.mkdir(parents=True, exist_ok=True)
        worktree_path = Path(
            tempfile.mkdtemp(prefix=f"{_safe_path_part(verify_attempt_id)}-", dir=str(worktree_parent))
        )
        try:
            shutil.rmtree(worktree_path)
            _git(["worktree", "add", "--detach", "--quiet", str(worktree_path), base_revision], cwd=repository_path)
            _git(["apply", "--index", str(patch_path)], cwd=worktree_path)
            actual_tree = _git(["write-tree"], cwd=worktree_path).strip()
            if actual_tree != expected_tree:
                raise ValueError("integrated tree mismatch")
        finally:
            subprocess.run(
                ["git", "worktree", "remove", "--force", str(worktree_path)],
                cwd=repository_path,
                check=False,
                capture_output=True,
                text=True,
            )
            shutil.rmtree(worktree_path, ignore_errors=True)
            subprocess.run(
                ["git", "worktree", "prune"],
                cwd=repository_path,
                check=False,
                capture_output=True,
                text=True,
            )

    def _task_output_manifest_for_verify_attempt(self, verify_attempt_id: str) -> TaskOutputManifest | None:
        with self.connect() as connection:
            row = connection.execute(
                "SELECT payload_json FROM task_output_manifests WHERE verify_attempt_id = ?",
                (verify_attempt_id,),
            ).fetchone()
        return TaskOutputManifest.from_dict(_json_loads(row["payload_json"])) if row is not None else None

    def complete_integration(
        self,
        integration_id: str,
        *,
        status: str,
        integrated_revision: str | None = None,
        error: str | None = None,
    ) -> dict[str, Any]:
        with self.connect() as connection:
            connection.execute("BEGIN IMMEDIATE")
            row = connection.execute(
                "SELECT payload_json FROM integration_queue WHERE integration_id = ?",
                (integration_id,),
            ).fetchone()
            if row is None:
                raise KeyError(integration_id)
            payload = _json_loads(row["payload_json"])
            payload.update(
                {
                    "status": status,
                    "integrated_revision": integrated_revision,
                    "error": error,
                    "completed_at": _now(),
                }
            )
            connection.execute(
                """
                UPDATE integration_queue
                SET status = ?, payload_json = ?, completed_at = ?
                WHERE integration_id = ?
                """,
                (status, _json_dumps(payload), payload["completed_at"], integration_id),
            )
            if status == "integrated" and integrated_revision:
                manifest_row = connection.execute(
                    "SELECT payload_json FROM task_output_manifests WHERE verify_attempt_id = ?",
                    (payload["verify_attempt_id"],),
                ).fetchone()
                if manifest_row is not None:
                    manifest_payload = _json_loads(manifest_row["payload_json"])
                    code = manifest_payload.get("code") if isinstance(manifest_payload.get("code"), dict) else {}
                    code["integrated_revision"] = integrated_revision
                    manifest_payload["code"] = code
                    connection.execute(
                        "UPDATE task_output_manifests SET payload_json = ? WHERE verify_attempt_id = ?",
                        (_json_dumps(manifest_payload), payload["verify_attempt_id"]),
                    )
            elif status in {"conflict", "failed"}:
                reason = HumanEscalationReason.LINEAR_SYNC_CONFLICT
                self._create_human_wait_on_connection(
                    connection,
                    str(payload["node_id"]),
                    reason=reason,
                    details={
                        "integration_id": integration_id,
                        "verify_attempt_id": payload["verify_attempt_id"],
                        "status": status,
                        "error": error,
                    },
                )
        return payload

    def list_task_output_manifests(self) -> list[TaskOutputManifest]:
        with self.connect() as connection:
            rows = connection.execute(
                "SELECT payload_json FROM task_output_manifests ORDER BY verify_attempt_id",
            ).fetchall()
        return [TaskOutputManifest.from_dict(_json_loads(row["payload_json"])) for row in rows]

    def integrated_manifest_for_node(self, node_id: str) -> TaskOutputManifest | None:
        with self.connect() as connection:
            rows = connection.execute(
                """
                SELECT payload_json FROM task_output_manifests
                WHERE node_id = ?
                ORDER BY verify_attempt_id DESC
                """,
                (node_id,),
            ).fetchall()
        for row in rows:
            manifest = TaskOutputManifest.from_dict(_json_loads(row["payload_json"]))
            if str(manifest.code.get("integrated_revision") or "").strip():
                return manifest
        return None

    def verified_branch_manifest_for_node(self, node_id: str) -> TaskOutputManifest | None:
        with self.connect() as connection:
            rows = connection.execute(
                """
                SELECT payload_json FROM task_output_manifests
                WHERE node_id = ?
                ORDER BY verify_attempt_id DESC
                """,
                (node_id,),
            ).fetchall()
        for row in rows:
            manifest = TaskOutputManifest.from_dict(_json_loads(row["payload_json"]))
            branch_name = str(manifest.code.get("branch_name") or "").strip()
            commit_sha = str(manifest.code.get("commit_sha") or manifest.code.get("result_revision") or "").strip()
            if branch_name and commit_sha:
                return manifest
        return None

    def integration_terminal_for_node(self, node_id: str) -> bool:
        if self.integrated_manifest_for_node(node_id) is not None:
            return True
        with self.connect() as connection:
            rows = connection.execute(
                """
                SELECT payload_json FROM integration_queue
                WHERE node_id = ?
                ORDER BY completed_at DESC, integration_id DESC
                """,
                (node_id,),
            ).fetchall()
        for row in rows:
            payload = _json_loads(row["payload_json"])
            if (
                payload.get("status") == "resolved"
                and str(payload.get("human_resolution") or "").strip()
                and str(payload.get("completed_at") or "").strip()
            ):
                return True
        return False

    def integrated_manifests_for_blockers(self, node_id: str) -> list[TaskOutputManifest]:
        manifests: list[TaskOutputManifest] = []
        for blocker_id in self.blockers_for(node_id):
            manifest = self.verified_branch_manifest_for_node(blocker_id)
            if manifest is not None:
                manifests.append(manifest)
        return manifests
