import type { RootDirective, RootReconciliationView } from "../../root-reconciliation/api/RootReconciliationContracts.js";

export interface RootDeliveryCommand {
  directive: RootDirective;
  view: RootReconciliationView;
  baseBranch: string;
  title: string;
  body: string;
}

export type RootDeliveryResult = { kind: "pull_request"; url: string };

export interface RootDeliveryInterface {
  deliver(command: RootDeliveryCommand): Promise<RootDeliveryResult>;
}
