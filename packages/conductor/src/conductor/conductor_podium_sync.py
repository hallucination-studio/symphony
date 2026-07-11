from __future__ import annotations

from .conductor_podium_sync_background import PodiumBackgroundMixin
from .conductor_podium_sync_dispatch import PodiumDispatchMixin
from .conductor_podium_sync_failure import PodiumSyncFailureMixin
from .conductor_podium_sync_project_label import PodiumProjectLabelMixin
from .conductor_podium_sync_reporter import PodiumReportMixin
from .conductor_podium_sync_smoke import PodiumSmokeCheckMixin
from .conductor_podium_sync_commands import PodiumCommandMixin


class ConductorPodiumSyncMixin(
    PodiumSyncFailureMixin,
    PodiumDispatchMixin,
    PodiumReportMixin,
    PodiumSmokeCheckMixin,
    PodiumCommandMixin,
    PodiumBackgroundMixin,
    PodiumProjectLabelMixin,
):
    pass


__all__ = ["ConductorPodiumSyncMixin"]
