from __future__ import annotations

import json
from pathlib import Path

import pytest

from podium.performer_profiles import PerformerProfileLoadError, load_profile_bundle


VALID_CONFIG = 'model = "gpt-test"\napproval_policy = "never"\n'


def _write_bundle(root: Path, *, performer: dict[str, object] | None = None, credentials: object | None = None) -> Path:
    profile_dir = root / "default"
    profile_dir.mkdir(parents=True)
    (profile_dir / "runtime.toml").write_text(VALID_CONFIG, encoding="utf-8")
    (profile_dir / "performer.json").write_text(
        json.dumps(
            {
                "performer_kind": "codex",
                "runtime_kind": "codex",
                "turn_policy": {"max_turns": 4},
                "credential_id": "chatgpt-main",
                **(performer or {}),
            }
        ),
        encoding="utf-8",
    )
    (profile_dir / "credentials.json").write_text(
        json.dumps(
            credentials
            or [
                {
                    "id": "chatgpt-main",
                    "name": "ChatGPT main",
                    "auth_method": "chatgpt_oauth",
                    "account_hint": "murphy@example.com",
                    "local_ref": "slot:chatgpt-main",
                }
            ]
        ),
        encoding="utf-8",
    )
    return profile_dir


def test_profile_bundle_loads_current_profiles_and_multiple_credentials(tmp_path: Path) -> None:
    _write_bundle(
        tmp_path,
        credentials=[
            {
                "id": "chatgpt-main",
                "name": "ChatGPT main",
                "auth_method": "chatgpt_oauth",
                "account_hint": "main",
                "local_ref": "slot:chatgpt-main",
            },
            {
                "id": "openai-backup",
                "name": "OpenAI backup",
                "auth_method": "api_key",
                "account_hint": "backup",
                "local_ref": "slot:openai-backup",
            },
        ],
    )

    bundle = load_profile_bundle(tmp_path, workspace_id="user-1", profile_name="default")

    assert bundle.performer_profile["id"] == "performer-profile:user-1:default"
    assert bundle.runtime_profile["id"] == "runtime-profile:user-1:default"
    assert bundle.performer_profile["runtime_profile_id"] == bundle.runtime_profile["id"]
    assert bundle.selected_credential["id"] == "credential:user-1:chatgpt-main"
    assert {row["id"] for row in bundle.credentials} == {
        "credential:user-1:chatgpt-main",
        "credential:user-1:openai-backup",
    }
    assert "auth" + ".json" not in str(bundle)


def test_profile_bundle_rejects_raw_credential_metadata(tmp_path: Path) -> None:
    _write_bundle(
        tmp_path,
        credentials=[
            {
                "id": "chatgpt-main",
                "name": "ChatGPT main",
                "auth_method": "api_key",
                "account_hint": "main",
                "local_ref": "slot:chatgpt-main",
                "api_key": "not-a-secret",
            }
        ],
    )

    with pytest.raises(PerformerProfileLoadError, match="(?i)credential"):
        load_profile_bundle(tmp_path, workspace_id="user-1")


def test_profile_bundle_requires_an_explicit_directory(tmp_path: Path) -> None:
    with pytest.raises(PerformerProfileLoadError) as error:
        load_profile_bundle(tmp_path / "missing", workspace_id="user-1")

    assert error.value.code == "performer_profile_required"
