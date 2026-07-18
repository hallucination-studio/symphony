import type {
  LinearInstallation,
  ProjectCatalogEntry,
} from "../../models.js";

export interface LinearCredentialStoreInterface {
  getLinearCredential(
    installationId: string,
  ): LinearInstallation | undefined;
  replaceProjects(
    installationId: string,
    projects: ReadonlyArray<ProjectCatalogEntry>,
  ): void;
  listProjects(installationId: string): ProjectCatalogEntry[];
}
