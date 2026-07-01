from __future__ import annotations

import json
from pathlib import Path

from .conductor_models import ConductorSettings, InstanceRecord


class ConductorStore:
    def __init__(self, data_root: Path):
        self.data_root = data_root
        self.instances_root = data_root / "instances"
        self.instances_root.mkdir(parents=True, exist_ok=True)

    def list_instances(self) -> list[InstanceRecord]:
        instances: list[InstanceRecord] = []
        for metadata_path in sorted(self.instances_root.glob("*/metadata.json")):
            payload = json.loads(metadata_path.read_text(encoding="utf-8"))
            instances.append(InstanceRecord.from_dict(payload))
        return instances

    def get_instance(self, instance_id: str) -> InstanceRecord | None:
        metadata_path = self.instances_root / instance_id / "metadata.json"
        if not metadata_path.exists():
            return None
        payload = json.loads(metadata_path.read_text(encoding="utf-8"))
        return InstanceRecord.from_dict(payload)

    def get_settings(self) -> ConductorSettings:
        settings_path = self.data_root / "settings.json"
        if not settings_path.exists():
            return ConductorSettings()
        payload = json.loads(settings_path.read_text(encoding="utf-8"))
        return ConductorSettings.from_dict(payload)

    def save_settings(self, settings: ConductorSettings) -> None:
        self.data_root.mkdir(parents=True, exist_ok=True)
        settings_path = self.data_root / "settings.json"
        settings_path.write_text(json.dumps(settings.to_dict(), indent=2, sort_keys=True), encoding="utf-8")

    def save_instance(self, instance: InstanceRecord) -> None:
        current = self.get_instance(instance.id)
        if current is not None and current.created_at == instance.created_at and current.updated_at == instance.updated_at:
            raise FileExistsError(f"Metadata already exists for {instance.id}")
        instance_root = self.instances_root / instance.id
        instance_root.mkdir(parents=True, exist_ok=True)
        metadata_path = instance_root / "metadata.json"
        metadata_path.write_text(json.dumps(instance.to_dict(), indent=2, sort_keys=True), encoding="utf-8")

    def create_instance(self, instance: InstanceRecord) -> None:
        instance_root = self.instances_root / instance.id
        metadata_path = instance_root / "metadata.json"
        if metadata_path.exists():
            raise FileExistsError(f"Metadata already exists for {instance.id}")
        instance_root.mkdir(parents=True, exist_ok=True)
        metadata_path.write_text(json.dumps(instance.to_dict(), indent=2, sort_keys=True), encoding="utf-8")

    def update_instance(self, instance: InstanceRecord) -> None:
        instance_root = self.instances_root / instance.id
        metadata_path = instance_root / "metadata.json"
        if not metadata_path.exists():
            raise FileNotFoundError(f"Metadata does not exist for {instance.id}")
        metadata_path.write_text(json.dumps(instance.to_dict(), indent=2, sort_keys=True), encoding="utf-8")

    def delete_instance(self, instance_id: str) -> None:
        instance_root = self.instances_root / instance_id
        if not instance_root.exists():
            return
        for path in sorted(instance_root.rglob("*"), reverse=True):
            if path.is_file() or path.is_symlink():
                path.unlink()
            elif path.is_dir():
                path.rmdir()
        instance_root.rmdir()

    def allocate_port(self, *, start: int = 8801) -> int:
        used = {instance.http_port for instance in self.list_instances()}
        port = start
        while port in used:
            port += 1
        return port
