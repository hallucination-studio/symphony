from __future__ import annotations

from contextlib import closing
from dataclasses import dataclass
import hashlib
import json
import os
from pathlib import Path
import re
import sqlite3
from typing import Any


SAFE_KEY_NAMES = {
    "fencingtoken",
    "tokenhealth",
    "tokenusage",
    "tokencount",
    "tokencounts",
    "inputtokens",
    "outputtokens",
    "cachedinputtokens",
    "totaltokens",
    "maxtokens",
}
COOKIE_HEADER = re.compile(r"(?im)(?P<prefix>\b(?:set-)?cookie\s*:\s*)[^\r\n]*")
AUTHORIZATION_HEADER = re.compile(r"(?im)(?P<prefix>\bauthorization\s*:\s*)[^\r\n]*")
AUTH_SCHEME = re.compile(r"(?i)\b(bearer|basic)\s+[A-Za-z0-9._~+/=:-]+")
KEY_VALUE = re.compile(
    r"(?P<prefix>[\"']?(?P<key>[A-Za-z][A-Za-z0-9_-]{0,63})[\"']?\s*[:=]\s*)"
    r"(?P<value>\"[^\"\r\n]*\"|'[^'\r\n]*'|[^\s,;}\r\n]+)"
)
SAFE_REFERENCE = re.compile(r"^\$[A-Z][A-Z0-9_]*$")


class UnsafeEvidenceError(RuntimeError):
    def __init__(self, locations: list[str]):
        super().__init__("unsafe_secret_material_detected")
        self.locations = locations


@dataclass(frozen=True)
class AttemptArtifacts:
    attempt_id: str
    request: Path | None
    result: Path | None
    log: Path | None


def managed_run_db_path(data_root: Path) -> Path:
    return data_root / "managed_run" / "managed_run.db"


def generation_log_paths(instance_root: Path) -> list[Path]:
    logs_dir = instance_root / "logs"
    return sorted(
        (path for path in logs_dir.glob("performer-[0-9][0-9][0-9][0-9][0-9][0-9].log") if path.is_file()),
        key=lambda path: path.name,
    )


def latest_generation_log(instance_root: Path) -> Path | None:
    paths = generation_log_paths(instance_root)
    return paths[-1] if paths else None


def attempt_artifacts(instance_root: Path) -> list[AttemptArtifacts]:
    attempts_root = instance_root / "state" / "managed_run"
    if not attempts_root.is_dir():
        return []
    return [
        AttemptArtifacts(
            attempt_id=attempt_dir.name,
            request=_file_or_none(attempt_dir / "turn-request.json"),
            result=_file_or_none(attempt_dir / "turn-result.json"),
            log=_file_or_none(attempt_dir / "attempt.log"),
        )
        for attempt_dir in sorted(path for path in attempts_root.iterdir() if path.is_dir())
    ]


def sanitize_text(text: str) -> str:
    sanitized = text.replace("\x00", "")
    sanitized = COOKIE_HEADER.sub(r"\g<prefix>[REDACTED]", sanitized)
    sanitized = AUTHORIZATION_HEADER.sub(r"\g<prefix>[REDACTED]", sanitized)
    sanitized = KEY_VALUE.sub(_redact_key_value, sanitized)
    return AUTH_SCHEME.sub(r"\1 [REDACTED]", sanitized)


def sanitize_evidence_value(value: Any, *, key: str = "") -> Any:
    if key and is_sensitive_key(key):
        return "<redacted>"
    if isinstance(value, dict):
        return {
            str(item_key): sanitize_evidence_value(item_value, key=str(item_key))
            for item_key, item_value in value.items()
        }
    if isinstance(value, list):
        return [sanitize_evidence_value(item) for item in value]
    if isinstance(value, str):
        return sanitize_text(value)
    return value


def is_sensitive_key(key: str) -> bool:
    normalized = re.sub(r"[^a-z0-9]", "", key.lower())
    if normalized in SAFE_KEY_NAMES:
        return False
    if normalized in {"token", "apikey", "password", "passphrase", "authorization", "cookie", "credential", "credentials", "privatekey"}:
        return True
    if any(part in normalized for part in ("secret", "password", "authorization", "cookie", "credential", "privatekey")):
        return True
    return normalized.endswith("token")


def copy_sanitized_file(source: Path, target: Path) -> None:
    target.parent.mkdir(parents=True, exist_ok=True)
    temporary = target.with_name(f".{target.name}.tmp")
    temporary.unlink(missing_ok=True)
    try:
        _create_private_file(temporary)
        if source.name.endswith(".json"):
            raw = source.read_text(encoding="utf-8", errors="replace")
            try:
                payload = json.loads(raw)
            except json.JSONDecodeError:
                _copy_sanitized_text(source, temporary)
            else:
                temporary.write_text(
                    json.dumps(sanitize_evidence_value(payload), indent=2, sort_keys=True),
                    encoding="utf-8",
                )
        elif source.name.endswith(".jsonl"):
            _copy_sanitized_jsonl(source, temporary)
        else:
            _copy_sanitized_text(source, temporary)
        temporary.replace(target)
        target.chmod(0o600)
    finally:
        temporary.unlink(missing_ok=True)


def snapshot_sqlite(source: Path, target: Path) -> None:
    if not source.is_file():
        raise FileNotFoundError(source)
    target.parent.mkdir(parents=True, exist_ok=True)
    temporary = target.with_name(f".{target.name}.tmp")
    temporary.unlink(missing_ok=True)
    try:
        _create_private_file(temporary)
        with closing(sqlite3.connect(f"{source.resolve().as_uri()}?mode=ro", uri=True)) as source_db:
            with closing(sqlite3.connect(temporary)) as target_db:
                source_db.backup(target_db)
                target_db.commit()
                target_db.execute("VACUUM")
                target_db.commit()
        locations = sqlite_secret_locations(temporary)
        if locations:
            raise UnsafeEvidenceError(locations)
        temporary.replace(target)
        target.chmod(0o600)
    finally:
        temporary.unlink(missing_ok=True)


def sqlite_secret_locations(db_path: Path) -> list[str]:
    locations: list[str] = []
    with closing(sqlite3.connect(f"{db_path.resolve().as_uri()}?mode=ro", uri=True)) as connection:
        tables = [
            str(row[0])
            for row in connection.execute(
                "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
            )
        ]
        for table in tables:
            columns = [str(row[1]) for row in connection.execute(f"PRAGMA table_info({_quote_identifier(table)})")]
            for column in columns:
                query = f"SELECT {_quote_identifier(column)} FROM {_quote_identifier(table)} WHERE {_quote_identifier(column)} IS NOT NULL"
                for (value,) in connection.execute(query):
                    if _unsafe_cell(column, value):
                        locations.append(f"{table}.{column}")
                        break
    return locations


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _unsafe_cell(column: str, value: Any) -> bool:
    if isinstance(value, bytes):
        text = value.decode("utf-8", errors="replace")
    elif isinstance(value, str):
        text = value
    else:
        return False
    if is_sensitive_key(column) and not _safe_secret_value(text):
        return True
    return sanitize_text(text) != text


def _redact_key_value(match: re.Match[str]) -> str:
    if not is_sensitive_key(match.group("key")):
        value = match.group("value")
        nested = sanitize_text(value) if ":" in value or "=" in value else value
        return f"{match.group('prefix')}{nested}"
    value = match.group("value")
    unquoted = value[1:-1] if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'" else value
    if _safe_secret_value(unquoted):
        return match.group(0)
    quote = value[0] if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'" else ""
    return f"{match.group('prefix')}{quote}[REDACTED]{quote}"


def _safe_secret_value(value: str) -> bool:
    stripped = value.strip()
    return bool(
        SAFE_REFERENCE.fullmatch(stripped)
        or stripped.lower() in {"<redacted>", "[redacted]"}
    )


def _copy_sanitized_jsonl(source: Path, target: Path) -> None:
    with source.open("r", encoding="utf-8", errors="replace") as source_handle, target.open("w", encoding="utf-8") as target_handle:
        for line in source_handle:
            try:
                payload = json.loads(line)
            except json.JSONDecodeError:
                target_handle.write(sanitize_text(line))
            else:
                target_handle.write(json.dumps(sanitize_evidence_value(payload), sort_keys=True) + "\n")


def _copy_sanitized_text(source: Path, target: Path) -> None:
    with source.open("r", encoding="utf-8", errors="replace") as source_handle, target.open("w", encoding="utf-8") as target_handle:
        for line in source_handle:
            target_handle.write(sanitize_text(line))


def _create_private_file(path: Path) -> None:
    descriptor = os.open(path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
    os.close(descriptor)


def _file_or_none(path: Path) -> Path | None:
    return path if path.is_file() else None


def _quote_identifier(identifier: str) -> str:
    return '"' + identifier.replace('"', '""') + '"'


__all__ = [
    "AttemptArtifacts",
    "UnsafeEvidenceError",
    "attempt_artifacts",
    "copy_sanitized_file",
    "generation_log_paths",
    "is_sensitive_key",
    "latest_generation_log",
    "managed_run_db_path",
    "sanitize_evidence_value",
    "sanitize_text",
    "sha256_file",
    "snapshot_sqlite",
    "sqlite_secret_locations",
]
