from __future__ import annotations

import pytest

from performer_api.runtime import RuntimeConfig, RuntimeRole


def _config_payload() -> dict[str, object]:
    profile = {"name": "codex", "backend": "codex", "settings": {"model": "gpt"}}
    return {
        "runtime_group_id": "group-1",
        "version": 4,
        "managed_run_policy": {
            "policy_id": "policy-1",
            "version": 4,
            "effective_at": "2026-07-12T00:00:00Z",
            "max_rework_attempts": 1,
        },
        "profiles": {
            "plan": profile,
            "work_item": {**profile, "role": "work_item"},
            "verify": {**profile, "role": "verify"},
        },
    }


def test_runtime_config_normalizes_legacy_role_names_without_legacy_contract() -> None:
    config = RuntimeConfig.from_dict(_config_payload())

    config.validate()

    assert set(config.profiles) == {RuntimeRole.PLAN, RuntimeRole.EXECUTE, RuntimeRole.GATE}
    assert set(config.to_dict()["profiles"]) == {"plan", "execute", "gate"}


def test_runtime_config_rejects_more_than_one_gate_rework() -> None:
    payload = _config_payload()
    policy = dict(payload["managed_run_policy"])
    policy["max_rework_attempts"] = 2
    payload["managed_run_policy"] = policy

    with pytest.raises(ValueError, match="max_rework_attempts_must_equal_one"):
        RuntimeConfig.from_dict(payload).validate()
