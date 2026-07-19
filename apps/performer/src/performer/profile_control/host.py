from __future__ import annotations

from collections.abc import Iterator
from typing import Any, BinaryIO

from performer.contracts import validate


class ProfileControlHost:
    def __init__(self, sdk: Any) -> None:
        self._sdk = sdk

    def handle(
        self, metadata: dict[str, Any], secret_stream: BinaryIO
    ) -> list[dict[str, Any]]:
        return list(self.iter_results(metadata, secret_stream))

    def iter_results(
        self, metadata: dict[str, Any], secret_stream: BinaryIO
    ) -> Iterator[dict[str, Any]]:
        metadata = validate("PerformerProfileControlMetadata", metadata)
        base = {
            "protocol_version": metadata["protocol_version"],
            "request_id": metadata["request_id"],
            "profile_id": metadata["profile_id"],
        }
        try:
            kind = metadata["kind"]
            if kind == "set_api_key":
                secret = _read_secret(secret_stream, metadata["secret_frame_length"])
                try:
                    self._sdk.login_api_key(secret.decode("utf-8"))
                finally:
                    secret = b""
                yield self._result(base, "login_succeeded")
                return
            if kind == "get_profile_status":
                try:
                    account = self._sdk.account(refresh_token=False)
                except Exception:
                    yield self._status(base, "invalid")
                    return
                account_value = getattr(account, "account", account)
                if account_value is None:
                    yield self._status(base, "login-required")
                    return
                account_value = getattr(account_value, "root", account_value)
                label = _account_label(account_value)
                yield self._status(base, "ready", label)
                return
            handle = self._sdk.login_chatgpt()
            yield self._result(base, "login_started")
            completed = handle.wait()
            if not getattr(completed, "success", False):
                yield self._failed(base)
                return
            yield self._result(base, "login_succeeded")
        except Exception:
            yield self._failed(base)

    @staticmethod
    def _result(base: dict[str, Any], kind: str) -> dict[str, Any]:
        return validate("PerformerProfileControlResult", {**base, "kind": kind})

    @staticmethod
    def _status(
        base: dict[str, Any], readiness: str, label: str | None = None
    ) -> dict[str, Any]:
        result = {**base, "kind": "profile_status", "readiness": readiness}
        if label:
            result["sanitized_account_label"] = label
        return validate("PerformerProfileControlResult", result)

    @staticmethod
    def _failed(base: dict[str, Any]) -> dict[str, Any]:
        return validate(
            "PerformerProfileControlResult",
            {
                **base,
                "kind": "login_failed",
                "error": {
                    "code": "performer_profile_control_failed",
                    "category": "provider",
                    "sanitized_reason": "The Provider profile operation failed.",
                    "retryable": False,
                    "action_required": "Review the profile authentication and retry.",
                    "next_action": "Retry the requested profile operation.",
                },
            },
        )


def _read_secret(stream: BinaryIO, length: int) -> bytes:
    secret = stream.read(length)
    if len(secret) != length or stream.read(1):
        raise ValueError("invalid secret frame")
    return secret


def _account_label(account: Any) -> str | None:
    for field in ("email", "name"):
        value = getattr(account, field, None)
        if isinstance(value, str) and 0 < len(value) <= 256:
            return value
    return None
