import type {
  ConductorBinding,
  LinearInstallation,
  ProjectCatalogEntry,
} from "../../models.js";

export interface ConductorBindingStoreInterface {
  getLinearCredential(installationId: string): LinearInstallation | undefined;
  getProject(projectId: string): ProjectCatalogEntry | undefined;
  saveConductorBinding(binding: ConductorBinding): void;
  listConductorBindings(): ConductorBinding[];
  getConductorBindingById(bindingId: string): ConductorBinding | undefined;
  getConductorBinding(): ConductorBinding | undefined;
  setConductorDesiredState(
    bindingId: string,
    desiredState: ConductorBinding["desiredState"],
  ): void;
}
