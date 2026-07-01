from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Any

import yaml
from jinja2 import Environment, StrictUndefined, TemplateAssertionError, TemplateError, TemplateSyntaxError


@dataclass(frozen=True)
class WorkflowDefinition:
    config: dict[str, Any]
    prompt_template: str


class WorkflowError(Exception):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code


def load_workflow(path: Path) -> WorkflowDefinition:
    if not path.exists():
        raise WorkflowError("missing_workflow_file", f"Workflow file not found: {path}")
    try:
        text = path.read_text(encoding="utf-8")
    except OSError as exc:
        raise WorkflowError("missing_workflow_file", str(exc)) from exc

    if not text.startswith("---"):
        return WorkflowDefinition(config={}, prompt_template=text.strip())

    parts = text.split("---", 2)
    if len(parts) < 3:
        raise WorkflowError("workflow_parse_error", "YAML front matter is not closed")

    raw_yaml = parts[1]
    body = parts[2].strip()
    try:
        parsed = yaml.safe_load(raw_yaml) if raw_yaml.strip() else {}
    except yaml.YAMLError as exc:
        raise WorkflowError("workflow_parse_error", str(exc)) from exc

    if parsed is None:
        parsed = {}
    if not isinstance(parsed, dict):
        raise WorkflowError("workflow_front_matter_not_a_map", "Workflow front matter must be a map")

    return WorkflowDefinition(config=parsed, prompt_template=body)


def render_prompt(template: str, variables: dict[str, Any]) -> str:
    source = template.strip() or "You are working on an issue from Linear."
    env = Environment(undefined=StrictUndefined, autoescape=False)
    try:
        compiled = env.from_string(source)
        return compiled.render(**variables)
    except TemplateAssertionError as exc:
        raise WorkflowError("template_render_error", str(exc)) from exc
    except TemplateSyntaxError as exc:
        raise WorkflowError("template_parse_error", str(exc)) from exc
    except TemplateError as exc:
        raise WorkflowError("template_render_error", str(exc)) from exc
