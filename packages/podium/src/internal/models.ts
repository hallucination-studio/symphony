export type ConductorDesiredState = "running" | "stopped";

export type ConductorRuntimeStatus =
  | "stopped"
  | "starting"
  | "ready"
  | "recovering"
  | "unbound"
  | "project-conflict"
  | "not-responding"
  | "crashed";

export interface RepositoryContext {
  repositoryIdentity: string;
  repositoryDisplayName: string;
  repositoryRoot: string;
  baseBranch: string;
}

export interface LinearInstallation {
  installationId: string;
  organizationId: string;
  accessToken: string;
  refreshToken: string;
  expiresAt: string;
}

export interface ProjectCatalogEntry {
  projectId: string;
  installationId: string;
  organizationId: string;
  name: string;
  updatedAt: string;
}

export interface ConductorBinding {
  bindingId: string;
  conductorId: string;
  conductorShortHash: string;
  linearInstallationId: string;
  organizationId: string;
  repositoryContext: RepositoryContext;
  desiredState: ConductorDesiredState;
}

export interface RuntimeObservation {
  bindingId: string;
  status: ConductorRuntimeStatus;
  observedAt: string;
  sanitizedSummary: string;
  lastResolvedProjectId?: string;
  projectResolutionConflict?: string;
}

export interface OAuthAttempt {
  attemptId: string;
  codeVerifier: string;
  state: string;
  createdAt: string;
}
