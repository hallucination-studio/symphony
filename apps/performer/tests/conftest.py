from __future__ import annotations

from datetime import UTC, datetime, timedelta

import pytest


@pytest.fixture
def plan_command(tmp_path):
    now = datetime.now(UTC)
    return {
        "protocol_version": "1",
        "turn_id": "turn-1",
        "turn_kind": "plan",
        "root_issue_id": "root-1",
        "performer_profile_id": "profile-1",
        "codex_turn_settings": {
            "model": "gpt-5.2-codex",
            "reasoning_effort": "high",
            "is_fast_mode_enabled": False,
        },
        "turn_input_hash": "hash-1",
        "workspace_root": str(tmp_path),
        "started_at": now.isoformat(),
        "hard_deadline_at": (now + timedelta(minutes=5)).isoformat(),
        "body": {
            "root_issue": {"title": "Ship T6", "description": "Implement the runtime."},
            "current_tree": [],
        },
    }
