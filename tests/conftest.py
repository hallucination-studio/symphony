from __future__ import annotations

from collections.abc import AsyncIterator
import os
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit
from uuid import uuid4

import asyncpg
import pytest
import pytest_asyncio


class _SanitizedDatabaseUrl(str):
    def __repr__(self) -> str:
        return "<redacted-postgres-test-url>"


@pytest_asyncio.fixture
async def postgres_database_url() -> AsyncIterator[str]:
    base_url = os.environ.get("PODIUM_TEST_DATABASE_URL")
    if not base_url:
        pytest.skip("PODIUM_TEST_DATABASE_URL is required for PostgreSQL contract tests")

    schema = f"podium_contract_{uuid4().hex}"
    admin = await asyncpg.connect(base_url)
    try:
        await admin.execute(f'CREATE SCHEMA "{schema}"')
    finally:
        await admin.close()

    parsed = urlsplit(base_url)
    query = dict(parse_qsl(parsed.query, keep_blank_values=True))
    query["search_path"] = schema
    isolated_url = _SanitizedDatabaseUrl(urlunsplit(parsed._replace(query=urlencode(query))))
    assert str(isolated_url) not in repr(isolated_url)
    try:
        yield isolated_url
    finally:
        admin = await asyncpg.connect(base_url)
        try:
            await admin.execute(f'DROP SCHEMA IF EXISTS "{schema}" CASCADE')
        finally:
            await admin.close()
