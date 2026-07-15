from __future__ import annotations

import sqlite3
from pathlib import Path

import pytest

from podium.store.sqlite import SQLiteStore


def open_store(path: Path) -> SQLiteStore:
    store = SQLiteStore(path)
    store.initialize()
    return store


def installation(
    access_token: str = "access-one", refresh_token: str = "refresh-one"
) -> dict[str, object]:
    return {
        "installation_id": "installation-1",
        "organization_id": "organization-1",
        "app_user_id": "app-user-1",
        "granted_scopes": "app:assignable,read,write",
        "access_token": access_token,
        "refresh_token": refresh_token,
        "expires_at": 1_800_000_000,
    }


def test_credentials_survive_reopen_restart_and_update(tmp_path: Path) -> None:
    path = tmp_path / "podium.db"
    store = open_store(path)
    store.save_linear_installation(**installation())
    store.close()

    restarted = SQLiteStore(path)
    assert restarted.load_linear_credentials("installation-1") == {
        "access_token": "access-one",
        "refresh_token": "refresh-one",
        "expires_at": 1_800_000_000,
    }
    restarted.close()

    updated_application = SQLiteStore(path)
    assert updated_application.load_linear_credentials("installation-1") is not None
    updated_application.close()


def test_replace_pair_is_atomic_on_write_failure(tmp_path: Path) -> None:
    store = open_store(tmp_path / "podium.db")
    store.save_linear_installation(**installation())
    store.connection.execute(
        """CREATE TRIGGER reject_refresh BEFORE UPDATE OF refresh_token ON linear_installations
        BEGIN SELECT RAISE(ABORT, 'replacement rejected'); END"""
    )

    with pytest.raises(sqlite3.IntegrityError, match="replacement rejected"):
        store.replace_linear_credentials(
            "installation-1", "access-two", "refresh-two", expires_at=1_900_000_000
        )

    assert store.load_linear_credentials("installation-1") == {
        "access_token": "access-one",
        "refresh_token": "refresh-one",
        "expires_at": 1_800_000_000,
    }


def test_initial_save_failure_leaves_no_installation(tmp_path: Path) -> None:
    store = open_store(tmp_path / "podium.db")
    store.connection.execute(
        """CREATE TRIGGER reject_install BEFORE INSERT ON linear_installations
        BEGIN SELECT RAISE(ABORT, 'install rejected'); END"""
    )

    with pytest.raises(sqlite3.IntegrityError, match="install rejected"):
        store.save_linear_installation(**installation())

    assert store.connection.execute("SELECT COUNT(*) FROM linear_installations").fetchone()[0] == 0


def test_clear_pair_is_atomic_and_preserves_public_metadata(tmp_path: Path) -> None:
    store = open_store(tmp_path / "podium.db")
    store.save_linear_installation(**installation())
    store.clear_linear_credentials("installation-1")

    assert store.load_linear_credentials("installation-1") is None
    row = store.connection.execute(
        """SELECT organization_id, app_user_id, granted_scopes, status,
        access_token, refresh_token FROM linear_installations WHERE installation_id = ?""",
        ("installation-1",),
    ).fetchone()
    assert dict(row) == {
        "organization_id": "organization-1",
        "app_user_id": "app-user-1",
        "granted_scopes": "app:assignable,read,write",
        "status": "disconnected",
        "access_token": None,
        "refresh_token": None,
    }


def test_clear_failure_preserves_complete_connected_pair(tmp_path: Path) -> None:
    store = open_store(tmp_path / "podium.db")
    store.save_linear_installation(**installation())
    store.connection.execute(
        """CREATE TRIGGER reject_clear BEFORE UPDATE OF access_token ON linear_installations
        WHEN NEW.access_token IS NULL
        BEGIN SELECT RAISE(ABORT, 'clear rejected'); END"""
    )

    with pytest.raises(sqlite3.IntegrityError, match="clear rejected"):
        store.clear_linear_credentials("installation-1")

    assert store.load_linear_credentials("installation-1") == {
        "access_token": "access-one",
        "refresh_token": "refresh-one",
        "expires_at": 1_800_000_000,
    }
    assert store.connection.execute(
        "SELECT status FROM linear_installations WHERE installation_id = ?",
        ("installation-1",),
    ).fetchone()[0] == "connected"


def test_empty_or_half_token_pairs_are_rejected(tmp_path: Path) -> None:
    store = open_store(tmp_path / "podium.db")
    with pytest.raises(ValueError, match="linear_credential_pair_invalid"):
        store.save_linear_installation(**installation(access_token=""))
    with pytest.raises(ValueError, match="linear_credential_pair_invalid"):
        store.replace_linear_credentials("missing", "access", "", expires_at=1)
    with pytest.raises(sqlite3.IntegrityError, match="CHECK constraint failed"):
        store.connection.execute(
            """INSERT INTO linear_installations (
                installation_id, organization_id, app_user_id, granted_scopes,
                access_token, refresh_token, expires_at, status
            ) VALUES (?, ?, ?, ?, ?, NULL, ?, 'connected')""",
            ("half-pair", "organization-1", "app-user-1", "read", "access", 1),
        )


def test_ordinary_snapshot_never_contains_credentials(tmp_path: Path) -> None:
    store = open_store(tmp_path / "podium.db")
    store.save_linear_installation(**installation())
    store.add_binding("binding-1")

    snapshot = store.snapshot("binding-1")
    assert "access-one" not in repr(snapshot)
    assert "refresh-one" not in repr(snapshot)


def test_corrupt_or_unavailable_database_fails_without_fallback(tmp_path: Path) -> None:
    corrupt = tmp_path / "podium.db"
    corrupt.write_bytes(b"not a sqlite database")
    with pytest.raises(sqlite3.DatabaseError):
        SQLiteStore(corrupt)
    assert list(tmp_path.iterdir()) == [corrupt]
    assert corrupt.read_bytes() == b"not a sqlite database"

    unavailable = tmp_path / "directory"
    unavailable.mkdir()
    with pytest.raises(sqlite3.OperationalError, match="unable to open database file"):
        SQLiteStore(unavailable)
    assert sorted(path.name for path in tmp_path.iterdir()) == ["directory", "podium.db"]


def test_credential_seam_has_no_forbidden_storage_path(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    store = open_store(tmp_path / "podium.db")
    store.save_linear_installation(
        **installation("outward-access-sentinel", "outward-refresh-sentinel")
    )
    store.load_linear_credentials("installation-1")
    store.replace_linear_credentials(
        "installation-1",
        "replacement-access-sentinel",
        "replacement-refresh-sentinel",
        expires_at=1_900_000_000,
    )
    store.clear_linear_credentials("installation-1")

    root = Path(__file__).parents[1]
    sources = "\n".join(
        (root / relative).read_text()
        for relative in (
            "packages/podium/src/podium/store/sqlite.py",
            "packages/podium/src/podium/store/schema.py",
        )
    ).lower()
    for forbidden in (
        "keychain",
        "credential store",
        "encrypt",
        "decrypt",
        "ciphertext",
        "memory_only",
        "dual_store",
    ):
        assert forbidden not in sources
    captured = capsys.readouterr()
    outward = captured.out + captured.err
    assert "outward-access-sentinel" not in outward
    assert "outward-refresh-sentinel" not in outward
    assert "replacement-access-sentinel" not in outward
    assert "replacement-refresh-sentinel" not in outward


def test_schema_has_only_approved_credential_columns(tmp_path: Path) -> None:
    store = open_store(tmp_path / "podium.db")
    columns = {
        row[1] for row in store.connection.execute("PRAGMA table_info(linear_installations)")
    }
    assert columns == {
        "installation_id",
        "organization_id",
        "organization_name",
        "app_user_id",
        "granted_scopes",
        "access_token",
        "refresh_token",
        "expires_at",
        "status",
        "last_verified_at",
        "error_code",
    }
