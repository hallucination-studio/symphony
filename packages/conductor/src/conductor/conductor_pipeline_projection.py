from __future__ import annotations

from typing import Any

from .conductor_pipeline_projection_common import ConductorPipelineStore
from .conductor_pipeline_projection_reconcile import ReconcileMixin
from .conductor_pipeline_projection_activity import ActivityMixin
from .conductor_pipeline_projection_ingest import IngestMixin
from .conductor_pipeline_projection_description import DescriptionMixin


class PipelineLinearProjector(
    ReconcileMixin,
    ActivityMixin,
    IngestMixin,
    DescriptionMixin,
):
    def __init__(
        self,
        *,
        store: ConductorPipelineStore,
        tracker: Any,
        root_issue_id: str,
        delegate_id: str | None = None,
    ):
        self.store = store
        self.tracker = tracker
        self.root_issue_id = root_issue_id
        self.delegate_id = delegate_id


__all__ = ["PipelineLinearProjector"]
