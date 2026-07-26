import type { LinearInstallation, ProjectCatalogEntry } from "../models.js";
import type { ConductorBindingStoreInterface } from "../conductor-bindings/api/ConductorBindingStoreInterface.js";
import type { LinearCredentialStoreInterface } from "../linear-auth/api/LinearCredentialStoreInterface.js";

export interface PodiumClientStoreInterface
  extends ConductorBindingStoreInterface,
    LinearCredentialStoreInterface {
  getOnlyLinearCredential(): LinearInstallation | undefined;
  getProject(projectId: string): ProjectCatalogEntry | undefined;
}

export type PodiumConductorStoreInterface = ConductorBindingStoreInterface;
