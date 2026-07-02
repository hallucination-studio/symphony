from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from podium.models import (
    OnboardingProgress,
    OnboardingStep,
    RepositoryMapping,
    RuntimeRecord,
)


class PodiumStore:
    """
    Simple JSON file persistence for Podium data.

    Manages:
    - Linear installations (workspace OAuth tokens)
    - Routing rules (workspace -> conductor mappings)
    - Runtime records (enrolled agents)
    - Onboarding progress (per workspace)
    - Repository mappings (per workspace)

    SECURITY: Linear OAuth tokens (access_token, refresh_token) are stored here
    but NEVER exposed in UI-facing responses.
    """

    def __init__(self, data_dir: str | Path | None = None):
        """
        Initialize store with optional data directory.

        Args:
            data_dir: Directory for persistent storage. If None, uses in-memory only.
        """
        self.data_dir = Path(data_dir) if data_dir else None

        # In-memory caches
        self._linear_installations: dict[str, dict[str, Any]] = {}
        self._routing_rules: dict[str, dict[str, Any]] = {}
        self._runtime_records: dict[str, dict[str, Any]] = {}
        self._onboarding_progress: dict[str, dict[str, Any]] = {}
        self._repository_mappings: dict[str, dict[str, Any]] = {}

        # Load from disk if path provided
        if self.data_dir:
            self._load_all()

    def _load_all(self) -> None:
        """Load all data from disk."""
        if not self.data_dir:
            return

        self._linear_installations = self._load_json("linear_installations.json")
        self._routing_rules = self._load_json("routing_rules.json")
        self._runtime_records = self._load_json("runtime_records.json")
        self._onboarding_progress = self._load_json("onboarding_progress.json")
        self._repository_mappings = self._load_json("repository_mappings.json")

    def _load_json(self, filename: str) -> dict[str, Any]:
        """Load JSON file from data directory."""
        if not self.data_dir:
            return {}

        file_path = self.data_dir / filename
        if not file_path.exists():
            return {}

        try:
            data = json.loads(file_path.read_text(encoding="utf-8"))
            if isinstance(data, dict):
                return data
        except (OSError, json.JSONDecodeError):
            pass

        return {}

    def _save_json(self, filename: str, data: dict[str, Any]) -> None:
        """Save JSON file to data directory."""
        if not self.data_dir:
            return

        self.data_dir.mkdir(parents=True, exist_ok=True)
        file_path = self.data_dir / filename
        file_path.write_text(
            json.dumps(data, indent=2, sort_keys=True),
            encoding="utf-8"
        )

    # ===== Linear Installations =====

    def get_linear_installation(self, workspace_id: str) -> dict[str, Any] | None:
        """Get Linear installation for workspace (includes OAuth tokens)."""
        return self._linear_installations.get(workspace_id)

    def save_linear_installation(self, workspace_id: str, installation: dict[str, Any]) -> None:
        """Save Linear installation (OAuth tokens)."""
        self._linear_installations[workspace_id] = installation
        self._save_json("linear_installations.json", self._linear_installations)

    def list_linear_installations(self) -> dict[str, dict[str, Any]]:
        """List all Linear installations."""
        return dict(self._linear_installations)

    # ===== Routing Rules =====

    def get_routing_rule(self, workspace_id: str) -> dict[str, Any] | None:
        """Get routing rule for workspace."""
        return self._routing_rules.get(workspace_id)

    def save_routing_rule(self, workspace_id: str, rule: dict[str, Any]) -> None:
        """Save routing rule for workspace."""
        self._routing_rules[workspace_id] = rule
        self._save_json("routing_rules.json", self._routing_rules)

    def list_routing_rules(self) -> dict[str, dict[str, Any]]:
        """List all routing rules."""
        return dict(self._routing_rules)

    # ===== Runtime Records =====

    def get_runtime_record(self, runtime_id: str) -> RuntimeRecord | None:
        """Get runtime record by ID."""
        data = self._runtime_records.get(runtime_id)
        if not data:
            return None
        return RuntimeRecord.from_dict(data)

    def save_runtime_record(self, record: RuntimeRecord) -> None:
        """Save runtime record."""
        self._runtime_records[record.runtime_id] = record.to_dict()
        self._save_json("runtime_records.json", self._runtime_records)

    def list_runtime_records(self) -> list[RuntimeRecord]:
        """List all runtime records."""
        return [
            RuntimeRecord.from_dict(data)
            for data in self._runtime_records.values()
        ]

    def update_runtime_heartbeat(self, runtime_id: str) -> None:
        """Update runtime heartbeat timestamp."""
        if runtime_id not in self._runtime_records:
            # Auto-create if not exists
            record = RuntimeRecord(
                runtime_id=runtime_id,
                online=True,
                last_heartbeat=datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
            )
            self.save_runtime_record(record)
        else:
            data = self._runtime_records[runtime_id]
            data["online"] = True
            data["last_heartbeat"] = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
            self._save_json("runtime_records.json", self._runtime_records)

    # ===== Onboarding Progress =====

    def get_onboarding_progress(self, workspace_id: str) -> OnboardingProgress | None:
        """Get onboarding progress for workspace."""
        data = self._onboarding_progress.get(workspace_id)
        if not data:
            return None
        return OnboardingProgress.from_dict(data)

    def save_onboarding_progress(self, workspace_id: str, progress: OnboardingProgress) -> None:
        """Save onboarding progress for workspace."""
        self._onboarding_progress[workspace_id] = progress.to_dict()
        self._save_json("onboarding_progress.json", self._onboarding_progress)

    def get_or_create_onboarding_progress(self, workspace_id: str) -> OnboardingProgress:
        """Get or create default onboarding progress."""
        progress = self.get_onboarding_progress(workspace_id)
        if progress:
            return progress

        # Create default progress
        progress = OnboardingProgress(
            current_step=OnboardingStep.LINEAR_CONNECT,
            completed_steps=[],
            next_action="Connect your Linear workspace to get started",
        )
        self.save_onboarding_progress(workspace_id, progress)
        return progress

    # ===== Repository Mappings =====

    def get_repository_mapping(self, workspace_id: str) -> RepositoryMapping | None:
        """Get repository mapping for workspace."""
        data = self._repository_mappings.get(workspace_id)
        if not data:
            return None
        return RepositoryMapping.from_dict(data)

    def save_repository_mapping(self, workspace_id: str, mapping: RepositoryMapping) -> None:
        """Save repository mapping for workspace."""
        self._repository_mappings[workspace_id] = mapping.to_dict()
        self._save_json("repository_mappings.json", self._repository_mappings)

    # ===== Query Helpers =====

    def get_workspace_context(self, workspace_id: str) -> dict[str, Any]:
        """
        Get complete workspace context (for UI bootstrap).

        Returns UI-safe data only - no OAuth tokens.
        """
        installation = self.get_linear_installation(workspace_id)
        progress = self.get_onboarding_progress(workspace_id)
        mapping = self.get_repository_mapping(workspace_id)

        return {
            "workspace_id": workspace_id,
            "linear_connected": installation is not None,
            "onboarding_progress": progress.to_dict() if progress else None,
            "repository_mapping": mapping.to_dict() if mapping else None,
        }
