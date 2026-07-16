import type { RuntimeObservation } from "../../models.js";

export interface RuntimeObservationStoreInterface {
  saveRuntimeObservation(observation: RuntimeObservation): void;
  getRuntimeObservation(bindingId: string): RuntimeObservation | undefined;
}
