from __future__ import annotations

import sqlite3
from dataclasses import dataclass
import re


_IDENTIFIER = re.compile(r"[A-Za-z0-9][A-Za-z0-9._:-]{0,199}")


def _identifier(value: str, code: str) -> None:
    if not isinstance(value, str) or _IDENTIFIER.fullmatch(value) is None:
        raise ValueError(code)


def _positive_int(value: int, code: str) -> None:
    if isinstance(value, bool) or not isinstance(value, int) or value < 1:
        raise ValueError(code)


def _nonnegative_int(value: int, code: str) -> None:
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        raise ValueError(code)


@dataclass(frozen=True)
class DispatchLease:
    dispatch_id: str
    binding_id: str
    issue_id: str
    delegation_epoch: int
    binding_generation: int
    status: str
    conductor_id: str
    lease_id: str
    leased_until: int
    fencing_token: int


class DispatchRepository:
    def __init__(self, connection: sqlite3.Connection) -> None:
        self.connection = connection

    def lease(
        self,
        binding_id: str,
        conductor_id: str,
        *,
        binding_generation: int,
        lease_id: str,
        now: int,
        leased_until: int,
    ) -> DispatchLease | None:
        _identifier(binding_id, "dispatch_binding_id_invalid")
        _identifier(conductor_id, "dispatch_conductor_id_invalid")
        _identifier(lease_id, "dispatch_lease_id_invalid")
        _positive_int(binding_generation, "dispatch_binding_generation_invalid")
        _nonnegative_int(now, "dispatch_lease_time_invalid")
        _nonnegative_int(leased_until, "dispatch_lease_deadline_invalid")
        if leased_until <= now:
            raise ValueError("dispatch_lease_deadline_invalid")
        with self.connection:
            self.connection.execute("BEGIN IMMEDIATE")
            binding = self.connection.execute(
                """SELECT conductor_id, generation, active FROM conductor_bindings
                WHERE binding_id = ?""",
                (binding_id,),
            ).fetchone()
            if (
                binding is None
                or not binding["active"]
                or binding["conductor_id"] != conductor_id
                or binding["generation"] != binding_generation
            ):
                return None
            repeated = self.connection.execute(
                """SELECT * FROM local_dispatches
                WHERE binding_id = ? AND leased_conductor_id = ? AND lease_id = ?
                  AND status = 'leased' AND binding_generation = ?""",
                (binding_id, conductor_id, lease_id, binding_generation),
            ).fetchone()
            if repeated is not None:
                return _lease(repeated)
            candidate = self.connection.execute(
                """SELECT dispatch_id FROM local_dispatches
                WHERE binding_id = ? AND binding_generation = ?
                  AND (status = 'queued' OR (status = 'leased' AND leased_until <= ?))
                ORDER BY dispatch_id LIMIT 1""",
                (binding_id, binding_generation, now),
            ).fetchone()
            if candidate is None:
                return None
            row = self.connection.execute(
                """UPDATE local_dispatches SET
                    status = 'leased', leased_conductor_id = ?, lease_id = ?,
                    leased_until = ?, fencing_token = fencing_token + 1
                WHERE dispatch_id = ? RETURNING *""",
                (conductor_id, lease_id, leased_until, candidate["dispatch_id"]),
            ).fetchone()
            return _lease(row)

    def ack(
        self,
        dispatch_id: str,
        conductor_id: str,
        lease_id: str,
        fencing_token: int,
    ) -> bool:
        _identifier(dispatch_id, "dispatch_id_invalid")
        _identifier(conductor_id, "dispatch_conductor_id_invalid")
        _identifier(lease_id, "dispatch_lease_id_invalid")
        _positive_int(fencing_token, "dispatch_fencing_token_invalid")
        with self.connection:
            self.connection.execute("BEGIN IMMEDIATE")
            row = self.connection.execute(
                """SELECT dispatch.status, dispatch.leased_conductor_id,
                    dispatch.lease_id, dispatch.fencing_token
                FROM local_dispatches AS dispatch
                JOIN conductor_bindings AS binding
                  ON binding.binding_id = dispatch.binding_id
                 AND binding.active = 1
                 AND binding.generation = dispatch.binding_generation
                 AND binding.conductor_id = dispatch.leased_conductor_id
                WHERE dispatch.dispatch_id = ?""",
                (dispatch_id,),
            ).fetchone()
            if row is None or (
                row["leased_conductor_id"], row["lease_id"], row["fencing_token"]
            ) != (conductor_id, lease_id, fencing_token):
                return False
            if row["status"] == "acked":
                return True
            if row["status"] != "leased":
                return False
            self.connection.execute(
                "UPDATE local_dispatches SET status = 'acked' WHERE dispatch_id = ?",
                (dispatch_id,),
            )
            return True

    def reclaim_expired(self, *, now: int) -> int:
        _nonnegative_int(now, "dispatch_reclaim_time_invalid")
        with self.connection:
            self.connection.execute("BEGIN IMMEDIATE")
            cursor = self.connection.execute(
                """UPDATE local_dispatches SET status = 'queued',
                    leased_conductor_id = NULL, lease_id = NULL, leased_until = NULL
                WHERE status = 'leased' AND leased_until <= ?""",
                (now,),
            )
            return cursor.rowcount


def _lease(row: sqlite3.Row) -> DispatchLease:
    return DispatchLease(
        dispatch_id=row["dispatch_id"],
        binding_id=row["binding_id"],
        issue_id=row["issue_id"],
        delegation_epoch=row["delegation_epoch"],
        binding_generation=row["binding_generation"],
        status=row["status"],
        conductor_id=row["leased_conductor_id"],
        lease_id=row["lease_id"],
        leased_until=row["leased_until"],
        fencing_token=row["fencing_token"],
    )
