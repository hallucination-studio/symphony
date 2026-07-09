from __future__ import annotations

import sqlite3
from pathlib import Path

from .conductor_pipeline_store_schema import init_pipeline_db
from .conductor_pipeline_store_types import GraphRevision
from .conductor_pipeline_store_runtime import RuntimeMixin
from .conductor_pipeline_store_graph import GraphMixin
from .conductor_pipeline_store_observability import ObservabilityMixin
from .conductor_pipeline_store_attempts import AttemptsMixin
from .conductor_pipeline_store_leases import LeasesMixin
from .conductor_pipeline_store_integration_queue import IntegrationQueueMixin
from .conductor_pipeline_store_integration_apply import IntegrationApplyMixin
from .conductor_pipeline_store_waits import WaitsMixin
from .conductor_pipeline_store_projection import ProjectionMixin
from .conductor_pipeline_store_graph_mutation import GraphMutationMixin
from .conductor_pipeline_store_completion import CompletionMixin
from .conductor_pipeline_store_failure_view import FailureViewMixin


class ConductorPipelineStore(
    RuntimeMixin,
    GraphMixin,
    ObservabilityMixin,
    AttemptsMixin,
    LeasesMixin,
    IntegrationQueueMixin,
    IntegrationApplyMixin,
    WaitsMixin,
    ProjectionMixin,
    GraphMutationMixin,
    CompletionMixin,
    FailureViewMixin,
):
    def __init__(self, data_root: Path):
        self.data_root = data_root
        self.db_path = data_root / "pipeline.db"
        self.artifact_root = data_root / "artifacts"
        self.data_root.mkdir(parents=True, exist_ok=True)
        self.artifact_root.mkdir(parents=True, exist_ok=True)
        self._init_db()

    def connect(self) -> sqlite3.Connection:
        connection = sqlite3.connect(self.db_path, timeout=5.0)
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA busy_timeout = 5000")
        connection.execute("PRAGMA journal_mode = WAL")
        return connection

    def _init_db(self) -> None:
        init_pipeline_db(str(self.db_path))


__all__ = ["ConductorPipelineStore", "GraphRevision"]
