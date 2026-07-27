from __future__ import annotations

from dataclasses import dataclass
from importlib.resources import files
from importlib.resources.abc import Traversable
from types import MappingProxyType
from typing import Literal, Mapping, cast


Role = Literal["root_reconciler", "plan", "work", "verify"]

ROLE_RESOURCE_NAMES: Mapping[Role, str] = MappingProxyType({
    "root_reconciler": "root-reconciler.md",
    "plan": "plan.md",
    "work": "work.md",
    "verify": "verify.md",
})

ROLE_OPENING_LINES: Mapping[Role, str] = MappingProxyType({
    "root_reconciler": "You are the Symphony Root Reconciler.",
    "plan": "You are the Symphony Plan role.",
    "work": "You are the Symphony Work role.",
    "verify": "You are the Symphony Verify role.",
})


class PromptResourceError(ValueError):
    def __init__(self, code: str) -> None:
        super().__init__(code)
        self.code = code


@dataclass(frozen=True)
class RolePromptCatalog:
    _prompts: Mapping[Role, str]

    def for_role(self, role: str) -> str:
        if role not in ROLE_RESOURCE_NAMES:
            raise PromptResourceError("performer_prompt_role_unknown")
        return self._prompts[cast(Role, role)]


def load_role_prompt_catalog() -> RolePromptCatalog:
    try:
        directory = files("performer").joinpath("prompts")
    except (ModuleNotFoundError, OSError, TypeError) as error:
        raise PromptResourceError("performer_prompt_resource_unreadable") from error

    prompts: dict[Role, str] = {}
    for role, filename in ROLE_RESOURCE_NAMES.items():
        resource = directory.joinpath(filename)
        try:
            if not resource.is_file():
                raise PromptResourceError("performer_prompt_resource_missing")
            content = resource.read_text(encoding="utf-8").strip()
        except PromptResourceError:
            raise
        except (OSError, UnicodeError) as error:
            raise PromptResourceError("performer_prompt_resource_unreadable") from error
        if not content:
            raise PromptResourceError("performer_prompt_resource_empty")
        if not content.isascii():
            raise PromptResourceError("performer_prompt_resource_not_english")
        prompts[role] = content

    if _markdown_resource_paths(directory) != set(ROLE_RESOURCE_NAMES.values()):
        raise PromptResourceError("performer_prompt_resource_set_invalid")
    if len(set(prompts.values())) != len(prompts):
        raise PromptResourceError("performer_prompt_resource_duplicate")
    for role, content in prompts.items():
        if not content.startswith(ROLE_OPENING_LINES[role]):
            raise PromptResourceError("performer_prompt_resource_role_mismatch")
    return RolePromptCatalog(MappingProxyType(prompts))


def _markdown_resource_paths(directory: Traversable, relative_path: str = "") -> set[str]:
    try:
        resources = directory.iterdir()
    except (AttributeError, OSError, TypeError) as error:
        raise PromptResourceError("performer_prompt_resource_unreadable") from error

    paths: set[str] = set()
    for resource in resources:
        path = f"{relative_path}{resource.name}"
        try:
            if resource.is_dir():
                paths.update(_markdown_resource_paths(resource, f"{path}/"))
            elif resource.is_file() and resource.name.endswith(".md"):
                paths.add(path)
        except (AttributeError, OSError, TypeError) as error:
            raise PromptResourceError("performer_prompt_resource_unreadable") from error
    return paths
