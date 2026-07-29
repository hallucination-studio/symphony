import assert from "node:assert/strict";
import test from "node:test";

import { parseCorrelationId, parseRootIssueId } from "../../contracts/identity.js";
import type { LinearObservation } from "../../contracts/observation.js";
import {
  mutateAndReadBack,
  type LinearGatewayInterface,
  type LinearMutation,
} from "./LinearGatewayInterface.js";

const rootId = parseRootIssueId("LIN-1");
const observation: LinearObservation = {
  root_id: rootId,
  root_status: "Todo",
  active_cycle: null,
};

class AppliedWithoutFactGateway implements LinearGatewayInterface {
  readCount = 0;

  async discoverRoots() { return []; }
  async readRoot() { this.readCount += 1; return observation; }
  async mutate(command: LinearMutation) {
    return { outcome: "applied" as const, target_id: command.root_id, correlation_id: command.correlation_id };
  }
}

test("Linear transport success cannot advance state without fresh matching facts", async () => {
  const gateway = new AppliedWithoutFactGateway();
  const command: LinearMutation = {
    kind: "set_root_status",
    root_id: rootId,
    correlation_id: parseCorrelationId("corr:1"),
    expected_status: "Todo",
    desired_status: "In Progress",
  };
  await assert.rejects(
    mutateAndReadBack(gateway, command, (fresh) => fresh.root_status === "In Progress"),
    /linear_readback_mismatch/u,
  );
  assert.equal(gateway.readCount, 1);
});
