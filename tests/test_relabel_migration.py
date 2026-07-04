from __future__ import annotations

import pytest

from tools import relabel_migration


def issue_with_labels(*names: str) -> dict[str, object]:
    return {
        "id": "issue-1",
        "identifier": "ENG-1",
        "url": "https://linear.test/ENG-1",
        "team": {"id": "team-1"},
        "labels": {
            "nodes": [
                {"id": f"label-{index}", "name": name}
                for index, name in enumerate(names, start=1)
            ]
        },
    }


def test_relabel_migration_phase_mapping_uses_one_target_phase() -> None:
    assert relabel_migration._target_phase(
        [
            "performer:running",
            "performer:retry/exhausted",
            "performer:type/task",
        ]
    ) == "performer:phase/failed"


@pytest.mark.asyncio
async def test_relabel_migration_removes_legacy_labels_and_preserves_current_axes(monkeypatch) -> None:
    ensured: list[str] = []

    async def fake_ensure_label(team_id: str, name: str) -> str:
        ensured.append(f"{team_id}:{name}")
        return f"id-{name}"

    monkeypatch.setattr(relabel_migration, "ensure_label", fake_ensure_label)

    result = await relabel_migration.relabel_issue(
        issue_with_labels(
            "team-owned",
            "performer:type/task",
            "performer:running",
            "performer:type/gate",
            "performer:gate/pending",
        ),
        apply=False,
    )

    assert ensured == ["team-1:performer:phase/implementation"]
    assert result["changed"] is True
    assert result["after"] == [
        "team-owned",
        "performer:type/gate",
        "performer:gate/pending",
        "performer:phase/implementation",
    ]
