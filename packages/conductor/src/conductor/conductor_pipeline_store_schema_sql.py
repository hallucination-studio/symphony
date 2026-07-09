from __future__ import annotations


PIPELINE_SCHEMA_SQL = """
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
