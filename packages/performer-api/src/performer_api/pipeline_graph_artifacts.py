from __future__ import annotations

from dataclasses import asdict, dataclass, field
from datetime import datetime, timedelta
from typing import Any
from uuid import uuid4

from .pipeline_enums import PASS_THRESHOLD, RuntimeMode
from .pipeline_utils import (
    _dict,
    _format_time,
    _int,
    _jsonable_dict,
    _mode,
    _optional_str,
    _parse_time,
    _str_list,
    _utc,
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
