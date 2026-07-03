from __future__ import annotations

import ast
from pathlib import Path


APP_PATH = Path("packages/podium/src/podium/app.py")


def test_managed_podium_state_does_not_declare_business_collections() -> None:
    tree = ast.parse(APP_PATH.read_text(encoding="utf-8"))
    state_class = next(
        node
        for node in tree.body
        if isinstance(node, ast.ClassDef) and node.name == "ManagedPodiumState"
    )

    offenders: list[str] = []
    for node in state_class.body:
        if not isinstance(node, ast.AnnAssign) or not isinstance(node.annotation, ast.Subscript):
            continue
        name = node.target.id if isinstance(node.target, ast.Name) else "<unknown>"
        annotation = ast.unparse(node.annotation)
        if annotation.startswith(("dict[", "list[")):
            offenders.append(name)

    assert offenders == []


def test_podium_app_no_longer_uses_legacy_onboarding_store() -> None:
    source = APP_PATH.read_text(encoding="utf-8")

    assert "from .onboarding import OnboardingStore" not in source
    assert "app.state.onboarding" not in source
