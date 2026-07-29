import type { NativeEffectObservationOutcome } from "../../linear-runtime/api/LinearRootRuntimeInterface.js";
import type { RecoveredRootState } from "../../linear-runtime/api/RootStateRecoveryInterface.js";
import type { RootStateMechanicalEffect } from "../../root-transition/api/RootStateMechanicalEffect.js";

export interface NativeLinearEffectBoundaryInterface {
  apply(input: {
    rootIssueId: string;
    projectId: string;
    effect: RootStateMechanicalEffect;
  }): Promise<NativeEffectObservationOutcome>;
}

export interface RootStateEffectMaterializerInterface {
  materialize(input: {
    state: RecoveredRootState;
    effect: RootStateMechanicalEffect;
  }): Promise<NativeEffectObservationOutcome>;
}
