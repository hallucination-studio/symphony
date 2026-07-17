import type {
  ConductorBinding,
  LinearCredential,
  ProjectCatalogEntry,
} from "../../models.js";

export interface ConductorBindingStoreInterface {
  getLinearCredential(installationId: string): LinearCredential | undefined;
  getProject(projectId: string): ProjectCatalogEntry | undefined;
  saveConductorBinding(binding: ConductorBinding): void;
  getConductorBinding(): ConductorBinding | undefined;
  setConductorDesiredState(
    bindingId: string,
    desiredState: ConductorBinding["desiredState"],
  ): void;
}
