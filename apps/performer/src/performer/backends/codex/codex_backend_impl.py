from __future__ import annotations

import json
import os
import re
import threading
from copy import deepcopy
from datetime import UTC, datetime
from pathlib import Path
from threading import Event
from typing import Any
from urllib.parse import urlsplit

from contracts import SCHEMA_REGISTRY
from openai_codex import Codex, CodexConfig, Sandbox

from performer.backends.provider_backend_interface import (
    ProviderBackendError,
    ProviderBackendInterface,
    ProviderSession,
    ProviderTurnCanceled,
    ProviderTurnDeadlineExpired,
)
from performer.prompt_resources import RolePromptCatalog
from performer.root_reconciler.comment_replies import pending_comment_reply_sources_from_request

CODEX_BASE_URL_ENVIRONMENT_KEY = "SYMPHONY_CODEX_BASE_URL"
CODEX_PLUGIN_BOOTSTRAP_OVERRIDE = "features.plugins=false"
CONDUCTOR_PERFORMER_SCHEMA_ID = "https://symphony.local/contracts/conductor-performer.schema.json"
COMMON_SCHEMA_ID = "https://symphony.local/contracts/common.schema.json"
def create_sdk(environment: dict[str, str] | None = None) -> Codex:
    source = os.environ if environment is None else environment
    base_url = source.get(CODEX_BASE_URL_ENVIRONMENT_KEY)
    overrides = [CODEX_PLUGIN_BOOTSTRAP_OVERRIDE]
    if base_url is not None:
        _validate_base_url(base_url)
        overrides.append(f"openai_base_url={json.dumps(base_url)}")
    return Codex(CodexConfig(config_overrides=tuple(overrides)))


def _validate_base_url(value: str) -> None:
    if any(ord(character) < 32 or ord(character) == 127 for character in value):
        raise ValueError("codex_base_url_invalid")
    try:
        parsed = urlsplit(value)
        port = parsed.port
    except ValueError as error:
        raise ValueError("codex_base_url_invalid") from error
    if parsed.username or parsed.password or parsed.query or parsed.fragment:
        raise ValueError("codex_base_url_invalid")
    if not parsed.hostname or parsed.path.startswith("//") or (port is None and parsed.netloc.endswith(":")):
        raise ValueError("codex_base_url_invalid")
    if parsed.scheme not in {"http", "https"}:
        raise ValueError("codex_base_url_invalid")


class CodexBackendImpl(ProviderBackendInterface):
    """The only module allowed to depend on the Provider SDK."""

    def __init__(self, sdk: Any, prompt_catalog: RolePromptCatalog) -> None:
        self._sdk = sdk
        self._prompt_catalog = prompt_catalog

    def open_role_session(self, role: str, settings: dict[str, Any]) -> ProviderSession:
        try:
            base_instructions = self._prompt_catalog.for_role(role)
        except ValueError as error:
            raise ProviderBackendError(
                "The Performer role is unsupported.",
                code="role_unsupported",
                retryable=False,
            ) from error
        normalized = _settings(settings)
        service_tier = self._service_tier(normalized)
        try:
            thread = self._sdk.thread_start(
                model=normalized.get("model"),
                service_tier=service_tier,
                sandbox=_sandbox_for_role(role),
                base_instructions=base_instructions,
            )
        except Exception as error:
            raise ProviderBackendError(
                "The Provider could not start the role session.",
                code="provider_session_start_failed",
                retryable=True,
                action_required="Retry the role with a fresh Provider context.",
            ) from error
        return ProviderSession(role, thread, normalized)

    def execute_role_turn(
        self,
        session: ProviderSession,
        request: dict[str, Any],
        *,
        workspace_root: Path | None,
        cancel_event: Event,
    ) -> dict[str, Any]:
        settings = session.settings or {}
        try:
            service_tier = self._service_tier(settings)
            prompt = _role_prompt(session.role, request)
            output_schema = _role_output_schema(session.role, request)
        except ProviderBackendError:
            raise
        except Exception as error:
            raise ProviderBackendError(
                "The Performer could not prepare the Provider turn.",
                code="provider_turn_preparation_failed",
                retryable=False,
                append_outcome="not_accepted",
            ) from error
        try:
            handle = session.provider_handle.turn(
                prompt,
                cwd=str(workspace_root) if workspace_root is not None else None,
                model=settings.get("model"),
                effort=settings.get("reasoning_effort"),
                sandbox=_sandbox_for_role(session.role),
                service_tier=service_tier,
                output_schema=output_schema,
            )
        except Exception as error:
            raise ProviderBackendError(
                "The Provider could not start the role turn.",
                code="provider_turn_start_failed",
                retryable=True,
                action_required="Retry the turn with a fresh Provider context.",
            ) from error

        interrupted = threading.Event()
        deadline_expired = threading.Event()
        interrupt_requested = threading.Event()
        stop_watcher = threading.Event()
        completed = False
        deadline = _deadline_at(request)

        def request_interrupt() -> None:
            if interrupt_requested.is_set():
                return
            interrupt_requested.set()
            try:
                handle.interrupt()
            except Exception:
                pass

        def cancel_watcher() -> None:
            while not stop_watcher.wait(0.02):
                if cancel_event.is_set():
                    interrupted.set()
                    request_interrupt()
                    return

        def deadline_watcher() -> None:
            if deadline is None:
                return
            seconds_remaining = (deadline - datetime.now(UTC)).total_seconds()
            if not stop_watcher.wait(max(0, seconds_remaining)):
                deadline_expired.set()
                request_interrupt()

        watcher = threading.Thread(target=cancel_watcher, daemon=True)
        deadline_watcher_thread = threading.Thread(target=deadline_watcher, daemon=True)
        watcher.start()
        deadline_watcher_thread.start()
        try:
            try:
                result = handle.run()
                completed = True
            except Exception as error:
                if deadline_expired.is_set():
                    raise ProviderTurnDeadlineExpired() from error
                if cancel_event.is_set() or interrupted.is_set():
                    raise ProviderTurnCanceled() from error
                raise ProviderBackendError(
                    _provider_failure_reason(error),
                    code="provider_turn_failed",
                    retryable=True,
                ) from error
        finally:
            stop_watcher.set()
            watcher.join(timeout=1)
            deadline_watcher_thread.join(timeout=1)
            if not completed:
                request_interrupt()

        if cancel_event.is_set() or interrupted.is_set():
            raise ProviderTurnCanceled()
        if deadline_expired.is_set():
            raise ProviderTurnDeadlineExpired()
        if str(result.status) not in {"completed", "TurnStatus.completed"} or result.error:
            raise ProviderBackendError(
                "The Provider did not complete the role turn.",
                code="provider_turn_incomplete",
                retryable=True,
                append_outcome="accepted",
            )
        try:
            return {"output": _role_output(session.role, result.final_response), "usage": _usage(result.usage)}
        except ProviderBackendError as error:
            error.append_outcome = "accepted"
            raise
        except Exception as error:
            raise ProviderBackendError(
                "The Provider returned an invalid role turn result.",
                code="provider_output_invalid",
                retryable=False,
                append_outcome="accepted",
            ) from error

    def interrupt_turn(self, session: ProviderSession) -> None:
        # A turn handle is interrupted by the cancellation watcher. This method
        # is reserved for a close racing with an active turn.
        return None

    def close_role_session(self, session: ProviderSession) -> None:
        thread_id = getattr(session.provider_handle, "id", None)
        if not isinstance(thread_id, str) or not thread_id:
            return
        try:
            self._sdk.thread_archive(thread_id)
        except Exception as error:
            raise ProviderBackendError(
                "The Provider role session could not be closed.",
                code="provider_session_close_failed",
                retryable=True,
            ) from error

    def _service_tier(self, settings: dict[str, Any]) -> str | None:
        fast = settings.get("is_fast_mode_enabled", False)
        if fast and self._authentication_method() != "chatgpt":
            raise ProviderBackendError(
                "Codex Fast is unavailable for this Profile.",
                code="performer_profile_setting_unsupported",
                retryable=False,
                action_required="Disable Fast or use a supported ChatGPT Profile.",
                append_outcome="not_accepted",
            )
        return "fast" if fast else None

    def _authentication_method(self) -> str | None:
        try:
            response = self._sdk.account(refresh_token=False)
        except Exception:
            return None
        account = getattr(response, "account", None)
        root = getattr(account, "root", account)
        return getattr(root, "type", None)


def _settings(settings: dict[str, Any]) -> dict[str, Any]:
    value = settings.get("model_settings", settings)
    if not isinstance(value, dict):
        raise ProviderBackendError("The role settings are invalid.", code="role_settings_invalid", retryable=False)
    return dict(value)


def _deadline_at(request: dict[str, Any]) -> datetime | None:
    limits = request.get("limits")
    if not isinstance(limits, dict):
        return None
    value = limits.get("deadline_at")
    if not isinstance(value, str):
        return None
    try:
        deadline = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    if deadline.tzinfo is None:
        return None
    return deadline.astimezone(UTC)


def _sandbox_for_role(role: str) -> Sandbox:
    return Sandbox.workspace_write if role == "work" else Sandbox.read_only


def _role_prompt(role: str, request: dict[str, Any]) -> str:
    context = {key: value for key, value in request.items() if key not in {"workspace_root", "secrets"}}
    prompt = (
        "ROLE REQUEST:\n"
        f"{json.dumps(context, separators=(',', ':'))}"
    )
    if role == "root_reconciler":
        reply_sources = pending_comment_reply_sources_from_request(request)
        if reply_sources:
            prompt += (
                "\nROOT COMMENT REPLY RULE: Return exactly one comment_replies entry for each source below, "
                "copying source_input_id and source exactly. Do not reply to any other comment."
                "\nROOT PENDING COMMENT REPLY SOURCES:\n"
                f"{json.dumps(reply_sources, separators=(',', ':'))}"
            )
        else:
            prompt += (
                "\nROOT COMMENT REPLY RULE: No comment source is pending in this turn, so comment_replies must be []."
            )
        if request.get("kind") == "open_root_reconciler":
            prompt += (
                "\nROOT TARGET IDS:\n"
                f"{json.dumps(_root_target_ids(request), separators=(',', ':'))}"
                " Use only these exact IDs for cycle_issue_id and stage issue IDs."
            )
        else:
            prompt += "\nThis is a delta turn. Reuse IDs established by the existing Root session context and use only IDs present in that context or this delta."
    return prompt


def _role_output_schema(role: str, request: dict[str, Any] | None = None) -> dict[str, Any]:
    if role == "root_reconciler":
        conductor_schema = SCHEMA_REGISTRY[CONDUCTOR_PERFORMER_SCHEMA_ID]
        common_schema = SCHEMA_REGISTRY[COMMON_SCHEMA_ID]
        root_directive = _expand_schema(
            conductor_schema["$defs"]["RootDirective"],
            conductor_defs=conductor_schema["$defs"],
            common_defs=common_schema["$defs"],
        )
        output_fields = ("rationale", "evidence_refs", "consumed_input_ids", "comment_replies", "action")
        properties = {field: root_directive["properties"][field] for field in output_fields}
        if not pending_comment_reply_sources_from_request(request or {}):
            properties["comment_replies"] = {
                **properties["comment_replies"],
                "maxItems": 0,
            }
        return {
            "type": "object",
            "additionalProperties": False,
            "required": list(output_fields),
            "properties": properties,
        }
    outcome_definition = {
        "plan": "PlanResultOutcome",
        "work": "WorkResultOutcome",
        "verify": "VerifyResultOutcome",
    }.get(role)
    if outcome_definition is None:
        raise ValueError("role_output_schema_unsupported")
    conductor_schema = SCHEMA_REGISTRY[CONDUCTOR_PERFORMER_SCHEMA_ID]
    common_schema = SCHEMA_REGISTRY[COMMON_SCHEMA_ID]
    return _expand_schema(
        conductor_schema["$defs"][outcome_definition],
        conductor_defs=conductor_schema["$defs"],
        common_defs=common_schema["$defs"],
    )


def _root_target_ids(request: dict[str, Any]) -> dict[str, Any]:
    bootstrap = request.get("bootstrap")
    snapshot = bootstrap.get("root_snapshot") if isinstance(bootstrap, dict) else None
    root = snapshot.get("root") if isinstance(snapshot, dict) else None
    root_issue = root.get("issue") if isinstance(root, dict) else None
    root_issue_id = root_issue.get("issue_id") if isinstance(root_issue, dict) else request.get("root_issue_id")
    cycles: list[dict[str, Any]] = []
    raw_cycles = snapshot.get("cycles") if isinstance(snapshot, dict) else None
    if isinstance(raw_cycles, list):
        for cycle in raw_cycles:
            if not isinstance(cycle, dict):
                continue
            cycle_issue = cycle.get("cycle_issue")
            cycle_issue_id = cycle_issue.get("issue_id") if isinstance(cycle_issue, dict) else None
            if not isinstance(cycle_issue_id, str):
                continue
            stage_issue_ids = [
                {"issue_id": issue.get("issue_id"), "issue_kind": issue.get("issue_kind")}
                for issue in cycle.get("issues", [])
                if isinstance(issue, dict)
                and isinstance(issue.get("issue_id"), str)
                and isinstance(issue.get("issue_kind"), str)
            ]
            cycles.append({"cycle_issue_id": cycle_issue_id, "stage_issue_ids": stage_issue_ids})
    return {
        "root_issue_id": root_issue_id if isinstance(root_issue_id, str) else "unknown",
        "cycles": cycles,
    }


def _expand_schema(
    value: Any,
    *,
    conductor_defs: dict[str, Any],
    common_defs: dict[str, Any],
    active_refs: tuple[str, ...] = (),
) -> Any:
    if isinstance(value, dict):
        reference = value.get("$ref")
        if isinstance(reference, str):
            if reference in active_refs:
                raise ValueError("contract_schema_reference_cycle")
            if reference.startswith("#/$defs/"):
                target = conductor_defs[reference.removeprefix("#/$defs/")]
            elif reference.startswith("common.schema.json#/$defs/"):
                target = common_defs[reference.removeprefix("common.schema.json#/$defs/")]
            else:
                raise ValueError("contract_schema_reference_unsupported")
            return _expand_schema(
                deepcopy(target),
                conductor_defs=conductor_defs,
                common_defs=common_defs,
                active_refs=(*active_refs, reference),
            )
        return {
            key: _expand_schema(
                child,
                conductor_defs=conductor_defs,
                common_defs=common_defs,
                active_refs=active_refs,
            )
            for key, child in value.items()
        }
    if isinstance(value, list):
        return [
            _expand_schema(
                child,
                conductor_defs=conductor_defs,
                common_defs=common_defs,
                active_refs=active_refs,
            )
            for child in value
        ]
    return value


def _role_output(role: str, response: Any) -> dict[str, Any]:
    if not isinstance(response, str) or not response.strip():
        raise ProviderBackendError(
            "The Provider returned an empty role result.",
            code="provider_output_empty",
            retryable=True,
        )
    try:
        output = _decode_single_json_object(response)
    except (json.JSONDecodeError, ValueError) as error:
        raise ProviderBackendError(
            "The Provider returned an invalid role result.",
            code="provider_output_invalid_json" if isinstance(error, json.JSONDecodeError) else str(error),
            retryable=True,
        ) from error
    if not isinstance(output, dict):
        raise ProviderBackendError("The Provider returned an invalid role result.", code="provider_output_object_invalid", retryable=True)
    if role == "root_reconciler":
        if "action" not in output:
            raise ProviderBackendError("The Provider returned a RootDirective without an action.", code="root_directive_action_missing", retryable=True)
        if not isinstance(output["action"], dict):
            raise ProviderBackendError("The Provider returned a RootDirective with an invalid action.", code="root_directive_action_invalid", retryable=True)
        if not isinstance(output["action"].get("kind"), str):
            raise ProviderBackendError("The Provider returned a RootDirective action without a kind.", code="root_directive_action_kind_missing", retryable=True)
    elif not isinstance(output.get("kind"), str):
        raise ProviderBackendError("The Provider returned an invalid role result.", code="role_output_kind_invalid", retryable=True)
    return output


def _decode_single_json_object(value: str) -> Any:
    stripped = value.strip()
    try:
        return json.loads(stripped)
    except json.JSONDecodeError:
        pass
    decoder = json.JSONDecoder()
    matches: list[Any] = []
    index = 0
    while index < len(stripped):
        if stripped[index] != "{":
            index += 1
            continue
        try:
            item, end = decoder.raw_decode(stripped, index)
        except json.JSONDecodeError:
            index += 1
            continue
        if isinstance(item, dict):
            matches.append(item)
        index = end
    if not matches:
        raise ValueError("provider_output_invalid_json")
    if len(matches) != 1:
        raise ValueError("provider_output_not_unique")
    return matches[0]


def _provider_failure_reason(error: Exception) -> str:
    detail = f"{type(error).__name__}: {error}"
    detail = re.sub(r"(?i)(authorization\s*:\s*bearer\s+)[^\s,;]+", r"\1[REDACTED]", detail)
    detail = re.sub(r"(?i)\bbearer\s+[^\s,;]+", "Bearer [REDACTED]", detail)
    detail = re.sub(r"(?i)\bsk-[A-Za-z0-9._-]+", "[REDACTED]", detail)
    return f"The Provider turn failed: {detail}"[:1_024]


def _usage(usage: Any) -> dict[str, Any]:
    if usage is None:
        return {"status": "unavailable", "reason": "provider_omitted"}
    total = getattr(usage, "total", usage)
    fields = ("input_tokens", "cached_input_tokens", "output_tokens", "reasoning_output_tokens", "total_tokens")
    try:
        snapshot = {field: getattr(total, field) for field in fields}
    except AttributeError:
        return {"status": "unavailable", "reason": "invalid_provider_usage"}
    if not all(isinstance(value, int) and not isinstance(value, bool) and value >= 0 for value in snapshot.values()):
        return {"status": "unavailable", "reason": "invalid_provider_usage"}
    return {"status": "measured", **snapshot}
