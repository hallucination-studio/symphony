from __future__ import annotations

import asyncio
import json
import subprocess
import time
import uuid
from pathlib import Path

import asyncpg

from real_symphony_e2e_common import Evidence, allocate_port


E2E_POSTGRES_IMAGE = "postgres:16-alpine"


async def start_e2e_postgres_if_needed(root: Path, env: dict[str, str], evidence: Evidence) -> str | None:
    if env.get("PODIUM_DATABASE_URL", "").strip():
        evidence.check("podium-db:external-url-configured", True)
        return None
    config = _postgres_config()
    result = _start_container(config)
    _write_container_log(root, config, result)
    evidence.artifact("postgres-container", root / "postgres-container.log")
    evidence.check(
        "podium-db:ephemeral-postgres-started",
        result.returncode == 0,
        container_name=config["container_name"],
        port=config["port"],
        image=E2E_POSTGRES_IMAGE,
        stderr_tail=result.stderr[-500:],
    )
    if result.returncode != 0:
        raise RuntimeError("ephemeral PostgreSQL container failed to start")
    database_url = f"postgresql://podium:{config['password']}@127.0.0.1:{config['port']}/podium"
    try:
        await _wait_for_postgres_ready(config["container_name"], database_url, evidence, int(config["port"]))
    except Exception:
        stop_e2e_postgres(config["container_name"])
        raise
    env["PODIUM_DATABASE_URL"] = database_url
    return str(config["container_name"])


def _postgres_config() -> dict[str, object]:
    return {
        "port": allocate_port(),
        "container_name": f"symphony-e2e-pg-{uuid.uuid4().hex[:12]}",
        "password": uuid.uuid4().hex,
    }


def _start_container(config: dict[str, object]) -> subprocess.CompletedProcess[str]:
    command = [
        "docker",
        "run",
        "-d",
        "--rm",
        "--name",
        str(config["container_name"]),
        "-e",
        "POSTGRES_USER=podium",
        "-e",
        f"POSTGRES_PASSWORD={config['password']}",
        "-e",
        "POSTGRES_DB=podium",
        "-p",
        f"127.0.0.1:{config['port']}:5432",
        E2E_POSTGRES_IMAGE,
    ]
    return subprocess.run(command, text=True, capture_output=True, timeout=60)


def _write_container_log(root: Path, config: dict[str, object], result: subprocess.CompletedProcess[str]) -> None:
    payload = {
        "container_name": config["container_name"],
        "port": config["port"],
        "returncode": result.returncode,
        "stdout_tail": result.stdout[-500:],
        "stderr_tail": result.stderr[-500:],
    }
    (root / "postgres-container.log").write_text(json.dumps(payload, indent=2, sort_keys=True), encoding="utf-8")


async def _wait_for_postgres_ready(container_name: object, database_url: str, evidence: Evidence, port: int) -> None:
    deadline = time.monotonic() + 30
    ready = False
    last_stderr = ""
    while time.monotonic() < deadline:
        probe = subprocess.run(
            ["docker", "exec", str(container_name), "pg_isready", "-U", "podium", "-d", "podium"],
            text=True,
            capture_output=True,
            timeout=10,
        )
        ready, last_stderr = await _probe_postgres_connection(probe, database_url)
        if ready:
            break
        await asyncio.sleep(0.5)
    evidence.check("podium-db:ephemeral-postgres-ready", ready, container_name=container_name, port=port, stderr_tail=last_stderr)
    if not ready:
        raise RuntimeError("ephemeral PostgreSQL container did not become ready")


async def _probe_postgres_connection(probe: subprocess.CompletedProcess[str], database_url: str) -> tuple[bool, str]:
    if probe.returncode != 0:
        return False, probe.stderr[-500:] or probe.stdout[-500:]
    try:
        connection = await asyncpg.connect(database_url)
        await connection.close()
        return True, ""
    except Exception as exc:
        return False, f"{exc.__class__.__name__}: {exc}"


def stop_e2e_postgres(container_name: str | None) -> None:
    if not container_name:
        return
    subprocess.run(["docker", "rm", "-f", container_name], text=True, capture_output=True, timeout=30)
