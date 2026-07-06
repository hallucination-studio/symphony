from __future__ import annotations

import argparse
import asyncio
import json
from pathlib import Path
from typing import Any

from performer.codex_client import CodexSdkClient
from performer.runner import AgentRunner
from performer.orchestrator import Orchestrator
from performer.workspace import WorkspaceManager
from performer_api.config import (
    AgentConfig,
    CodexConfig,
    CompletionVerificationConfig,
    HooksConfig,
    PersistenceConfig,
    PollingConfig,
    ServiceConfig,
    TrackerConfig,
    WorkspaceConfig,
)
from performer_api.models import Issue
from performer_api.persistence import PersistenceStore


class ProbeCodexClient:
    def __init__(self) -> None:
        self.prompts: list[Any] = []
        self.events: list[dict[str, Any]] = []

    async def thread_start(self, **kwargs: Any) -> Any:
        return ProbeThread(self)


class ProbeThread:
    id = "probe-thread"

    def __init__(self, sdk: ProbeCodexClient) -> None:
        self.sdk = sdk

    def turn(self, prompt: Any, **kwargs: Any) -> Any:
        self.sdk.prompts.append(prompt)
        if not isinstance(prompt, str):
            raise TypeError(f"prompt was not awaited: {type(prompt).__name__}")
        return ProbeTurn(len(self.sdk.prompts))


class ProbeTurn:
    def __init__(self, turn_number: int) -> None:
        self.id = f"turn-{turn_number}"

    async def run(self) -> dict[str, Any]:
        return {
            "final_response": json.dumps(
                {
                    "summary": self.id,
                    "test_commands": [],
                    "changed_files": [],
                    "remaining_risks": [],
                    "next_action": "ready_for_review",
                }
            )
        }


class ProbeTracker:
    def __init__(self, issue: Issue) -> None:
        self.issue = issue
        self.refresh_calls: list[list[str]] = []

    async def fetch_candidate_issues(self) -> list[Issue]:
        return [self.issue]

    async def fetch_issue_states_by_ids(self, issue_ids: list[str]) -> list[Issue]:
        self.refresh_calls.append(list(issue_ids))
        return [self.issue] if self.issue.id in issue_ids else []

    async def fetch_issues_by_states(self, state_names: list[str]) -> list[Issue]:
        return []

    async def comment_issue(self, issue_id: str, body: str) -> dict[str, Any]:
        return {"success": True, "issue_id": issue_id}

    async def set_issue_lifecycle_label(self, issue_id: str, label_name: str) -> dict[str, Any]:
        return {"success": True, "issue_id": issue_id, "label": label_name}

    async def transition_issue_by_state_name(self, issue_id: str, state_name: str) -> dict[str, Any]:
        return {"success": True, "issue_id": issue_id, "state": state_name}


def make_issue() -> Issue:
    return Issue(
        id="mt-1",
        identifier="MT-1",
        title="Probe continuation",
        state="Todo",
        labels=["codex"],
        project_slug="MT",
    )


def make_config(root: Path, *, persistence_path: Path) -> ServiceConfig:
    return ServiceConfig(
        tracker=TrackerConfig(
            kind="linear",
            endpoint="https://api.linear.app/graphql",
            project_slug="MT",
            api_key="probe-token",
            active_states=["Todo", "In Progress"],
            terminal_states=["Closed", "Cancelled", "Canceled", "Duplicate", "Done"],
        ),
        polling=PollingConfig(interval_ms=30_000),
        workspace=WorkspaceConfig(root=root),
        hooks=HooksConfig(),
        agent=AgentConfig(max_turns=2, max_concurrent_agents=1),
        codex=CodexConfig(),
        prompt_template="Do {{ issue.identifier }}",
        workflow_path=root / "WORKFLOW.md",
        persistence=PersistenceConfig(path=persistence_path),
        completion_verification=CompletionVerificationConfig(enabled=False),
    )


def summarize_probe(
    *,
    codex: ProbeCodexClient,
    tracker: ProbeTracker,
    persistence_path: Path,
) -> dict[str, Any]:
    persisted = PersistenceStore(persistence_path).load()
    continuation = persisted.continuations[0] if persisted.continuations else None
    return {
        "pass": bool(
            len(codex.prompts) == 2
            and all(isinstance(prompt, str) for prompt in codex.prompts)
            and tracker.refresh_calls
            and continuation is not None
            and continuation.issue_id == "mt-1"
            and continuation.phase == "continuing"
            and continuation.status_label == "performer:phase/implementation"
        ),
        "turn_count": len(codex.prompts),
        "prompt_types": [type(prompt).__name__ for prompt in codex.prompts],
        "tracker_refresh_calls": tracker.refresh_calls,
        "persisted_continuations": [
            {
                "issue_id": entry.issue_id,
                "identifier": entry.identifier,
                "attempt": entry.attempt,
                "phase": entry.phase,
                "status_label": entry.status_label,
                "last_message": entry.last_message,
            }
            for entry in persisted.continuations
        ],
        "event_names": [str(event.get("event") or "") for event in codex.events],
    }


async def run_probe(args: argparse.Namespace) -> dict[str, Any]:
    root = args.workspace.resolve()
    root.mkdir(parents=True, exist_ok=True)
    persistence_path = (args.persistence or root / "state" / "performer.json").resolve()
    issue = make_issue()
    tracker = ProbeTracker(issue)
    fake_sdk = ProbeCodexClient()
    config = make_config(root, persistence_path=persistence_path)
    codex = CodexSdkClient(config.codex, sdk_factory=lambda _config: fake_sdk)
    runner = AgentRunner(
        config,
        WorkspaceManager(config.workspace, config.hooks),
        codex_client=codex,
        tracker=tracker,
    )
    orchestrator = Orchestrator(
        config,
        tracker,
        runner,
        workspace_manager=runner.workspace_manager,
        persistence_store=PersistenceStore(persistence_path),
    )

    await orchestrator.tick()
    await orchestrator.wait_for_idle()

    summary = summarize_probe(codex=fake_sdk, tracker=tracker, persistence_path=persistence_path)
    summary["workspace"] = str(root)
    summary["persistence_path"] = str(persistence_path)
    if args.out:
        args.out.parent.mkdir(parents=True, exist_ok=True)
        args.out.write_text(json.dumps(summary, indent=2, sort_keys=True), encoding="utf-8")
    return summary


def parser() -> argparse.ArgumentParser:
    arg_parser = argparse.ArgumentParser(description="Verify Performer continuation through runner and orchestrator.")
    arg_parser.add_argument("--workspace", type=Path, required=True)
    arg_parser.add_argument("--persistence", type=Path)
    arg_parser.add_argument("--out", type=Path)
    return arg_parser


def main() -> int:
    args = parser().parse_args()
    summary = asyncio.run(run_probe(args))
    print(json.dumps(summary, indent=2, sort_keys=True))
    return 0 if summary["pass"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
