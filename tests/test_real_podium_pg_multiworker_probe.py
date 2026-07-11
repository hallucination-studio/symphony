from __future__ import annotations

import argparse
import importlib
import json
import os
from pathlib import Path
import subprocess
import sys
from urllib.parse import urlsplit

import asyncpg
import pytest


ROOT = Path(__file__).resolve().parents[1]
PROBE = ROOT / "tools" / "real_podium_pg_multiworker_probe.py"
PYTHONPATH = os.pathsep.join(
    str(ROOT / path)
    for path in (
        "packages/performer-api/src",
        "packages/performer/src",
        "packages/conductor/src",
        "packages/podium/src",
    )
)


def _load_probe():
    return importlib.import_module("tools.real_podium_pg_multiworker_probe")


def _database_url() -> str:
    database_url = os.environ.get("PODIUM_TEST_DATABASE_URL", "").strip()
    if not database_url:
        pytest.skip("PODIUM_TEST_DATABASE_URL is required for the real PostgreSQL probe")
    return database_url


async def _probe_schemas(database_url: str) -> list[str]:
    connection = await asyncpg.connect(database_url)
    try:
        rows = await connection.fetch(
            "SELECT nspname FROM pg_namespace WHERE nspname LIKE 'podium_multiworker_%' ORDER BY nspname"
        )
    finally:
        await connection.close()
    return [str(row["nspname"]) for row in rows]


def test_probe_import_and_help_do_not_require_a_database() -> None:
    env = {**os.environ, "PYTHONPATH": PYTHONPATH}
    env.pop("PODIUM_TEST_DATABASE_URL", None)

    imported = subprocess.run(
        [sys.executable, "-c", "import tools.real_podium_pg_multiworker_probe"],
        cwd=ROOT,
        env=env,
        text=True,
        capture_output=True,
        check=False,
    )
    helped = subprocess.run(
        [sys.executable, str(PROBE), "--help"],
        cwd=ROOT,
        env=env,
        text=True,
        capture_output=True,
        check=False,
    )

    assert imported.returncode == 0, imported.stderr
    assert helped.returncode == 0, helped.stderr
    assert "PODIUM_TEST_DATABASE_URL" in helped.stdout


def test_parser_reads_the_database_url_from_the_environment(monkeypatch: pytest.MonkeyPatch) -> None:
    probe = _load_probe()
    monkeypatch.setenv(
        "PODIUM_TEST_DATABASE_URL",
        "postgresql://probe:database-secret@127.0.0.1:5432/podium",
    )

    args = probe.parser().parse_args([])

    assert args.database_url == "postgresql://probe:database-secret@127.0.0.1:5432/podium"


def test_main_records_a_structured_sanitized_failure(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    probe = _load_probe()
    database_url = "postgresql://probe:database-secret@127.0.0.1:5432/podium"
    output_path = tmp_path / "probe.json"

    async def fail(_args: argparse.Namespace) -> dict[str, object]:
        raise RuntimeError(f"connection failed password=database-secret token=runtime-secret {database_url}")

    monkeypatch.setenv("PODIUM_TEST_DATABASE_URL", database_url)
    monkeypatch.setattr(probe, "run_probe", fail)

    exit_code = probe.main(["--out", str(output_path)])
    captured = capsys.readouterr()
    report = json.loads(captured.out)

    assert exit_code == 1
    assert report == json.loads(output_path.read_text(encoding="utf-8"))
    assert report["pass"] is False
    assert report["error_type"] == "RuntimeError"
    assert report["error_code"] == "pg_multiworker_probe_failed"
    assert report["action_required"] == "inspect_postgres_probe"
    assert report["retryable"] is False
    assert report["attempt_number"] == 1
    serialized = json.dumps(report)
    assert "database-secret" not in serialized
    assert "runtime-secret" not in serialized
    assert database_url not in serialized


@pytest.mark.asyncio
async def test_probe_proves_one_durable_reconciliation_and_lease_across_two_pools(
    tmp_path: Path,
) -> None:
    probe = _load_probe()
    database_url = _database_url()
    output_path = tmp_path / "probe.json"
    schemas_before = await _probe_schemas(database_url)

    report = await probe.run_probe(argparse.Namespace(database_url=database_url, out=output_path))

    assert report == json.loads(output_path.read_text(encoding="utf-8"))
    assert report["pass"] is True
    assert report["workers"] == {
        "pool_count": 2,
        "reconciliation_queued": [0, 1],
        "reconciliation_error_count": 0,
        "lease_winner_count": 1,
    }
    assert report["durable"] == {
        "dispatch_count": 1,
        "dispatch_status": "leased",
        "intake_key": "linear-issue:pg-multiworker-issue-1:epoch:1",
        "checkpoint_baseline_complete": True,
        "checkpoint_page_cursor": "",
        "delegated": True,
        "delegation_epoch": 1,
        "fencing_token": 1,
        "reconciliation_error_code": "",
        "reconciliation_retry_count": 0,
        "restart_readable": True,
    }
    assert report["cleanup"] == {"schema_dropped": True}
    assert await _probe_schemas(database_url) == schemas_before

    serialized = json.dumps(report)
    assert database_url not in serialized
    password = urlsplit(database_url).password
    assert not password or password not in serialized


@pytest.mark.asyncio
async def test_probe_drops_its_schema_when_a_worker_fails(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    probe = _load_probe()
    database_url = _database_url()
    schemas_before = await _probe_schemas(database_url)

    async def fail(_database_url: str) -> dict[str, object]:
        raise RuntimeError("forced worker failure")

    monkeypatch.setattr(probe, "_run_workers", fail)

    with pytest.raises(RuntimeError, match="forced worker failure"):
        await probe.run_probe(argparse.Namespace(database_url=database_url, out=None))

    assert await _probe_schemas(database_url) == schemas_before


@pytest.mark.asyncio
async def test_probe_surfaces_reconciler_semantic_failures_in_the_report(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    probe = _load_probe()
    database_url = _database_url()
    schemas_before = await _probe_schemas(database_url)

    def unavailable_transport(_request):
        import httpx

        return httpx.Response(503, json={"errors": [{"message": "forced diagnostic"}]})

    monkeypatch.setattr(probe, "linear_transport", unavailable_transport)

    report = await probe.run_probe(
        argparse.Namespace(database_url=database_url, out=None)
    )

    assert report["pass"] is False
    assert report["workers"]["reconciliation_error_count"] > 0
    assert report["durable"]["reconciliation_error_code"]
    assert report["error_type"] == "ReconciliationSemanticFailure"
    assert report["error_code"] == report["durable"]["reconciliation_error_code"]
    assert report["action_required"] == "retry_reconciliation"
    assert report["retryable"] is True
    assert report["attempt_number"] == 1
    assert report["next_action"] == "inspect_reconciliation_health"
    assert "forced diagnostic" not in json.dumps(report)
    assert database_url not in json.dumps(report)
    assert await _probe_schemas(database_url) == schemas_before
