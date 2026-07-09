from __future__ import annotations

from pathlib import Path
import re


ROOTS = [
    Path("AGENT.md"),
    Path("AGENTS.md"),
    Path("CLAUDE.md"),
    Path("Makefile"),
    Path("README.md"),
    Path("docs"),
    Path("packages"),
    Path("tests"),
    Path("tools"),
]


def test_repository_no_longer_uses_previous_managed_runs_term() -> None:
    forbidden = ["har" + "ness", "Har" + "ness", "HAR" + "NESS"]
    offenders: list[str] = []
    for path in _candidate_paths():
        path_text = str(path)
        if any(term in path_text for term in forbidden):
            offenders.append(path_text)
            continue
        if not path.is_file():
            continue
        try:
            text = path.read_text(encoding="utf-8")
        except UnicodeDecodeError:
            continue
        for term in forbidden:
            if term in text:
                offenders.append(path_text)
                break

    assert offenders == []


def test_managed_runs_contract_module_is_plural() -> None:
    singular_import = re.compile(r"performer_api\.managed_" + r"run(?!s)\b")
    offenders: list[str] = []
    for path in _candidate_paths():
        if not path.is_file():
            continue
        try:
            text = path.read_text(encoding="utf-8")
        except UnicodeDecodeError:
            continue
        if singular_import.search(text):
            offenders.append(str(path))

    assert offenders == []


def _candidate_paths() -> list[Path]:
    paths: list[Path] = []
    for root in ROOTS:
        if root.is_file():
            paths.append(root)
        elif root.is_dir():
            paths.extend(
                path
                for path in root.rglob("*")
                if not any(part in {".git", ".venv", "node_modules", "__pycache__", ".pytest_cache"} for part in path.parts)
            )
    return paths
