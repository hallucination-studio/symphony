from __future__ import annotations

import contextlib
import fcntl
import json
from pathlib import Path
from typing import Callable
from uuid import uuid4

from .ops_models import OpsSnapshot


class OpsStore:
    def __init__(self, path: Path):
        self.path = path

    def load(self) -> OpsSnapshot:
        if not self.path.exists():
            return OpsSnapshot()
        payload = json.loads(self.path.read_text(encoding="utf-8"))
        return OpsSnapshot.from_dict(payload)

    def save(self, snapshot: OpsSnapshot) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        tmp = self.path.with_name(f"{self.path.name}.{uuid4().hex}.tmp")
        tmp.write_text(json.dumps(snapshot.to_dict(), sort_keys=True), encoding="utf-8")
        tmp.replace(self.path)

    def update(self, mutator: Callable[[OpsSnapshot], object]) -> object:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        lock_path = self.path.with_suffix(f"{self.path.suffix}.lock")
        with lock_path.open("a+", encoding="utf-8") as lock_file:
            fcntl.flock(lock_file.fileno(), fcntl.LOCK_EX)
            try:
                snapshot = self.load()
                result = mutator(snapshot)
                self.save(snapshot)
                return result
            finally:
                with contextlib.suppress(OSError):
                    fcntl.flock(lock_file.fileno(), fcntl.LOCK_UN)
