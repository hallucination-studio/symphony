from __future__ import annotations

import sqlite3
from pathlib import Path

import pytest

from podium.conductor_bindings import DesiredBinding
from podium.linear_models import InstallationMetadata, InstallationStatus, LinearProject
from podium.store.bindings import BindingRepository
from podium.store.dispatch import DispatchRepository
from podium.store.failures import BackgroundFailure, FailureRepository
from podium.store.linear import LinearRepository
from podium.store.polling import IssueObservation, PendingDispatch, PollingRepository
from podium.store.sqlite import SQLiteStore


def configured_store(path: Path) -> SQLiteStore:
    store = SQLiteStore(path)
    store.initialize()
    linear = LinearRepository(store.connection)
    linear.save_installation(
        InstallationMetadata(
            "installation-1",
            "organization-1",
            "Symphony",
            "app-user-1",
            ("read",),
            None,
            InstallationStatus.DISCONNECTED,
            None,
            None,
        )
    )
    linear.replace_projects(
        "installation-1",
        (LinearProject("project-1", "organization-1", "team-1", "One", "one"),),
    )
    BindingRepository(store.connection).save(
        DesiredBinding("binding-1", "project-1", "conductor-1", 1)
    )
    return store


def page() -> tuple[tuple[IssueObservation, ...], tuple[PendingDispatch, ...]]:
    return (
        (IssueObservation("issue-1", True, 1),),
        (PendingDispatch("dispatch-1", "issue-1", 1, 1),),
    )


def test_checkpoint_epoch_and_dispatch_commit_atomically_and_idempotently(
    tmp_path: Path,
) -> None:
    store = configured_store(tmp_path / "podium.db")
    polling = PollingRepository(store.connection)
    observations, dispatches = page()

    assert polling.commit_page(
        "binding-1",
        expected_cursor=None,
        next_cursor="cursor-1",
        observations=observations,
        dispatches=dispatches,
    ) == 1
    assert polling.commit_page(
        "binding-1",
        expected_cursor=None,
        next_cursor="stale",
        observations=observations,
        dispatches=dispatches,
    ) is None
    assert polling.checkpoint("binding-1") == "cursor-1"
    assert store.connection.execute("SELECT count(*) FROM local_dispatches").fetchone()[0] == 1


def test_polling_failure_rolls_back_checkpoint_epoch_and_dispatch(tmp_path: Path) -> None:
    store = configured_store(tmp_path / "podium.db")
    polling = PollingRepository(store.connection)

    with pytest.raises(sqlite3.IntegrityError):
        polling.commit_page(
            "binding-1",
            expected_cursor=None,
            next_cursor="cursor-1",
            observations=(
                IssueObservation("issue-1", True, 1),
                IssueObservation("issue-2", True, 1),
            ),
            dispatches=(
                PendingDispatch("dispatch-1", "issue-1", 1, 1),
                PendingDispatch("dispatch-1", "issue-2", 1, 1),
            ),
        )

    assert polling.checkpoint("binding-1") is None
    assert store.connection.execute("SELECT count(*) FROM delegation_epochs").fetchone()[0] == 0
    assert store.connection.execute("SELECT count(*) FROM local_dispatches").fetchone()[0] == 0

    with pytest.raises(ValueError, match="dispatch_binding_generation_stale"):
        polling.commit_page(
            "binding-1",
            expected_cursor=None,
            next_cursor="cursor-stale-generation",
            observations=(IssueObservation("issue-1", True, 1),),
            dispatches=(PendingDispatch("dispatch-1", "issue-1", 1, 2),),
        )
    with pytest.raises(ValueError, match="dispatch_delegation_epoch_stale"):
        polling.commit_page(
            "binding-1",
            expected_cursor=None,
            next_cursor="cursor-stale-epoch",
            observations=(IssueObservation("issue-1", True, 2),),
            dispatches=(PendingDispatch("dispatch-1", "issue-1", 1, 1),),
        )
    assert polling.checkpoint("binding-1") is None


def test_equal_epoch_cannot_change_delegation_truth(tmp_path: Path) -> None:
    store = configured_store(tmp_path / "podium.db")
    polling = PollingRepository(store.connection)
    polling.commit_page(
        "binding-1", expected_cursor=None, next_cursor="cursor-1",
        observations=(IssueObservation("issue-1", True, 1),), dispatches=(),
    )

    with pytest.raises(ValueError, match="polling_delegation_epoch_conflict"):
        polling.commit_page(
            "binding-1", expected_cursor="cursor-1", next_cursor="cursor-2",
            observations=(IssueObservation("issue-1", False, 1),), dispatches=(),
        )

    assert polling.checkpoint("binding-1") == "cursor-1"
    assert store.connection.execute(
        "SELECT delegated FROM delegation_epochs WHERE issue_id = 'issue-1'"
    ).fetchone()[0] == 1


def test_lease_ack_and_reclaim_use_generation_and_fencing(tmp_path: Path) -> None:
    store = configured_store(tmp_path / "podium.db")
    polling = PollingRepository(store.connection)
    polling.commit_page(
        "binding-1",
        expected_cursor=None,
        next_cursor="cursor-1",
        observations=page()[0],
        dispatches=page()[1],
    )
    dispatches = DispatchRepository(store.connection)

    assert dispatches.lease(
        "binding-1", "conductor-1", binding_generation=2,
        lease_id="lease-stale", now=10, leased_until=20,
    ) is None
    first = dispatches.lease(
        "binding-1", "conductor-1", binding_generation=1,
        lease_id="lease-1", now=10, leased_until=20,
    )
    assert first is not None and first.fencing_token == 1
    assert dispatches.lease(
        "binding-1", "conductor-1", binding_generation=1,
        lease_id="lease-1", now=11, leased_until=20,
    ) == first
    assert dispatches.ack("dispatch-1", "conductor-1", "wrong", 1) is False
    assert dispatches.reclaim_expired(now=20) == 1

    second = dispatches.lease(
        "binding-1", "conductor-1", binding_generation=1,
        lease_id="lease-2", now=21, leased_until=30,
    )
    assert second is not None and second.fencing_token == 2
    assert dispatches.ack("dispatch-1", "conductor-1", "lease-1", 1) is False
    assert dispatches.ack("dispatch-1", "conductor-1", "lease-2", 2) is True
    assert dispatches.ack("dispatch-1", "conductor-1", "lease-2", 2) is True
    assert dispatches.reclaim_expired(now=31) == 0


def test_generation_bump_fences_an_existing_queued_dispatch(tmp_path: Path) -> None:
    store = configured_store(tmp_path / "podium.db")
    polling = PollingRepository(store.connection)
    polling.commit_page(
        "binding-1", expected_cursor=None, next_cursor="cursor-1",
        observations=page()[0], dispatches=page()[1],
    )
    BindingRepository(store.connection).save(
        DesiredBinding("binding-1", "project-1", "conductor-1", 2)
    )

    assert DispatchRepository(store.connection).lease(
        "binding-1", "conductor-1", binding_generation=1,
        lease_id="lease-1", now=1, leased_until=2,
    ) is None


def test_generation_bump_fences_an_existing_lease_ack(tmp_path: Path) -> None:
    store = configured_store(tmp_path / "podium.db")
    polling = PollingRepository(store.connection)
    polling.commit_page(
        "binding-1", expected_cursor=None, next_cursor="cursor-1",
        observations=page()[0], dispatches=page()[1],
    )
    dispatches = DispatchRepository(store.connection)
    assert dispatches.lease(
        "binding-1", "conductor-1", binding_generation=1,
        lease_id="lease-1", now=1, leased_until=10,
    ) is not None
    BindingRepository(store.connection).save(
        DesiredBinding("binding-1", "project-1", "conductor-1", 2)
    )

    assert dispatches.ack("dispatch-1", "conductor-1", "lease-1", 1) is False
    assert store.connection.execute(
        "SELECT status FROM local_dispatches WHERE dispatch_id = 'dispatch-1'"
    ).fetchone()[0] == "leased"


def test_dispatch_provenance_rejects_bool_and_unbounded_identifiers(tmp_path: Path) -> None:
    store = configured_store(tmp_path / "podium.db")
    dispatches = DispatchRepository(store.connection)

    with pytest.raises(ValueError, match="binding_generation_invalid"):
        dispatches.lease(
            "binding-1", "conductor-1", binding_generation=True,
            lease_id="lease-1", now=1, leased_until=2,
        )
    with pytest.raises(ValueError, match="lease_id_invalid"):
        dispatches.lease(
            "binding-1", "conductor-1", binding_generation=1,
            lease_id="x" * 201, now=1, leased_until=2,
        )
    with pytest.raises(ValueError, match="fencing_token_invalid"):
        dispatches.ack("dispatch-1", "conductor-1", "lease-1", True)


def test_dispatch_has_one_lease_across_connections_and_reopen(tmp_path: Path) -> None:
    path = tmp_path / "podium.db"
    first = configured_store(path)
    polling = PollingRepository(first.connection)
    polling.commit_page(
        "binding-1", expected_cursor=None, next_cursor="cursor-1",
        observations=page()[0], dispatches=page()[1],
    )
    first.close()

    reopened = SQLiteStore(path)
    reopened.initialize()
    competing = SQLiteStore(path)
    competing.initialize()
    lease = DispatchRepository(reopened.connection).lease(
        "binding-1", "conductor-1", binding_generation=1,
        lease_id="lease-1", now=1, leased_until=10,
    )
    assert lease is not None
    assert DispatchRepository(competing.connection).lease(
        "binding-1", "conductor-1", binding_generation=1,
        lease_id="lease-2", now=2, leased_until=11,
    ) is None


def test_background_failure_reopens_with_bounded_actionable_fields(tmp_path: Path) -> None:
    path = tmp_path / "podium.db"
    store = configured_store(path)
    failures = FailureRepository(store.connection)
    value = BackgroundFailure(
        "linear_polling", 2, "linear_poll_timeout", "retry_linear_polling", 100
    )
    failures.save(value)
    store.close()

    reopened = SQLiteStore(path)
    reopened.initialize()
    assert FailureRepository(reopened.connection).get("linear_polling") == value
    with pytest.raises(ValueError, match="reason_invalid"):
        BackgroundFailure("bad", 1, "x" * 501, "retry", None)
    with pytest.raises(ValueError, match="next_action_invalid"):
        BackgroundFailure("bad", 1, "safe", "open browser now", None)
