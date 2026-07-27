import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";

import { FramedProtocolPeer } from "./FramedProtocolPeer.js";

describe("FramedProtocolPeer", () => {
  it("dispatches a pending response while an incoming request is slow", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    let releaseRequest: () => void;
    const requestBlocked = new Promise<void>((resolve) => { releaseRequest = resolve; });
    let requestStarted: () => void;
    const requestRunning = new Promise<void>((resolve) => { requestStarted = resolve; });
    const peer = new FramedProtocolPeer(input, output, {
      decode: (value) => value as never,
      secretLength: () => 0,
      async handleRequest(body) {
        expect(body).toEqual({ kind: "slow_request" });
        requestStarted();
        await requestBlocked;
        return { kind: "slow_result" };
      },
    });

    const pending = peer.request({
      requestId: "profile-request-1",
      body: { kind: "profile_request" },
      timeoutMs: 200,
    });
    input.write(`${JSON.stringify({
      protocol_version: "1",
      request_id: "linear-request-1",
      body: { kind: "slow_request" },
    })}\n`);
    await requestRunning;
    input.write(`${JSON.stringify({
      protocol_version: "1",
      request_id: "profile-request-1",
      body: { kind: "profile_result" },
    })}\n`);

    try {
      await expect(pending).resolves.toEqual({ kind: "profile_result" });
    } finally {
      releaseRequest!();
    }
  });
});
