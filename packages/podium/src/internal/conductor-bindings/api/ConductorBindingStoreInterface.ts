import type {
  ConductorBinding,
  LinearInstallation,
  ProjectCatalogEntry,
} from "../../models.js";

export interface ConductorBindingStoreInterface {
  getLinearInstallation(installationId: string): LinearInstallation | undefined;
  getProject(projectId: string): ProjectCatalogEntry | undefined;
  saveConductorBinding(binding: ConductorBinding): void;
  getConductorBinding(): ConductorBinding | undefined;
  setConductorDesiredState(
    bindingId: string,
    desiredState: ConductorBinding["desiredState"],
  ): void;
}
