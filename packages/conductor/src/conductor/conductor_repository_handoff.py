from __future__ import annotations

from typing import Any, Callable

from performer_api.models import utc_now
from performer_api.ops_models import OpsSnapshot, TraceEvent

from .conductor_models import InstanceRecord


REPOSITORY_INTEGRATION_LABEL = "performer:type/repository-integration"
REPOSITORY_HANDOFF_MARKER_NAME = "SYMPHONY REPOSITORY HANDOFF"


class RepositoryHandoffError(Exception):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code


class RepositoryHandoffCoordinator:
    def __init__(
        self,
        *,
        ops_rows: Callable[[], list[tuple[InstanceRecord, Any, OpsSnapshot]]],
        tracker_factory: Callable[[InstanceRecord], Any],
    ):
        self.ops_rows = ops_rows
        self.tracker_factory = tracker_factory

    async def coordinate(self, *, instance_id: str | None = None) -> dict[str, Any]:
        rows = self.ops_rows()
        if instance_id is not None:
            rows = [row for row in rows if row[0].id == instance_id]
        closed_out = 0
        failed = 0
        skipped = 0
        for instance, store, snapshot in rows:
            closeout_source_ids = {
                str(event.payload.get("source_event_id") or "")
                for event in snapshot.events
                if event.event_type == "repository_handoff_closeout.v1"
                and event.payload.get("status") == "completed"
            }
            for event in list(snapshot.events):
                if event.event_type != "repository_handoff_report.v1":
                    continue
                if event.event_id in closeout_source_ids:
                    skipped += 1
                    continue
                try:
                    result = await self.closeout(instance, event)
                except Exception as exc:
                    failed += 1
                    snapshot = store.load()
                    snapshot.events.append(
                        repository_handoff_closeout_event(
                            snapshot,
                            source_event=event,
                            status="failed",
                            payload={"failure_reason": str(exc), "instance_id": instance.id},
                        )
                    )
                    store.save(snapshot)
                    continue
                snapshot = store.load()
                snapshot.events.append(
                    repository_handoff_closeout_event(
                        snapshot,
                        source_event=event,
                        status="completed",
                        payload={**result, "instance_id": instance.id},
                    )
                )
                store.save(snapshot)
                closed_out += 1
        return {"closed_out": closed_out, "failed": failed, "skipped": skipped}

    async def closeout(self, instance: InstanceRecord, event: TraceEvent) -> dict[str, Any]:
        report = dict(event.payload)
        issue_id = str(report.get("issue_id") or event.issue_id or "").strip()
        issue_identifier = str(report.get("issue_identifier") or issue_id).strip()
        if not issue_id:
            raise RepositoryHandoffError("repository_handoff_missing_issue_id", "Repository handoff report missing issue_id")
        tracker = self.tracker_factory(instance)
        child = await find_repository_integration_child(tracker, issue_id)
        description = repository_integration_description(report, instance=instance)
        delegate_id = linear_agent_app_user_id(instance.linear_filters) or None
        mode = "updated"
        if child is None:
            create_child = getattr(tracker, "create_child_issue_for", None)
            if not callable(create_child):
                raise RepositoryHandoffError("repository_handoff_tracker_missing_create", "Tracker cannot create child issue")
            child = await create_child(
                parent_issue_id=issue_id,
                title=f"Integrate {issue_identifier} implementation",
                description=description,
                label_names=[REPOSITORY_INTEGRATION_LABEL],
                delegate_id=delegate_id,
            )
            mode = "created"
        else:
            update_description = getattr(tracker, "update_issue_description_marker_block", None)
            if callable(update_description):
                await update_description(
                    str(child.get("id") or ""),
                    REPOSITORY_HANDOFF_MARKER_NAME,
                    description,
                )
        comment_result = await comment_repository_handoff(tracker, issue_id, report, child, instance)
        return {
            "status": "completed",
            "closeout_mode": mode,
            "child_issue_id": child.get("id"),
            "child_issue_identifier": child.get("identifier"),
            "child_issue_url": child.get("url"),
            "comment_result": comment_result,
            "source_event_id": event.event_id,
        }


async def find_repository_integration_child(tracker: Any, source_issue_id: str) -> dict[str, Any] | None:
    fetch_children = getattr(tracker, "fetch_child_issues", None)
    if not callable(fetch_children):
        return None
    children = await fetch_children(source_issue_id, label_name=REPOSITORY_INTEGRATION_LABEL)
    marker = repository_handoff_marker(source_issue_id)
    for child in children:
        if marker in str(child.get("description") or ""):
            return child
    return children[0] if children else None


async def comment_repository_handoff(
    tracker: Any,
    issue_id: str,
    report: dict[str, Any],
    child: dict[str, Any],
    instance: InstanceRecord,
) -> dict[str, Any] | None:
    comment_issue = getattr(tracker, "comment_issue", None)
    if not callable(comment_issue):
        return None
    mention = str(instance.linear_filters.get("integration_agent_mention") or "").strip()
    if not mention:
        mention = linear_agent_app_user_id(instance.linear_filters)
    body = repository_handoff_comment(report, child=child, mention=mention)
    return await comment_issue(issue_id, body)


def repository_handoff_marker(source_issue_id: str) -> str:
    return f"<!-- {REPOSITORY_HANDOFF_MARKER_NAME} source_issue_id={source_issue_id} -->"


def repository_handoff_closeout_event(
    snapshot: OpsSnapshot,
    *,
    source_event: TraceEvent,
    status: str,
    payload: dict[str, Any],
) -> TraceEvent:
    return TraceEvent(
        event_id=f"evt-{len(snapshot.events) + 1}",
        event_type="repository_handoff_closeout.v1",
        timestamp=utc_now().isoformat().replace("+00:00", "Z"),
        issue_id=source_event.issue_id,
        run_id=source_event.run_id,
        attempt_id=source_event.attempt_id,
        retention_tier="summary",
        summary=status,
        payload={"status": status, "source_event_id": source_event.event_id, **payload},
    )


def repository_integration_description(report: dict[str, Any], *, instance: InstanceRecord) -> str:
    issue_id = str(report.get("issue_id") or "")
    issue_identifier = str(report.get("issue_identifier") or issue_id)
    bundle = report.get("bundle") if isinstance(report.get("bundle"), dict) else {}
    git_snapshot = report.get("git_snapshot") if isinstance(report.get("git_snapshot"), dict) else {}
    structured = report.get("structured_result") if isinstance(report.get("structured_result"), dict) else {}
    changed_files = git_snapshot.get("changed_files") if isinstance(git_snapshot.get("changed_files"), list) else []
    manifest = report.get("artifact_manifest") if isinstance(report.get("artifact_manifest"), list) else []
    return "\n".join(
        [
            repository_handoff_marker(issue_id),
            f"# Integrate {issue_identifier} implementation",
            "",
            f"Source issue: {issue_identifier} (`{issue_id}`)",
            "Closeout mode: local_bundle",
            f"Workspace path: `{report.get('workspace_path') or instance.workspace_root}`",
            f"Bundle path: `{bundle.get('path') or ''}`",
            f"Patch path: `{bundle.get('changes_patch_path') or ''}`",
            f"Manifest path: `{bundle.get('manifest_path') or ''}`",
            "",
            "## Git Snapshot",
            f"- Repository root: `{git_snapshot.get('repo_root') or 'workspace-only'}`",
            f"- Branch: `{git_snapshot.get('branch') or 'unknown'}`",
            f"- HEAD: `{git_snapshot.get('head_sha') or 'unknown'}`",
            f"- Status: `{git_snapshot.get('status_porcelain') or 'clean-or-unavailable'}`",
            f"- Diff stat: `{git_snapshot.get('diff_stat') or 'none'}`",
            f"- Changed files: {', '.join(str(item) for item in changed_files) if changed_files else 'none'}",
            "",
            "## Test Evidence",
            str(
                structured.get("test_commands_and_exact_output")
                or structured.get("tests")
                or "See source issue implementation evidence."
            ),
            "",
            "## Integration Steps",
            "1. Inspect `changes.patch` and the manifest.",
            "2. Apply tracked changes to the target repository branch without committing automatically.",
            "3. Review copied untracked artifacts under the bundle `untracked/` directory.",
            "4. Run the test evidence commands or equivalent repository verification.",
            "",
            "## Completion Criteria",
            "- Required changes are integrated into the target branch.",
            "- Verification passes after integration.",
            "- Source issue remains traceable through this child issue and local bundle paths.",
            "",
            "## Artifact Manifest",
            "\n".join(
                f"- `{item.get('path')}` size={item.get('size')} sha256={item.get('sha256')}"
                for item in manifest[:25]
                if isinstance(item, dict)
            )
            or "No artifacts listed.",
        ]
    )


def repository_handoff_comment(report: dict[str, Any], *, child: dict[str, Any], mention: str) -> str:
    issue_identifier = str(report.get("issue_identifier") or report.get("issue_id") or "source issue")
    bundle = report.get("bundle") if isinstance(report.get("bundle"), dict) else {}
    child_ref = child.get("url") or child.get("identifier") or child.get("id") or "integration child issue"
    mention_line = f"{mention} " if mention else ""
    return "\n".join(
        [
            f"{mention_line}Repository handoff is ready for {issue_identifier}.",
            "",
            f"Integration child: {child_ref}",
            f"Bundle: `{bundle.get('path') or ''}`",
            f"Patch: `{bundle.get('changes_patch_path') or ''}`",
            f"Manifest: `{bundle.get('manifest_path') or ''}`",
            "",
            "Performer produced the local handoff bundle only. Conductor created this integration follow-up; no commit, push, or merge was performed.",
        ]
    )


def linear_agent_app_user_id(filters: dict[str, Any]) -> str:
    return str(filters.get("linear_agent_app_user_id") or filters.get("agent_app_user_id") or "").strip()
