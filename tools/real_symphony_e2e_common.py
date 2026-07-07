from __future__ import annotations

import json
import os
import signal
import asyncio
import socket
import subprocess
import time
import urllib.error
import urllib.request
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

LINEAR_ENDPOINT = "https://api.linear.app/graphql"
DEFAULT_PROJECT_SLUG = "d17d2f7a038d"
SENSITIVE_EVIDENCE_KEY_PARTS = ("secret", "password", "cookie", "authorization")


@dataclass
class ManagedProcess:
    name: str
    process: subprocess.Popen[bytes]

    def stop(self) -> None:
        if self.process.poll() is not None:
            return
        self.process.send_signal(signal.SIGINT)
        try:
            self.process.wait(timeout=10)
        except subprocess.TimeoutExpired:
            self.process.terminate()
            try:
                self.process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                self.process.kill()
                self.process.wait(timeout=5)


class Evidence:
    def __init__(self, out: Path) -> None:
        self.out = out
        self.data: dict[str, Any] = {
            "started_at": utc_now(),
            "checks": [],
            "artifacts": {},
            "failures": [],
        }

    def check(self, name: str, passed: bool, **details: Any) -> None:
        row = redact_evidence_value({"name": name, "passed": passed, **details})
        self.data["checks"].append(row)
        if not passed:
            self.data["failures"].append(row)
        status = "passed" if passed else "failed"
        print(f"event=e2e_check status={status} name={name}", flush=True)
        if not passed:
            print(json.dumps({"event": "e2e_failure", **row}, sort_keys=True), flush=True)
        self.write()

    def artifact(self, name: str, path: Path) -> None:
        self.data["artifacts"][name] = str(path)
        self.write()

    def write(self) -> None:
        self.out.parent.mkdir(parents=True, exist_ok=True)
        self.data["updated_at"] = utc_now()
        self.out.write_text(json.dumps(self.data, indent=2, sort_keys=True), encoding="utf-8")


def redact_evidence_value(value: Any, *, key: str | None = None) -> Any:
    if isinstance(value, dict):
        return {item_key: redact_evidence_value(item_value, key=str(item_key)) for item_key, item_value in value.items()}
    if isinstance(value, list):
        return [redact_evidence_value(item) for item in value]
    if isinstance(value, str) and key is not None and _is_sensitive_evidence_key(key):
        return "<redacted>"
    return value


def _is_sensitive_evidence_key(key: str) -> bool:
    normalized = key.lower()
    return normalized.endswith("_token") or any(part in normalized for part in SENSITIVE_EVIDENCE_KEY_PARTS)


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def allocate_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


def http_json(
    method: str,
    url: str,
    payload: dict[str, Any] | bytes | None = None,
    *,
    timeout: int = 30,
    headers: dict[str, str] | None = None,
) -> tuple[int, Any]:
    if isinstance(payload, bytes):
        body = payload
    else:
        body = None if payload is None else json.dumps(payload).encode()
    request_headers = {"Content-Type": "application/json"}
    if headers:
        request_headers.update(headers)
    request = urllib.request.Request(url, data=body, method=method, headers=request_headers)
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            raw = response.read().decode()
            if not raw:
                return response.status, None
            try:
                return response.status, json.loads(raw)
            except json.JSONDecodeError:
                return response.status, raw
    except urllib.error.HTTPError as exc:
        raw = exc.read().decode()
        try:
            parsed: Any = json.loads(raw)
        except json.JSONDecodeError:
            parsed = raw
        return exc.code, parsed
    except (TimeoutError, urllib.error.URLError, OSError) as exc:
        return 0, {"error": type(exc).__name__, "reason": str(exc)}


def read_json_object_if_ready(path: Path, default: dict[str, Any]) -> dict[str, Any]:
    if not path.exists():
        return default
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return default
    return payload if isinstance(payload, dict) else default



def run_cmd(name: str, command: list[str], evidence: Evidence, *, env: dict[str, str]) -> subprocess.CompletedProcess[str]:
    result = subprocess.run(command, text=True, capture_output=True, env=env, timeout=60)
    evidence.check(
        f"cli:{name}",
        result.returncode == 0,
        command=command[:3],
        stdout_tail=result.stdout[-500:],
        stderr_tail=result.stderr[-500:],
        returncode=result.returncode,
    )
    return result


def start_process(name: str, command: list[str], *, env: dict[str, str], stdout_path: Path) -> ManagedProcess:
    stdout_path.parent.mkdir(parents=True, exist_ok=True)
    handle = stdout_path.open("ab")
    process = subprocess.Popen(command, stdout=handle, stderr=subprocess.STDOUT, env=env)
    return ManagedProcess(name=name, process=process)


async def wait_for_http_ready(url: str, *, timeout_seconds: float = 10.0) -> tuple[int, Any]:
    deadline = time.monotonic() + timeout_seconds
    last_error: str | None = None
    while time.monotonic() < deadline:
        status, body = http_json("GET", url, timeout=2)
        if 200 <= status < 300:
            return status, body
        last_error = json.dumps(body) if isinstance(body, dict) else str(body)
        await asyncio.sleep(0.2)
    raise RuntimeError(f"HTTP service not ready at {url}: {last_error or 'timed out'}")


def make_fixture_repo(path: Path) -> Path:
    if path.exists():
        subprocess.run(["rm", "-rf", str(path)], check=True)
    (path / "tests").mkdir(parents=True)
    (path / "pyproject.toml").write_text('[tool.pytest.ini_options]\ntestpaths = ["tests"]\n', encoding="utf-8")
    (path / "tests" / "test_smoke.py").write_text("def test_smoke_fixture():\n    assert True\n", encoding="utf-8")
    (path / "README.md").write_text("Symphony real e2e fixture.\n", encoding="utf-8")
    subprocess.run(["git", "init", "-q"], cwd=path, check=True)
    subprocess.run(["git", "config", "user.email", "real-e2e@example.com"], cwd=path, check=True)
    subprocess.run(["git", "config", "user.name", "Symphony Real E2E"], cwd=path, check=True)
    subprocess.run(["git", "add", "."], cwd=path, check=True)
    subprocess.run(["git", "commit", "-q", "-m", "base"], cwd=path, check=True)
    return path


def api_url(port: int, path: str) -> str:
    return f"http://127.0.0.1:{port}{path}"
