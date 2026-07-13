"""Internal validation helpers for secret-free Performer wire contracts."""

from __future__ import annotations

from collections.abc import Collection
import re
from typing import Any


_IDENTIFIER = re.compile(r"\A[A-Za-z0-9][A-Za-z0-9._:-]{0,199}\Z")
_SHA256 = re.compile(r"\A[0-9a-f]{64}\Z")
_SECRET_LITERAL = re.compile(
    r"(?i)(?:sk-[A-Za-z0-9_-]{20,}|bearer\s+[A-Za-z0-9._~+/=-]{12,}|"
    r"-----BEGIN [A-Z ]*PRIVATE KEY-----)"
)
_JWT_LITERAL = re.compile(
    r"\b[A-Za-z0-9_-]{10,4096}\.[A-Za-z0-9_-]{10,4096}\.[A-Za-z0-9_-]{10,4096}\b"
)
_URL_USERINFO = re.compile(r"(?i)\b[a-z][a-z0-9+.-]*://[^/\s:@]+:[^@\s/]+@")
_ABSOLUTE_PATH = re.compile(
    r"(?i)(?:^|[\s=\"'(])(?:/(?!/)[^\s,;\"')]+|[A-Za-z]:\\[^\s,;\"')]+)"
)
_BASE64_BLOB = re.compile(r"\b[A-Za-z0-9+/_-]{160,}={0,2}\b")
_SECRET_ASSIGNMENT = re.compile(
    r"""(?ix)
    (?<![A-Za-z0-9_-])
    [\"']?
    (?:(?:[A-Za-z][A-Za-z0-9]*[_-])*)
    (?:api[_-]?key|client[_-]?secret|access[_-]?token|refresh[_-]?token|
       password|authorization|private[_-]?key)
    [\"']?
    (?![A-Za-z0-9_-])
    \s*[:=]\s*
    (
        \"(?:[^\"\\\\]|\\\\.)*\"
        | '(?:[^'\\\\]|\\\\.)*'
        | [^\s,\r\n;}]+
    )
    """
)


def exact_keys(payload: Any, expected: Collection[str], label: str) -> None:
    if not isinstance(payload, dict):
        raise ValueError(f"{label} must be an object")
    if set(payload) != set(expected):
        raise ValueError(f"{label} fields are invalid")


def identifier(value: Any, field: str) -> str:
    if not isinstance(value, str) or not _IDENTIFIER.fullmatch(value):
        raise ValueError(f"{field} is invalid")
    return value


def optional_identifier(value: Any, field: str) -> str:
    if value == "":
        return ""
    return identifier(value, field)


def positive_int(value: Any, field: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value <= 0:
        raise ValueError(f"{field} must be positive")
    return value


def sha256(value: Any, field: str) -> str:
    if not isinstance(value, str) or not _SHA256.fullmatch(value):
        raise ValueError(f"{field} must be lowercase SHA-256")
    return value


def safe_text(
    value: Any,
    field: str,
    *,
    max_bytes: int,
    allow_newlines: bool = False,
) -> str:
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"{field} must be a non-empty string")
    if len(value.encode("utf-8")) > max_bytes:
        raise ValueError(f"{field} is too large")
    if "\x00" in value or (not allow_newlines and ("\n" in value or "\r" in value)):
        raise ValueError(f"{field} contains invalid control characters")
    if _ABSOLUTE_PATH.search(value):
        raise ValueError(f"{field} contains a private path")
    if (
        _SECRET_LITERAL.search(value)
        or _JWT_LITERAL.search(value)
        or _URL_USERINFO.search(value)
        or _has_unredacted_secret_assignment(value)
    ):
        raise ValueError(f"{field} contains secret material")
    if _BASE64_BLOB.search(value):
        raise ValueError(f"{field} contains an unbounded Base64 payload")
    return value


def optional_text(
    value: Any,
    field: str,
    max_bytes: int,
    *,
    allow_newlines: bool = False,
) -> str:
    if value == "":
        return ""
    return safe_text(
        value,
        field,
        max_bytes=max_bytes,
        allow_newlines=allow_newlines,
    )


def json_copy(value: Any) -> Any:
    if isinstance(value, dict):
        return {str(key): json_copy(item) for key, item in value.items()}
    if isinstance(value, list):
        return [json_copy(item) for item in value]
    return value


def _has_unredacted_secret_assignment(value: str) -> bool:
    for match in _SECRET_ASSIGNMENT.finditer(value):
        assigned = match.group(1).strip().strip("\"'").strip()
        if assigned != "[REDACTED]":
            return True
    return False


__all__ = [
    "exact_keys",
    "identifier",
    "json_copy",
    "optional_identifier",
    "optional_text",
    "positive_int",
    "safe_text",
    "sha256",
]
