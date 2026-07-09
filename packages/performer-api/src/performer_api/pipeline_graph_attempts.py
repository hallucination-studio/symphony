from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from .pipeline_enums import AttemptState, RuntimeMode
from .pipeline_graph_gates import GateSpecSnapshot
from .pipeline_utils import _dict, _int, _jsonable_dict, _mode, _optional_int, _optional_str


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
