import type {
  LinearCredential,
  ProjectCatalogEntry,
} from "../../models.js";

export interface LinearCredentialStoreInterface {
  getLinearCredential(
    installationId: string,
  ): LinearCredential | undefined;
  replaceProjects(
    installationId: string,
    projects: ReadonlyArray<ProjectCatalogEntry>,
  ): void;
  listProjects(installationId: string): ProjectCatalogEntry[];
}
