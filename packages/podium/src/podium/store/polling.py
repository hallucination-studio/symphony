from __future__ import annotations

import sqlite3
from collections.abc import Iterable
from dataclasses import dataclass
import re


_IDENTIFIER = re.compile(r"[A-Za-z0-9][A-Za-z0-9._:-]{0,199}")


def _identifier(value: str, code: str) -> None:
    if not isinstance(value, str) or _IDENTIFIER.fullmatch(value) is None:
        raise ValueError(code)


def _positive_int(value: int, code: str) -> None:
    if isinstance(value, bool) or not isinstance(value, int) or value < 1:
        raise ValueError(code)


@dataclass(frozen=True)
class IssueObservation:
    issue_id: str
    delegated: bool
    epoch: int

    def __post_init__(self) -> None:
        _identifier(self.issue_id, "polling_issue_id_invalid")
        if not isinstance(self.delegated, bool):
            raise ValueError("polling_delegated_invalid")
        if isinstance(self.epoch, bool) or not isinstance(self.epoch, int) or self.epoch < 0:
            raise ValueError("polling_delegation_epoch_invalid")


@dataclass(frozen=True)
class PendingDispatch:
    dispatch_id: str
    issue_id: str
    delegation_epoch: int
    binding_generation: int

    def __post_init__(self) -> None:
        _identifier(self.dispatch_id, "dispatch_id_invalid")
        _identifier(self.issue_id, "dispatch_issue_id_invalid")
        _positive_int(self.delegation_epoch, "dispatch_delegation_epoch_invalid")
        _positive_int(self.binding_generation, "dispatch_binding_generation_invalid")


class PollingRepository:
    def __init__(self, connection: sqlite3.Connection) -> None:
        self.connection = connection

    def checkpoint(self, binding_id: str) -> str | None:
        row = self.connection.execute(
            "SELECT cursor FROM polling_checkpoints WHERE binding_id = ?", (binding_id,)
        ).fetchone()
        return row["cursor"] if row is not None else None

    def commit_page(
        self,
        binding_id: str,
        *,
        expected_cursor: str | None,
        next_cursor: str | None,
        observations: Iterable[IssueObservation],
        dispatches: Iterable[PendingDispatch],
    ) -> int | None:
        observations = tuple(observations)
        dispatches = tuple(dispatches)
        if not isinstance(next_cursor, str) or not next_cursor:
            raise ValueError("polling_next_cursor_invalid")
        with self.connection:
            self.connection.execute("BEGIN IMMEDIATE")
            current = self.connection.execute(
                "SELECT cursor FROM polling_checkpoints WHERE binding_id = ?",
                (binding_id,),
            ).fetchone()
            current_cursor = current["cursor"] if current is not None else None
            if current_cursor != expected_cursor:
                return None
            binding = self.connection.execute(
                """SELECT generation, active FROM conductor_bindings
                WHERE binding_id = ?""",
                (binding_id,),
            ).fetchone()
            if binding is None or not binding["active"]:
                raise ValueError("polling_binding_inactive")
            for observation in observations:
                previous = self.connection.execute(
                    """SELECT delegated, epoch FROM delegation_epochs
                    WHERE binding_id = ? AND issue_id = ?""",
                    (binding_id, observation.issue_id),
                ).fetchone()
                if previous is not None and observation.epoch < previous["epoch"]:
                    raise ValueError("polling_delegation_epoch_stale")
                if (
                    previous is not None
                    and observation.epoch == previous["epoch"]
                    and bool(previous["delegated"]) != observation.delegated
                ):
                    raise ValueError("polling_delegation_epoch_conflict")
                self.connection.execute(
                    """INSERT INTO delegation_epochs (binding_id, issue_id, delegated, epoch)
                    VALUES (?, ?, ?, ?)
                    ON CONFLICT(binding_id, issue_id) DO UPDATE SET
                        delegated = excluded.delegated,
                        epoch = excluded.epoch
                    """,
                    (
                        binding_id,
                        observation.issue_id,
                        int(observation.delegated),
                        observation.epoch,
                    ),
                )
            inserted = 0
            for dispatch in dispatches:
                if binding["generation"] != dispatch.binding_generation:
                    raise ValueError("dispatch_binding_generation_stale")
                observation = self.connection.execute(
                    """SELECT delegated, epoch FROM delegation_epochs
                    WHERE binding_id = ? AND issue_id = ?""",
                    (binding_id, dispatch.issue_id),
                ).fetchone()
                if (
                    observation is None
                    or not observation["delegated"]
                    or observation["epoch"] != dispatch.delegation_epoch
                ):
                    raise ValueError("dispatch_delegation_epoch_stale")
                cursor = self.connection.execute(
                    """INSERT INTO local_dispatches (
                        dispatch_id, binding_id, issue_id, delegation_epoch,
                        binding_generation, status
                    ) VALUES (?, ?, ?, ?, ?, 'queued')
                    ON CONFLICT(binding_id, issue_id, delegation_epoch) DO NOTHING""",
                    (
                        dispatch.dispatch_id,
                        binding_id,
                        dispatch.issue_id,
                        dispatch.delegation_epoch,
                        dispatch.binding_generation,
                    ),
                )
                inserted += cursor.rowcount
            self.connection.execute(
                """INSERT INTO polling_checkpoints (binding_id, cursor) VALUES (?, ?)
                ON CONFLICT(binding_id) DO UPDATE SET cursor = excluded.cursor""",
                (binding_id, next_cursor),
            )
            return inserted
