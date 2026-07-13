from __future__ import annotations

from dataclasses import dataclass

from performer_api.runtime_policy import RuntimePolicy


@dataclass(frozen=True)
class CodexConfig:
    model: str
    model_provider: str
    approval_mode: str
    reasoning_effort: str
    reasoning_summary: str
    sandbox: str
    initialize_timeout_ms: int
    turn_timeout_ms: int
    initialize_max_attempts: int
    overload_max_attempts: int
    sdk_codex_bin: str | None = None

    @classmethod
    def from_runtime_policy(
        cls,
        policy: RuntimePolicy,
        turn_kind: str,
        *,
        sdk_codex_bin: str | None = None,
    ) -> "CodexConfig":
        sandbox = policy.sandbox.get(turn_kind)
        if sandbox is None:
            raise ValueError("turn_kind must be plan, execute, or gate")
        return cls(
            model=policy.model,
            model_provider=policy.model_provider,
            approval_mode=policy.approval_mode,
            reasoning_effort=policy.reasoning_effort,
            reasoning_summary=policy.reasoning_summary,
            sandbox=sandbox,
            initialize_timeout_ms=policy.initialize_timeout_ms,
            turn_timeout_ms=policy.turn_timeout_ms,
            initialize_max_attempts=policy.initialize_max_attempts,
            overload_max_attempts=policy.overload_max_attempts,
            sdk_codex_bin=sdk_codex_bin,
        )
