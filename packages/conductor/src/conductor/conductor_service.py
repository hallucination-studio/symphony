from __future__ import annotations

from pathlib import Path
from typing import Any
import shutil
import subprocess
import socket
from datetime import datetime, timezone
import httpx

from .conductor_models import (
    ConductorSettings,
    InstanceCreateRequest,
    InstancePatchRequest,
    InstanceRecord,
    WorkflowValidationResult,
)
from .conductor_runtime import ConductorRuntimeManager
from .conductor_runtime import LogQuery
from .conductor_store import ConductorStore
from .conductor_workflow import (
    ConductorValidationError,
    generate_workflow_content,
    validate_instance_workflow,
    workflow_profiles,
)
from performer_api.ops_models import OpsSnapshot, TraceEvent
from performer_api.ops_projection import build_issue_detail, build_issue_list, build_run_detail, build_trace_stream
from performer_api.ops_retention import RetentionPolicy
from performer_api.ops_store import OpsStore
from performer_api.persistence import PersistenceStore, PersistedSession, PersistedState
from performer_api.models import LIFECYCLE_LABELS, RetryEntry, monotonic_ms, utc_now


WORKSPACE_INIT_EXCLUDES = {
    ".conductor",
    "conductor-data",
    ".venv",
    "workspaces",
    ".codex-runtime",
    ".test-real-flow",
    ".tmp-real-linear-flow",
    ".pytest_cache",
    "__pycache__",
    "node_modules",
    "target",
}
REPOSITORY_INTEGRATION_LABEL = "performer:type/repository-integration"
REPOSITORY_HANDOFF_MARKER_NAME = "SYMPHONY REPOSITORY HANDOFF"


class ConductorServiceError(Exception):
    def __init__(self, code: str, message: str, *, diagnostics: list[str] | None = None):
        super().__init__(message)
        self.code = code
        self.diagnostics = diagnostics or []


class RepositoryHandoffLinearProxy:
    def __init__(self, *, endpoint: str, api_key: str):
        self.endpoint = endpoint
        self.api_key = api_key

    async def graphql(self, query: str, variables: dict[str, Any] | None = None) -> dict[str, Any]:
        headers = {"Authorization": self.api_key, "Content-Type": "application/json"}
        async with httpx.AsyncClient(timeout=30, trust_env=False) as client:
            response = await client.post(self.endpoint, json={"query": query, "variables": variables or {}}, headers=headers)
        response.raise_for_status()
        payload = response.json()
        if not isinstance(payload, dict):
            raise ConductorServiceError("linear_unknown_payload", "Linear response was not an object")
        if payload.get("errors"):
            raise ConductorServiceError("linear_graphql_errors", str(payload["errors"]))
        return payload

    async def fetch_child_issues(self, parent_issue_id: str, *, label_name: str | None = None) -> list[dict[str, Any]]:
        payload = await self.graphql(
            """
query RepositoryHandoffChildren($issueId: String!) {
  issue(id: $issueId) {
    children(first: 100) {
      nodes {
        id
        identifier
        title
        description
        url
        delegate { id }
        labels { nodes { name } }
      }
    }
  }
}
""",
            {"issueId": parent_issue_id},
        )
        nodes = ((((payload.get("data") or {}).get("issue") or {}).get("children") or {}).get("nodes") or [])
        children = [_normalize_linear_issue_dict(node) for node in nodes if isinstance(node, dict)]
        if label_name is None:
            return children
        wanted = label_name.strip().lower()
        return [child for child in children if wanted in {str(label).lower() for label in child.get("labels", [])}]

    async def create_child_issue_for(
        self,
        *,
        parent_issue_id: str,
        title: str,
        description: str,
        label_names: list[str],
        delegate_id: str | None = None,
    ) -> dict[str, Any]:
        context = await self._creation_context(parent_issue_id)
        label_ids = [await self._ensure_label_id(context["team_id"], name) for name in label_names]
        payload = await self.graphql(
            """
mutation RepositoryHandoffCreateChild(
  $teamId: String!,
  $projectId: String!,
  $stateId: String!,
  $labelIds: [String!],
  $title: String!,
  $description: String!,
  $parentId: String,
  $delegateId: String
) {
  issueCreate(input: {
    teamId: $teamId,
    projectId: $projectId,
    stateId: $stateId,
    labelIds: $labelIds,
    title: $title,
    description: $description,
    parentId: $parentId,
    delegateId: $delegateId
  }) {
    success
    issue {
      id
      identifier
      title
      description
      url
      delegate { id }
      labels { nodes { name } }
    }
  }
}
""",
            {
                "teamId": context["team_id"],
                "projectId": context["project_id"],
                "stateId": context["state_id"],
                "labelIds": label_ids,
                "title": title,
                "description": description,
                "parentId": parent_issue_id,
                "delegateId": delegate_id,
            },
        )
        result = ((payload.get("data") or {}).get("issueCreate") or {})
        issue = result.get("issue") if isinstance(result, dict) else {}
        if not result.get("success") or not isinstance(issue, dict) or not issue.get("id"):
            raise ConductorServiceError("linear_issue_create_failed", "Linear issueCreate returned success=false")
        return _normalize_linear_issue_dict(issue)

    async def update_issue_description_marker_block(
        self,
        issue_id: str,
        marker_name: str,
        block: str,
    ) -> dict[str, Any]:
        payload = await self.graphql(
            """
query RepositoryHandoffDescription($issueId: String!) {
  issue(id: $issueId) { id identifier description }
}
""",
            {"issueId": issue_id},
        )
        issue = ((payload.get("data") or {}).get("issue") or {})
        current = str(issue.get("description") or "") if isinstance(issue, dict) else ""
        description = _replace_marker_block(current, marker_name, block)
        payload = await self.graphql(
            """
mutation RepositoryHandoffUpdateDescription($issueId: String!, $description: String!) {
  issueUpdate(id: $issueId, input: { description: $description }) {
    success
    issue { id identifier description }
  }
}
""",
            {"issueId": issue_id, "description": description},
        )
        result = ((payload.get("data") or {}).get("issueUpdate") or {})
        return {"success": bool(result.get("success")), "issue_id": issue_id, "description": description}

    async def comment_issue(self, issue_id: str, body: str) -> dict[str, Any]:
        payload = await self.graphql(
            """
mutation RepositoryHandoffComment($issueId: String!, $body: String!) {
  commentCreate(input: { issueId: $issueId, body: $body }) {
    success
    comment { id }
  }
}
""",
            {"issueId": issue_id, "body": body},
        )
        result = ((payload.get("data") or {}).get("commentCreate") or {})
        comment = result.get("comment") if isinstance(result, dict) else {}
        return {"success": bool(result.get("success")), "comment_id": comment.get("id") if isinstance(comment, dict) else None}

    async def _creation_context(self, issue_id: str) -> dict[str, str]:
        payload = await self.graphql(
            """
query RepositoryHandoffCreationContext($issueId: String!) {
  issue(id: $issueId) {
    team { id }
    project { id }
    state { id }
  }
}
""",
            {"issueId": issue_id},
        )
        issue = ((payload.get("data") or {}).get("issue") or {})
        team = issue.get("team") if isinstance(issue, dict) and isinstance(issue.get("team"), dict) else {}
        project = issue.get("project") if isinstance(issue, dict) and isinstance(issue.get("project"), dict) else {}
        state = issue.get("state") if isinstance(issue, dict) and isinstance(issue.get("state"), dict) else {}
        return {"team_id": str(team.get("id") or ""), "project_id": str(project.get("id") or ""), "state_id": str(state.get("id") or "")}

    async def _ensure_label_id(self, team_id: str, label_name: str) -> str:
        payload = await self.graphql(
            """
query RepositoryHandoffLabelByName($name: String!, $teamId: ID!) {
  issueLabels(first: 20, filter: { name: { eq: $name }, team: { id: { eq: $teamId } } }) {
    nodes { id name }
  }
}
""",
            {"name": label_name, "teamId": team_id},
        )
        nodes = (((payload.get("data") or {}).get("issueLabels") or {}).get("nodes") or [])
        for node in nodes:
            if isinstance(node, dict) and node.get("id"):
                return str(node["id"])
        payload = await self.graphql(
            """
mutation RepositoryHandoffCreateLabel($name: String!, $teamId: String!) {
  issueLabelCreate(input: { name: $name, teamId: $teamId }) {
    success
    issueLabel { id name }
  }
}
""",
            {"name": label_name, "teamId": team_id},
        )
        label = (((payload.get("data") or {}).get("issueLabelCreate") or {}).get("issueLabel") or {})
        if not isinstance(label, dict) or not label.get("id"):
            raise ConductorServiceError("linear_label_create_failed", f"Could not create Linear label: {label_name}")
        return str(label["id"])


class ConductorService:
    def __init__(
        self,
        *,
        store: ConductorStore,
        data_root: Path,
        runtime_manager: ConductorRuntimeManager | None = None,
    ):
        self.store = store
        self.data_root = data_root
        self.runtime_manager = runtime_manager or ConductorRuntimeManager()
        self.repository_handoff_tracker_factory = self._repository_handoff_tracker
        self._active_podium_dispatches: dict[str, dict[str, str]] = {}
        self.data_root.mkdir(parents=True, exist_ok=True)
        self._normalize_stale_runtime_state()

    def list_instances(self) -> list[InstanceRecord]:
        return self.store.list_instances()

    def settings(self) -> ConductorSettings:
        return self.store.get_settings()

    def update_settings(self, settings: ConductorSettings) -> ConductorSettings:
        self.store.save_settings(settings)
        return settings

    def update_settings_json(self, payload: dict[str, Any]) -> ConductorSettings:
        merged = self.store.get_settings().to_dict()
        merged.update(payload)
        return self.update_settings(ConductorSettings.from_dict(merged))

    async def dispatch_podium_event(self, event: dict[str, Any]) -> dict[str, Any]:
        issue_id = str(event.get("issue_id") or "").strip()
        issue_identifier = str(event.get("issue_identifier") or "").strip()
        if not issue_id and not issue_identifier:
            raise ConductorServiceError("missing_issue_id", "Podium dispatch event requires issue_id or issue_identifier")
        project_slug = str(event.get("project_slug") or "").strip()
        agent_app_user_id = str(event.get("agent_app_user_id") or event.get("app_user_id") or "").strip()
        if not agent_app_user_id:
            return {
                "status": "skipped",
                "issue_id": issue_id or None,
                "issue_identifier": issue_identifier or None,
                "reason": "missing_linear_agent_app_user",
            }
        instance = self._instance_for_podium_event(project_slug=project_slug, agent_app_user_id=agent_app_user_id)
        if instance is None:
            return {
                "status": "skipped",
                "issue_id": issue_id or None,
                "issue_identifier": issue_identifier or None,
                "reason": "no_matching_instance",
            }
        started = await self.runtime_manager.start(
            instance,
            env=self._runtime_env(),
            dispatch_issue_id=issue_id or issue_identifier,
        )
        dispatch_id = str(event.get("dispatch_id") or "").strip()
        if dispatch_id:
            self._active_podium_dispatches[instance.id] = {
                "dispatch_id": dispatch_id,
                "issue_id": issue_id,
            }
        self.store.update_instance(started)
        return {
            "status": "accepted",
            "issue_id": issue_id or None,
            "issue_identifier": issue_identifier or None,
            "instance_id": instance.id,
            "agent_session_id": event.get("agent_session_id") or None,
            "agent_app_user_id": agent_app_user_id,
        }

    async def poll_podium_dispatch_once(self) -> dict[str, Any]:
        settings = self.store.get_settings()
        podium_url = settings.podium_url.strip().rstrip("/")
        runtime_token = settings.podium_runtime_token.strip()
        if not podium_url or not runtime_token:
            return {"status": "skipped", "reason": "runtime_not_configured"}
        headers = {"Authorization": f"Bearer {runtime_token}"}
        async with httpx.AsyncClient(timeout=10, trust_env=False) as client:
            lease_response = await client.post(f"{podium_url}/api/v1/runtime/dispatches/lease", headers=headers)
            if lease_response.status_code == 401:
                return {"status": "skipped", "reason": "runtime_unauthorized"}
            lease_response.raise_for_status()
            leased = lease_response.json().get("dispatch")
            if not leased:
                return {"status": "idle"}
            result = await self.dispatch_podium_event(leased)
            await client.post(
                f"{podium_url}/api/v1/runtime/dispatches/ack",
                headers=headers,
                json={
                    "dispatch_id": leased.get("dispatch_id"),
                    "status": result.get("status", "accepted"),
                    "reason": result.get("reason"),
                    "runtime_phase": result.get("runtime_phase"),
                },
            )
            return {"status": "leased", "dispatch": leased, "result": result}

    def build_podium_report(self, *, log_tail_lines: int = 200) -> dict[str, Any]:
        settings = self.store.get_settings()
        dashboard = self.dashboard()
        bindings: list[dict[str, Any]] = []
        metrics: dict[str, dict[str, Any]] = {}
        queue: dict[str, dict[str, Any]] = {}
        log_tail: dict[str, dict[str, Any]] = {}
        totals = dashboard.get("totals") if isinstance(dashboard.get("totals"), dict) else {}
        instances = self.store.list_instances()
        for instance in instances:
            agent_app_user_id = _linear_agent_app_user_id(instance.linear_filters)
            bindings.append(
                {
                    "instance_id": instance.id,
                    "name": instance.name,
                    "linear_project": instance.linear_project,
                    "project_slug": instance.linear_project,
                    "agent_app_user_id": agent_app_user_id,
                    "workflow_profile": instance.workflow_profile,
                    "process_status": instance.process_status,
                    "repo_source": {"type": instance.repo_source_type, "value": instance.repo_source_value},
                }
            )
            performer = self._performer_runtime_from_persistence(instance)
            metrics[instance.id] = {
                "tokens": int(totals.get("tokens") or 0),
                "runtime_seconds": float(totals.get("runtime_seconds") or 0),
                "retries": int((performer.get("counts") or {}).get("retrying") or 0),
                "continuations": int((performer.get("counts") or {}).get("continuing") or 0),
                "blocked": int((performer.get("counts") or {}).get("blocked") or 0),
                "failures": int(totals.get("failures") or 0),
            }
            queue[instance.id] = {
                "queued": 0,
                "leased": 0,
                "running": 1 if instance.process_status == "running" else 0,
            }
            logs = self.query_instance_logs(instance.id, tail=log_tail_lines, order="desc")
            log_tail[instance.id] = {
                "generation": logs.get("generation"),
                "offset_end": logs.get("offset_end", 0),
                "lines": logs.get("lines") or [],
            }
        return {
            "conductor_id": settings.conductor_id,
            "hostname": _hostname(),
            "label": "",
            "version": "",
            "bindings": bindings,
            "metrics": metrics,
            "queue": queue,
            "log_tail": log_tail,
        }

    async def post_podium_report(
        self,
        *,
        transport: httpx.AsyncBaseTransport | None = None,
        log_tail_lines: int = 200,
    ) -> dict[str, Any]:
        settings = self.store.get_settings()
        podium_url = settings.podium_url.strip().rstrip("/")
        runtime_token = settings.podium_runtime_token.strip()
        if not podium_url or not runtime_token:
            return {"status": "skipped", "reason": "runtime_not_configured"}
        async with httpx.AsyncClient(timeout=10, trust_env=False, transport=transport) as client:
            response = await client.post(
                f"{podium_url}/api/v1/runtime/report",
                headers={"Authorization": f"Bearer {runtime_token}"},
                json=self.build_podium_report(log_tail_lines=log_tail_lines),
            )
        if response.status_code == 401:
            return {"status": "skipped", "reason": "runtime_unauthorized"}
        response.raise_for_status()
        payload = response.json()
        return payload if isinstance(payload, dict) else {"status": "ok"}

    async def handle_podium_ws_command(
        self,
        command: dict[str, Any],
        *,
        post_log_chunk: Any | None = None,
    ) -> dict[str, Any]:
        kind = str(command.get("type") or "")
        if kind == "dispatch.available":
            dispatch = command.get("dispatch") if isinstance(command.get("dispatch"), dict) else command
            return await self.dispatch_podium_event(dispatch)
        if kind == "log.fetch":
            instance_id = str(command.get("instance_id") or "")
            logs = self.query_instance_logs(
                instance_id,
                tail=_optional_int(command.get("tail"), 200),
                previous=bool(command.get("previous")),
                order=str(command.get("order") or "desc"),
            )
            payload = {
                "request_id": str(command.get("request_id") or ""),
                "instance_id": instance_id,
                "generation": logs.get("generation"),
                "offset_start": logs.get("offset_start", 0),
                "offset_end": logs.get("offset_end", 0),
                "order": logs.get("order") or "desc",
                "lines": logs.get("lines") or [],
            }
            if post_log_chunk is not None:
                await post_log_chunk(payload)
                return {"status": "posted", "request_id": payload["request_id"]}
            return {"status": "log_chunk_ready", "chunk": payload}
        return {"status": "ignored", "reason": "unsupported_command"}

    async def coordinate_background_once(self) -> dict[str, Any]:
        closeout = await self.coordinate_repository_handoff_closeouts()
        dispatch_acks = await self.ack_completed_podium_dispatches()
        gated_followups_started = 0
        resumed = 0
        for instance in self.store.list_instances():
            current = self.get_instance(instance.id)
            if current is None:
                continue
            resume = await self._resume_pending_performer_work(current)
            if resume is not None:
                self.store.update_instance(resume)
                resumed += 1
                continue
            issue_id = self._pending_gated_followup_issue_id(current)
            if issue_id is None:
                continue
            followup = await self._coordinate_gated_followup(current, issue_id=issue_id)
            if followup is None:
                continue
            followup = self._with_gated_followup_stage(followup, issue_id, "gate")
            self.store.update_instance(followup)
            gated_followups_started += 1
        return {
            "repository_handoff": closeout,
            "dispatch_acks": dispatch_acks,
            "gated_followups_started": gated_followups_started,
            "resumed": resumed,
        }

    async def ack_completed_podium_dispatches(
        self,
        *,
        transport: httpx.AsyncBaseTransport | None = None,
    ) -> dict[str, Any]:
        if not self._active_podium_dispatches:
            return {"acked": 0, "failed": 0, "skipped": 0}
        settings = self.store.get_settings()
        podium_url = settings.podium_url.strip().rstrip("/")
        runtime_token = settings.podium_runtime_token.strip()
        if not podium_url or not runtime_token:
            return {"acked": 0, "failed": 0, "skipped": len(self._active_podium_dispatches)}
        acked = 0
        failed = 0
        skipped = 0
        async with httpx.AsyncClient(timeout=10, trust_env=False, transport=transport) as client:
            for instance_id, active in list(self._active_podium_dispatches.items()):
                instance = self.store.get_instance(instance_id)
                if instance is None:
                    self._active_podium_dispatches.pop(instance_id, None)
                    skipped += 1
                    continue
                refreshed = self.get_instance(instance_id) or instance
                if refreshed.process_status not in {"exited", "stopped"}:
                    skipped += 1
                    continue
                snapshot = OpsStore(Path(refreshed.persistence_path).parent / "ops.json").load()
                issue = snapshot.issues.get(active["issue_id"])
                if issue is None or issue.state not in {"completed", "failed", "blocked"}:
                    skipped += 1
                    continue
                status = "completed" if issue.state == "completed" else "failed"
                reason = "completed_by_runtime" if issue.state == "completed" else (issue.failure_reason or issue.state)
                response = await client.post(
                    f"{podium_url}/api/v1/runtime/dispatches/ack",
                    headers={"Authorization": f"Bearer {runtime_token}"},
                    json={
                        "dispatch_id": active["dispatch_id"],
                        "status": status,
                        "reason": reason,
                        "runtime_phase": issue.state,
                    },
                )
                if response.status_code >= 400:
                    failed += 1
                    continue
                self._active_podium_dispatches.pop(instance_id, None)
                acked += 1
        return {"acked": acked, "failed": failed, "skipped": skipped}

    async def _coordinate_gated_followup(self, instance: InstanceRecord, *, issue_id: str) -> InstanceRecord | None:
        if instance.workflow_profile != "gated-task":
            return None
        refresh = getattr(self.runtime_manager, "refresh", None)
        if not callable(refresh):
            return None
        refreshed = refresh(instance)
        if refreshed.process_status not in {"exited", "stopped"}:
            return None
        snapshot = OpsStore(Path(instance.persistence_path).parent / "ops.json").load()
        issue = snapshot.issues.get(issue_id)
        if issue is None or issue.state != "completed" or issue.run_count != 1:
            return None
        stage = self._next_gated_followup_stage(refreshed, issue_id)
        if stage is None:
            return None
        if not self.store.claim_gated_followup_marker(instance.id, issue_id, stage):
            return None
        self._record_gated_followup_event(refreshed, issue_id=issue_id, stage=stage, event_type="gate_followup_starting")
        try:
            followup = await self.runtime_manager.start(
                refreshed.with_updates(process_status="starting"),
                env=self._runtime_env(),
                dispatch_issue_id=issue_id,
            )
        except Exception as exc:
            self.store.mark_gated_followup_failed(instance.id, issue_id, stage, str(exc))
            raise
        self.store.mark_gated_followup_started(instance.id, issue_id, stage)
        self._record_gated_followup_event(followup, issue_id=issue_id, stage=stage, event_type="gate_followup_started")
        return followup

    async def get_instance_coordinated(self, instance_id: str) -> InstanceRecord | None:
        instance = self.get_instance(instance_id)
        if instance is None:
            return None
        await self.coordinate_repository_handoff_closeouts(instance_id=instance_id)
        resumed = await self._resume_pending_performer_work(instance)
        if resumed is not None:
            self.store.update_instance(resumed)
            return resumed
        issue_id = self._pending_gated_followup_issue_id(instance)
        if issue_id is None:
            return instance
        followup = await self._coordinate_gated_followup(instance, issue_id=issue_id)
        if followup is None:
            return instance
        followup = self._with_gated_followup_stage(followup, issue_id, "gate")
        self.store.update_instance(followup)
        return followup

    async def coordinate_repository_handoff_closeouts(self, *, instance_id: str | None = None) -> dict[str, Any]:
        rows = self._ops_stores()
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
                    result = await self._closeout_repository_handoff(instance, event)
                except Exception as exc:
                    failed += 1
                    snapshot = store.load()
                    snapshot.events.append(
                        _repository_handoff_closeout_event(
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
                    _repository_handoff_closeout_event(
                        snapshot,
                        source_event=event,
                        status="completed",
                        payload={**result, "instance_id": instance.id},
                    )
                )
                store.save(snapshot)
                closed_out += 1
        return {"closed_out": closed_out, "failed": failed, "skipped": skipped}

    async def _closeout_repository_handoff(self, instance: InstanceRecord, event: TraceEvent) -> dict[str, Any]:
        report = dict(event.payload)
        issue_id = str(report.get("issue_id") or event.issue_id or "").strip()
        issue_identifier = str(report.get("issue_identifier") or issue_id).strip()
        if not issue_id:
            raise ConductorServiceError("repository_handoff_missing_issue_id", "Repository handoff report missing issue_id")
        tracker = self.repository_handoff_tracker_factory(instance)
        child = await self._find_repository_integration_child(tracker, issue_id)
        description = _repository_integration_description(report, instance=instance)
        delegate_id = _linear_agent_app_user_id(instance.linear_filters) or None
        mode = "updated"
        if child is None:
            create_child = getattr(tracker, "create_child_issue_for", None)
            if not callable(create_child):
                raise ConductorServiceError("repository_handoff_tracker_missing_create", "Tracker cannot create child issue")
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
        comment_result = await self._comment_repository_handoff(tracker, issue_id, report, child, instance)
        return {
            "status": "completed",
            "closeout_mode": mode,
            "child_issue_id": child.get("id"),
            "child_issue_identifier": child.get("identifier"),
            "child_issue_url": child.get("url"),
            "comment_result": comment_result,
            "source_event_id": event.event_id,
        }

    async def _find_repository_integration_child(self, tracker: Any, source_issue_id: str) -> dict[str, Any] | None:
        fetch_children = getattr(tracker, "fetch_child_issues", None)
        if not callable(fetch_children):
            return None
        children = await fetch_children(source_issue_id, label_name=REPOSITORY_INTEGRATION_LABEL)
        marker = _repository_handoff_marker(source_issue_id)
        for child in children:
            if marker in str(child.get("description") or ""):
                return child
        return children[0] if children else None

    async def _comment_repository_handoff(
        self,
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
            mention = _linear_agent_app_user_id(instance.linear_filters)
        body = _repository_handoff_comment(report, child=child, mention=mention)
        return await comment_issue(issue_id, body)

    def _repository_handoff_tracker(self, instance: InstanceRecord) -> Any:
        settings = self.store.get_settings()
        endpoint_base = settings.podium_url.strip().rstrip("/") or "https://podium.example"
        return RepositoryHandoffLinearProxy(
            endpoint=f"{endpoint_base}/api/v1/linear/graphql",
            api_key=settings.podium_proxy_token.strip(),
        )

    async def _resume_pending_performer_work(self, instance: InstanceRecord) -> InstanceRecord | None:
        refresh = getattr(self.runtime_manager, "refresh", None)
        if not callable(refresh):
            return None
        refreshed = refresh(instance)
        if refreshed.process_status not in {"exited", "stopped"}:
            return None
        if refreshed.last_exit_code not in {0, None}:
            return None
        persisted = PersistenceStore(Path(refreshed.persistence_path)).load()
        if not (persisted.retry_attempts or persisted.continuations or persisted.blocked):
            return None
        issue_id = _first_pending_performer_issue_id(persisted)
        return await self.runtime_manager.start(
            refreshed.with_updates(process_status="starting"),
            env=self._runtime_env(),
            dispatch_issue_id=issue_id,
        )

    def _pending_gated_followup_issue_id(self, instance: InstanceRecord) -> str | None:
        if instance.workflow_profile != "gated-task":
            return None
        snapshot = OpsStore(Path(instance.persistence_path).parent / "ops.json").load()
        candidates = [
            issue
            for issue in snapshot.issues.values()
            if issue.state == "completed"
            and issue.run_count == 1
            and self._next_gated_followup_stage(instance, issue.issue_id) is not None
        ]
        if not candidates:
            return None
        candidates.sort(key=lambda issue: issue.last_activity_at or issue.issue_identifier or issue.issue_id, reverse=True)
        return candidates[0].issue_id

    def _next_gated_followup_stage(self, instance: InstanceRecord, issue_id: str) -> str | None:
        persisted = set(instance.gated_followup_stages.get(issue_id, []))
        for stage in ("gate",):
            if stage in persisted and instance.last_exit_code not in {0, None}:
                return stage
            if stage not in persisted:
                return stage
        return None

    def _with_gated_followup_stage(self, instance: InstanceRecord, issue_id: str, stage: str) -> InstanceRecord:
        stages = {key: list(value) for key, value in instance.gated_followup_stages.items()}
        issue_stages = list(stages.get(issue_id, []))
        if stage not in issue_stages:
            issue_stages.append(stage)
        stages[issue_id] = issue_stages
        return instance.with_updates(gated_followup_stages=stages)

    def _record_gated_followup_event(self, instance: InstanceRecord, *, issue_id: str, stage: str, event_type: str) -> None:
        path = Path(instance.persistence_path).parent / "ops.json"
        store = OpsStore(path)
        snapshot = store.load()
        snapshot.events.append(
            TraceEvent(
                event_id=f"evt-{len(snapshot.events) + 1}",
                event_type=event_type,
                timestamp=utc_now().isoformat().replace("+00:00", "Z"),
                issue_id=issue_id,
                retention_tier="summary",
                summary=stage,
                payload={"instance_id": instance.id, "stage": stage},
            )
        )
        store.save(snapshot)

    def dashboard(self) -> dict[str, Any]:
        instances = self.store.list_instances()
        process_statuses: dict[str, int] = {}
        workflow_statuses: dict[str, int] = {}
        linear_views: dict[str, dict[str, Any]] = {}
        total_tokens = 0
        runtime_seconds = 0
        retry_count = 0
        continuation_count = 0
        blocked_count = 0
        persisted_failures = 0
        for instance in instances:
            process_statuses[instance.process_status] = process_statuses.get(instance.process_status, 0) + 1
            workflow_statuses[instance.workflow_generation_status] = workflow_statuses.get(instance.workflow_generation_status, 0) + 1
            filters_key = json_stable(instance.linear_filters)
            linear_key = f"{instance.linear_project}\0{filters_key}"
            if linear_key not in linear_views:
                linear_views[linear_key] = {
                    "project": instance.linear_project,
                    "filters": instance.linear_filters,
                    "instances": 0,
                }
            linear_views[linear_key]["instances"] += 1
            persisted = PersistenceStore(Path(instance.persistence_path)).load()
            retry_count += len(persisted.retry_attempts)
            continuation_count += len(persisted.continuations)
            blocked_count += len(persisted.blocked)
            persisted_failures += sum(1 for retry in persisted.retry_attempts if retry.error)
            now = datetime.now(timezone.utc)
            for session in persisted.sessions:
                total_tokens += session.tokens.total_tokens
                runtime_seconds += max(int((now - session.started_at).total_seconds()), 0)
        return {
            "counts": {
                "instances": len(instances),
                "running": process_statuses.get("running", 0),
                "workflow_draft": workflow_statuses.get("draft", 0),
                "workflow_invalid": workflow_statuses.get("invalid", 0),
            },
            "process_statuses": process_statuses,
            "workflow_statuses": workflow_statuses,
            "linear_views": list(linear_views.values()),
            "totals": {
                "tokens": total_tokens,
                "runtime_seconds": runtime_seconds,
                "failures": sum(1 for instance in instances if instance.last_error) + persisted_failures,
                "retries": retry_count,
                "continuations": continuation_count,
                "blocked": blocked_count,
            },
        }

    def list_issues(self) -> list[dict[str, Any]]:
        rows: list[dict[str, Any]] = []
        for instance, snapshot in self._ops_snapshots():
            for issue in build_issue_list(snapshot):
                row = issue.to_dict()
                row["instance_id"] = instance.id
                rows.append(row)
        return sorted(rows, key=lambda row: str(row.get("last_activity_at") or ""), reverse=True)

    def get_issue(self, issue_id: str) -> dict[str, Any]:
        for instance, snapshot in self._ops_snapshots():
            if issue_id in snapshot.issues:
                detail = build_issue_detail(snapshot, issue_id)
                detail["instance_id"] = instance.id
                return detail
        raise ConductorServiceError("issue_not_found", f"Issue not found: {issue_id}")

    def list_runs(self) -> list[dict[str, Any]]:
        rows: list[dict[str, Any]] = []
        for instance, snapshot in self._ops_snapshots():
            for run in snapshot.runs.values():
                row = run.to_dict()
                row["instance_id"] = instance.id
                rows.append(row)
        return sorted(rows, key=lambda row: str(row.get("last_activity_at") or ""), reverse=True)

    def get_run(self, run_id: str) -> dict[str, Any]:
        for instance, snapshot in self._ops_snapshots():
            if run_id in snapshot.runs:
                detail = build_run_detail(snapshot, run_id)
                detail["instance_id"] = instance.id
                return detail
        raise ConductorServiceError("run_not_found", f"Run not found: {run_id}")

    def list_trace_events(
        self, *, issue_id: str | None, run_id: str | None, limit: int = 200
    ) -> list[dict[str, Any]]:
        events: list[dict[str, Any]] = []
        for instance, snapshot in self._ops_snapshots():
            for event in build_trace_stream(snapshot, issue_id=issue_id, run_id=run_id, limit=limit):
                row = event.to_dict()
                row["instance_id"] = instance.id
                events.append(row)
        return sorted(events, key=lambda row: str(row.get("timestamp") or ""))[-limit:]

    def retention_status(self) -> dict[str, Any]:
        pinned_issue_ids: set[str] = set()
        pinned_run_ids: set[str] = set()
        event_counts = {"summary": 0, "trace": 0, "raw": 0}
        for _instance, snapshot in self._ops_snapshots():
            pinned_issue_ids.update(snapshot.retention.pinned_issue_ids)
            pinned_run_ids.update(snapshot.retention.pinned_run_ids)
            for event in snapshot.events:
                if event.retention_tier in event_counts:
                    event_counts[event.retention_tier] += 1
        return {
            "pinned_issue_count": len(pinned_issue_ids),
            "pinned_run_count": len(pinned_run_ids),
            "pinned_issue_ids": sorted(pinned_issue_ids),
            "pinned_run_ids": sorted(pinned_run_ids),
            "event_counts": event_counts,
        }

    def pin_issue(self, issue_id: str) -> dict[str, Any]:
        self._update_issue_pin(issue_id, pinned=True)
        return self.retention_status()

    def unpin_issue(self, issue_id: str) -> dict[str, Any]:
        self._update_issue_pin(issue_id, pinned=False)
        return self.retention_status()

    def collect_retention(self, policy: RetentionPolicy | None = None) -> dict[str, Any]:
        policy = policy or RetentionPolicy()
        for _instance, store, snapshot in self._ops_stores():
            store.save(policy.apply(snapshot))
        return self.retention_status()

    def get_instance(self, instance_id: str) -> InstanceRecord | None:
        instance = self.store.get_instance(instance_id)
        if instance is None:
            return None
        refresh = getattr(self.runtime_manager, "refresh", None)
        if not callable(refresh):
            return instance
        refreshed = refresh(instance)
        if refreshed != instance:
            self.store.update_instance(refreshed)
        return refreshed

    def create_instance(self, request: InstanceCreateRequest) -> InstanceRecord:
        instance, validation = self._build_instance_candidate(request, persist_workflow=True)
        if not validation.ok:
            raise ConductorServiceError(validation.error_code or "invalid_workflow", "Workflow validation failed", diagnostics=validation.diagnostics)

        instance = instance.with_updates(workflow_generation_status="valid")
        self._materialize_instance(instance)
        self._initialize_workspace(instance)
        self.store.create_instance(instance)
        return instance

    def preview_instance(self, request: InstanceCreateRequest) -> tuple[InstanceRecord, WorkflowValidationResult]:
        return self._build_instance_candidate(request, persist_workflow=False)

    def _build_instance_candidate(
        self, request: InstanceCreateRequest, *, persist_workflow: bool
    ) -> tuple[InstanceRecord, WorkflowValidationResult]:
        resolved_repo_path = self._resolve_repo(request.repo_source_type, request.repo_source_value)
        instance_id = self._allocate_instance_id()
        instance_dir = request.instance_dir or str((self.data_root / "instances" / instance_id).resolve())
        workspace_root = request.workspace_root or str((Path(instance_dir) / "workspace" / "repo").resolve())
        persistence_path = request.persistence_path or str((Path(instance_dir) / "state" / "performer.json").resolve())
        log_path = request.log_path or str((Path(instance_dir) / "logs" / "performer.log").resolve())
        workflow_path = str((Path(instance_dir) / "WORKFLOW.md").resolve())
        http_port = request.http_port or self.store.allocate_port()

        instance = InstanceRecord.create(
            id=instance_id,
            name=request.name,
            repo_source_type=request.repo_source_type,
            repo_source_value=request.repo_source_value,
            resolved_repo_path=resolved_repo_path,
            instance_dir=instance_dir,
            workflow_path=workflow_path,
            workspace_root=workspace_root,
            persistence_path=persistence_path,
            log_path=log_path,
            http_port=http_port,
            linear_project=request.linear_project,
            linear_filters=request.linear_filters,
            workflow_profile=request.workflow_profile,
            workflow_inputs=request.workflow_inputs,
        )
        instance = instance.with_updates(workflow_content=self._generate_workflow(instance))
        validation = validate_instance_workflow(instance, self.store.list_instances(), persist=persist_workflow)
        if validation.ok:
            instance = instance.with_updates(workflow_generation_status="valid")
        else:
            instance = instance.with_updates(workflow_generation_status="invalid")
        return instance, validation

    def update_instance(self, instance_id: str, patch: InstancePatchRequest) -> InstanceRecord:
        current = self._require_instance(instance_id)
        updated = current.with_updates(
            name=patch.name if patch.name is not None else current.name,
            linear_project=patch.linear_project if patch.linear_project is not None else current.linear_project,
            linear_filters=patch.linear_filters if patch.linear_filters is not None else current.linear_filters,
            workflow_profile=patch.workflow_profile if patch.workflow_profile is not None else current.workflow_profile,
            workflow_inputs=patch.workflow_inputs if patch.workflow_inputs is not None else current.workflow_inputs,
        )
        workflow_content = patch.workflow_content
        if workflow_content is None and (
            patch.linear_project is not None or patch.linear_filters is not None or patch.workflow_profile is not None or patch.workflow_inputs is not None
        ):
            workflow_content = self._generate_workflow(updated)
        if workflow_content is not None:
            updated = updated.with_updates(workflow_content=workflow_content)
            validation = validate_instance_workflow(updated, self._other_instances(instance_id))
            if not validation.ok:
                raise ConductorServiceError(
                    validation.error_code or "invalid_workflow",
                    "Workflow validation failed",
                    diagnostics=validation.diagnostics,
                )
            updated = updated.with_updates(
                workflow_content=workflow_content,
                workflow_generation_status="valid",
            )
            Path(updated.workflow_path).write_text(updated.workflow_content, encoding="utf-8")
        self.store.update_instance(updated)
        return updated

    def delete_instance(self, instance_id: str) -> None:
        instance = self._require_instance(instance_id)
        if instance.process_status in {"running", "starting"}:
            raise ConductorServiceError("instance_running", "Stop the instance before deleting it")
        instance_root = Path(instance.instance_dir)
        self.store.delete_instance(instance_id)
        if instance_root.exists():
            shutil.rmtree(instance_root, ignore_errors=True)

    def validate_workflow(self, instance_id: str, workflow_content: str) -> WorkflowValidationResult:
        current = self._require_instance(instance_id)
        candidate = current.with_updates(workflow_content=workflow_content)
        return validate_instance_workflow(candidate, self._other_instances(instance_id))

    def generate_workflow(self, instance_id: str) -> InstanceRecord:
        current = self._require_instance(instance_id)
        workflow_content = self._generate_workflow(current)
        return self.update_instance(instance_id, InstancePatchRequest(workflow_content=workflow_content))

    async def start_instance(self, instance_id: str) -> InstanceRecord:
        current = self._require_instance(instance_id)
        validation = validate_instance_workflow(current, self._other_instances(instance_id))
        if not validation.ok:
            raise ConductorServiceError(validation.error_code or "invalid_workflow", "Workflow validation failed", diagnostics=validation.diagnostics)
        started = await self.runtime_manager.start(
            current.with_updates(process_status="starting"),
            env=self._runtime_env(),
        )
        self.store.update_instance(started)
        return started

    async def stop_instance(self, instance_id: str) -> InstanceRecord:
        current = self._require_instance(instance_id)
        stopped = await self.runtime_manager.stop(current)
        self.store.update_instance(stopped)
        return stopped

    async def restart_instance(self, instance_id: str) -> InstanceRecord:
        current = self._require_instance(instance_id)
        validation = validate_instance_workflow(current, self._other_instances(instance_id))
        if not validation.ok:
            raise ConductorServiceError(validation.error_code or "invalid_workflow", "Workflow validation failed", diagnostics=validation.diagnostics)
        restarted = await self.runtime_manager.restart(current, env=self._runtime_env())
        self.store.update_instance(restarted)
        return restarted

    async def approve_runtime_error(self, instance_id: str, *, issue_id: str | None = None) -> dict[str, Any]:
        current = self._require_instance(instance_id)
        store = PersistenceStore(Path(current.persistence_path))
        persisted = store.load()
        if issue_id:
            selected = [
                entry
                for entry in persisted.blocked
                if entry.issue_id == issue_id or entry.identifier.lower() == issue_id.lower()
            ]
        else:
            selected = list(persisted.blocked[:1])
        if not selected:
            raise ConductorServiceError("blocked_runtime_not_found", "No blocked runtime error matched the request")
        approved = selected[0]
        remaining_blocked = [entry for entry in persisted.blocked if entry.issue_id != approved.issue_id]
        retry = RetryEntry(
            issue_id=approved.issue_id,
            identifier=approved.identifier,
            attempt=approved.attempt,
            due_at=utc_now(),
            due_at_ms=monotonic_ms(),
            error=f"human_approved_runtime_error: {approved.error}",
            issue_url=approved.issue_url,
            phase="retrying",
            status_label=LIFECYCLE_LABELS["retrying"],
            last_message=approved.last_message or approved.error,
            recent_events=list(approved.recent_events),
        )
        store.save(
            PersistedState(
                retry_attempts=[*persisted.retry_attempts, retry],
                continuations=list(persisted.continuations),
                blocked=remaining_blocked,
                sessions=list(persisted.sessions),
            )
        )
        instance = current
        if current.process_status in {"starting", "running", "unhealthy", "crash_loop"}:
            instance = await self.runtime_manager.restart(current, env=self._runtime_env())
            self.store.update_instance(instance)
        return {
            "approved": {
                "issue_id": approved.issue_id,
                "issue_identifier": approved.identifier,
                "attempt": approved.attempt,
                "error": approved.error,
            },
            "instance": instance.to_dict(include_workflow_content=False),
        }

    def instance_runtime(self, instance_id: str) -> dict[str, object]:
        current = self._require_instance(instance_id)
        runtime = dict(self.runtime_manager.runtime_snapshot(current))
        performer = self._performer_runtime_from_persistence(current)
        runtime["workspace"] = {
            "root": current.workspace_root,
            "strategy": "instance_repo_workspace",
            "description": (
                "Conductor initializes an instance-level repository workspace once, then reuses the "
                "prepared repository workspace for Performer and Codex runs."
            ),
        }
        runtime["performer"] = performer
        runtime["metrics"] = _runtime_metrics(performer)
        return runtime

    def query_instance_logs(
        self,
        instance_id: str,
        *,
        tail: int | None = 200,
        limit_bytes: int = 1_048_576,
        previous: bool = False,
        order: str = "desc",
        timestamps: bool = False,
        prefix: bool = False,
    ) -> dict[str, Any]:
        current = self._require_instance(instance_id)
        result = self.runtime_manager.query_logs(
            current,
            LogQuery(
                tail=tail,
                limit_bytes=limit_bytes,
                previous=previous,
                order=order,
                timestamps=timestamps,
                prefix=prefix,
            ),
        )
        return {
            "instance_id": result.instance_id,
            "generation": result.generation,
            "path": result.path,
            "order": result.order,
            "lines": result.lines,
            "logs": result.text(),
            "offset_start": result.offset_start,
            "offset_end": result.offset_end,
            "warnings": result.warnings,
        }

    def instance_logs(self, instance_id: str) -> str:
        current = self._require_instance(instance_id)
        return self.runtime_manager.read_logs(current)

    def inspect_repo(self, repo_source_type: str, repo_source_value: str) -> dict[str, Any]:
        resolved = self._resolve_repo(repo_source_type, repo_source_value)
        repo_path = Path(resolved)
        files = sorted(path.name for path in repo_path.iterdir())[:20]
        return {
            "repo_source_type": repo_source_type,
            "repo_source_value": repo_source_value,
            "resolved_path": resolved,
            "exists": repo_path.exists(),
            "git": (repo_path / ".git").exists(),
            "files": files,
        }

    def clone_repo(self, repo_url: str, target_path: str) -> dict[str, Any]:
        target = Path(target_path)
        if target.exists() and any(target.iterdir()):
            return {"repo_url": repo_url, "target_path": str(target), "cloned": False}
        target.parent.mkdir(parents=True, exist_ok=True)
        try:
            subprocess.run(["git", "clone", "--", repo_url, str(target)], check=True)
        except subprocess.CalledProcessError as exc:
            raise ConductorServiceError("git_clone_failed", f"Git clone failed: {exc}") from exc
        return {"repo_url": repo_url, "target_path": str(target), "cloned": True}

    def available_workflow_profiles(self) -> list[dict[str, str]]:
        return workflow_profiles()

    def _resolve_repo(self, repo_source_type: str, repo_source_value: str) -> str:
        if repo_source_type == "git":
            if not repo_source_value.strip():
                raise ConductorServiceError("missing_git_url", "Git repository URL is required")
            return repo_source_value
        if repo_source_type != "local_path":
            raise ConductorServiceError("unsupported_repo_source", f"Unsupported repo source type: {repo_source_type}")
        candidate = Path(repo_source_value).expanduser().resolve()
        if not candidate.exists() or not candidate.is_dir():
            raise ConductorServiceError("missing_local_path", f"Local path does not exist: {candidate}")
        return str(candidate)

    def _materialize_instance(self, instance: InstanceRecord) -> None:
        instance_dir = Path(instance.instance_dir)
        (instance_dir / "logs").mkdir(parents=True, exist_ok=True)
        (instance_dir / "state").mkdir(parents=True, exist_ok=True)
        Path(instance.workspace_root).mkdir(parents=True, exist_ok=True)
        Path(instance.workflow_path).write_text(instance.workflow_content, encoding="utf-8")
        Path(instance.log_path).touch()

    def _initialize_workspace(self, instance: InstanceRecord) -> None:
        workspace = Path(instance.workspace_root)
        workspace.mkdir(parents=True, exist_ok=True)
        if any(workspace.iterdir()):
            return
        if instance.repo_source_type == "git":
            self.clone_repo(instance.resolved_repo_path, instance.workspace_root)
            return
        if instance.repo_source_type != "local_path":
            return
        source = Path(instance.resolved_repo_path)
        if not source.exists() or not source.is_dir():
            raise ConductorServiceError("missing_local_path", f"Local path does not exist: {source}")
        for item in source.iterdir():
            if item.name in WORKSPACE_INIT_EXCLUDES:
                continue
            try:
                if item.resolve() == self.data_root.resolve():
                    continue
            except OSError:
                pass
            target = workspace / item.name
            if item.is_dir():
                shutil.copytree(item, target, symlinks=True)
            else:
                shutil.copy2(item, target)

    def _generate_workflow(self, instance: InstanceRecord) -> str:
        try:
            settings = self.store.get_settings()
            podium_url = settings.podium_url.strip() or "https://podium.example"
            return generate_workflow_content(instance, podium_url=podium_url)
        except ConductorValidationError as exc:
            raise ConductorServiceError(exc.code, str(exc)) from exc

    def _other_instances(self, instance_id: str) -> list[InstanceRecord]:
        return [instance for instance in self.store.list_instances() if instance.id != instance_id]

    def _require_instance(self, instance_id: str) -> InstanceRecord:
        current = self.store.get_instance(instance_id)
        if current is None:
            raise ConductorServiceError("instance_not_found", f"Instance not found: {instance_id}")
        return current

    def _instance_for_podium_event(self, *, project_slug: str, agent_app_user_id: str) -> InstanceRecord | None:
        candidates = self.store.list_instances()
        if project_slug:
            candidates = [instance for instance in candidates if instance.linear_project == project_slug]
        candidates = [
            instance
            for instance in candidates
            if _linear_agent_app_user_id(instance.linear_filters) == agent_app_user_id
        ]
        if not candidates:
            return None
        return candidates[0]

    def _allocate_instance_id(self) -> str:
        existing = {instance.id for instance in self.store.list_instances()}
        index = 1
        while True:
            candidate = f"inst-{index}"
            if candidate not in existing:
                return candidate
            index += 1

    def _runtime_env(self) -> dict[str, str]:
        settings = self.store.get_settings()
        env: dict[str, str] = {}
        proxy_token = settings.podium_proxy_token.strip()
        if proxy_token:
            env["PODIUM_PROXY_TOKEN"] = proxy_token
        runtime_token = settings.podium_runtime_token.strip()
        if runtime_token:
            env["PODIUM_RUNTIME_TOKEN"] = runtime_token
        runtime_id = settings.podium_runtime_id.strip()
        if runtime_id:
            env["PODIUM_RUNTIME_ID"] = runtime_id
        runtime_group_id = settings.runtime_group_id.strip()
        if runtime_group_id:
            env["PODIUM_RUNTIME_GROUP_ID"] = runtime_group_id
        return env

    def _normalize_stale_runtime_state(self) -> None:
        for instance in self.store.list_instances():
            if instance.process_status in {"starting", "running", "unhealthy", "crash_loop"}:
                recovered = self.runtime_manager.recover(instance)
                if recovered is not None:
                    self.store.update_instance(recovered)
                else:
                    self.store.update_instance(instance.with_updates(process_status="stopped", pid=None))

    def _performer_runtime_from_persistence(self, instance: InstanceRecord) -> dict[str, Any]:
        persisted = PersistenceStore(Path(instance.persistence_path)).load()
        running = [_persisted_session_row(session) for session in persisted.sessions]
        retrying = [_persisted_retry_row(entry) for entry in persisted.retry_attempts]
        continuing = [_persisted_continuation_row(entry) for entry in persisted.continuations]
        blocked = [_persisted_blocked_row(entry) for entry in persisted.blocked]
        return {
            "source": "persistence",
            "persistence_path": instance.persistence_path,
            "counts": {
                "running": len(running),
                "retrying": len(retrying),
                "continuing": len(continuing),
                "blocked": len(blocked),
            },
            "running": running,
            "retrying": retrying,
            "continuing": continuing,
            "blocked": blocked,
            "issues": running + retrying + continuing + blocked,
        }

    def _ops_snapshots(self) -> list[tuple[InstanceRecord, OpsSnapshot]]:
        return [(instance, snapshot) for instance, _store, snapshot in self._ops_stores()]

    def _ops_stores(self) -> list[tuple[InstanceRecord, OpsStore, OpsSnapshot]]:
        rows: list[tuple[InstanceRecord, OpsStore, OpsSnapshot]] = []
        for instance in self.store.list_instances():
            store = OpsStore(Path(instance.persistence_path).parent / "ops.json")
            snapshot = store.load()
            rows.append((instance, store, snapshot))
        return rows

    def _update_issue_pin(self, issue_id: str, *, pinned: bool) -> None:
        found = False
        for _instance, store, snapshot in self._ops_stores():
            if issue_id not in snapshot.issues and issue_id not in snapshot.retention.pinned_issue_ids:
                continue
            found = True
            pinned_ids = list(snapshot.retention.pinned_issue_ids)
            if pinned and issue_id not in pinned_ids:
                pinned_ids.append(issue_id)
            if not pinned:
                pinned_ids = [item for item in pinned_ids if item != issue_id]
            snapshot.retention = snapshot.retention.__class__(
                pinned_issue_ids=sorted(pinned_ids),
                pinned_run_ids=list(snapshot.retention.pinned_run_ids),
                last_collected_at=snapshot.retention.last_collected_at,
            )
            store.save(snapshot)
        if not found:
            raise ConductorServiceError("issue_not_found", f"Issue not found: {issue_id}")


def json_stable(payload: dict[str, Any]) -> str:
    import json

    return json.dumps(payload, separators=(",", ":"), sort_keys=True)


def _normalize_linear_issue_dict(node: dict[str, Any]) -> dict[str, Any]:
    labels = node.get("labels") if isinstance(node.get("labels"), dict) else {}
    label_nodes = labels.get("nodes") if isinstance(labels, dict) else []
    delegate = node.get("delegate") if isinstance(node.get("delegate"), dict) else None
    return {
        "id": node.get("id"),
        "identifier": node.get("identifier"),
        "title": node.get("title"),
        "description": node.get("description") or "",
        "url": node.get("url"),
        "delegate_id": delegate.get("id") if delegate else None,
        "labels": [
            str(label.get("name") or "")
            for label in (label_nodes or [])
            if isinstance(label, dict) and label.get("name")
        ],
    }


def _replace_marker_block(current: str, marker_name: str, block: str) -> str:
    start = f"<!-- {marker_name}:START -->"
    end = f"<!-- {marker_name}:END -->"
    replacement = f"{start}\n{block.strip()}\n{end}"
    if start in current and end in current:
        prefix, rest = current.split(start, 1)
        _old, suffix = rest.split(end, 1)
        return f"{prefix.rstrip()}\n\n{replacement}\n\n{suffix.lstrip()}".strip()
    base = current.strip()
    return f"{base}\n\n{replacement}".strip() if base else replacement


def _persisted_session_row(session: PersistedSession) -> dict[str, Any]:
    return {
        "issue_id": session.issue_id,
        "issue_identifier": session.issue_identifier,
        "issue_url": session.issue_url,
        "session_id": session.session_id,
        "thread_id": session.thread_id,
        "turn_id": session.turn_id,
        "worker_host": session.worker_host,
        "phase": session.phase,
        "status_label": session.status_label,
        "workspace_path": session.workspace_path,
        "started_at": session.started_at.isoformat().replace("+00:00", "Z"),
        "last_event": session.last_event,
        "last_message": session.last_message,
        "last_raw_message": session.last_raw_message,
        "recent_events": session.recent_events,
        "turn_count": session.turn_count,
        "tokens": {
            "input_tokens": session.tokens.input_tokens,
            "output_tokens": session.tokens.output_tokens,
            "cached_tokens": session.tokens.cached_tokens,
            "total_tokens": session.tokens.total_tokens,
        },
    }


def _persisted_retry_row(entry) -> dict[str, Any]:
    return {
        "issue_id": entry.issue_id,
        "issue_identifier": entry.identifier,
        "issue_url": entry.issue_url,
        "attempt": entry.attempt,
        "due_at": entry.due_at.isoformat().replace("+00:00", "Z"),
        "due_at_ms": entry.due_at_ms,
        "error": entry.error,
        "last_message": entry.last_message,
        "phase": entry.phase,
        "status_label": entry.status_label,
        "recent_events": entry.recent_events,
    }


def _persisted_continuation_row(entry) -> dict[str, Any]:
    return {
        "issue_id": entry.issue_id,
        "issue_identifier": entry.identifier,
        "issue_url": entry.issue_url,
        "attempt": entry.attempt,
        "due_at": entry.due_at.isoformat().replace("+00:00", "Z"),
        "due_at_ms": entry.due_at_ms,
        "error": None,
        "last_message": entry.last_message,
        "phase": entry.phase,
        "status_label": entry.status_label,
        "recent_events": entry.recent_events,
    }


def _persisted_blocked_row(entry) -> dict[str, Any]:
    return {
        "issue_id": entry.issue_id,
        "issue_identifier": entry.identifier,
        "issue_url": entry.issue_url,
        "attempt": entry.attempt,
        "blocked_at": entry.blocked_at.isoformat().replace("+00:00", "Z"),
        "error": entry.error,
        "last_message": entry.last_message,
        "phase": entry.phase,
        "status_label": entry.status_label,
        "recent_events": entry.recent_events,
    }


def _runtime_metrics(performer: dict[str, Any]) -> dict[str, Any]:
    running = performer.get("running") if isinstance(performer.get("running"), list) else []
    retrying = performer.get("retrying") if isinstance(performer.get("retrying"), list) else []
    continuing = performer.get("continuing") if isinstance(performer.get("continuing"), list) else []
    blocked = performer.get("blocked") if isinstance(performer.get("blocked"), list) else []
    tokens = {"input_tokens": 0, "output_tokens": 0, "cached_tokens": 0, "total_tokens": 0}
    turns = 0
    for row in running:
        if not isinstance(row, dict):
            continue
        row_tokens = row.get("tokens") if isinstance(row.get("tokens"), dict) else {}
        tokens["input_tokens"] += _int(row_tokens.get("input_tokens"))
        tokens["output_tokens"] += _int(row_tokens.get("output_tokens"))
        tokens["cached_tokens"] += _int(row_tokens.get("cached_tokens"))
        tokens["total_tokens"] += _int(row_tokens.get("total_tokens"))
        turns += _int(row.get("turn_count"))
    return {
        "tokens": tokens,
        "turns": turns,
        "running": len(running),
        "retrying": len(retrying),
        "continuing": len(continuing),
        "blocked": len(blocked),
    }


def _int(value: Any) -> int:
    if isinstance(value, bool):
        return 0
    if isinstance(value, int):
        return value
    return 0


def _optional_int(value: Any, default: int | None) -> int | None:
    if value is None:
        return default
    if isinstance(value, str) and value.strip().lower() in {"", "none", "null", "all"}:
        return None
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def _hostname() -> str:
    try:
        return socket.gethostname()
    except OSError:
        return ""


def _linear_agent_app_user_id(filters: dict[str, Any]) -> str:
    return str(filters.get("linear_agent_app_user_id") or filters.get("agent_app_user_id") or "").strip()


def _first_pending_performer_issue_id(persisted: PersistedState) -> str | None:
    for collection in (persisted.retry_attempts, persisted.continuations, persisted.blocked):
        for entry in collection:
            issue_id = str(getattr(entry, "issue_id", "") or "").strip()
            if issue_id:
                return issue_id
    return None


def _repository_handoff_marker(source_issue_id: str) -> str:
    return f"<!-- {REPOSITORY_HANDOFF_MARKER_NAME} source_issue_id={source_issue_id} -->"


def _repository_handoff_closeout_event(
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


def _repository_integration_description(report: dict[str, Any], *, instance: InstanceRecord) -> str:
    issue_id = str(report.get("issue_id") or "")
    issue_identifier = str(report.get("issue_identifier") or issue_id)
    bundle = report.get("bundle") if isinstance(report.get("bundle"), dict) else {}
    git_snapshot = report.get("git_snapshot") if isinstance(report.get("git_snapshot"), dict) else {}
    structured = report.get("structured_result") if isinstance(report.get("structured_result"), dict) else {}
    changed_files = git_snapshot.get("changed_files") if isinstance(git_snapshot.get("changed_files"), list) else []
    manifest = report.get("artifact_manifest") if isinstance(report.get("artifact_manifest"), list) else []
    return "\n".join(
        [
            _repository_handoff_marker(issue_id),
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


def _repository_handoff_comment(report: dict[str, Any], *, child: dict[str, Any], mention: str) -> str:
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
