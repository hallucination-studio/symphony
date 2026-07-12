from __future__ import annotations

from .conductor_linear_direct_base import LinearDirectGraphQLBase, LinearDirectProxyError
from .conductor_linear_direct_comments import ManagedRunCommentMixin
from .conductor_linear_direct_context import LinearDirectContextMixin
from .conductor_linear_direct_issues import ManagedRunIssueMixin
from .conductor_linear_direct_project_labels import ProjectLabelLinearProxyMixin


class ManagedRunLinearProxy(
    ManagedRunIssueMixin,
    ManagedRunCommentMixin,
    LinearDirectContextMixin,
    LinearDirectGraphQLBase,
):
    pass


class ProjectLabelLinearProxy(ProjectLabelLinearProxyMixin, ManagedRunLinearProxy):
    """Reads and writes project-level labels through Podium's Linear proxy.

    Linear models project labels (`ProjectLabel`) separately from issue labels,
    so this cannot reuse `issueLabel*`. `projectUpdate.labelIds` is a full
    replacement; callers merge before writing (see `_merge_project_labels`).
    """


__all__ = ["LinearDirectProxyError", "ManagedRunLinearProxy", "ProjectLabelLinearProxy"]
