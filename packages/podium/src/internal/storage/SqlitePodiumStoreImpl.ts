import { createRequire } from "node:module";

import type Database from "better-sqlite3";

import type { ConductorBindingStoreInterface } from "../conductor-bindings/api/ConductorBindingStoreInterface.js";
import type { LinearInstallationStoreInterface } from "../linear-auth/api/LinearInstallationStoreInterface.js";
import type {
  ConductorBinding,
  LinearInstallation,
  OAuthAttempt,
  ProjectCatalogEntry,
  RepositoryContext,
  RootRuntimeObservation,
  RuntimeObservation,
} from "../models.js";
import type { RuntimeObservationStoreInterface } from "../runtime-observations/api/RuntimeObservationStoreInterface.js";

export class SqlitePodiumStoreImpl
  implements
    LinearInstallationStoreInterface,
    ConductorBindingStoreInterface,
    RuntimeObservationStoreInterface
{
  readonly #database: Database.Database;

  constructor(databasePath: string) {
    this.#database = openDatabase(databasePath);
    this.#database.exec("PRAGMA journal_mode = WAL");
    this.#database.exec("PRAGMA foreign_keys = ON");
    this.#createSchema();
  }

  #createSchema(): void {
    this.#database.exec(`
      CREATE TABLE IF NOT EXISTS linear_installations (
        installation_id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL,
        credential_kind TEXT NOT NULL CHECK (credential_kind IN ('oauth', 'development_token')),
        access_token TEXT NOT NULL,
        delegate_actor_id TEXT,
        refresh_token TEXT,
        expires_at TEXT,
        CHECK (
          (credential_kind = 'oauth' AND refresh_token IS NOT NULL AND expires_at IS NOT NULL)
          OR (credential_kind = 'development_token' AND refresh_token IS NULL AND expires_at IS NULL)
        )
      );
      CREATE TABLE IF NOT EXISTS project_catalog (
        project_id TEXT PRIMARY KEY,
        installation_id TEXT NOT NULL,
        organization_id TEXT NOT NULL,
        name TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (installation_id) REFERENCES linear_installations(installation_id)
      );
      CREATE TABLE IF NOT EXISTS conductor_bindings (
        binding_id TEXT PRIMARY KEY,
        conductor_id TEXT NOT NULL UNIQUE,
        conductor_short_hash TEXT NOT NULL UNIQUE,
        linear_installation_id TEXT NOT NULL,
        organization_id TEXT NOT NULL,
        repository_handle TEXT NOT NULL,
        repository_identity TEXT NOT NULL,
        repository_display_name TEXT NOT NULL,
        repository_root TEXT NOT NULL,
        base_branch TEXT NOT NULL,
        desired_state TEXT NOT NULL CHECK (desired_state IN ('running', 'stopped')),
        FOREIGN KEY (linear_installation_id) REFERENCES linear_installations(installation_id)
      );
      CREATE TABLE IF NOT EXISTS runtime_observations (
        binding_id TEXT PRIMARY KEY,
        status TEXT NOT NULL,
        observed_at TEXT NOT NULL,
        sanitized_summary TEXT NOT NULL,
        last_resolved_project_id TEXT,
        project_resolution_conflict TEXT,
        FOREIGN KEY (binding_id) REFERENCES conductor_bindings(binding_id)
      );
      CREATE TABLE IF NOT EXISTS root_runtime_observations (
        binding_id TEXT NOT NULL,
        root_issue_id TEXT NOT NULL,
        observed_at TEXT NOT NULL,
        sanitized_summary TEXT NOT NULL,
        PRIMARY KEY (binding_id, root_issue_id),
        FOREIGN KEY (binding_id) REFERENCES conductor_bindings(binding_id)
      );
      CREATE TABLE IF NOT EXISTS oauth_attempts (
        attempt_id TEXT PRIMARY KEY,
        code_verifier TEXT NOT NULL,
        state TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL
      );
    `);
    this.#migrateLinearInstallations();
    this.#ensureColumn("linear_installations", "delegate_actor_id", "TEXT");
    this.#ensureColumn(
      "conductor_bindings",
      "repository_handle",
      "TEXT NOT NULL DEFAULT 'legacy-repository-handle'",
    );
    this.#migrateConductorBindingSingleton();
  }

  saveLinearInstallation(installation: LinearInstallation): void {
    this.#database
      .prepare(`
        INSERT INTO linear_installations (
          installation_id, organization_id, credential_kind, access_token,
          delegate_actor_id, refresh_token, expires_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(installation_id) DO UPDATE SET
          organization_id = excluded.organization_id,
          credential_kind = excluded.credential_kind,
          access_token = excluded.access_token,
          delegate_actor_id = excluded.delegate_actor_id,
          refresh_token = excluded.refresh_token,
          expires_at = excluded.expires_at
      `)
      .run(
        installation.installationId,
        installation.organizationId,
        installation.kind,
        installation.accessToken,
        installation.kind === "development_token" ? installation.delegateActorId : null,
        installation.kind === "oauth" ? installation.refreshToken : null,
        installation.kind === "oauth" ? installation.expiresAt : null,
      );
  }

  getLinearInstallation(installationId: string): LinearInstallation | undefined {
    const row = this.#database
      .prepare(`
        SELECT installation_id, organization_id, credential_kind, access_token,
               delegate_actor_id, refresh_token, expires_at
        FROM linear_installations WHERE installation_id = ?
      `)
      .get(installationId) as
      | {
          installation_id: string;
          organization_id: string;
          credential_kind: "oauth" | "development_token";
          access_token: string;
          delegate_actor_id: string | null;
          refresh_token: string | null;
          expires_at: string | null;
        }
      | undefined;
    if (!row) return undefined;
    if (row.credential_kind === "development_token") {
      if (row.refresh_token || row.expires_at || !row.delegate_actor_id) {
        throw new Error("linear_installation_record_invalid");
      }
      return {
        kind: "development_token",
        installationId: row.installation_id,
        organizationId: row.organization_id,
        delegateActorId: row.delegate_actor_id,
        accessToken: row.access_token,
      };
    }
    if (!row.refresh_token || !row.expires_at) throw new Error("linear_installation_record_invalid");
    return {
          kind: "oauth",
          installationId: row.installation_id,
          organizationId: row.organization_id,
          accessToken: row.access_token,
          refreshToken: row.refresh_token,
          expiresAt: row.expires_at,
        };
  }

  getLinearCredential(installationId: string): LinearInstallation | undefined {
    return this.getLinearInstallation(installationId);
  }

  getOnlyLinearInstallation(): LinearInstallation | undefined {
    const rows = this.#database
      .prepare("SELECT installation_id FROM linear_installations ORDER BY installation_id LIMIT 2")
      .all() as Array<{ installation_id: string }>;
    if (rows.length > 1) throw new Error("linear_installation_ambiguous");
    return rows[0]
      ? this.getLinearInstallation(rows[0].installation_id)
      : undefined;
  }

  getOnlyLinearCredential(): LinearInstallation | undefined {
    return this.getOnlyLinearInstallation();
  }

  saveProject(project: ProjectCatalogEntry): void {
    this.#database
      .prepare(`
        INSERT INTO project_catalog (
          project_id, installation_id, organization_id, name, updated_at
        ) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(project_id) DO UPDATE SET
          installation_id = excluded.installation_id,
          organization_id = excluded.organization_id,
          name = excluded.name,
          updated_at = excluded.updated_at
      `)
      .run(
        project.projectId,
        project.installationId,
        project.organizationId,
        project.name,
        project.updatedAt,
      );
  }

  replaceProjects(
    installationId: string,
    projects: ReadonlyArray<ProjectCatalogEntry>,
  ): void {
    const replace = this.#database.transaction(() => {
      this.#database
        .prepare("DELETE FROM project_catalog WHERE installation_id = ?")
        .run(installationId);
      for (const project of projects) {
        this.saveProject(project);
      }
    });
    replace();
  }

  listProjects(installationId: string): ProjectCatalogEntry[] {
    const rows = this.#database
      .prepare(`
        SELECT project_id, installation_id, organization_id, name, updated_at
        FROM project_catalog WHERE installation_id = ? ORDER BY name, project_id
      `)
      .all(installationId) as Array<{
      project_id: string;
      installation_id: string;
      organization_id: string;
      name: string;
      updated_at: string;
    }>;
    return rows.map((row) => ({
      projectId: row.project_id,
      installationId: row.installation_id,
      organizationId: row.organization_id,
      name: row.name,
      updatedAt: row.updated_at,
    }));
  }

  getProject(projectId: string): ProjectCatalogEntry | undefined {
    const row = this.#database
      .prepare(`
        SELECT project_id, installation_id, organization_id, name, updated_at
        FROM project_catalog WHERE project_id = ?
      `)
      .get(projectId) as
      | {
          project_id: string;
          installation_id: string;
          organization_id: string;
          name: string;
          updated_at: string;
        }
      | undefined;
    return row
      ? {
          projectId: row.project_id,
          installationId: row.installation_id,
          organizationId: row.organization_id,
          name: row.name,
          updatedAt: row.updated_at,
        }
      : undefined;
  }

  saveConductorBinding(binding: ConductorBinding): void {
    this.#database
      .prepare(`
        INSERT INTO conductor_bindings (
          binding_id, conductor_id, conductor_short_hash, linear_installation_id,
          organization_id, repository_handle, repository_identity, repository_display_name,
          repository_root, base_branch, desired_state
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(binding_id) DO UPDATE SET
          desired_state = excluded.desired_state
      `)
      .run(
        binding.bindingId,
        binding.conductorId,
        binding.conductorShortHash,
        binding.linearInstallationId,
        binding.organizationId,
        binding.repositoryContext.repositoryHandle,
        binding.repositoryContext.repositoryIdentity,
        binding.repositoryContext.repositoryDisplayName,
        binding.repositoryContext.repositoryRoot,
        binding.repositoryContext.baseBranch,
        binding.desiredState,
      );
  }

  listConductorBindings(): ConductorBinding[] {
    const rows = this.#database
      .prepare("SELECT * FROM conductor_bindings ORDER BY conductor_id")
      .all() as BindingRow[];
    return rows.map(bindingFromRow);
  }

  getConductorBindingById(bindingId: string): ConductorBinding | undefined {
    const row = this.#database
      .prepare("SELECT * FROM conductor_bindings WHERE binding_id = ?")
      .get(bindingId) as BindingRow | undefined;
    return row ? bindingFromRow(row) : undefined;
  }

  getConductorBinding(): ConductorBinding | undefined {
    const row = this.#database
      .prepare("SELECT * FROM conductor_bindings ORDER BY conductor_id LIMIT 1")
      .get() as BindingRow | undefined;
    return row ? bindingFromRow(row) : undefined;
  }

  setConductorDesiredState(
    bindingId: string,
    desiredState: ConductorBinding["desiredState"],
  ): void {
    const result = this.#database
      .prepare(
        "UPDATE conductor_bindings SET desired_state = ? WHERE binding_id = ?",
      )
      .run(desiredState, bindingId);
    if (result.changes !== 1) {
      throw new Error("conductor_binding_missing");
    }
  }

  saveRuntimeObservation(observation: RuntimeObservation): void {
    this.#database
      .prepare(`
        INSERT INTO runtime_observations (
          binding_id, status, observed_at, sanitized_summary,
          last_resolved_project_id, project_resolution_conflict
        ) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(binding_id) DO UPDATE SET
          status = excluded.status,
          observed_at = excluded.observed_at,
          sanitized_summary = excluded.sanitized_summary,
          last_resolved_project_id = excluded.last_resolved_project_id,
          project_resolution_conflict = excluded.project_resolution_conflict
      `)
      .run(
        observation.bindingId,
        observation.status,
        observation.observedAt,
        observation.sanitizedSummary,
        observation.lastResolvedProjectId ?? null,
        observation.projectResolutionConflict ?? null,
      );
  }

  getRuntimeObservation(bindingId: string): RuntimeObservation | undefined {
    const row = this.#database
      .prepare("SELECT * FROM runtime_observations WHERE binding_id = ?")
      .get(bindingId) as
      | {
          binding_id: string;
          status: RuntimeObservation["status"];
          observed_at: string;
          sanitized_summary: string;
          last_resolved_project_id: string | null;
          project_resolution_conflict: string | null;
        }
      | undefined;
    if (!row) return undefined;
    return {
      bindingId: row.binding_id,
      status: row.status,
      observedAt: row.observed_at,
      sanitizedSummary: row.sanitized_summary,
      ...(row.last_resolved_project_id
        ? { lastResolvedProjectId: row.last_resolved_project_id }
        : {}),
      ...(row.project_resolution_conflict
        ? { projectResolutionConflict: row.project_resolution_conflict }
        : {}),
    };
  }

  saveRootRuntimeObservation(observation: RootRuntimeObservation): void {
    this.#database
      .prepare(`
        INSERT INTO root_runtime_observations (
          binding_id, root_issue_id, observed_at, sanitized_summary
        ) VALUES (?, ?, ?, ?)
        ON CONFLICT(binding_id, root_issue_id) DO UPDATE SET
          observed_at = excluded.observed_at,
          sanitized_summary = excluded.sanitized_summary
      `)
      .run(
        observation.bindingId,
        observation.rootIssueId,
        observation.observedAt,
        observation.sanitizedSummary,
      );
  }

  getRootRuntimeObservation(
    bindingId: string,
    rootIssueId: string,
  ): RootRuntimeObservation | undefined {
    const row = this.#database
      .prepare(`
        SELECT binding_id, root_issue_id, observed_at, sanitized_summary
        FROM root_runtime_observations
        WHERE binding_id = ? AND root_issue_id = ?
      `)
      .get(bindingId, rootIssueId) as
      | {
          binding_id: string;
          root_issue_id: string;
          observed_at: string;
          sanitized_summary: string;
        }
      | undefined;
    return row
      ? {
          bindingId: row.binding_id,
          rootIssueId: row.root_issue_id,
          observedAt: row.observed_at,
          sanitizedSummary: row.sanitized_summary,
        }
      : undefined;
  }

  saveOAuthAttempt(attempt: OAuthAttempt): void {
    this.#database
      .prepare(`
        INSERT INTO oauth_attempts (attempt_id, code_verifier, state, created_at)
        VALUES (?, ?, ?, ?)
      `)
      .run(attempt.attemptId, attempt.codeVerifier, attempt.state, attempt.createdAt);
  }

  consumeOAuthAttempt(state: string): OAuthAttempt | undefined {
    const transaction = this.#database.transaction(() => {
      const row = this.#database
        .prepare("SELECT * FROM oauth_attempts WHERE state = ?")
        .get(state) as
        | {
            attempt_id: string;
            code_verifier: string;
            state: string;
            created_at: string;
          }
        | undefined;
      if (row) {
        this.#database.prepare("DELETE FROM oauth_attempts WHERE state = ?").run(state);
      }
      return row;
    });
    const row = transaction();
    return row
      ? {
          attemptId: row.attempt_id,
          codeVerifier: row.code_verifier,
          state: row.state,
          createdAt: row.created_at,
        }
      : undefined;
  }

  listTableNames(): string[] {
    const names = this.#database
      .prepare(`
        SELECT name FROM sqlite_master
        WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
        ORDER BY name
      `)
      .all() as Array<{ name: string }>;
    return names.map(({ name }) => name);
  }

  #migrateLinearInstallations(): void {
    const columns = this.#database
      .prepare("PRAGMA table_info(linear_installations)")
      .all() as Array<{ name: string; notnull: 0 | 1 }>;
    const credentialKind = columns.find(({ name }) => name === "credential_kind");
    const refreshToken = columns.find(({ name }) => name === "refresh_token");
    const expiresAt = columns.find(({ name }) => name === "expires_at");
    if (credentialKind && refreshToken?.notnull === 0 && expiresAt?.notnull === 0) return;

    this.#database.pragma("foreign_keys = OFF");
    try {
      this.#database.exec(`
        BEGIN;
        CREATE TABLE linear_installations_next (
          installation_id TEXT PRIMARY KEY,
          organization_id TEXT NOT NULL,
          credential_kind TEXT NOT NULL CHECK (credential_kind IN ('oauth', 'development_token')),
          access_token TEXT NOT NULL,
          refresh_token TEXT,
          expires_at TEXT,
          CHECK (
            (credential_kind = 'oauth' AND refresh_token IS NOT NULL AND expires_at IS NOT NULL)
            OR (credential_kind = 'development_token' AND refresh_token IS NULL AND expires_at IS NULL)
          )
        );
        INSERT INTO linear_installations_next (
          installation_id, organization_id, credential_kind, access_token,
          refresh_token, expires_at
        )
        SELECT installation_id, organization_id, 'oauth', access_token,
               refresh_token, expires_at
        FROM linear_installations;
        DROP TABLE linear_installations;
        ALTER TABLE linear_installations_next RENAME TO linear_installations;
        COMMIT;
      `);
    } catch (error) {
      if (this.#database.inTransaction) this.#database.exec("ROLLBACK");
      throw error;
    } finally {
      this.#database.pragma("foreign_keys = ON");
    }
  }

  #ensureColumn(table: string, column: string, definition: string): void {
    const columns = this.#database
      .prepare(`PRAGMA table_info(${table})`)
      .all() as Array<{ name: string }>;
    if (!columns.some(({ name }) => name === column)) {
      this.#database.exec(
        `ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`,
      );
    }
  }

  #migrateConductorBindingSingleton(): void {
    const columns = this.#database
      .prepare("PRAGMA table_info(conductor_bindings)")
      .all() as Array<{ name: string }>;
    if (!columns.some(({ name }) => name === "singleton")) return;

    this.#database.pragma("foreign_keys = OFF");
    try {
      this.#database.exec(`
        BEGIN;
        ALTER TABLE conductor_bindings RENAME TO conductor_bindings_legacy;
        CREATE TABLE conductor_bindings (
          binding_id TEXT PRIMARY KEY,
          conductor_id TEXT NOT NULL UNIQUE,
          conductor_short_hash TEXT NOT NULL UNIQUE,
          linear_installation_id TEXT NOT NULL,
          organization_id TEXT NOT NULL,
          repository_handle TEXT NOT NULL,
          repository_identity TEXT NOT NULL,
          repository_display_name TEXT NOT NULL,
          repository_root TEXT NOT NULL,
          base_branch TEXT NOT NULL,
          desired_state TEXT NOT NULL CHECK (desired_state IN ('running', 'stopped')),
          FOREIGN KEY (linear_installation_id) REFERENCES linear_installations(installation_id)
        );
        INSERT INTO conductor_bindings (
          binding_id, conductor_id, conductor_short_hash, linear_installation_id,
          organization_id, repository_handle, repository_identity, repository_display_name,
          repository_root, base_branch, desired_state
        )
        SELECT binding_id, conductor_id, conductor_short_hash, linear_installation_id,
               organization_id, repository_handle, repository_identity, repository_display_name,
               repository_root, base_branch, desired_state
        FROM conductor_bindings_legacy;
        DROP TABLE conductor_bindings_legacy;
        COMMIT;
      `);
    } catch (error) {
      if (this.#database.inTransaction) this.#database.exec("ROLLBACK");
      throw error;
    } finally {
      this.#database.pragma("foreign_keys = ON");
    }
  }

  close(): void {
    this.#database.close();
  }
}

interface BindingRow {
  binding_id: string;
  conductor_id: string;
  conductor_short_hash: string;
  linear_installation_id: string;
  organization_id: string;
  repository_handle: string;
  repository_identity: string;
  repository_display_name: string;
  repository_root: string;
  base_branch: string;
  desired_state: "running" | "stopped";
}

function bindingFromRow(row: BindingRow): ConductorBinding {
  const repositoryContext: RepositoryContext = {
    repositoryHandle: row.repository_handle,
    repositoryIdentity: row.repository_identity,
    repositoryDisplayName: row.repository_display_name,
    repositoryRoot: row.repository_root,
    baseBranch: row.base_branch,
  };
  return {
    bindingId: row.binding_id,
    conductorId: row.conductor_id,
    conductorShortHash: row.conductor_short_hash,
    linearInstallationId: row.linear_installation_id,
    organizationId: row.organization_id,
    repositoryContext,
    desiredState: row.desired_state,
  };
}

function openDatabase(databasePath: string): Database.Database {
  const require = createRequire(import.meta.url);
  if ("Bun" in globalThis) {
    const moduleName = ["bun", "sqlite"].join(":");
    const { Database: BunDatabase } = require(moduleName) as {
      Database: new (path: string) => Database.Database;
    };
    return new BunDatabase(databasePath);
  }
  const moduleName = ["better", "sqlite3"].join("-");
  const BetterSqliteDatabase = require(moduleName) as typeof Database;
  return new BetterSqliteDatabase(databasePath);
}
