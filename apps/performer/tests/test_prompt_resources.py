from __future__ import annotations

import os
from pathlib import Path
from shutil import copytree
import subprocess
import sys

import pytest

from performer import prompt_resources
from performer.prompt_resources import (
    ROLE_OPENING_LINES,
    PromptResourceError,
    load_role_prompt_catalog,
)


PROMPT_DIRECTORY = Path(__file__).resolve().parents[1] / "src" / "performer" / "prompts"
PERFORMER_DIRECTORY = PROMPT_DIRECTORY.parents[2]

ROLE_RESOURCES = {
    "root_reconciler": "root-reconciler.md",
    "plan": "plan.md",
    "work": "work.md",
    "verify": "verify.md",
}

COMMON_SECTIONS = (
    "## Role and Authority",
    "## Trigger Conditions",
    "## Workflow",
    "## Anti-Rationalization",
    "## Red Flags",
    "## Exit Criteria",
    "## Output Contract",
)

ROLE_REQUIREMENTS = {
    "root_reconciler": (
        "DEFINE clarifies the durable Root requirement.",
        "REVIEW evaluates each read-back terminal CycleOutcome",
        "Automatic delivery is the default unless the user explicitly disables it.",
        "SHIP with conclude_root ready_for_delivery",
        'wrapper shape {"action": <RootDirectiveAction>}',
        "never create SPEC.md, PLAN.md, tasks files, review reports, or delivery notes",
    ),
    "plan": (
        "independently dispatchable Work units",
        "dependency_proposal_keys",
        "dependency_edges to []",
        "every Root acceptance criterion",
        "Never return a partial plan_completed",
        "DEFINE, Plan, REVIEW, and SHIP artifacts belong in Linear",
    ),
    "work": (
        "complete exactly one selected Work Issue",
        "Ordinary command or test failure is not automatically terminal.",
        "Diagnose and retry ordinary failures.",
        "Do not opportunistically complete another Work Issue",
        "Conductor owns commits and delivery.",
        "progress artifacts belong in Linear",
    ),
    "verify": (
        "supplied immutable target revision",
        "Every acceptance criterion and verification requirement",
        "A reported pass without matching evidence is not a pass.",
        "Use verify_inconclusive when evidence cannot establish a conclusion.",
        "Root REVIEW belongs to the Root Reconciler",
        "Verify conclusions belong in the VerifyResult that Conductor persists to Linear.",
    ),
}


def test_role_prompt_resources_have_the_required_workflow_structure() -> None:
    resources = _read_resources(PROMPT_DIRECTORY)

    for role, content in resources.items():
        assert content.startswith(ROLE_OPENING_LINES[role])
        assert all(content.count(section) == 1 for section in COMMON_SECTIONS)
        assert content.count("```mermaid") == 1
        assert content.count("flowchart TD") == 1
        assert all(requirement in content for requirement in ROLE_REQUIREMENTS[role])


def test_loader_eagerly_returns_the_complete_immutable_role_catalog() -> None:
    catalog = load_role_prompt_catalog()
    resources = _read_resources(PROMPT_DIRECTORY)

    assert {role: catalog.for_role(role) for role in ROLE_RESOURCES} == resources
    with pytest.raises(TypeError):
        catalog._prompts["plan"] = "replacement"  # type: ignore[index]


def test_loader_rejects_an_unknown_role() -> None:
    catalog = load_role_prompt_catalog()

    with pytest.raises(PromptResourceError, match="performer_prompt_role_unknown"):
        catalog.for_role("other")


@pytest.mark.parametrize(
    ("mutation", "code"),
    [
        ("missing", "performer_prompt_resource_missing"),
        ("unreadable", "performer_prompt_resource_unreadable"),
        ("empty", "performer_prompt_resource_empty"),
        ("duplicate", "performer_prompt_resource_duplicate"),
        ("non_english", "performer_prompt_resource_not_english"),
        ("role_mismatch", "performer_prompt_resource_role_mismatch"),
        ("unexpected", "performer_prompt_resource_set_invalid"),
        ("nested", "performer_prompt_resource_set_invalid"),
    ],
)
def test_role_prompt_resource_validation_rejects_invalid_resource_sets(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    mutation: str,
    code: str,
) -> None:
    resource_directory = tmp_path / "package" / "prompts"
    copytree(PROMPT_DIRECTORY, resource_directory)
    monkeypatch.setattr(prompt_resources, "files", lambda _: resource_directory.parent)
    if mutation == "unreadable":
        original_read_text = Path.read_text

        def unreadable(path: Path, *args: object, **kwargs: object) -> str:
            if path == resource_directory / ROLE_RESOURCES["plan"]:
                raise OSError("denied")
            return original_read_text(path, *args, **kwargs)

        monkeypatch.setattr(Path, "read_text", unreadable)
    else:
        _mutate(resource_directory, mutation)

    with pytest.raises(PromptResourceError, match=code):
        load_role_prompt_catalog()


def test_process_composition_eagerly_validates_the_prompt_catalog(monkeypatch: pytest.MonkeyPatch) -> None:
    from performer import __main__ as performer_main

    loaded: list[object] = []

    class Host:
        def __init__(self, *_: object, **__: object) -> None:
            pass

        def iter_lines(self, *_: object) -> tuple[()]:
            return ()

        def cancel(self) -> None:
            pass

    monkeypatch.setattr(performer_main, "load_role_prompt_catalog", lambda: loaded.append(object()))
    monkeypatch.setattr(performer_main, "create_sdk", lambda: object())
    monkeypatch.setattr(performer_main, "AgentProtocolHost", Host)
    monkeypatch.setattr(performer_main.signal, "signal", lambda *_: None)
    monkeypatch.setattr(performer_main.sys, "argv", ["performer", "--agent"])
    monkeypatch.setattr(performer_main.sys, "stdin", type("Input", (), {"buffer": object()})())

    performer_main.main()

    assert len(loaded) == 1


def test_built_wheel_loads_prompt_resources_outside_the_source_checkout(tmp_path: Path) -> None:
    wheel_directory = tmp_path / "wheel"
    installed_directory = tmp_path / "installed"
    subprocess.run(
        [
            sys.executable,
            "-m",
            "pip",
            "wheel",
            "--no-deps",
            "--no-build-isolation",
            "--wheel-dir",
            str(wheel_directory),
            str(PERFORMER_DIRECTORY),
        ],
        check=True,
        capture_output=True,
        text=True,
    )
    wheel = next(wheel_directory.glob("symphony_performer-*.whl"))
    subprocess.run(
        [sys.executable, "-m", "pip", "install", "--no-deps", "--target", str(installed_directory), str(wheel)],
        check=True,
        capture_output=True,
        text=True,
    )
    environment = {**os.environ, "PYTHONPATH": str(installed_directory)}
    probe = (
        "from pathlib import Path\n"
        "import performer\n"
        "from performer.prompt_resources import load_role_prompt_catalog\n"
        f"installed = Path({str(installed_directory)!r}).resolve()\n"
        "assert Path(performer.__file__).resolve().is_relative_to(installed)\n"
        "assert load_role_prompt_catalog().for_role('verify').startswith('You are the Symphony Verify role.')\n"
    )
    subprocess.run(
        [sys.executable, "-c", probe],
        check=True,
        cwd=tmp_path,
        env=environment,
        capture_output=True,
        text=True,
    )


def _read_resources(resource_directory: Path) -> dict[str, str]:
    resources: dict[str, str] = {}
    for role, filename in ROLE_RESOURCES.items():
        path = resource_directory / filename
        if not path.is_file():
            raise ValueError("performer_prompt_resource_missing")
        content = path.read_text(encoding="utf-8").strip()
        if not content:
            raise ValueError("performer_prompt_resource_empty")
        if not content.isascii():
            raise ValueError("performer_prompt_resource_not_english")
        resources[role] = content
    if {
        path.relative_to(resource_directory).as_posix()
        for path in resource_directory.rglob("*.md")
    } != set(ROLE_RESOURCES.values()):
        raise ValueError("performer_prompt_resource_set_invalid")
    if len(set(resources.values())) != len(resources):
        raise ValueError("performer_prompt_resource_duplicate")
    for role, content in resources.items():
        if not content.startswith(ROLE_OPENING_LINES[role]):
            raise ValueError("performer_prompt_resource_role_mismatch")
    return resources


def _mutate(resource_directory: Path, mutation: str) -> None:
    plan = resource_directory / ROLE_RESOURCES["plan"]
    if mutation == "missing":
        plan.unlink()
    elif mutation == "empty":
        plan.write_text("\n", encoding="utf-8")
    elif mutation == "duplicate":
        plan.write_text((resource_directory / ROLE_RESOURCES["work"]).read_text(encoding="utf-8"), encoding="utf-8")
    elif mutation == "non_english":
        plan.write_text("\u4e0d\u662f English", encoding="utf-8")
    elif mutation == "role_mismatch":
        plan.write_text("You are the Symphony Other role.", encoding="utf-8")
    elif mutation == "unexpected":
        (resource_directory / "other.md").write_text("You are the Symphony Other role.", encoding="utf-8")
    elif mutation == "nested":
        nested = resource_directory / "nested"
        nested.mkdir()
        (nested / "other.md").write_text("You are the Symphony Other role.", encoding="utf-8")
    else:
        raise AssertionError(f"Unknown mutation: {mutation}")
