from __future__ import annotations

import json
import hashlib
from pathlib import Path

import pytest

from podium.performer_profiles import PerformerProfileLoadError, load_profile_bundle
from podium.podium_project_bindings import PodiumProjectBindingsMixin


VALID_CONFIG = 'model = "gpt-test"\napproval_policy = "never"\ncli_auth_credentials_store = "file"\n'


def _write_bundle(root: Path, *, performer: dict[str, object] | None = None) -> Path:
    profile_dir = root / "default"
    profile_dir.mkdir(parents=True)
    (profile_dir / "runtime.toml").write_text(VALID_CONFIG, encoding="utf-8")
    (profile_dir / "performer.json").write_text(
        json.dumps(
            {
                "performer_kind": "codex",
                "runtime_kind": "codex",
                "turn_policy": {"max_turns": 4},
                **(performer or {}),
            }
        ),
        encoding="utf-8",
    )
    return profile_dir


def test_profile_bundle_loads_only_current_non_secret_profiles(tmp_path: Path) -> None:
    _write_bundle(tmp_path)

    bundle = load_profile_bundle(tmp_path, workspace_id="user-1", profile_name="default")

    assert bundle.performer_profile["id"] == "performer-profile:user-1:default"
    assert bundle.runtime_profile["id"] == "runtime-profile:user-1:default"
    assert bundle.performer_profile["runtime_profile_id"] == bundle.runtime_profile["id"]
    assert not hasattr(bundle, "credentials")
    assert not hasattr(bundle, "selected_credential")


def test_profile_bundle_rejects_credential_selection_field(tmp_path: Path) -> None:
    _write_bundle(tmp_path, performer={"credential_id": "legacy"})
    with pytest.raises(PerformerProfileLoadError, match="not allowed"):
        load_profile_bundle(tmp_path, workspace_id="user-1")


def test_profile_bundle_requires_an_explicit_directory(tmp_path: Path) -> None:
    with pytest.raises(PerformerProfileLoadError) as error:
        load_profile_bundle(tmp_path / "missing", workspace_id="user-1")

    assert error.value.code == "performer_profile_required"


@pytest.mark.anyio
async def test_project_binding_command_contains_current_profile_documents_without_revisions() -> None:
    class Store:
        async def get_performer_binding_for_project_binding(self, _binding_id: str) -> dict[str, object]:
            return {
                "id": "performer-binding:binding-1",
                "performer_profile_id": "performer-profile:user-1:default",
                "runtime_profile_id": "runtime-profile:user-1:default",
                "performer_kind": "codex",
                "runtime_kind": "codex",
                "turn_policy": {"max_turns": 4},
                "policy_sha256": hashlib.sha256(b'{"max_turns":4}').hexdigest(),
                "config_format": "toml",
                "config_document": VALID_CONFIG,
                "config_sha256": hashlib.sha256(VALID_CONFIG.encode()).hexdigest(),
                "state": "pending",
                "generation": 2,
            }

    service = type("Service", (PodiumProjectBindingsMixin,), {})()
    service.store = Store()
    command = await service.project_binding_command(
        {
            "id": "binding-1",
            "config_version": 7,
            "linear_project_id": "project-1",
            "project_slug": "example",
            "project_name": "Example",
            "agent_app_user_id": "agent-1",
            "repo_source": {"type": "local_path", "value": "/repo"},
        }
    )

    assert command["binding_config_version"] == 7
    assert command["performer_binding_id"] == "performer-binding:binding-1"
    assert command["runtime_profile_id"] == "runtime-profile:user-1:default"
    assert command["config_document"] == VALID_CONFIG.strip() + "\n"
    assert "credential_id" not in command
    assert "credential_ref" not in command
    assert "auth_method" not in command
    assert "account_hint" not in command
    assert not any("revision" in key for key in command)
