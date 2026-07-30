import type { TaskObservationEvent } from "../../contracts/observation.js";

export interface TaskManageObserverInterface {
  poll_once(): Promise<readonly TaskObservationEvent[]>;
}
