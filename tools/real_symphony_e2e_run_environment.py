from __future__ import annotations

import os
from pathlib import Path

from real_symphony_e2e_errors import E2EConfigurationError


def runtime_env() -> dict[str, str]:
    env = os.environ.copy()
    env["PYTHONPATH"] = os.pathsep.join(
        [
            str(Path.cwd() / "packages" / "performer-api" / "src"),
            str(Path.cwd() / "packages" / "performer" / "src"),
            str(Path.cwd() / "packages" / "conductor" / "src"),
            str(Path.cwd() / "packages" / "podium" / "src"),
            env.get("PYTHONPATH", ""),
        ]
    )
    return env


def linear_fixture_token() -> str:
    token = os.environ.get("SYMPHONY_E2E_LINEAR_FIXTURE_TOKEN", "").strip()
    if token:
        return token
    raise E2EConfigurationError(
        failure_class="environment_failure",
        error_code="linear_fixture_token_required",
        sanitized_reason="A Linear fixture token is required for external E2E issue setup.",
        retryable=False,
        next_action="set_symphony_e2e_linear_fixture_token",
    )
