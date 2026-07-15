from __future__ import annotations

import importlib.util
import json
import os
from pathlib import Path

import pytest


REPO_ROOT = Path(__file__).resolve().parents[1]
BUILDER_PATH = REPO_ROOT / "tools" / "build_desktop_sidecars.py"
TAURI_CONFIG_PATH = (
    REPO_ROOT / "packages" / "podium" / "desktop" / "src-tauri" / "tauri.conf.json"
)


def _load_builder():
    spec = importlib.util.spec_from_file_location("build_desktop_sidecars", BUILDER_PATH)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _load_smoke():
    path = REPO_ROOT / "tools" / "desktop_process_smoke.py"
    spec = importlib.util.spec_from_file_location("desktop_process_smoke", path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_desktop_bundle_declares_three_target_suffixed_sidecars() -> None:
    config = json.loads(TAURI_CONFIG_PATH.read_text(encoding="utf-8"))

    assert config["bundle"]["externalBin"] == [
        "binaries/podium",
        "binaries/conductor",
        "binaries/performer",
    ]


def test_builder_keeps_role_entrypoints_and_package_paths_independent() -> None:
    builder = _load_builder()

    assert [(item.name, item.entrypoint) for item in builder.SIDECARS] == [
        ("podium", "podium.desktop_cli:main"),
        ("conductor", "conductor.conductor_cli:main"),
        ("performer", "performer.cli:main"),
    ]
    assert [item.package_path for item in builder.SIDECARS] == [
        "packages/podium/src",
        "packages/conductor/src",
        "packages/performer/src",
    ]
    assert builder.SIDECARS[-1].collected_packages == ("performer", "openai_codex")


def test_builder_names_every_artifact_for_the_requested_target(tmp_path, monkeypatch) -> None:
    builder = _load_builder()
    commands: list[list[str]] = []

    def fake_run(command, **kwargs):
        command = [str(part) for part in command]
        commands.append(command)
        name = command[command.index("--name") + 1]
        dist = Path(command[command.index("--distpath") + 1])
        dist.mkdir(parents=True, exist_ok=True)
        (dist / name).write_bytes(name.encode())

    monkeypatch.setattr(builder.subprocess, "run", fake_run)
    target = "aarch64-apple-darwin"

    builder.build_sidecars(REPO_ROOT, tmp_path, target)

    assert sorted(path.name for path in tmp_path.iterdir()) == [
        f"conductor-{target}",
        f"performer-{target}",
        f"podium-{target}",
    ]
    assert [command[command.index("--name") + 1] for command in commands] == [
        f"podium-{target}",
        f"conductor-{target}",
        f"performer-{target}",
    ]
    assert "--collect-all" not in commands[0]
    assert "--collect-all" not in commands[1]
    collected = [
        commands[2][index + 1]
        for index, value in enumerate(commands[2])
        if value == "--collect-all"
    ]
    assert collected == ["performer", "openai_codex"]


def test_real_artifacts_run_from_a_clean_install_root() -> None:
    binaries = os.environ.get("SYMPHONY_TASK_1_8_BINARIES")
    if not binaries:
        pytest.skip("set SYMPHONY_TASK_1_8_BINARIES for the real artifact smoke")

    result = _load_smoke().run_smoke(
        Path(binaries), os.environ.get("SYMPHONY_TASK_1_8_TARGET", "aarch64-apple-darwin")
    )

    assert result["status"] == "passed"
    assert result["instance_id"]
    assert result["performer_control_pid"]
    assert result["performer_turn_pid"]
    assert result["run_id"]
    assert result["turn_id"]
    assert Path(result["turn_result_path"]).name == "turn-result.json"
    assert Path(result["turn_log_path"]).name == "performer.log"
    assert result["clean_home"] is True
    assert result["clean_codex_home"] is True
    assert result["checkout_absent_from_environment"] is True
    assert result["orphan_count"] == 0
