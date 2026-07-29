import assert from "node:assert/strict";
import test from "node:test";

import { parseLinearMutation } from "./LinearGatewayInterface.js";

test("Linear mutation input accepts only the exact v1 target and precondition shape", () => {
  const command = {
    schema_version: 1,
    kind: "set_root_status",
    root_id: "LIN-1",
    correlation_id: "corr:1",
    expected_status: "Todo",
    desired_status: "In Progress",
  };
  assert.deepEqual(parseLinearMutation(command), command);
  assert.throws(() => parseLinearMutation({ ...command, schema_version: 2 }), /unsupported_schema_version/u);
  assert.throws(() => parseLinearMutation({ ...command, desired_status: "Done" }), /linear_root_done_forbidden/u);
  assert.throws(() => parseLinearMutation({ ...command, raw_sdk: {} }), /invalid_contract_keys/u);
});
