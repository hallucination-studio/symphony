from __future__ import annotations

from dataclasses import asdict
from pathlib import Path

import pytest

from podium.linear_models import InstallationMetadata, InstallationStatus, LinearProject
from podium.store.linear import LinearRepository, ProjectSelectionConflict
from podium.store.migrations import MIGRATIONS, apply_migrations
from podium.store.sqlite import SQLiteStore


def repository(path: Path) -> tuple[SQLiteStore, LinearRepository]:
    store = SQLiteStore(path)
    store.initialize()
    return store, LinearRepository(store.connection)


def metadata(status: InstallationStatus = InstallationStatus.DISCONNECTED) -> InstallationMetadata:
    return InstallationMetadata(
        installation_id="installation-1",
        organization_id="organization-1",
        organization_name="Symphony",
        app_user_id="app-user-1",
        granted_scopes=("app:assignable", "read", "write"),
        expires_at=None,
        status=status,
        last_verified_at=1_800_000_000,
        error_code=None,
    )


def test_installation_metadata_round_trips_without_credentials(tmp_path: Path) -> None:
    store, linear = repository(tmp_path / "podium.db")
    linear.save_installation(metadata())

    record = linear.installation("installation-1")

    assert record is not None
    assert record.granted_scopes == ("app:assignable", "read", "write")
    assert record.status is InstallationStatus.DISCONNECTED
    assert set(asdict(record)).isdisjoint(
        {"access_token", "refresh_token", "credential_reference", "ciphertext"}
    )
    assert "token" not in repr(record).lower()
    store.close()


def test_v1_credentials_and_scopes_survive_the_v2_metadata_upgrade(tmp_path: Path) -> None:
    path = tmp_path / "podium.db"
    store = SQLiteStore(path)
    apply_migrations(store.connection, migrations=(MIGRATIONS[0],))
    store.save_linear_installation(
        installation_id="installation-1",
        organization_id="organization-1",
        app_user_id="app-user-1",
        granted_scopes="app:assignable,read,write",
        access_token="access-one",
        refresh_token="refresh-one",
        expires_at=1_800_000_000,
    )

    apply_migrations(store.connection)
    linear = LinearRepository(store.connection)

    assert store.load_linear_credentials("installation-1") == {
        "access_token": "access-one",
        "refresh_token": "refresh-one",
        "expires_at": 1_800_000_000,
    }
    assert linear.installation("installation-1").granted_scopes == (
        "app:assignable",
        "read",
        "write",
    )


@pytest.mark.parametrize(
    "status,error_code",
    [
        (InstallationStatus.CREDENTIALS_MISSING, "credentials_missing_for_existing_installation"),
        (InstallationStatus.REAUTHORIZATION_REQUIRED, "linear_token_rejected_after_refresh"),
    ],
)
def test_missing_credentials_and_reauthorization_are_distinct_states(
    tmp_path: Path, status: InstallationStatus, error_code: str
) -> None:
    store, linear = repository(tmp_path / f"{status.value}.db")
    value = metadata(status)
    linear.save_installation(
        InstallationMetadata(**{**asdict(value), "error_code": error_code})
    )

    assert linear.installation("installation-1").status is status
    assert linear.installation("installation-1").error_code == error_code
    store.close()


def test_installation_rejects_an_unsanitized_error_reason() -> None:
    value = metadata(InstallationStatus.REAUTHORIZATION_REQUIRED)

    with pytest.raises(ValueError, match="linear_error_code_invalid"):
        InstallationMetadata(
            **{**asdict(value), "error_code": "request failed with raw token"}
        )


def test_projects_reopen_with_stable_identity_and_bound_selection_protection(
    tmp_path: Path,
) -> None:
    path = tmp_path / "podium.db"
    store, linear = repository(path)
    linear.save_installation(metadata())
    linear.replace_projects(
        "installation-1",
        (
            LinearProject("project-1", "organization-1", "team-1", "Runtime", "runtime"),
            LinearProject("project-2", "organization-1", "team-1", "Agents", "agents"),
        ),
    )
    linear.replace_selection("installation-1", ("project-1",), protected_project_ids=())
    store.close()

    reopened = SQLiteStore(path)
    reopened.initialize()
    linear = LinearRepository(reopened.connection)
    assert [(record.project_id, record.selected) for record in linear.projects()] == [
        ("project-1", True),
        ("project-2", False),
    ]

    with pytest.raises(ProjectSelectionConflict, match="linear_project_bound"):
        linear.replace_selection(
            "installation-1", (), protected_project_ids=("project-1",)
        )
    assert linear.projects()[0].selected is True


def test_project_scope_conflicts_and_failed_selection_roll_back(tmp_path: Path) -> None:
    store, linear = repository(tmp_path / "podium.db")
    linear.save_installation(metadata())
    other = InstallationMetadata(
        **{
            **asdict(metadata()),
            "installation_id": "installation-2",
            "organization_id": "organization-2",
            "organization_name": "Other",
        }
    )
    linear.save_installation(other)
    linear.replace_projects(
        "installation-1",
        (LinearProject("project-1", "organization-1", "team-1", "Runtime", "runtime"),),
    )
    linear.replace_selection("installation-1", ("project-1",), protected_project_ids=())

    with pytest.raises(ProjectSelectionConflict, match="organization_mismatch"):
        linear.replace_projects(
            "installation-2",
            (LinearProject("project-2", "organization-1", "team-1", "Wrong", "wrong"),),
        )
    with pytest.raises(ProjectSelectionConflict, match="installation_mismatch"):
        linear.replace_projects(
            "installation-2",
            (LinearProject("project-1", "organization-2", "team-2", "Moved", "moved"),),
        )
    with pytest.raises(ProjectSelectionConflict, match="linear_project_not_found"):
        linear.replace_selection(
            "installation-1", ("missing",), protected_project_ids=()
        )

    assert [(row.project_id, row.installation_id, row.selected) for row in linear.projects()] == [
        ("project-1", "installation-1", True)
    ]


def test_installation_cannot_move_to_another_organization(tmp_path: Path) -> None:
    store, linear = repository(tmp_path / "podium.db")
    linear.save_installation(metadata())
    store.replace_linear_credentials(
        "installation-1", "access-one", "refresh-one", expires_at=1_800_000_000
    )
    linear.replace_projects(
        "installation-1",
        (LinearProject("project-1", "organization-1", "team-1", "Runtime", "runtime"),),
    )
    changed = InstallationMetadata(
        **{
            **asdict(metadata(InstallationStatus.CONNECTED)),
            "organization_id": "organization-2",
            "organization_name": "Other",
        }
    )

    with pytest.raises(ValueError, match="linear_installation_organization_mismatch"):
        linear.save_installation(changed)

    assert linear.installation("installation-1").organization_id == "organization-1"
    assert linear.projects()[0].organization_id == "organization-1"
    assert store.load_linear_credentials("installation-1") == {
        "access_token": "access-one",
        "refresh_token": "refresh-one",
        "expires_at": 1_800_000_000,
    }
