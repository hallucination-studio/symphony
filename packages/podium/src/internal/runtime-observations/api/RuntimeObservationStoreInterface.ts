import type {
  RootRuntimeObservation,
  RuntimeObservation,
} from "../../models.js";

export interface RuntimeObservationStoreInterface {
  saveRuntimeObservation(observation: RuntimeObservation): void;
  getRuntimeObservation(bindingId: string): RuntimeObservation | undefined;
  saveRootRuntimeObservation(observation: RootRuntimeObservation): void;
  getRootRuntimeObservation(
    bindingId: string,
    rootIssueId: string,
  ): RootRuntimeObservation | undefined;
}
