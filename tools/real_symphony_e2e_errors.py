from __future__ import annotations


class E2EFailure(RuntimeError):
    def __init__(
        self,
        *,
        failure_class: str,
        error_code: str,
        sanitized_reason: str,
        retryable: bool,
        next_action: str,
    ) -> None:
        super().__init__(sanitized_reason)
        self.failure_class = failure_class
        self.error_code = error_code
        self.sanitized_reason = sanitized_reason
        self.retryable = retryable
        self.next_action = next_action


class E2EConfigurationError(E2EFailure):
    pass


__all__ = ["E2EConfigurationError", "E2EFailure"]
