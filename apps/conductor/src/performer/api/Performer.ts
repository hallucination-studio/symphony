import type {
  PerformerLaunchRequest,
  PerformerProcessResult,
} from "../../contracts/performer.js";

/** Mechanical process boundary used by Conductor role runners. */
export interface Performer {
  launch(
    request: PerformerLaunchRequest,
    signal?: AbortSignal,
  ): Promise<PerformerProcessResult>;
}
