import type {
  LinearInstallation,
  OAuthAttempt,
  ProjectCatalogEntry,
} from "../../models.js";

export interface LinearInstallationStoreInterface {
  saveLinearInstallation(installation: LinearInstallation): void;
  getLinearInstallation(installationId: string): LinearInstallation | undefined;
  saveOAuthAttempt(attempt: OAuthAttempt): void;
  consumeOAuthAttempt(state: string): OAuthAttempt | undefined;
  replaceProjects(
    installationId: string,
    projects: ReadonlyArray<ProjectCatalogEntry>,
  ): void;
  listProjects(installationId: string): ProjectCatalogEntry[];
}
