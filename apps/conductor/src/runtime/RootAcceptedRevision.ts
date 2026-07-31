import {
  parseRootIssueId,
  parseRuntimeGeneration,
  type RootIssueId,
  type RuntimeGeneration,
} from "../contracts/identity.js";
import { createRootHeadBranch } from "../delivery/api/DeliveryInterface.js";
import {
  parseRootAcceptanceView,
  type RootAcceptanceView,
} from "./RootToolBoundary.js";

declare const acceptedRevisionAuthorizationBrand: unique symbol;

export interface AcceptedRevisionAuthorization {
  readonly root_id: RootIssueId;
  readonly runtime_generation: RuntimeGeneration;
  readonly acceptance_view: RootAcceptanceView;
  readonly [acceptedRevisionAuthorizationBrand]: true;
}

export interface AcceptedRevisionAuthorizationInput {
  readonly root_id: RootIssueId;
  readonly runtime_generation: RuntimeGeneration;
  readonly acceptance_view: RootAcceptanceView;
}

export interface AcceptedRevisionIssuer {
  issue(input: AcceptedRevisionAuthorizationInput): AcceptedRevisionAuthorization;
}

export interface AcceptedRevisionVerifier {
  assert(authorization: AcceptedRevisionAuthorization): void;
}

export interface AcceptedRevisionAuthority {
  readonly issuer: AcceptedRevisionIssuer;
  readonly verifier: AcceptedRevisionVerifier;
}

export function createAcceptedRevisionAuthority(): AcceptedRevisionAuthority {
  const issued = new WeakSet<object>();
  const issuer: AcceptedRevisionIssuer = Object.freeze({
    issue(input: AcceptedRevisionAuthorizationInput): AcceptedRevisionAuthorization {
      const rootId = parseRootIssueId(input.root_id);
      const acceptanceView = parseRootAcceptanceView(input.acceptance_view);
      if (acceptanceView.head_branch !== createRootHeadBranch(rootId)) {
        throw new Error("accepted_revision_delivery_identity_mismatch");
      }
      const authorization = Object.freeze({
        root_id: rootId,
        runtime_generation: parseRuntimeGeneration(input.runtime_generation),
        acceptance_view: acceptanceView,
      }) as AcceptedRevisionAuthorization;
      issued.add(authorization);
      return authorization;
    },
  });
  const verifier: AcceptedRevisionVerifier = Object.freeze({
    assert(authorization: AcceptedRevisionAuthorization): void {
      if (
        typeof authorization !== "object"
        || authorization === null
        || !Object.isFrozen(authorization)
        || !issued.has(authorization)
      ) throw new Error("invalid_accepted_revision_authorization");
    },
  });
  return Object.freeze({ issuer, verifier });
}
