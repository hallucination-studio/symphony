from __future__ import annotations

from dataclasses import dataclass
from typing import Any


RUNTIME_WAIT_KINDS = frozenset({"approval_requested", "permission_required", "tool_input_required"})


@dataclass(frozen=True)
class ManagedRunTurnContext:
    run_id: str
    work_item_id: str
    policy_revision: int
    plan_version: int
    lease_id: str
    fencing_token: str
    turn_id: str

    def to_dict(self) -> dict[str, Any]:
        return {
            "run_id": self.run_id,
            "work_item_id": self.work_item_id,
            "policy_revision": self.policy_revision,
            "plan_version": self.plan_version,
            "lease_id": self.lease_id,
            "fencing_token": self.fencing_token,
            "turn_id": self.turn_id,
        }

    @classmethod
    def from_dict(cls, payload: dict[str, Any]) -> ManagedRunTurnContext:
        return cls(
            run_id=str(payload.get("run_id") or ""),
            work_item_id=str(payload.get("work_item_id") or ""),
            policy_revision=_int(payload.get("policy_revision")),
            plan_version=_int(payload.get("plan_version")),
            lease_id=str(payload.get("lease_id") or ""),
            fencing_token=str(payload.get("fencing_token") or ""),
            turn_id=str(payload.get("turn_id") or ""),
        )

    def validation_errors(self) -> list[str]:
        errors: list[str] = []
        if not self.run_id:
            errors.append("run_id_required")
        if self.policy_revision <= 0:
            errors.append("policy_revision_required")
        if self.plan_version < 0:
            errors.append("plan_version_invalid")
        if not self.lease_id:
            errors.append("lease_id_required")
        if not self.fencing_token:
            errors.append("fencing_token_required")
        if not self.turn_id:
            errors.append("turn_id_required")
        return errors

    def mismatch_reason(self, actual: ManagedRunTurnContext) -> str | None:
        invalid = actual.validation_errors()
        if invalid:
            return f"invalid_turn_context:{invalid[0]}"
        for field, reason in (
            ("run_id", "result_run_id_mismatch"),
            ("work_item_id", "result_work_item_id_mismatch"),
            ("policy_revision", "stale_policy_revision"),
            ("plan_version", "stale_plan_version"),
            ("lease_id", "stale_lease_id"),
            ("fencing_token", "stale_fencing_token"),
            ("turn_id", "stale_turn_id"),
        ):
            if getattr(self, field) != getattr(actual, field):
                return reason
        return None


@dataclass(frozen=True)
class ManagedRunRuntimeWait:
    wait_kind: str
    message: str

    def to_dict(self) -> dict[str, str]:
        return {"wait_kind": self.wait_kind, "message": self.message}

    @classmethod
    def from_dict(cls, payload: dict[str, Any]) -> ManagedRunRuntimeWait:
        return cls(
            wait_kind=str(payload.get("wait_kind") or ""),
            message=str(payload.get("message") or ""),
        )

    def validation_errors(self) -> list[str]:
        errors: list[str] = []
        if self.wait_kind not in RUNTIME_WAIT_KINDS:
            errors.append("runtime_wait_kind_invalid")
        if not self.message.strip():
            errors.append("runtime_wait_message_required")
        return errors


def _int(value: Any) -> int:
    return value if isinstance(value, int) and not isinstance(value, bool) else 0


__all__ = ["ManagedRunRuntimeWait", "ManagedRunTurnContext", "RUNTIME_WAIT_KINDS"]
