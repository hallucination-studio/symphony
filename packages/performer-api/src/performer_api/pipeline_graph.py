from __future__ import annotations

import hashlib
import json
from dataclasses import asdict, dataclass, field
from datetime import datetime, timedelta
from typing import Any
from uuid import uuid4

from .pipeline_enums import (
    AttemptState,
    GateStep,
    GraphNodeState,
    HumanEscalationReason,
    PASS_THRESHOLD,
    RuntimeMode,
)
from .pipeline_utils import (
    _dict,
    _format_time,
    _gate_steps,
    _int,
    _jsonable_dict,
    _mode,
    _optional_int,
    _optional_str,
    _parse_time,
    _str_list,
    _utc,
)


@dataclass(frozen=True)
class GraphNode:
    node_id: str
    title: str
    state: GraphNodeState
    issue_id: str | None = None
    issue_identifier: str | None = None
    parent_node_id: str | None = None
    gate_snapshot_hash: str | None = None
    verify_score: int | None = None
    rework_count: int = 0
    replan_depth: int = 0
    superseded_by: list[str] = field(default_factory=list)
    human_reason: HumanEscalationReason | None = None

    def to_dict(self) -> dict[str, Any]:
        return {
            "node_id": self.node_id,
            "title": self.title,
            "state": self.state.value,
            "issue_id": self.issue_id,
            "issue_identifier": self.issue_identifier,
            "parent_node_id": self.parent_node_id,
            "gate_snapshot_hash": self.gate_snapshot_hash,
            "verify_score": self.verify_score,
            "rework_count": self.rework_count,
            "replan_depth": self.replan_depth,
            "superseded_by": list(self.superseded_by),
            "human_reason": self.human_reason.value if self.human_reason is not None else None,
        }

    @classmethod
    def from_dict(cls, payload: dict[str, Any]) -> GraphNode:
        reason = payload.get("human_reason")
        return cls(
            node_id=str(payload.get("node_id") or ""),
            title=str(payload.get("title") or ""),
            state=GraphNodeState.from_value(payload.get("state") or GraphNodeState.PLANNED.value),
            issue_id=_optional_str(payload.get("issue_id")),
            issue_identifier=_optional_str(payload.get("issue_identifier")),
            parent_node_id=_optional_str(payload.get("parent_node_id")),
            gate_snapshot_hash=_optional_str(payload.get("gate_snapshot_hash")),
            verify_score=_optional_int(payload.get("verify_score")),
            rework_count=_int(payload.get("rework_count"), default=0),
            replan_depth=_int(payload.get("replan_depth"), default=0),
            superseded_by=_str_list(payload.get("superseded_by")),
            human_reason=HumanEscalationReason(str(reason)) if reason else None,
        )


@dataclass(frozen=True)
class GateSpecContent:
    acceptance_criteria: list[str]
    verification_procedure: list[GateStep | str | dict[str, Any]]
    rubric: dict[str, str]
    pass_threshold: int = PASS_THRESHOLD
    verifier_credentials: list[str] = field(default_factory=list)

    def __post_init__(self) -> None:
        if self.pass_threshold != PASS_THRESHOLD:
            raise ValueError(f"pass_threshold must be {PASS_THRESHOLD}")
        object.__setattr__(
            self,
            "verification_procedure",
            [GateStep.from_obj(step) for step in self.verification_procedure if step is not None],
        )

    def to_dict(self) -> dict[str, Any]:
        return {
            "acceptance_criteria": list(self.acceptance_criteria),
            "verification_procedure": [step.to_dict() for step in self.verification_procedure],
            "rubric": dict(sorted(self.rubric.items())),
            "pass_threshold": self.pass_threshold,
            "verifier_credentials": list(self.verifier_credentials),
        }

    @classmethod
    def from_dict(cls, payload: dict[str, Any]) -> GateSpecContent:
        return cls(
            acceptance_criteria=_str_list(payload.get("acceptance_criteria")),
            verification_procedure=_gate_steps(payload.get("verification_procedure")),
            rubric={str(key): str(value) for key, value in _dict(payload.get("rubric")).items()},
            pass_threshold=_int(payload.get("pass_threshold"), default=PASS_THRESHOLD),
            verifier_credentials=_str_list(payload.get("verifier_credentials")),
        )


@dataclass(frozen=True)
class GateSpecSnapshot:
    gate_id: str
    task_id: str
    version: int
    created_by: str
    created_at: str
    content: GateSpecContent
    hash: str
    frozen: bool = True

    @classmethod
    def create(
        cls,
        *,
        gate_id: str,
        task_id: str,
        created_by: str,
        created_at: str,
        content: GateSpecContent,
        version: int = 1,
    ) -> GateSpecSnapshot:
        return cls(
            gate_id=gate_id,
            task_id=task_id,
            version=version,
            created_by=created_by,
            created_at=created_at,
            content=content,
            hash=canonical_gate_hash(content),
            frozen=True,
        )

    def to_dict(self) -> dict[str, Any]:
        return {
            "gate_id": self.gate_id,
            "task_id": self.task_id,
            "version": self.version,
            "created_by": self.created_by,
            "created_at": self.created_at,
            "content": self.content.to_dict(),
            "hash": self.hash,
            "frozen": self.frozen,
        }

    @classmethod
    def from_dict(cls, payload: dict[str, Any]) -> GateSpecSnapshot:
        content = GateSpecContent.from_dict(_dict(payload.get("content")))
        gate_hash = str(payload.get("hash") or canonical_gate_hash(content))
        expected = canonical_gate_hash(content)
        if gate_hash != expected:
            raise ValueError("gate hash does not match canonical content")
        return cls(
            gate_id=str(payload.get("gate_id") or ""),
            task_id=str(payload.get("task_id") or ""),
            version=_int(payload.get("version"), default=1),
            created_by=str(payload.get("created_by") or ""),
            created_at=str(payload.get("created_at") or ""),
            content=content,
            hash=gate_hash,
            frozen=bool(payload.get("frozen", True)),
        )


@dataclass(frozen=True)
class AttemptRecord:
    attempt_id: str
    node_id: str
    mode: RuntimeMode
    state: AttemptState
    graph_revision: int = 0
    policy_revision: int = 0
    lease_id: str = ""
    fencing_token: str = ""
    gate_snapshot_hash: str | None = None
    score: int | None = None
    started_at: str | None = None
    completed_at: str | None = None
    result_uri: str | None = None
    error: str | None = None
    process_pid: int | None = None
    thread_id: str | None = None
    kind: str | None = None

    def to_dict(self) -> dict[str, Any]:
        return {
            "attempt_id": self.attempt_id,
            "node_id": self.node_id,
            "mode": self.mode.value,
            "state": self.state.value,
            "graph_revision": self.graph_revision,
            "policy_revision": self.policy_revision,
            "lease_id": self.lease_id,
            "fencing_token": self.fencing_token,
            "gate_snapshot_hash": self.gate_snapshot_hash,
            "score": self.score,
            "started_at": self.started_at,
            "completed_at": self.completed_at,
            "result_uri": self.result_uri,
            "error": self.error,
            "process_pid": self.process_pid,
            "thread_id": self.thread_id,
            "kind": self.kind,
        }

    @classmethod
    def from_dict(cls, payload: dict[str, Any]) -> AttemptRecord:
        return cls(
            attempt_id=str(payload.get("attempt_id") or ""),
            node_id=str(payload.get("node_id") or ""),
            mode=_mode(payload.get("mode")),
            state=AttemptState(str(payload.get("state") or AttemptState.PENDING.value)),
            graph_revision=_int(payload.get("graph_revision"), default=0),
            policy_revision=_int(payload.get("policy_revision"), default=0),
            lease_id=str(payload.get("lease_id") or ""),
            fencing_token=str(payload.get("fencing_token") or ""),
            gate_snapshot_hash=_optional_str(payload.get("gate_snapshot_hash")),
            score=_optional_int(payload.get("score")),
            started_at=_optional_str(payload.get("started_at")),
            completed_at=_optional_str(payload.get("completed_at")),
            result_uri=_optional_str(payload.get("result_uri")),
            error=_optional_str(payload.get("error")),
            process_pid=_optional_int(payload.get("process_pid")),
            thread_id=_optional_str(payload.get("thread_id")),
            kind=_optional_str(payload.get("kind")),
        )


@dataclass(frozen=True)
class AttemptSummary:
    attempt_id: str
    node_id: str
    mode: RuntimeMode
    status: AttemptState
    graph_revision: int
    policy_revision: int
    gate_snapshot_hash: str | None = None
    score: int | None = None
    result_uri: str | None = None
    error: str | None = None

    def to_dict(self) -> dict[str, Any]:
        return {
            "attempt_id": self.attempt_id,
            "node_id": self.node_id,
            "mode": self.mode.value,
            "status": self.status.value,
            "graph_revision": self.graph_revision,
            "policy_revision": self.policy_revision,
            "gate_snapshot_hash": self.gate_snapshot_hash,
            "score": self.score,
            "result_uri": self.result_uri,
            "error": self.error,
        }

    @classmethod
    def from_dict(cls, payload: dict[str, Any]) -> AttemptSummary:
        return cls(
            attempt_id=str(payload.get("attempt_id") or ""),
            node_id=str(payload.get("node_id") or ""),
            mode=_mode(payload.get("mode")),
            status=AttemptState(str(payload.get("status") or payload.get("state") or AttemptState.PENDING.value)),
            graph_revision=_int(payload.get("graph_revision"), default=0),
            policy_revision=_int(payload.get("policy_revision"), default=0),
            gate_snapshot_hash=_optional_str(payload.get("gate_snapshot_hash")),
            score=_optional_int(payload.get("score")),
            result_uri=_optional_str(payload.get("result_uri")),
            error=_optional_str(payload.get("error")),
        )


@dataclass(frozen=True)
class FencedAttemptResult:
    attempt_id: str
    node_id: str
    status: AttemptState
    graph_revision: int
    policy_revision: int
    gate_snapshot_hash: str
    lease_id: str
    fencing_token: str
    error: str | None = None
    thread_id: str | None = None
    kind: str | None = None

    mode: RuntimeMode = RuntimeMode.EXECUTE

    def _base_dict(self) -> dict[str, Any]:
        return {
            "attempt_id": self.attempt_id,
            "node_id": self.node_id,
            "mode": self.mode.value,
            "status": self.status.value,
            "graph_revision": self.graph_revision,
            "policy_revision": self.policy_revision,
            "gate_snapshot_hash": self.gate_snapshot_hash,
            "lease_id": self.lease_id,
            "fencing_token": self.fencing_token,
            "error": self.error,
            "thread_id": self.thread_id,
            "kind": self.kind,
        }

@dataclass(frozen=True)
class ExecuteAttemptRequest:
    attempt_id: str
    node_id: str
    graph_revision: int
    policy_revision: int
    gate_snapshot: GateSpecSnapshot
    lease_id: str
    fencing_token: str
    task_title: str = ""
    issue_identifier: str | None = None
    issue_description: str = ""
    base_revision: str = ""
    repository: dict[str, Any] = field(default_factory=dict)
    artifact_paths: dict[str, Any] = field(default_factory=dict)
    upstream_manifests: list[dict[str, Any]] = field(default_factory=list)
    reason: str | None = None
    expected_thread_id: str | None = None
    thread_state_workspace_path: str | None = None
    kind: str | None = None

    def to_dict(self) -> dict[str, Any]:
        return {
            "attempt_id": self.attempt_id,
            "node_id": self.node_id,
            "graph_revision": self.graph_revision,
            "policy_revision": self.policy_revision,
            "gate_snapshot": self.gate_snapshot.to_dict(),
            "gate_snapshot_hash": self.gate_snapshot.hash,
            "lease_id": self.lease_id,
            "fencing_token": self.fencing_token,
            "task_title": self.task_title,
            "issue_identifier": self.issue_identifier,
            "issue_description": self.issue_description,
            "base_revision": self.base_revision,
            "repository": _jsonable_dict(self.repository),
            "artifact_paths": _jsonable_dict(self.artifact_paths),
            "upstream_manifests": [_jsonable_dict(manifest) for manifest in self.upstream_manifests],
            "reason": self.reason,
            "expected_thread_id": self.expected_thread_id,
            "thread_state_workspace_path": self.thread_state_workspace_path,
            "kind": self.kind,
        }

    @classmethod
    def from_dict(cls, payload: dict[str, Any]) -> ExecuteAttemptRequest:
        gate_payload = payload.get("gate_snapshot")
        if not isinstance(gate_payload, dict):
            raise ValueError("execute attempt request requires gate_snapshot")
        return cls(
            attempt_id=str(payload.get("attempt_id") or ""),
            node_id=str(payload.get("node_id") or ""),
            graph_revision=_int(payload.get("graph_revision"), default=0),
            policy_revision=_int(payload.get("policy_revision"), default=0),
            gate_snapshot=GateSpecSnapshot.from_dict(gate_payload),
            lease_id=str(payload.get("lease_id") or ""),
            fencing_token=str(payload.get("fencing_token") or ""),
            task_title=str(payload.get("task_title") or ""),
            issue_identifier=_optional_str(payload.get("issue_identifier")),
            issue_description=str(payload.get("issue_description") or ""),
            base_revision=str(payload.get("base_revision") or ""),
            repository=_dict(payload.get("repository")),
            artifact_paths=_dict(payload.get("artifact_paths")),
            upstream_manifests=[_dict(item) for item in payload.get("upstream_manifests") or [] if isinstance(item, dict)],
            reason=_optional_str(payload.get("reason")),
            expected_thread_id=_optional_str(payload.get("expected_thread_id")),
            thread_state_workspace_path=_optional_str(payload.get("thread_state_workspace_path")),
            kind=_optional_str(payload.get("kind")),
        )


@dataclass(frozen=True)
class ExecuteAttemptResult(FencedAttemptResult):
    verification_input: dict[str, Any] | None = None
    mode: RuntimeMode = RuntimeMode.EXECUTE

    def to_dict(self) -> dict[str, Any]:
        payload = self._base_dict()
        payload["verification_input"] = _jsonable_dict(self.verification_input or {})
        return payload

    @classmethod
    def from_dict(cls, payload: dict[str, Any]) -> ExecuteAttemptResult:
        return cls(
            attempt_id=str(payload.get("attempt_id") or ""),
            node_id=str(payload.get("node_id") or ""),
            status=AttemptState(str(payload.get("status") or AttemptState.PENDING.value)),
            graph_revision=_int(payload.get("graph_revision"), default=0),
            policy_revision=_int(payload.get("policy_revision"), default=0),
            gate_snapshot_hash=str(payload.get("gate_snapshot_hash") or ""),
            lease_id=str(payload.get("lease_id") or ""),
            fencing_token=str(payload.get("fencing_token") or ""),
            error=_optional_str(payload.get("error")),
            thread_id=_optional_str(payload.get("thread_id")),
            kind=_optional_str(payload.get("kind")),
            verification_input=_dict(payload.get("verification_input")),
        )


@dataclass(frozen=True)
class VerifyAttemptRequest:
    attempt_id: str
    node_id: str
    execute_attempt_id: str
    graph_revision: int
    policy_revision: int
    gate_snapshot: GateSpecSnapshot
    lease_id: str
    fencing_token: str
    verification_input: dict[str, Any]
    artifact_paths: dict[str, Any] = field(default_factory=dict)
    reason: str | None = None
    kind: str | None = None

    def to_dict(self) -> dict[str, Any]:
        return {
            "attempt_id": self.attempt_id,
            "node_id": self.node_id,
            "execute_attempt_id": self.execute_attempt_id,
            "graph_revision": self.graph_revision,
            "policy_revision": self.policy_revision,
            "gate_snapshot": self.gate_snapshot.to_dict(),
            "gate_snapshot_hash": self.gate_snapshot.hash,
            "lease_id": self.lease_id,
            "fencing_token": self.fencing_token,
            "verification_input": _jsonable_dict(self.verification_input),
            "artifact_paths": _jsonable_dict(self.artifact_paths),
            "reason": self.reason,
            "kind": self.kind,
        }

    @classmethod
    def from_dict(cls, payload: dict[str, Any]) -> VerifyAttemptRequest:
        gate_payload = payload.get("gate_snapshot")
        if not isinstance(gate_payload, dict):
            raise ValueError("verify attempt request requires gate_snapshot")
        return cls(
            attempt_id=str(payload.get("attempt_id") or ""),
            node_id=str(payload.get("node_id") or ""),
            execute_attempt_id=str(payload.get("execute_attempt_id") or ""),
            graph_revision=_int(payload.get("graph_revision"), default=0),
            policy_revision=_int(payload.get("policy_revision"), default=0),
            gate_snapshot=GateSpecSnapshot.from_dict(gate_payload),
            lease_id=str(payload.get("lease_id") or ""),
            fencing_token=str(payload.get("fencing_token") or ""),
            verification_input=_dict(payload.get("verification_input")),
            artifact_paths=_dict(payload.get("artifact_paths")),
            reason=_optional_str(payload.get("reason")),
            kind=_optional_str(payload.get("kind")),
        )


@dataclass(frozen=True)
class VerifyAttemptResult(FencedAttemptResult):
    score: int = 0
    passed: bool = False
    execute_attempt_id: str = ""
    mode: RuntimeMode = RuntimeMode.VERIFY

    def to_dict(self) -> dict[str, Any]:
        payload = self._base_dict()
        payload.update({"score": self.score, "passed": self.passed, "execute_attempt_id": self.execute_attempt_id})
        return payload

    @classmethod
    def from_dict(cls, payload: dict[str, Any]) -> VerifyAttemptResult:
        return cls(
            attempt_id=str(payload.get("attempt_id") or ""),
            node_id=str(payload.get("node_id") or ""),
            status=AttemptState(str(payload.get("status") or AttemptState.PENDING.value)),
            graph_revision=_int(payload.get("graph_revision"), default=0),
            policy_revision=_int(payload.get("policy_revision"), default=0),
            gate_snapshot_hash=str(payload.get("gate_snapshot_hash") or ""),
            lease_id=str(payload.get("lease_id") or ""),
            fencing_token=str(payload.get("fencing_token") or ""),
            error=_optional_str(payload.get("error")),
            thread_id=_optional_str(payload.get("thread_id")),
            kind=_optional_str(payload.get("kind")),
            score=_int(payload.get("score"), default=0),
            passed=bool(payload.get("passed")),
            execute_attempt_id=str(payload.get("execute_attempt_id") or ""),
        )


@dataclass(frozen=True)
class VerificationInputSnapshot:
    task_id: str
    execute_attempt_id: str
    base_revision: str
    artifact_uris: list[dict[str, Any]]
    declared_commands: list[str]
    evidence_uri: str
    gate_snapshot_hash: str
    repository_path: str = ""
    workspace_path: str = ""
    branch_name: str = ""
    commit_sha: str = ""
    no_changes: bool = False
    patch_uri: str = ""
    patch_hash: str = ""
    expected_result_tree: str = ""
    result_revision: str | None = None

    def to_dict(self) -> dict[str, Any]:
        payload = asdict(self)
        for key in ("patch_uri", "patch_hash", "expected_result_tree", "result_revision"):
            if not payload.get(key):
                payload.pop(key, None)
        if not payload.get("no_changes"):
            payload.pop("no_changes", None)
        return payload

    @classmethod
    def from_dict(cls, payload: dict[str, Any]) -> VerificationInputSnapshot:
        return cls(
            task_id=str(payload.get("task_id") or ""),
            execute_attempt_id=str(payload.get("execute_attempt_id") or ""),
            base_revision=str(payload.get("base_revision") or ""),
            artifact_uris=[_dict(item) for item in payload.get("artifact_uris") or [] if isinstance(item, dict)],
            declared_commands=_str_list(payload.get("declared_commands")),
            evidence_uri=str(payload.get("evidence_uri") or ""),
            gate_snapshot_hash=str(payload.get("gate_snapshot_hash") or ""),
            repository_path=str(payload.get("repository_path") or ""),
            workspace_path=str(payload.get("workspace_path") or ""),
            branch_name=str(payload.get("branch_name") or ""),
            commit_sha=str(payload.get("commit_sha") or payload.get("result_revision") or ""),
            no_changes=bool(payload.get("no_changes", False)),
            patch_uri=str(payload.get("patch_uri") or ""),
            patch_hash=str(payload.get("patch_hash") or ""),
            expected_result_tree=str(payload.get("expected_result_tree") or ""),
            result_revision=_optional_str(payload.get("result_revision")),
        )


@dataclass(frozen=True)
class TaskOutputManifest:
    node_id: str
    verify_attempt_id: str
    gate_snapshot_hash: str
    score: int
    code: dict[str, Any]
    artifacts: list[dict[str, Any]] = field(default_factory=list)

    def __post_init__(self) -> None:
        if self.score < PASS_THRESHOLD:
            raise ValueError(f"task output manifests require score >= {PASS_THRESHOLD}")

    def to_dict(self) -> dict[str, Any]:
        return {
            "node_id": self.node_id,
            "verify_attempt_id": self.verify_attempt_id,
            "gate_snapshot_hash": self.gate_snapshot_hash,
            "score": self.score,
            "code": _jsonable_dict(self.code),
            "artifacts": [_jsonable_dict(artifact) for artifact in self.artifacts],
        }

    @classmethod
    def from_dict(cls, payload: dict[str, Any]) -> TaskOutputManifest:
        return cls(
            node_id=str(payload.get("node_id") or ""),
            verify_attempt_id=str(payload.get("verify_attempt_id") or ""),
            gate_snapshot_hash=str(payload.get("gate_snapshot_hash") or ""),
            score=_int(payload.get("score"), default=0),
            code=_dict(payload.get("code")),
            artifacts=[_dict(item) for item in payload.get("artifacts") or [] if isinstance(item, dict)],
        )

@dataclass(frozen=True)
class WorkerLease:
    lease_id: str
    fencing_token: str
    mode: RuntimeMode
    node_id: str
    attempt_id: str
    acquired_at: str
    heartbeat_at: str
    expires_at: str

    @classmethod
    def create(
        cls,
        *,
        lease_id: str,
        mode: RuntimeMode,
        node_id: str,
        attempt_id: str,
        acquired_at: datetime,
        ttl_seconds: int,
    ) -> WorkerLease:
        acquired = _utc(acquired_at)
        expires = acquired + timedelta(seconds=ttl_seconds)
        return cls(
            lease_id=lease_id,
            fencing_token=uuid4().hex,
            mode=mode,
            node_id=node_id,
            attempt_id=attempt_id,
            acquired_at=_format_time(acquired),
            heartbeat_at=_format_time(acquired),
            expires_at=_format_time(expires),
        )

    def is_active(self, at: datetime, *, fencing_token: str) -> bool:
        return self.fencing_token == fencing_token and _utc(at) <= _parse_time(self.expires_at)

    def to_dict(self) -> dict[str, Any]:
        return {
            "lease_id": self.lease_id,
            "fencing_token": self.fencing_token,
            "mode": self.mode.value,
            "node_id": self.node_id,
            "attempt_id": self.attempt_id,
            "acquired_at": self.acquired_at,
            "heartbeat_at": self.heartbeat_at,
            "expires_at": self.expires_at,
        }

    @classmethod
    def from_dict(cls, payload: dict[str, Any]) -> WorkerLease:
        return cls(
            lease_id=str(payload.get("lease_id") or ""),
            fencing_token=str(payload.get("fencing_token") or ""),
            mode=_mode(payload.get("mode")),
            node_id=str(payload.get("node_id") or ""),
            attempt_id=str(payload.get("attempt_id") or ""),
            acquired_at=str(payload.get("acquired_at") or ""),
            heartbeat_at=str(payload.get("heartbeat_at") or ""),
            expires_at=str(payload.get("expires_at") or ""),
        )

def canonical_gate_hash(content: GateSpecContent | dict[str, Any]) -> str:
    payload = content.to_dict() if isinstance(content, GateSpecContent) else _jsonable_dict(content)
    encoded = json.dumps(payload, sort_keys=True, separators=(",", ":")).encode("utf-8")
    return "sha256:" + hashlib.sha256(encoded).hexdigest()
