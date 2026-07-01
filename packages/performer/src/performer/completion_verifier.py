"""完成验证模块 - 确保任务真的完成了"""
from __future__ import annotations

import subprocess
import os
import shlex
import sys
from pathlib import Path
from typing import Any, Protocol

from performer_api.config import CompletionVerificationConfig
from performer_api.models import Issue
from performer_api.ops_models import CheckResult, CompletionVerdict, OpsSnapshot


class TrackerProtocol(Protocol):
    async def fetch_issue_states_by_ids(self, issue_ids: list[str]) -> list[Issue]: ...


def _utc_now_iso() -> str:
    from datetime import datetime, timezone

    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def _command_evidence_from_payload(payload: Any) -> tuple[str | None, int | None]:
    if not isinstance(payload, dict):
        return None, None
    command = payload.get("command")
    exit_code_raw = payload.get("exit_code")
    if not isinstance(command, str) or not command.strip():
        nested = payload.get("payload")
        if isinstance(nested, dict):
            command = nested.get("command")
            exit_code_raw = nested.get("exit_code")
    exit_code = exit_code_raw if isinstance(exit_code_raw, int) and not isinstance(exit_code_raw, bool) else None
    return command if isinstance(command, str) else None, exit_code


def _parse_recorded_command(command: str) -> tuple[list[str], dict[str, str]] | None:
    try:
        parts = shlex.split(command)
    except ValueError:
        return None
    if not parts:
        return None
    env = os.environ.copy()
    while parts and "=" in parts[0] and not parts[0].startswith("-"):
        key, value = parts[0].split("=", 1)
        if not key.replace("_", "").isalnum():
            return None
        env[key] = value
        parts = parts[1:]
    if not parts:
        return None
    if parts[0] in {"pytest", "py.test"}:
        return parts, env
    if len(parts) >= 3 and parts[1:3] == ["-m", "pytest"]:
        if parts[0] in {"python", "python3"}:
            parts[0] = sys.executable
        return parts, env
    return None


def _env_evidence(env: dict[str, str] | None) -> dict[str, str]:
    if not env:
        return {}
    evidence: dict[str, str] = {}
    pythonpath = env.get("PYTHONPATH")
    if pythonpath:
        evidence["PYTHONPATH"] = pythonpath
    return evidence


class CompletionVerifier:
    """
    完成验证器 - 在 Codex 报告完成后独立验证实际产出

    基于 Superpowers 的 verification-before-completion 原则：
    - Evidence before claims (证据先于断言)
    - Independent verification (独立验证)
    - No blind trust (不盲目信任)
    """

    def __init__(self, config: CompletionVerificationConfig, tracker: TrackerProtocol):
        self.config = config
        self.tracker = tracker

    async def verify_completion(
        self, issue: Issue, workspace_path: Path, ops_snapshot: OpsSnapshot
    ) -> CompletionVerdict:
        """
        执行所有验证检查并返回判定

        Returns:
            CompletionVerdict with status:
            - VERIFIED: 可以标记完成
            - NEEDS_RETRY: 需要重试
            - NEEDS_HUMAN: 需要人工判断
        """
        if not self.config.enabled:
            return CompletionVerdict(
                status="VERIFIED",
                reason="Verification disabled",
                checks=[],
                verified_at=_utc_now_iso(),
                evidence={},
            )

        # 运行所有检查
        checks: list[CheckResult] = []
        all_check_names = self.config.required_checks + self.config.optional_checks

        if "workspace_changes" in all_check_names:
            checks.append(await self._check_workspace_changes(workspace_path))

        if "repo_path" in all_check_names:
            checks.append(self._check_repo_path(workspace_path))

        if "test_results" in all_check_names:
            checks.append(await self._check_test_results(issue, workspace_path, ops_snapshot))

        if "test_command_evidence" in all_check_names:
            checks.append(self._check_test_command_evidence(issue, ops_snapshot))

        if "metrics_reasonable" in all_check_names:
            checks.append(self._check_metrics_reasonable(ops_snapshot))

        if "linear_state" in all_check_names:
            checks.append(await self._check_linear_state(issue))

        # 聚合判定
        return self._aggregate_verdict(checks)

    def _check_repo_path(self, workspace_path: Path) -> CheckResult:
        """检查 workspace 是否是当前目标仓库且路径可信"""
        try:
            resolved = workspace_path.resolve()
            if not resolved.exists():
                return CheckResult(
                    check_name="repo_path",
                    passed=False,
                    message=f"Workspace path does not exist: {resolved}",
                    evidence={"workspace_path": str(resolved)},
                )
            if not (resolved / ".git").exists():
                return CheckResult(
                    check_name="repo_path",
                    passed=False,
                    message=f"Workspace is not a git repo: {resolved}",
                    evidence={"workspace_path": str(resolved)},
                )
            expected_root = self.config.expected_repo_root
            if expected_root:
                expected = Path(expected_root).resolve()
                try:
                    resolved.relative_to(expected)
                except ValueError:
                    return CheckResult(
                        check_name="repo_path",
                        passed=False,
                        message=f"Workspace path is outside expected repo root: {resolved}",
                        evidence={"workspace_path": str(resolved), "expected_repo_root": str(expected)},
                    )
            return CheckResult(
                check_name="repo_path",
                passed=True,
                message=f"Workspace path verified: {resolved}",
                evidence={"workspace_path": str(resolved)},
            )
        except Exception as exc:
            return CheckResult(
                check_name="repo_path",
                passed=False,
                message=f"Repo path check failed: {exc}",
                evidence={"workspace_path": str(workspace_path), "error": str(exc)},
            )

    async def _check_workspace_changes(self, workspace_path: Path) -> CheckResult:
        """检查 workspace 是否有实际变更"""
        try:
            # 检查 git 仓库
            if not (workspace_path / ".git").exists():
                return CheckResult(
                    check_name="workspace_changes",
                    passed=False,
                    message="Not a git repo",
                    evidence={"status": "not_git_repo"},
                )

            # 运行 git status，允许纯新增未跟踪文件也算有效产出
            status_result = subprocess.run(
                ["git", "status", "--short"],
                cwd=workspace_path,
                capture_output=True,
                text=True,
                timeout=10,
            )
            status_output = status_result.stdout.strip()
            if not status_output:
                return CheckResult(
                    check_name="workspace_changes",
                    passed=False,
                    message="No files changed",
                    evidence={"git_status": "empty"},
                )

            diff_result = subprocess.run(
                ["git", "diff", "--stat", "HEAD"],
                cwd=workspace_path,
                capture_output=True,
                text=True,
                timeout=10,
            )
            stat_output = diff_result.stdout.strip()
            content_size = len(stat_output)

            if content_size < self.config.min_workspace_changes_chars:
                untracked_chars = 0
                for line in status_output.splitlines():
                    if line.startswith("?? "):
                        rel_path = line[3:].strip()
                        candidate = workspace_path / rel_path
                        if candidate.is_file():
                            untracked_chars += len(candidate.read_text(encoding="utf-8", errors="ignore"))
                content_size = max(content_size, untracked_chars)

            if content_size < self.config.min_workspace_changes_chars:
                return CheckResult(
                    check_name="workspace_changes",
                    passed=False,
                    message=(
                        f"Changes too minimal ({content_size} chars < "
                        f"{self.config.min_workspace_changes_chars})"
                    ),
                    evidence={
                        "diff_stat": stat_output or "empty",
                        "git_status": status_output,
                        "change_chars": content_size,
                    },
                )

            lines = stat_output.splitlines()
            summary = lines[0] if lines else status_output.splitlines()[0]

            return CheckResult(
                check_name="workspace_changes",
                passed=True,
                message=f"Changes detected: {summary}",
                evidence={
                    "diff_stat": stat_output or "empty",
                    "git_status": status_output,
                    "change_chars": content_size,
                },
            )

        except subprocess.TimeoutExpired:
            return CheckResult(
                check_name="workspace_changes",
                passed=False,
                message="Git command timeout",
                evidence={"status": "timeout"},
            )
        except Exception as e:
            return CheckResult(
                check_name="workspace_changes",
                passed=False,
                message=f"Check failed: {e}",
                evidence={"error": str(e)},
            )

    async def _check_test_results(self, issue: Issue, workspace_path: Path, ops_snapshot: OpsSnapshot) -> CheckResult:
        """检查测试是否通过"""
        try:
            # 检测项目类型
            cmd: list[str] | None = None
            env: dict[str, str] | None = None
            test_framework = "unknown"

            if (workspace_path / "package.json").exists():
                cmd = ["npm", "test"]
                test_framework = "npm"
            elif (workspace_path / "pyproject.toml").exists() or (workspace_path / "pytest.ini").exists():
                recorded = self._recorded_successful_pytest_command(issue, ops_snapshot)
                if recorded is not None:
                    cmd, env = recorded
                else:
                    cmd = [sys.executable, "-m", "pytest", "-v", "--tb=short"]
                    env = self._python_test_env(workspace_path)
                    if self.config.expected_test_patterns:
                        cmd.extend(self.config.expected_test_patterns)
                test_framework = "pytest"
            elif (workspace_path / "Cargo.toml").exists():
                cmd = ["cargo", "test"]
                test_framework = "cargo"

            if cmd is None:
                return CheckResult(
                    check_name="test_results",
                    passed=False,
                    message="No test framework detected",
                    evidence={"status": "no_framework"},
                )

            if test_framework == "pytest" and self.config.expected_test_patterns:
                missing = [pattern for pattern in self.config.expected_test_patterns if pattern not in cmd]
                if missing:
                    return CheckResult(
                        check_name="test_results",
                        passed=False,
                        message=f"Focused test pattern missing from pytest command: {', '.join(missing)}",
                        evidence={"expected_test_patterns": self.config.expected_test_patterns, "command": cmd},
                    )

            # 运行测试
            result = subprocess.run(
                cmd,
                cwd=workspace_path,
                capture_output=True,
                text=True,
                timeout=self.config.test_timeout_seconds,
                env=env,
            )

            output_tail = result.stdout[-500:] if result.stdout else ""
            error_tail = result.stderr[-500:] if result.stderr else ""

            if result.returncode == 0:
                return CheckResult(
                    check_name="test_results",
                    passed=True,
                    message=f"Tests passed ({test_framework})",
                    evidence={
                        "exit_code": 0,
                        "framework": test_framework,
                        "command": cmd,
                        "env": _env_evidence(env),
                        "output": output_tail,
                    },
                )
            else:
                return CheckResult(
                    check_name="test_results",
                    passed=False,
                    message=f"Tests failed (exit {result.returncode}, {test_framework})",
                    evidence={
                        "exit_code": result.returncode,
                        "framework": test_framework,
                        "command": cmd,
                        "env": _env_evidence(env),
                        "output": output_tail,
                        "errors": error_tail,
                    },
                )

        except subprocess.TimeoutExpired:
            return CheckResult(
                check_name="test_results",
                passed=False,
                message=f"Tests timed out (>{self.config.test_timeout_seconds}s)",
                evidence={"status": "timeout"},
            )
        except FileNotFoundError as e:
            return CheckResult(
                check_name="test_results",
                passed=False,
                message=f"Test command not found: {e}",
                evidence={"status": "command_not_found"},
            )
        except Exception as e:
            return CheckResult(
                check_name="test_results",
                passed=False,
                message=f"Test check failed: {e}",
                evidence={"error": str(e)},
            )

    def _recorded_successful_pytest_command(
        self,
        issue: Issue,
        ops_snapshot: OpsSnapshot,
    ) -> tuple[list[str], dict[str, str]] | None:
        patterns = [pattern for pattern in self.config.expected_test_patterns if pattern]
        if not patterns:
            return None
        issue_run_ids = {
            run.run_id
            for run in ops_snapshot.runs.values()
            if run.issue_id == issue.id
        }
        for event in ops_snapshot.events:
            if event.issue_id != issue.id and event.run_id not in issue_run_ids:
                continue
            command, exit_code = _command_evidence_from_payload(event.payload)
            if exit_code != 0 or not isinstance(command, str):
                continue
            if "pytest" not in command or not any(pattern in command for pattern in patterns):
                continue
            parsed = _parse_recorded_command(command)
            if parsed is not None:
                return parsed
        return None

    def _python_test_env(self, workspace_path: Path) -> dict[str, str] | None:
        if not (workspace_path / "src").is_dir():
            return None
        env = os.environ.copy()
        existing = env.get("PYTHONPATH")
        env["PYTHONPATH"] = "src" if not existing else f"src{os.pathsep}{existing}"
        return env

    def _check_test_command_evidence(self, issue: Issue, ops_snapshot: OpsSnapshot) -> CheckResult:
        patterns = [pattern for pattern in self.config.expected_test_patterns if pattern]
        if not patterns:
            return CheckResult(
                check_name="test_command_evidence",
                passed=True,
                message="No expected test patterns configured; skipping test command evidence check",
                evidence={"expected_test_patterns": []},
            )
        issue_run_ids = {
            run.run_id
            for run in ops_snapshot.runs.values()
            if run.issue_id == issue.id
        }
        commands: list[tuple[str, int | None]] = []
        for event in ops_snapshot.events:
            if event.issue_id != issue.id and event.run_id not in issue_run_ids:
                continue
            command, exit_code = _command_evidence_from_payload(event.payload)
            if not isinstance(command, str) or not command.strip():
                continue
            commands.append((command.strip(), exit_code))
        if not commands:
            return CheckResult(
                check_name="test_command_evidence",
                passed=False,
                message="No test command evidence recorded in ops snapshot",
                evidence={"expected_test_patterns": patterns},
            )
        for pattern in patterns:
            for command, exit_code in commands:
                if pattern in command and exit_code == 0:
                    return CheckResult(
                        check_name="test_command_evidence",
                        passed=True,
                        message=f"Matched test command evidence for pattern: {pattern}",
                        evidence={"command": command, "exit_code": exit_code},
                    )
        return CheckResult(
            check_name="test_command_evidence",
            passed=False,
            message="No successful recorded test command matched the expected patterns",
            evidence={
                "expected_test_patterns": patterns,
                "commands": [{"command": command, "exit_code": exit_code} for command, exit_code in commands],
            },
        )

    def _check_metrics_reasonable(self, ops_snapshot: OpsSnapshot) -> CheckResult:
        """检查 metrics 是否合理"""
        try:
            if not ops_snapshot.runs:
                return CheckResult(
                    check_name="metrics_reasonable",
                    passed=False,
                    message="No run data",
                    evidence={},
                )

            latest_run = list(ops_snapshot.runs.values())[-1]

            # 检查 turn count
            if latest_run.turn_count == 0:
                return CheckResult(
                    check_name="metrics_reasonable",
                    passed=False,
                    message="Zero turns (no actual work)",
                    evidence={"turn_count": 0},
                )

            # 检查 duration
            if latest_run.started_at:
                from datetime import datetime, timezone

                started = datetime.fromisoformat(latest_run.started_at.replace("Z", "+00:00"))
                now = datetime.now(timezone.utc)
                duration_sec = (now - started).total_seconds()

                if duration_sec < self.config.min_duration_seconds:
                    return CheckResult(
                        check_name="metrics_reasonable",
                        passed=False,
                        message=f"Suspiciously fast ({duration_sec:.1f}s < {self.config.min_duration_seconds}s)",
                        evidence={"duration_sec": duration_sec},
                    )

            # 检查 tool calls. Older telemetry snapshots may store tool calls only
            # as trace events, so derive a fallback count from the run event stream.
            tool_call_count = latest_run.tool_call_count or sum(
                1
                for event in ops_snapshot.events
                if event.run_id == latest_run.run_id and event.event_type in {"tool_call_started", "tool_call_completed"}
            )
            if tool_call_count == 0:
                return CheckResult(
                    check_name="metrics_reasonable",
                    passed=False,
                    message="No tool calls (likely no actual work)",
                    evidence={"tool_call_count": 0},
                )

            return CheckResult(
                check_name="metrics_reasonable",
                passed=True,
                message=f"Metrics normal ({latest_run.turn_count} turns, {tool_call_count} tools)",
                evidence={
                    "turn_count": latest_run.turn_count,
                    "tool_call_count": tool_call_count,
                },
            )

        except Exception as e:
            return CheckResult(
                check_name="metrics_reasonable",
                passed=False,
                message=f"Metrics check failed: {e}",
                evidence={"error": str(e)},
            )

    async def _check_linear_state(self, issue: Issue) -> CheckResult:
        """检查 Linear 状态一致性"""
        try:
            # 重新查询 Linear
            fresh_issues = await self.tracker.fetch_issue_states_by_ids([issue.id])

            if not fresh_issues:
                return CheckResult(
                    check_name="linear_state",
                    passed=False,
                    message="Issue not found in Linear",
                    evidence={"issue_id": issue.id},
                )

            fresh_issue = fresh_issues[0]

            # 检查是否还有未解除的 blocker
            if fresh_issue.blocked_by:
                blockers = [
                    {
                        "id": blocker.id,
                        "identifier": blocker.identifier,
                        "state": blocker.state,
                    }
                    for blocker in fresh_issue.blocked_by
                ]
                return CheckResult(
                    check_name="linear_state",
                    passed=False,
                    message=f"Active blockers remain: {len(fresh_issue.blocked_by)}",
                    evidence={"blockers": blockers},
                )

            return CheckResult(
                check_name="linear_state",
                passed=True,
                message=f"Linear state valid: {fresh_issue.state}",
                evidence={"state": fresh_issue.state},
            )

        except Exception as e:
            return CheckResult(
                check_name="linear_state",
                passed=False,
                message=f"Linear check failed: {e}",
                evidence={"error": str(e)},
            )

    def _aggregate_verdict(self, checks: list[CheckResult]) -> CompletionVerdict:
        """
        聚合所有检查结果，给出最终判定

        判定逻辑:
        - 关键检查 (required_checks) 必须全部通过
        - 可选检查 (optional_checks) 失败 → 人工判断
        """
        # 关键检查必须全部通过
        critical_failed = [c for c in checks if c.check_name in self.config.required_checks and not c.passed]

        if critical_failed:
            return CompletionVerdict(
                status="NEEDS_RETRY",
                reason=f"Critical checks failed: {', '.join(c.check_name for c in critical_failed)}",
                checks=checks,
                verified_at=_utc_now_iso(),
                evidence={"failed_checks": [c.to_dict() for c in critical_failed]},
            )

        # 可选检查失败 → 人工判断
        optional_failed = [c for c in checks if c.check_name in self.config.optional_checks and not c.passed]

        if optional_failed:
            return CompletionVerdict(
                status="NEEDS_HUMAN",
                reason=f"Optional checks need review: {', '.join(c.check_name for c in optional_failed)}",
                checks=checks,
                verified_at=_utc_now_iso(),
                evidence={"warning_checks": [c.to_dict() for c in optional_failed]},
            )

        # 全部通过
        return CompletionVerdict(
            status="VERIFIED",
            reason="All checks passed",
            checks=checks,
            verified_at=_utc_now_iso(),
            evidence={"all_checks": [c.to_dict() for c in checks]},
        )
