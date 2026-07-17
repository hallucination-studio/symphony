import type {
  ConductorBinding,
  LinearCredential,
  ProjectCatalogEntry,
  RuntimeObservation,
} from "../models.js";
import type { ConductorBindingStoreInterface } from "../conductor-bindings/api/ConductorBindingStoreInterface.js";
import type { LinearCredentialStoreInterface } from "../linear-auth/api/LinearCredentialStoreInterface.js";
import type { RuntimeObservationStoreInterface } from "../runtime-observations/api/RuntimeObservationStoreInterface.js";

export interface PodiumClientStoreInterface
  extends ConductorBindingStoreInterface,
    LinearCredentialStoreInterface {
  getOnlyLinearCredential(): LinearCredential | undefined;
  getConductorBinding(): ConductorBinding | undefined;
  getRuntimeObservation(bindingId: string): RuntimeObservation | undefined;
  getProject(projectId: string): ProjectCatalogEntry | undefined;
}

export interface PodiumConductorStoreInterface
  extends ConductorBindingStoreInterface,
    RuntimeObservationStoreInterface {}
