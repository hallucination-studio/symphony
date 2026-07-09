from __future__ import annotations

import sqlite3

from performer_api.pipeline import GraphNode

from .conductor_pipeline_helpers import _json_dumps, _json_loads, _node_runtime_payload, _now
from .conductor_pipeline_store_schema_sql import PIPELINE_SCHEMA_SQL


def init_pipeline_db(db_path: str) -> None:
    with sqlite3.connect(db_path) as connection:
        connection.executescript(PIPELINE_SCHEMA_SQL)
        _migrate_graph_nodes_primary_key(connection)
        _migrate_node_runtime_state(connection)
        _migrate_verification_inputs_created_at(connection)


def _migrate_graph_nodes_primary_key(connection: sqlite3.Connection) -> None:
    columns = connection.execute("PRAGMA table_info(graph_nodes)").fetchall()
    primary_key_columns = [str(row[1]) for row in columns if int(row[5] or 0) > 0]
    if primary_key_columns == ["revision", "node_id"]:
        return
    if not primary_key_columns:
        return
    connection.execute("ALTER TABLE graph_nodes RENAME TO graph_nodes_legacy")
    connection.execute(
        """
        CREATE TABLE graph_nodes (
          revision INTEGER NOT NULL,
          node_id TEXT NOT NULL,
          payload_json TEXT NOT NULL,
          PRIMARY KEY (revision, node_id)
        )
        """
    )
    connection.execute(
        """
        INSERT OR IGNORE INTO graph_nodes (revision, node_id, payload_json)
        SELECT revision, node_id, payload_json FROM graph_nodes_legacy
        """
    )
    connection.execute("DROP TABLE graph_nodes_legacy")


def _migrate_node_runtime_state(connection: sqlite3.Connection) -> None:
    connection.execute(
        """
        CREATE TABLE IF NOT EXISTS node_runtime_state (
          node_id TEXT PRIMARY KEY,
          payload_json TEXT NOT NULL
        )
        """
    )
    rows = connection.execute("SELECT node_id, payload_json FROM graph_nodes ORDER BY revision, node_id").fetchall()
    for row in rows:
        row_node_id = str(row["node_id"] if isinstance(row, sqlite3.Row) else row[0])
        row_payload = str(row["payload_json"] if isinstance(row, sqlite3.Row) else row[1])
        payload = _json_loads(row_payload)
        node = GraphNode.from_dict(payload)
        connection.execute(
            """
            INSERT OR IGNORE INTO node_runtime_state (node_id, payload_json)
            VALUES (?, ?)
            """,
            (row_node_id, _json_dumps(_node_runtime_payload(node))),
        )


def _migrate_verification_inputs_created_at(connection: sqlite3.Connection) -> None:
    columns = {str(row[1]) for row in connection.execute("PRAGMA table_info(verification_inputs)").fetchall()}
    if "created_at" not in columns:
        connection.execute("ALTER TABLE verification_inputs ADD COLUMN created_at TEXT")
        connection.execute(
            "UPDATE verification_inputs SET created_at = ? WHERE created_at IS NULL OR created_at = ''",
            (_now(),),
        )
