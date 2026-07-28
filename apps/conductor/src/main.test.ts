import assert from "node:assert/strict";
import test from "node:test";

import { providerIoCaptureDirectory, providerIoCapturePath, runtimeLogLevel } from "./main.js";

test("runtime failures are published at error level", () => {
  assert.equal(runtimeLogLevel("root_reconciler_failed"), "error");
  assert.equal(runtimeLogLevel("root_reconciliation_failed"), "error");
  assert.equal(runtimeLogLevel("root_directive_materialization_failed"), "error");
  assert.equal(runtimeLogLevel("root_next_action_materialized"), "info");
});

test("Provider I/O capture is disabled by default and uses an explicit absolute directory", () => {
  assert.equal(providerIoCaptureDirectory(undefined), undefined);
  assert.equal(providerIoCaptureDirectory("/tmp/symphony-provider-io"), "/tmp/symphony-provider-io");
  assert.throws(() => providerIoCaptureDirectory("relative/provider-io"), /provider_io_capture_directory_invalid/u);
  assert.equal(
    providerIoCapturePath("/tmp/symphony-provider-io", "abc123def456", "profile-1", 42),
    "/tmp/symphony-provider-io/provider-io-abc123def456-profile-1-42.jsonl",
  );
});
