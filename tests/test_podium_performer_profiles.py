from __future__ import annotations

import json
import hashlib
from pathlib import Path

import pytest

from podium.performer_profiles import PerformerProfileLoadError, load_profile_bundle
from podium.podium_project_bindings import PodiumProjectBindingsMixin


EXECUTION_POLICY = {
    "version": 1,
    "model": "gpt-5.4",
    "model_provider": "openai",
    "approval_mode": "auto_review",
    "reasoning_effort": "high",
    "reasoning_summary": "auto",
    "sandbox": {
        "plan": "read_only",
        "execute": "workspace_write",
        "gate": "read_only",
    },
    "initialize_timeout_ms": 5000,
    "turn_timeout_ms": 3600000,
    "initialize_max_attempts": 4,
    "overload_max_attempts": 5,
}


def _policy_hash(policy: dict[str, object]) -> str:
    canonical = json.dumps(policy, sort_keys=True, separators=(",", ":"), ensure_ascii=True)
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def _write_bundle(
    root: Path,
    *,
    runtime: dict[str, object] | None = None,
    performer: dict[str, object] | None = None,
) -> Path:
    profile_dir = root / "default"
    profile_dir.mkdir(parents=True)
    (profile_dir / "runtime.json").write_text(
        json.dumps(
            {
                "runtime_kind": "codex",
                "execution_policy": EXECUTION_POLICY,
                **(runtime or {}),
            }
        ),
        encoding="utf-8",
    )
    (profile_dir / "performer.json").write_text(
        json.dumps(
            {
                "performer_kind": "codex",
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
    assert bundle.runtime_profile["execution_policy"] == EXECUTION_POLICY
    assert len(bundle.runtime_profile["execution_policy_sha256"]) == 64
    assert bundle.performer_profile["turn_policy"] == {"max_turns": 4}
    assert len(bundle.performer_profile["turn_policy_sha256"]) == 64
    assert not any("config" in key for key in bundle.runtime_profile)
    assert not any("credential" in key for key in bundle.runtime_profile)
    assert not hasattr(bundle, "credentials")
    assert not hasattr(bundle, "selected_credential")


def test_profile_bundle_rejects_credential_selection_field(tmp_path: Path) -> None:
    _write_bundle(tmp_path, performer={"credential_id": "legacy"})
    with pytest.raises(PerformerProfileLoadError, match="not allowed"):
        load_profile_bundle(tmp_path, workspace_id="user-1")


@pytest.mark.parametrize(
    ("document", "field"),
    [
        ("runtime", "config_document"),
        ("runtime", "codex_home"),
        ("performer", "runtime_kind"),
        ("performer", "api_host"),
    ],
)
def test_profile_bundle_rejects_unknown_or_codex_owned_fields(
    tmp_path: Path,
    document: str,
    field: str,
) -> None:
    overrides = {field: "not-allowed"}
    _write_bundle(
        tmp_path,
        runtime=overrides if document == "runtime" else None,
        performer=overrides if document == "performer" else None,
    )

    with pytest.raises(PerformerProfileLoadError, match="not allowed"):
        load_profile_bundle(tmp_path, workspace_id="user-1")


def test_profile_bundle_does_not_echo_unknown_field_names(tmp_path: Path) -> None:
    field = "token-secret-value"
    _write_bundle(tmp_path, runtime={field: "opaque"})

    with pytest.raises(PerformerProfileLoadError) as error:
        load_profile_bundle(tmp_path, workspace_id="user-1")

    assert error.value.code == "performer_profile_key_rejected"
    assert field not in error.value.reason


def test_profile_bundle_normalizes_deep_policy_failures(tmp_path: Path) -> None:
    profile_dir = tmp_path / "default"
    profile_dir.mkdir(parents=True)
    deep_policy = '{"next":' * 40 + "{}" + "}" * 40
    (profile_dir / "runtime.json").write_text(
        json.dumps({"runtime_kind": "codex", "execution_policy": EXECUTION_POLICY}),
        encoding="utf-8",
    )
    (profile_dir / "performer.json").write_text(
        '{"performer_kind":"codex","turn_policy":' + deep_policy + "}",
        encoding="utf-8",
    )

    with pytest.raises(PerformerProfileLoadError) as error:
        load_profile_bundle(tmp_path, workspace_id="user-1")

    assert error.value.code == "invalid_performer_policy"


def test_profile_bundle_does_not_accept_runtime_toml_as_required_input(tmp_path: Path) -> None:
    profile_dir = tmp_path / "default"
    profile_dir.mkdir(parents=True)
    (profile_dir / "runtime.toml").write_text('model = "gpt-test"\n', encoding="utf-8")
    (profile_dir / "performer.json").write_text(
        json.dumps({"performer_kind": "codex", "turn_policy": {}}),
        encoding="utf-8",
    )

    with pytest.raises(PerformerProfileLoadError) as error:
        load_profile_bundle(tmp_path, workspace_id="user-1")

    assert error.value.code == "performer_profile_required"


def test_profile_bundle_requires_an_explicit_directory(tmp_path: Path) -> None:
    with pytest.raises(PerformerProfileLoadError) as error:
        load_profile_bundle(tmp_path / "missing", workspace_id="user-1")

    assert error.value.code == "performer_profile_required"


@pytest.mark.anyio
async def test_project_binding_command_contains_only_current_policy_without_revisions() -> None:
    class Store:
        async def get_performer_binding_for_project_binding(self, _binding_id: str) -> dict[str, object]:
            return {
                "id": "performer-binding:binding-1",
                "performer_profile_id": "performer-profile:user-1:default",
                "runtime_profile_id": "runtime-profile:user-1:default",
                "performer_kind": "codex",
                "runtime_kind": "codex",
                "execution_policy": EXECUTION_POLICY,
                "execution_policy_sha256": _policy_hash(EXECUTION_POLICY),
                "turn_policy": {"max_turns": 4},
                "turn_policy_sha256": _policy_hash({"max_turns": 4}),
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
    assert command["execution_policy"] == EXECUTION_POLICY
    assert command["execution_policy_sha256"] == _policy_hash(EXECUTION_POLICY)
    assert command["turn_policy"] == {"max_turns": 4}
    assert command["turn_policy_sha256"] == _policy_hash({"max_turns": 4})
    assert "config_format" not in command
    assert "config_document" not in command
    assert "config_sha256" not in command
    assert "credential_id" not in command
    assert "credential_ref" not in command
    assert "auth_method" not in command
    assert "account_hint" not in command
    assert not any("revision" in key for key in command)
