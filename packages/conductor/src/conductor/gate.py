from __future__ import annotations

import subprocess
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from performer_api.turns import GateResult
from performer_api.workflow import Task


@dataclass(frozen=True)
class CommandResult:
    command: str
    passed: bool
    exit_code: int | None
    output: str

    def to_dict(self) -> dict[str, Any]:
        return {
            "command": self.command,
            "passed": self.passed,
            "exit_code": self.exit_code,
            "output": self.output,
        }


class AcceptanceGate:
    def __init__(self, *, timeout_seconds: int = 300) -> None:
        self.timeout_seconds = timeout_seconds

    def run_commands(self, task: Task, workspace: Path) -> list[CommandResult]:
        return [self._run(command, workspace) for command in task.verification_commands]

    def evaluate(
        self,
        task: Task,
        workspace: Path,
        codex_result: GateResult,
    ) -> tuple[GateResult, dict[str, Any]]:
        commands = self.run_commands(task, workspace)
        commands_passed = all(result.passed for result in commands)
        passed = commands_passed and codex_result.passed and codex_result.score >= codex_result.threshold
        findings = list(codex_result.findings)
        if not commands_passed:
            findings.append("verification_command_failed")
        evidence = {"commands": [result.to_dict() for result in commands]}
        return GateResult(
            passed=passed,
            score=codex_result.score,
            threshold=codex_result.threshold,
            rubric=codex_result.rubric,
            provenance=codex_result.provenance,
            findings=findings,
            artifact_refs=codex_result.artifact_refs,
        ), evidence

    def _run(self, command: str, workspace: Path) -> CommandResult:
        try:
            completed = subprocess.run(
                command,
                cwd=workspace,
                shell=True,
                capture_output=True,
                text=True,
                timeout=self.timeout_seconds,
                check=False,
            )
        except subprocess.TimeoutExpired as exc:
            return CommandResult(command, False, None, _tail(exc.stdout, exc.stderr))
        except OSError as exc:
            return CommandResult(command, False, None, str(exc))
        return CommandResult(command, completed.returncode == 0, completed.returncode, _tail(completed.stdout, completed.stderr))


def _tail(stdout: str | bytes | None, stderr: str | bytes | None, limit: int = 4000) -> str:
    def text(value: str | bytes | None) -> str:
        return value.decode(errors="replace") if isinstance(value, bytes) else str(value or "")

    combined = "\n".join(part for part in (text(stdout), text(stderr)) if part).strip()
    return combined[-limit:]


__all__ = ["AcceptanceGate", "CommandResult"]
