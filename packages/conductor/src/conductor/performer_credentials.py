from __future__ import annotations

import fcntl
import json
import os
import re
import shutil
import stat
import subprocess
import tempfile
import time
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterator, Sequence

from performer_api.codex_runtime import CodexRuntimeConfigError, validate_codex_toml


_SLOT_ID = re.compile(r"\A[a-z0-9][a-z0-9._-]{0,63}\Z")
_EMAIL = re.compile(r"\A[^\s@]+@[^\s@]+\.[^\s@]+\Z")
_SECRET = re.compile(r"(?i)(?:sk-[A-Za-z0-9_-]{12,}|bearer\s+|api[_-]?key|access[_-]?token|refresh[_-]?token)")
_STATES = frozenset({"active", "needs_login", "blocked"})
_OPAQUE_FILES = ("auth.json", "version.json", "models_cache.json")
_MAX_AUTH_BYTES = 1024 * 1024


class PerformerCredentialError(RuntimeError):
    def __init__(self, code: str, reason: str | None = None) -> None:
        super().__init__(reason or code)
        self.code = code
        self.reason = reason or code


@dataclass
class MaterializedCredential:
    slot_id: str
    codex_home: Path
    _lock_file: Any


class PerformerCredentialSlots:
    def __init__(self, data_root: Path, *, codex_command: Sequence[str] = ("codex",)) -> None:
        self.root = Path(data_root) / "performer-credentials"
        self.codex_command = tuple(codex_command)
        self.root.mkdir(parents=True, exist_ok=True)

    def init(self, slot_id: str, display_name: str) -> dict[str, Any]:
        slot_id = _valid_slot_id(slot_id)
        display_name = _valid_display_name(display_name)
        directory = self.root / slot_id
        try:
            directory.mkdir(mode=0o700)
            home = directory / "CODEX_HOME"
            home.mkdir(mode=0o700)
        except FileExistsError as exc:
            raise PerformerCredentialError("managed_codex_slot_exists") from exc
        (home / "config.toml").write_text('cli_auth_credentials_store = "file"\n', encoding="utf-8")
        metadata = {"version": 1, "slot_id": slot_id, "display_name": display_name, "performer_kind": "codex", "state": "needs_login"}
        self._write_json(directory / "slot.json", metadata)
        return {**metadata, "codex_home": str(home.resolve())}

    def list(self) -> dict[str, Any]:
        slots = []
        for path in sorted(self.root.iterdir(), key=lambda item: item.name):
            if not path.is_dir() or not _SLOT_ID.fullmatch(path.name):
                continue
            try:
                slots.append(self._read_slot(path.name))
            except PerformerCredentialError:
                slots.append({"slot_id": path.name, "display_name": path.name, "performer_kind": "codex", "state": "blocked"})
        selection = self._read_selection(optional=True)
        return {"slots": slots, "selection": selection}

    def stage_seed(self, slot_id: str, source: Path) -> dict[str, Any]:
        slot_id = _valid_slot_id(slot_id)
        source = Path(source).expanduser().resolve(strict=True)
        ambient = (Path.home() / ".codex").resolve()
        if source == ambient or ambient in source.parents or not source.is_dir():
            raise PerformerCredentialError("managed_codex_seed_path_invalid")
        target = self.root / slot_id / "CODEX_HOME"
        self._read_slot(slot_id)
        for name in _OPAQUE_FILES:
            candidate = source / name
            if candidate.exists():
                destination = target / name
                destination.unlink(missing_ok=True)
                self._copy_valid_file(candidate, destination, auth=(name == "auth.json"))
        self._set_state(slot_id, "needs_login")
        return self._read_slot(slot_id)

    def select(self, slot_id: str) -> dict[str, Any]:
        slot = self._read_slot(_valid_slot_id(slot_id))
        if slot["state"] != "active":
            raise PerformerCredentialError("managed_codex_slot_not_active")
        with self._metadata_lock():
            previous = self._read_selection(optional=True)
            generation = int((previous or {}).get("generation") or 0) + 1
            selection = {"slot_id": slot_id, "generation": generation}
            self._write_json(self.root / "selection.json", selection)
        return selection

    def selected_slot_id(self) -> str:
        selection = self._read_selection(optional=False)
        assert selection is not None
        slot = self._read_slot(str(selection["slot_id"]))
        if slot["state"] != "active":
            raise PerformerCredentialError("managed_codex_slot_not_active")
        return str(slot["slot_id"])

    def materialize(self, slot_id: str, destination: Path, config_document: str, *, require_active: bool = True) -> MaterializedCredential:
        slot_id = _valid_slot_id(slot_id)
        slot = self._read_slot(slot_id)
        if require_active and slot["state"] != "active":
            raise PerformerCredentialError("managed_codex_slot_not_active")
        try:
            config = validate_codex_toml(config_document)
        except CodexRuntimeConfigError as exc:
            raise PerformerCredentialError(exc.code, exc.reason) from exc
        lock_file = self._acquire_slot_lock(slot_id)
        try:
            source = self.root / slot_id / "CODEX_HOME"
            auth = source / "auth.json"
            if not auth.exists():
                self._set_state(slot_id, "needs_login")
                raise PerformerCredentialError("managed_codex_login_required")
            destination = Path(destination)
            if destination.exists():
                shutil.rmtree(destination)
            destination.mkdir(parents=True, mode=0o700)
            for name in _OPAQUE_FILES:
                source_path = source / name
                if source_path.exists():
                    self._copy_valid_file(source_path, destination / name, auth=(name == "auth.json"))
            (destination / "config.toml").write_text(config, encoding="utf-8")
            return MaterializedCredential(slot_id, destination, lock_file)
        except Exception:
            fcntl.flock(lock_file.fileno(), fcntl.LOCK_UN)
            lock_file.close()
            raise

    def reconcile(self, materialized: MaterializedCredential) -> None:
        try:
            source = materialized.codex_home / "auth.json"
            target = self.root / materialized.slot_id / "CODEX_HOME" / "auth.json"
            if not source.exists():
                target.unlink(missing_ok=True)
                self._set_state(materialized.slot_id, "needs_login")
                return
            self._atomic_copy_auth(source, target)
        except Exception as exc:
            self._set_state(materialized.slot_id, "blocked")
            if isinstance(exc, PerformerCredentialError):
                raise
            raise PerformerCredentialError("managed_codex_refresh_commit_failed") from exc
        finally:
            fcntl.flock(materialized._lock_file.fileno(), fcntl.LOCK_UN)
            materialized._lock_file.close()

    def check(self, slot_id: str, config_document: str, *, model: str | None = None, timeout: float = 60.0) -> dict[str, Any]:
        slot_id = _valid_slot_id(slot_id)
        with tempfile.TemporaryDirectory(prefix="symphony-codex-check-") as temporary:
            root = Path(temporary)
            materialized = self.materialize(slot_id, root / "CODEX_HOME", config_document, require_active=False)
            try:
                schema = root / "result-schema.json"
                output = root / "last-message.json"
                schema.write_text(
                    json.dumps(
                        {
                            "type": "object",
                            "properties": {"ok": {"type": "boolean", "const": True}},
                            "required": ["ok"],
                            "additionalProperties": False,
                        },
                        separators=(",", ":"),
                    ),
                    encoding="utf-8",
                )
                command = [
                    *self.codex_command,
                    "exec",
                    "--sandbox",
                    "read-only",
                    "--skip-git-repo-check",
                    "--ephemeral",
                    "--output-schema",
                    str(schema),
                    "--output-last-message",
                    str(output),
                ]
                if model:
                    command.extend(["--model", model])
                command.append('Return only this JSON object: {"ok": true}')
                env = {"PATH": os.environ.get("PATH", ""), "CODEX_HOME": str(materialized.codex_home)}
                completed = subprocess.run(command, cwd=root, env=env, capture_output=True, text=True, timeout=max(timeout, 0.1), check=False)
                try:
                    checked = json.loads(output.read_text(encoding="utf-8"))
                except (OSError, json.JSONDecodeError):
                    checked = None
                if completed.returncode != 0:
                    raise PerformerCredentialError(_check_failure_code(completed.stdout, completed.stderr))
                if checked != {"ok": True}:
                    raise PerformerCredentialError("managed_codex_check_invalid_result")
                completed_materialization = materialized
                materialized = None
                self.reconcile(completed_materialization)
                self._set_state(slot_id, "active")
                return {"slot_id": slot_id, "status": "passed"}
            except subprocess.TimeoutExpired as exc:
                raise PerformerCredentialError("managed_codex_check_timeout") from exc
            finally:
                if materialized is not None:
                    self.reconcile(materialized)

    def _read_slot(self, slot_id: str) -> dict[str, Any]:
        payload = self._read_json(self.root / slot_id / "slot.json")
        if payload.get("slot_id") != slot_id or payload.get("performer_kind") != "codex" or payload.get("state") not in _STATES:
            raise PerformerCredentialError("managed_codex_slot_invalid")
        return {key: payload[key] for key in ("slot_id", "display_name", "performer_kind", "state")}

    def _set_state(self, slot_id: str, state: str) -> None:
        payload = self._read_json(self.root / slot_id / "slot.json")
        payload["state"] = state
        self._write_json(self.root / slot_id / "slot.json", payload)

    def _read_selection(self, *, optional: bool) -> dict[str, Any] | None:
        path = self.root / "selection.json"
        if optional and not path.exists():
            return None
        payload = self._read_json(path)
        if not _SLOT_ID.fullmatch(str(payload.get("slot_id") or "")) or int(payload.get("generation") or 0) < 1:
            raise PerformerCredentialError("managed_codex_selection_invalid")
        return {"slot_id": str(payload["slot_id"]), "generation": int(payload["generation"])}

    def _acquire_slot_lock(self, slot_id: str) -> Any:
        lock = (self.root / slot_id / ".slot.lock").open("a+b")
        deadline = time.monotonic() + 5.0
        while True:
            try:
                fcntl.flock(lock.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
                return lock
            except BlockingIOError:
                if time.monotonic() >= deadline:
                    lock.close()
                    raise PerformerCredentialError("managed_codex_slot_busy")
                time.sleep(0.05)

    @contextmanager
    def _metadata_lock(self) -> Iterator[None]:
        lock = (self.root / ".metadata.lock").open("a+b")
        fcntl.flock(lock.fileno(), fcntl.LOCK_EX)
        try:
            yield
        finally:
            fcntl.flock(lock.fileno(), fcntl.LOCK_UN)
            lock.close()

    @staticmethod
    def _read_json(path: Path) -> dict[str, Any]:
        try:
            payload = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            raise PerformerCredentialError("managed_codex_metadata_invalid") from exc
        if not isinstance(payload, dict):
            raise PerformerCredentialError("managed_codex_metadata_invalid")
        return payload

    @staticmethod
    def _write_json(path: Path, payload: dict[str, Any]) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        temporary = path.with_name(f".{path.name}.{os.getpid()}.tmp")
        fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        try:
            os.write(fd, json.dumps(payload, sort_keys=True, separators=(",", ":")).encode())
            os.fsync(fd)
        finally:
            os.close(fd)
        os.replace(temporary, path)
        directory_fd = os.open(path.parent, os.O_RDONLY)
        try:
            os.fsync(directory_fd)
        finally:
            os.close(directory_fd)

    @staticmethod
    def _copy_valid_file(source: Path, destination: Path, *, auth: bool) -> None:
        flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0)
        fd = os.open(source, flags)
        try:
            details = os.fstat(fd)
            limit = _MAX_AUTH_BYTES if auth else 4 * 1024 * 1024
            if not stat.S_ISREG(details.st_mode) or details.st_nlink != 1 or details.st_size <= 0 or details.st_size > limit:
                raise PerformerCredentialError("managed_codex_slot_invalid")
            with os.fdopen(os.dup(fd), "rb") as input_file, destination.open("xb") as output_file:
                shutil.copyfileobj(input_file, output_file)
            if auth:
                destination.chmod(0o600)
        finally:
            os.close(fd)

    def _atomic_copy_auth(self, source: Path, target: Path) -> None:
        temporary = target.with_name(f".auth.{os.getpid()}.tmp")
        try:
            self._copy_valid_file(source, temporary, auth=True)
            with temporary.open("rb") as handle:
                os.fsync(handle.fileno())
            os.replace(temporary, target)
            directory_fd = os.open(target.parent, os.O_RDONLY)
            try:
                os.fsync(directory_fd)
            finally:
                os.close(directory_fd)
        except Exception as exc:
            temporary.unlink(missing_ok=True)
            raise PerformerCredentialError("managed_codex_refresh_commit_failed") from exc


def _valid_slot_id(value: str) -> str:
    normalized = str(value or "").strip()
    if not _SLOT_ID.fullmatch(normalized):
        raise PerformerCredentialError("managed_codex_slot_id_invalid")
    return normalized


def _valid_display_name(value: str) -> str:
    normalized = str(value or "").strip()
    if not normalized or len(normalized) > 80 or any(ord(character) < 32 for character in normalized) or _EMAIL.fullmatch(normalized) or _SECRET.search(normalized):
        raise PerformerCredentialError("managed_codex_display_name_invalid")
    return normalized


def _check_failure_code(stdout: str | None, stderr: str | None) -> str:
    text = f"{stdout or ''}\n{stderr or ''}".lower()[:32_768]
    if any(marker in text for marker in ("401", "unauthorized", "authentication", "invalid api key", "token expired")):
        return "managed_codex_auth_rejected"
    if any(marker in text for marker in ("login required", "not logged in", "codex login")):
        return "managed_codex_login_required"
    if any(marker in text for marker in ("502", "503", "504", "bad gateway", "service unavailable", "overloaded", "connection refused")):
        return "managed_codex_provider_unavailable"
    return "managed_codex_check_failed"


__all__ = ["MaterializedCredential", "PerformerCredentialError", "PerformerCredentialSlots"]
