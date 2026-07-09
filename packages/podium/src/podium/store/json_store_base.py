from __future__ import annotations

import json
import tempfile
from pathlib import Path
from typing import Any


class JsonStoreBase:
    def __init__(self, data_dir: str | Path | None = None) -> None:
        self.data_dir = Path(data_dir) if data_dir is not None else Path(tempfile.mkdtemp(prefix="podium-json-store-"))
        self.data_dir.mkdir(parents=True, exist_ok=True)

    def _path(self, name: str) -> Path:
        return self.data_dir / name

    def _load_map(self, name: str) -> dict[str, Any]:
        path = self._path(name)
        if not path.exists():
            return {}
        try:
            payload = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return {}
        return payload if isinstance(payload, dict) else {}

    def _load_list(self, name: str) -> list[Any]:
        path = self._path(name)
        if not path.exists():
            return []
        try:
            payload = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return []
        return payload if isinstance(payload, list) else []

    def _write(self, name: str, payload: Any) -> None:
        path = self._path(name)
        tmp = path.with_name(f"{path.name}.tmp")
        tmp.write_text(json.dumps(payload, indent=2, sort_keys=True), encoding="utf-8")
        tmp.replace(path)

    def _next_id(self, prefix: str, name: str) -> str:
        rows = self._load_map(name)
        used: set[int] = set()
        for key in rows:
            if key.startswith(prefix):
                try:
                    used.add(int(key.removeprefix(prefix)))
                except ValueError:
                    continue
        index = 1
        while index in used:
            index += 1
        return f"{prefix}{index}"
