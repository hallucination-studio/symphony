from __future__ import annotations

import logging
import re
import sqlite3
import uuid
from pathlib import Path
from typing import Any, Callable

from .conductor_bindings import DesiredBinding
from .desktop_commands import CommandError
from .store.bindings import BindingConflict, BindingRepository

LOGGER = logging.getLogger(__name__)
CONDUCTOR_COMMANDS = frozenset({"conductor.create"})
_PROJECT_ID = re.compile(r"[A-Za-z0-9][A-Za-z0-9._:-]{0,199}")


def dispatch_conductor_command(
    command: str,
    input_value: object,
    repository: BindingRepository,
    *,
    id_factory: Callable[[], str] | None = None,
) -> dict[str, Any]:
    if not isinstance(input_value, dict) or command != "conductor.create" or set(
        input_value
    ) != {
        "project_id",
        "repository",
    }:
        raise CommandError("desktop_command_input_invalid", "command_input_invalid")
    project_id = _identifier(input_value.get("project_id"))
    repository_path = _canonical_directory(input_value.get("repository"))
    unique_id = (id_factory or _unique_id)()
    conductor_id = f"conductor-{unique_id}"
    binding = DesiredBinding(
        binding_id=f"binding-{unique_id}",
        project_id=project_id,
        conductor_id=conductor_id,
        generation=1,
        repository_path=repository_path,
        data_root_key=conductor_id,
    )
    try:
        repository.create(binding)
    except BindingConflict as error:
        _raise_create_failure(str(error), binding, retryable=False)
    except sqlite3.Error:
        _raise_create_failure(
            "create_conductor_persistence_failed", binding, retryable=True
        )
    return {
        "binding_id": binding.binding_id,
        "project_id": binding.project_id,
        "conductor_id": binding.conductor_id,
        "generation": binding.generation,
        "desired": binding.desired_state,
        "observed": binding.observed_state,
    }


def _identifier(value: object) -> str:
    if not isinstance(value, str) or _PROJECT_ID.fullmatch(value) is None:
        raise CommandError("desktop_command_input_invalid", "command_input_invalid") from None
    return value


def _canonical_directory(value: object) -> str:
    if not isinstance(value, str) or not value or len(value) > 4096 or "\x00" in value:
        raise CommandError("desktop_command_input_invalid", "command_input_invalid")
    candidate = Path(value)
    try:
        canonical = candidate.resolve(strict=True)
    except OSError:
        raise CommandError("desktop_command_input_invalid", "command_input_invalid") from None
    if not candidate.is_absolute() or canonical != candidate or not canonical.is_dir():
        raise CommandError("desktop_command_input_invalid", "command_input_invalid")
    return str(canonical)


def _unique_id() -> str:
    return uuid.uuid4().hex


def _raise_create_failure(
    code: str, binding: DesiredBinding, *, retryable: bool
) -> None:
    LOGGER.error(
        "event=create_conductor_failed error_type=create_conductor "
        "binding_id=%s project_id=%s conductor_id=%s generation=%s "
        "error_code=%s sanitized_reason=%s action_required=true retryable=%s "
        "next_action=%s",
        binding.binding_id,
        binding.project_id,
        binding.conductor_id,
        binding.generation,
        code,
        code,
        str(retryable).lower(),
        "retry_create_conductor" if retryable else "choose_another_project_or_repository",
    )
    raise CommandError(
        code,
        code,
        action_required=True,
        retryable=retryable,
        next_action=(
            "retry_create_conductor"
            if retryable
            else "choose_another_project_or_repository"
        ),
    )
