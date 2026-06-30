from __future__ import annotations

import json
from pathlib import Path

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
        tmp = self.path.with_suffix(".tmp")
        tmp.write_text(json.dumps(snapshot.to_dict(), sort_keys=True), encoding="utf-8")
        tmp.replace(self.path)
