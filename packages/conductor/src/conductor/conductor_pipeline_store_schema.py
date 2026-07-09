from __future__ import annotations

import sqlite3

from performer_api.pipeline import GraphNode

from .conductor_pipeline_helpers import _json_dumps, _json_loads, _node_runtime_payload, _now


def init_pipeline_db(db_path: str) -> None:
    with sqlite3.connect(db_path) as connection:
        connection.executescript(
            """
            CREATE TABLE IF NOT EXISTS runtime_config (
              id INTEGER PRIMARY KEY CHECK (id = 1),
              version INTEGER NOT NULL,
              payload_json TEXT NOT NULL,
              updated_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS graph_revisions (
              revision INTEGER PRIMARY KEY,
              graph_id TEXT NOT NULL,
              plan_attempt_id TEXT NOT NULL,
              root_node_id TEXT NOT NULL,
              payload_json TEXT NOT NULL,
              created_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS graph_nodes (
              revision INTEGER NOT NULL,
              node_id TEXT NOT NULL,
              payload_json TEXT NOT NULL,
              PRIMARY KEY (revision, node_id)
            );
            CREATE TABLE IF NOT EXISTS node_runtime_state (
              node_id TEXT PRIMARY KEY,
              payload_json TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS graph_edges (
              revision INTEGER NOT NULL,
              blocker_node_id TEXT NOT NULL,
              blocked_node_id TEXT NOT NULL,
              PRIMARY KEY (revision, blocker_node_id, blocked_node_id)
            );
            CREATE TABLE IF NOT EXISTS dispatch_context (
              node_id TEXT PRIMARY KEY,
              payload_json TEXT NOT NULL,
              updated_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS gate_snapshots (
              gate_hash TEXT PRIMARY KEY,
              node_id TEXT NOT NULL,
              payload_json TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS worker_leases (
              lease_id TEXT PRIMARY KEY,
              node_id TEXT NOT NULL,
              mode TEXT NOT NULL,
              payload_json TEXT NOT NULL,
              active INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS attempts (
              attempt_id TEXT PRIMARY KEY,
              node_id TEXT NOT NULL,
              mode TEXT NOT NULL,
              state TEXT NOT NULL,
              payload_json TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS verification_inputs (
              execute_attempt_id TEXT PRIMARY KEY,
              node_id TEXT NOT NULL,
              payload_json TEXT NOT NULL,
              created_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS task_output_manifests (
              verify_attempt_id TEXT PRIMARY KEY,
              node_id TEXT NOT NULL,
              payload_json TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS integration_queue (
              integration_id TEXT PRIMARY KEY,
              node_id TEXT NOT NULL,
              verify_attempt_id TEXT NOT NULL,
              status TEXT NOT NULL,
              payload_json TEXT NOT NULL,
              created_at TEXT NOT NULL,
              completed_at TEXT
            );
            CREATE TABLE IF NOT EXISTS repository_integrations (
              graph_id TEXT NOT NULL,
              repository_path TEXT NOT NULL,
              integrated_revision TEXT NOT NULL,
              updated_at TEXT NOT NULL,
              PRIMARY KEY (graph_id, repository_path)
            );
            CREATE TABLE IF NOT EXISTS human_waits (
              wait_id TEXT PRIMARY KEY,
              node_id TEXT NOT NULL,
              status TEXT NOT NULL,
              payload_json TEXT NOT NULL,
              created_at TEXT NOT NULL,
              resolved_at TEXT
            );
            CREATE TABLE IF NOT EXISTS runtime_waits (
              wait_id TEXT PRIMARY KEY,
              attempt_id TEXT NOT NULL,
              node_id TEXT NOT NULL,
              mode TEXT NOT NULL,
              status TEXT NOT NULL,
              payload_json TEXT NOT NULL,
              created_at TEXT NOT NULL,
              updated_at TEXT NOT NULL,
              resolved_at TEXT
            );
            CREATE TABLE IF NOT EXISTS linear_projections (
              projection_id TEXT PRIMARY KEY,
              node_id TEXT NOT NULL,
              linear_issue_id TEXT NOT NULL,
              payload_json TEXT NOT NULL,
              updated_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS linear_projection_comments (
              comment_key TEXT PRIMARY KEY,
              linear_issue_id TEXT NOT NULL,
              comment_id TEXT NOT NULL,
              payload_json TEXT NOT NULL,
              updated_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS linear_projection_health (
              id INTEGER PRIMARY KEY CHECK (id = 1),
              payload_json TEXT NOT NULL,
              updated_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS stuck_node_observations (
              graph_revision INTEGER NOT NULL,
              node_id TEXT NOT NULL,
              count INTEGER NOT NULL,
              payload_json TEXT NOT NULL,
              first_seen_at TEXT NOT NULL,
              last_seen_at TEXT NOT NULL,
              PRIMARY KEY (graph_revision, node_id)
            );
            CREATE TABLE IF NOT EXISTS graph_deliveries (
              delivery_id TEXT PRIMARY KEY,
              graph_revision INTEGER NOT NULL,
              status TEXT NOT NULL,
              payload_json TEXT NOT NULL,
              created_at TEXT NOT NULL,
              updated_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS scheduler_tick_policy (
              id INTEGER PRIMARY KEY CHECK (id = 1),
              payload_json TEXT NOT NULL,
              updated_at TEXT NOT NULL
            );
            """
        )
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
