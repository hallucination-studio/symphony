import { describe, expect, it } from "vitest";
import { linearHealth } from "./linear";

describe("linearHealth", () => {
  it("treats required reauthorization as a broken actionable connection", () => {
    const health = linearHealth({
      workspace_id: "workspace-1",
      state: "reauthorization_required",
    });

    expect(health).toMatchObject({
      connected: false,
      broken: true,
      status: "degraded",
      title: "Linear authorization required",
      actionLabel: "Reauthorize Linear",
    });
  });
});
