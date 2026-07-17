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
  repositoryHandle: string;
  repositoryIdentity: string;
  repositoryDisplayName: string;
  repositoryRoot: string;
  baseBranch: string;
}

export interface LinearCredential {
  installationId: string;
  organizationId: string;
  accessToken: string;
}

export interface LinearInstallation extends LinearCredential {
  refreshToken: string;
  expiresAt: string;
}

export interface ProjectCatalogEntry {
  projectId: string;
  installationId: string;
  organizationId: string;
  name: string;
  slugId?: string;
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
