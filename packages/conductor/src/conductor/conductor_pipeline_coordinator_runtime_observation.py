from __future__ import annotations

from .conductor_pipeline_coordinator_common import *


class RuntimeObservationMixin:
    def observe_runtime_waits_from_logs(self, instance: Any) -> int:
        observed = 0
        seen: set[tuple[str, str]] = set()
        for log_path in _runtime_log_candidates(instance):
            try:
                lines = log_path.read_text(encoding="utf-8", errors="replace").splitlines()
            except OSError:
                continue
            for line in lines[-500:]:
                event = _attempt_event_from_performer_stream_line(line)
                if event is None:
                    continue
                wait = _runtime_wait_from_attempt_event(event)
                if wait is None:
                    continue
                attempt_id = str(wait.get("attempt_id") or "")
                wait_kind = str(wait.get("wait_kind") or "")
                if not attempt_id or not wait_kind or (attempt_id, wait_kind) in seen:
                    continue
                seen.add((attempt_id, wait_kind))
                try:
                    attempt = self.store.get_attempt(attempt_id)
                except KeyError:
                    continue
                if attempt.state is not AttemptState.RUNNING:
                    continue
                try:
                    mode = RuntimeMode(str(wait.get("mode") or attempt.mode.value))
                except ValueError:
                    continue
                if mode is not attempt.mode:
                    continue
                node_id = str(wait.get("node_id") or attempt.node_id)
                if node_id != attempt.node_id:
                    continue
                lease = self.store.active_lease(attempt.node_id, attempt.mode)
                if lease is None or lease.attempt_id != attempt.attempt_id:
                    continue
                if self.store.record_runtime_wait(
                    attempt_id=attempt.attempt_id,
                    node_id=attempt.node_id,
                    mode=attempt.mode,
                    wait_kind=wait_kind,
                    message=_optional_event_str(wait.get("message")),
                    command=_optional_event_str(wait.get("command")),
                    thread_id=_optional_event_str(wait.get("thread_id")),
                    turn_id=_optional_event_str(wait.get("turn_id")),
                    session_id=_optional_event_str(wait.get("session_id")),
                    lease_id=lease.lease_id,
                    log_path=str(log_path),
                ):
                    observed += 1
        return observed

    def fail_running_attempts_for_exited_process(
        self,
        instance: Any,
        *,
        at: datetime | None = None,
    ) -> int:
        if getattr(instance, "process_status", None) != "exited":
            return 0
        at = at or datetime.now(timezone.utc)
        if _recently_observed_process_exit(instance, at=at):
            return 0
        failed = 0
        error = _process_exit_error(instance)
        for attempt in self.store.list_attempts():
            if attempt.state is not AttemptState.RUNNING:
                continue
            lease = self.store.active_lease(attempt.node_id, attempt.mode)
            if lease is None or lease.attempt_id != attempt.attempt_id:
                continue
            result_path = Path(instance.instance_dir) / "state" / "pipeline" / attempt.attempt_id / "attempt-result.json"
            if result_path.exists():
                continue
            self._fail_started_attempt_for_backend_error(
                mode=attempt.mode,
                node_id=attempt.node_id,
                attempt_id=attempt.attempt_id,
                lease_id=lease.lease_id,
                error=error,
                at=at,
            )
            _append_instance_log(
                instance,
                (
                    "pipeline_attempt_process_exited "
                    f"mode={attempt.mode.value} node_id={attempt.node_id} "
                    f"attempt_id={attempt.attempt_id} lease_id={lease.lease_id} "
                    f"exit_code={getattr(instance, 'last_exit_code', None)} error={error}"
                ),
            )
            failed += 1
        return failed

    def fail_exited_attempt_snapshot(
        self,
        instance: Any,
        snapshot: dict[str, object],
        *,
        at: datetime | None = None,
    ) -> int:
        attempt_id = str(snapshot.get("attempt_id") or "").strip()
        if not attempt_id:
            return 0
        try:
            attempt = self.store.get_attempt(attempt_id)
        except KeyError:
            return 0
        if attempt.state is not AttemptState.RUNNING:
            return 0
        snapshot_mode = str(snapshot.get("mode") or "").strip()
        if snapshot_mode and snapshot_mode != attempt.mode.value:
            return 0
        lease = self.store.active_lease(attempt.node_id, attempt.mode)
        if lease is None or lease.attempt_id != attempt.attempt_id:
            return 0
        snapshot_lease_id = str(snapshot.get("lease_id") or "").strip()
        if snapshot_lease_id and snapshot_lease_id != lease.lease_id:
            return 0
        snapshot_result_path_value = str(snapshot.get("result_path") or "").strip()
        if snapshot_result_path_value and Path(snapshot_result_path_value).exists():
            return 0
        error = _attempt_snapshot_exit_error(snapshot, instance)
        self._fail_started_attempt_for_backend_error(
            mode=attempt.mode,
            node_id=attempt.node_id,
            attempt_id=attempt.attempt_id,
            lease_id=lease.lease_id,
            error=error,
            at=at or datetime.now(timezone.utc),
        )
        _append_instance_log(
            instance,
            (
                "pipeline_attempt_process_exited "
                f"mode={attempt.mode.value} node_id={attempt.node_id} "
                f"attempt_id={attempt.attempt_id} lease_id={lease.lease_id} "
                f"pid={snapshot.get('pid')} exit_code={snapshot.get('exit_code')} error={error}"
            ),
        )
        return 1
