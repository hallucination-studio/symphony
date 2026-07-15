from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import signal
import socket
import subprocess
import tempfile
import time
from pathlib import Path
from urllib.request import Request, urlopen

from conductor.store import ConductorStore
from performer_api.performer_control import PerformerReadinessState


_FAKE_CODEX = r'''#!/usr/bin/python3
import json
import sys
import time
from pathlib import Path


log_path = Path(sys.argv[0]).with_suffix(".log")


def send(payload):
    print(json.dumps(payload, separators=(",", ":")), flush=True)


for line in sys.stdin:
    message = json.loads(line)
    with log_path.open("a", encoding="utf-8") as handle:
        handle.write(str(message.get("method")) + "\n")
    request_id = message.get("id")
    method = message.get("method")
    if request_id is None:
        continue
    if method == "initialize":
        send({"id": request_id, "result": {"userAgent": "task-1.8-smoke", "serverInfo": {"name": "fake-codex", "version": "1"}}})
    elif method == "thread/start":
        cwd = message.get("params", {}).get("cwd", "/tmp")
        thread = {"id": "thread-smoke", "preview": "", "modelProvider": "openai", "createdAt": 1, "updatedAt": 1, "status": {"type": "idle"}, "ephemeral": True, "turns": [], "source": "exec", "sessionId": "session-smoke", "cwd": cwd, "cliVersion": "1"}
        send({"id": request_id, "result": {"thread": thread, "model": "gpt-5.4", "modelProvider": "openai", "cwd": cwd, "approvalPolicy": "never", "approvalsReviewer": "user", "sandbox": {"type": "readOnly"}}})
    elif method == "turn/start":
        turn = {"id": "turn-smoke", "items": [], "status": "inProgress"}
        send({"id": request_id, "result": {"turn": turn}})
        time.sleep(1)
        task = {"id": "task-smoke", "title": "Verify packaged chain", "objective": "Prove one controlled turn", "acceptance_criteria": ["The turn result is persisted"], "verification_commands": ["true"], "files_likely_touched": ["README.md"]}
        result = json.dumps({"summary": "Packaged turn completed", "tasks": [task], "risks": [], "architecture_decisions": [], "open_questions": [], "approval_required": False})
        item = {"id": "item-smoke", "type": "agentMessage", "text": result, "phase": "final_answer"}
        send({"method": "item/completed", "params": {"threadId": "thread-smoke", "turnId": "turn-smoke", "completedAtMs": 1, "item": item}})
        send({"method": "turn/completed", "params": {"threadId": "thread-smoke", "turn": {"id": "turn-smoke", "items": [], "status": "completed"}}})
'''


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Prove the installed Desktop process chain.")
    parser.add_argument("--binaries-dir", required=True, type=Path)
    parser.add_argument("--target-triple", required=True)
    return parser.parse_args()


def run_smoke(binaries_dir: Path, target_triple: str) -> dict[str, object]:
    with tempfile.TemporaryDirectory(prefix="symphony-desktop-process-") as temp_dir:
        root = Path(temp_dir)
        install_root = root / "install"
        install_root.mkdir()
        for role in ("podium", "conductor", "performer"):
            source = binaries_dir / f"{role}-{target_triple}"
            if not source.is_file():
                raise RuntimeError(f"desktop_sidecar_missing:{role}")
            shutil.copy2(source, install_root / role)

        home = root / "home"
        codex_home = root / "codex-home"
        repository = root / "repository"
        for path in (home, codex_home, repository):
            path.mkdir()
        _initialize_repository(repository)
        data_root = root / "conductor-data"
        fake_codex = root / "fake-codex"
        fake_codex.write_text(_FAKE_CODEX, encoding="utf-8")
        fake_codex.chmod(0o755)
        port = _free_port()
        environment = {
            "HOME": str(home),
            "CODEX_HOME": str(codex_home),
            "PATH": "/usr/bin:/bin",
            "LANG": "C.UTF-8",
            "CODEX_SDK_CODEX_BIN": str(fake_codex),
        }

        first = _start_conductor(install_root / "conductor", data_root, port, environment)
        try:
            _wait_ready(port, first)
            created = _request_json(
                port,
                "POST",
                "/api/instances",
                {
                    "name": "isolated",
                    "repo_source_type": "local_path",
                    "repo_source_value": str(repository),
                    "linear_project": "SMOKE",
                    "linear_filters": _performer_binding(),
                },
            )
            instance_id = str(created["instance"]["id"])
        finally:
            _stop(first)

        second = _start_conductor(install_root / "conductor", data_root, port, environment)
        control_pid = None
        tracked_pids: set[int] = set()
        try:
            _wait_ready(port, second)
            control_pid = _wait_for_performer(second.pid)
            tracked_pids.add(control_pid)
            run_id = _seed_controlled_turn(data_root, instance_id)
            turn_pid = _wait_for_performer(second.pid, turn=True)
            tracked_pids.update(_descendants(second.pid))
            managed = _wait_for_turn(
                port, data_root, instance_id, run_id, second.pid, tracked_pids
            )
        finally:
            _stop(second)
        orphan_pids = [pid for pid in tracked_pids if not _wait_pid_exit(pid)]
        if orphan_pids:
            raise RuntimeError("desktop_process_orphaned")

        return {
            "status": "passed",
            "desktop_role": "conductor_supervisor",
            "conductor_pid": second.pid,
            "performer_control_pid": control_pid,
            "performer_turn_pid": turn_pid,
            "instance_id": instance_id,
            "performer_control": managed.get("performer_control"),
            "run_id": run_id,
            "turn_id": managed["turn_id"],
            "turn_result_path": managed["turn_result_path"],
            "turn_log_path": managed["turn_log_path"],
            "clean_home": str(home).startswith(str(root)),
            "clean_codex_home": str(codex_home).startswith(str(root)),
            "checkout_absent_from_environment": all(
                str(Path(__file__).resolve().parents[1]) not in value
                for value in environment.values()
            ),
            "orphan_count": len(orphan_pids),
        }


def _initialize_repository(repository: Path) -> None:
    (repository / "README.md").write_text("# isolated smoke\n", encoding="utf-8")
    _run_git(repository, "init", "-q")
    _run_git(repository, "add", "README.md")
    _run_git(repository, "commit", "-qm", "baseline")


def _run_git(repository: Path, *arguments: str) -> None:
    subprocess.run(
        [
            "/usr/bin/git",
            "-C",
            str(repository),
            "-c",
            "user.name=Symphony Smoke",
            "-c",
            "user.email=smoke@example.invalid",
            *arguments,
        ],
        check=True,
        capture_output=True,
    )


def _seed_controlled_turn(data_root: Path, instance_id: str) -> str:
    store = ConductorStore(data_root)
    instance = store.get_instance(instance_id)
    if instance is None:
        raise RuntimeError("desktop_smoke_instance_missing")
    binding = instance.linear_filters
    store.record_performer_readiness(
        PerformerReadinessState(
            performer_kind=str(binding["performer_kind"]),
            binding_generation=int(binding["performer_binding_generation"]),
            capability_version=1,
            execution_policy_sha256=str(binding["execution_policy_sha256"]),
            status="ready",
            last_check_status="passed",
            error=None,
        )
    )
    run = store.create_run("issue-smoke", "SMOKE-1", instance_id=instance_id)
    store.update_run_payload(str(run["run_id"]), {"issue_description": "Prove packaged turn"})
    return str(run["run_id"])


def _wait_for_turn(
    port: int,
    data_root: Path,
    instance_id: str,
    run_id: str,
    conductor_pid: int,
    tracked_pids: set[int],
) -> dict[str, object]:
    deadline = time.monotonic() + 30
    response: dict[str, object] = {}
    while time.monotonic() < deadline:
        response = _request_json(port, "GET", "/api/managed-runs")
        tracked_pids.update(_descendants(conductor_pid))
        run_root = data_root / "instances" / instance_id / "state" / "workflow-runs" / run_id
        for result_path in run_root.glob("*/turn-result.json"):
            log_path = result_path.with_name("performer.log")
            if log_path.is_file():
                result = json.loads(result_path.read_text(encoding="utf-8"))
                context = result.get("context") if isinstance(result, dict) else None
                if context != {
                    "run_id": run_id,
                    "task_id": "",
                    "attempt_id": result_path.parent.name,
                    "fencing_token": 1,
                    "turn_kind": "plan",
                }:
                    raise RuntimeError("performer_turn_context_mismatch")
                if result.get("plan", {}).get("tasks", [{}])[0].get("id") != "task-smoke":
                    raise RuntimeError("performer_turn_result_invalid")
                log = log_path.read_text(encoding="utf-8", errors="replace")
                if "exit_code=0" not in log:
                    raise RuntimeError("performer_turn_exit_unsuccessful")
                fake_log = data_root.parent / "fake-codex.log"
                methods = fake_log.read_text(encoding="utf-8").splitlines()
                if methods != ["initialize", "initialized", "thread/start", "turn/start"]:
                    raise RuntimeError("fake_codex_sequence_invalid")
                return {
                    **response,
                    "turn_id": result_path.parent.name,
                    "turn_result_path": str(result_path),
                    "turn_log_path": str(log_path),
                }
        time.sleep(0.05)
    store = ConductorStore(data_root)
    instance = store.get_instance(instance_id)
    log_tail = ""
    if instance is not None and Path(instance.log_path).is_file():
        log_tail = Path(instance.log_path).read_text(encoding="utf-8", errors="replace")[-1000:]
    raise TimeoutError(
        "performer_turn_completion_timeout:"
        + json.dumps(
            {
                "run": store.get_run(run_id),
                "control": store.get_performer_control_state(),
                "files": [str(path.relative_to(data_root)) for path in data_root.rglob("*") if path.is_file()],
                "log_tail": log_tail,
                "fake_codex_log": (data_root.parent / "fake-codex.log").read_text(
                    encoding="utf-8", errors="replace"
                )
                if (data_root.parent / "fake-codex.log").is_file()
                else "",
                "response": response,
            },
            default=str,
            sort_keys=True,
        )
    )


def _start_conductor(
    executable: Path, data_root: Path, port: int, environment: dict[str, str]
) -> subprocess.Popen[bytes]:
    return subprocess.Popen(
        [str(executable), "--host", "127.0.0.1", "--port", str(port), "--data-root", str(data_root)],
        stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.PIPE,
        env=environment,
        cwd=executable.parent,
    )


def _performer_binding() -> dict[str, object]:
    policy = {
        "version": 1,
        "model": "gpt-5.4",
        "model_provider": "openai",
        "approval_mode": "auto_review",
        "reasoning_effort": "high",
        "reasoning_summary": "auto",
        "sandbox": {"plan": "read_only", "execute": "workspace_write", "gate": "read_only"},
        "initialize_timeout_ms": 5_000,
        "turn_timeout_ms": 3_600_000,
        "initialize_max_attempts": 4,
        "overload_max_attempts": 5,
    }
    return {
        "performer_kind": "codex",
        "performer_binding_id": "performer-binding:smoke",
        "performer_binding_generation": 1,
        "execution_policy": policy,
        "execution_policy_sha256": _canonical_sha256(policy),
        "turn_policy_sha256": _canonical_sha256({}),
    }


def _canonical_sha256(payload: dict[str, object]) -> str:
    encoded = json.dumps(payload, separators=(",", ":"), sort_keys=True).encode()
    return hashlib.sha256(encoded).hexdigest()


def _wait_ready(port: int, process: subprocess.Popen[bytes]) -> None:
    deadline = time.monotonic() + 20
    while time.monotonic() < deadline:
        try:
            if _request_json(port, "GET", "/").get("status") == "ok":
                return
        except OSError:
            if process.poll() is not None:
                stderr = (process.stderr.read() if process.stderr else b"").decode(
                    "utf-8", errors="replace"
                )
                raise RuntimeError(f"conductor_exited:{stderr[-500:]}")
            time.sleep(0.05)
    raise TimeoutError("conductor_start_timeout")


def _request_json(
    port: int, method: str, path: str, body: dict[str, object] | None = None
) -> dict[str, object]:
    payload = json.dumps(body).encode() if body is not None else None
    request = Request(
        f"http://127.0.0.1:{port}{path}",
        data=payload,
        method=method,
        headers={"Content-Type": "application/json"},
    )
    with urlopen(request, timeout=2) as response:
        result = json.loads(response.read())
    if not isinstance(result, dict):
        raise RuntimeError("conductor_response_invalid")
    return result


def _free_port() -> int:
    with socket.socket() as listener:
        listener.bind(("127.0.0.1", 0))
        return int(listener.getsockname()[1])


def _wait_for_performer(parent_pid: int, *, turn: bool = False) -> int:
    deadline = time.monotonic() + 20
    while time.monotonic() < deadline:
        for pid in _descendants(parent_pid):
            command = _command(pid)
            if "performer" not in command:
                continue
            if turn and "--turn-request-path" in command:
                return pid
            if not turn and " control" in command:
                return pid
        time.sleep(0.05)
    kind = "turn" if turn else "control"
    raise TimeoutError(f"performer_{kind}_start_timeout")


def _children(parent_pid: int) -> list[int]:
    result = subprocess.run(
        ["/bin/ps", "-axo", "pid=,ppid="], capture_output=True, text=True, check=True
    )
    return [
        int(pid)
        for line in result.stdout.splitlines()
        for pid, ppid in [line.split()]
        if int(ppid) == parent_pid
    ]


def _descendants(parent_pid: int) -> list[int]:
    pending = [parent_pid]
    descendants: list[int] = []
    while pending:
        children = _children(pending.pop())
        descendants.extend(children)
        pending.extend(children)
    return descendants


def _command(pid: int) -> str:
    result = subprocess.run(
        ["/bin/ps", "-p", str(pid), "-o", "command="],
        capture_output=True,
        text=True,
        check=False,
    )
    return result.stdout.strip() if result.returncode == 0 else ""


def _pid_exists(pid: int) -> bool:
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    return True


def _wait_pid_exit(pid: int) -> bool:
    deadline = time.monotonic() + 5
    while time.monotonic() < deadline:
        if not _pid_exists(pid):
            return True
        time.sleep(0.05)
    return not _pid_exists(pid)


def _stop(process: subprocess.Popen[bytes]) -> None:
    if process.poll() is not None:
        return
    process.send_signal(signal.SIGTERM)
    try:
        process.wait(timeout=5)
    except subprocess.TimeoutExpired:
        process.kill()
        process.wait(timeout=5)


def main() -> int:
    args = parse_args()
    print(json.dumps(run_smoke(args.binaries_dir, args.target_triple), sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
