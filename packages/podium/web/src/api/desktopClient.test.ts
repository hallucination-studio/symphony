import { expect, it, vi } from "vitest";
import { createDesktopClient } from "./desktopClient";

it("invokes the exact bounded lifecycle command without fetch", async () => {
  const output = {
    status: "ready",
    installation_status: "not_installed",
    error_code: null,
    sanitized_reason: null,
    action_required: false,
    retryable: false,
    next_action: "none",
  };
  const invokeCommand = vi.fn().mockResolvedValue({
    kind: "command.result",
    request_id: "desktop-command-1",
    protocol_version: 1,
    command: "lifecycle.snapshot",
    ok: true,
    output,
  });
  const desktopClient = createDesktopClient(invokeCommand);
  const fetchSpy = vi.spyOn(globalThis, "fetch");

  await expect(desktopClient.lifecycleSnapshot()).resolves.toEqual(output);
  expect(invokeCommand).toHaveBeenCalledWith("podium_command", {
    request: { command: "lifecycle.snapshot", input: {} },
  });
  expect(fetchSpy).not.toHaveBeenCalled();
  fetchSpy.mockRestore();
});

it("rejects undeclared output fields and sanitized command errors", async () => {
  const invokeCommand = vi.fn().mockResolvedValueOnce({
    kind: "command.result",
    request_id: "desktop-command-1",
    protocol_version: 1,
    command: "lifecycle.snapshot",
    ok: true,
    output: {
      status: "ready",
      installation_status: "not_installed",
      error_code: null,
      sanitized_reason: null,
      action_required: false,
      retryable: false,
      next_action: "none",
      access_token: "must-not-pass",
    },
  });
  const desktopClient = createDesktopClient(invokeCommand);
  await expect(desktopClient.lifecycleSnapshot()).rejects.toMatchObject({
    code: "desktop_command_response_invalid",
  });

  invokeCommand.mockResolvedValueOnce({
    kind: "command.result",
    request_id: "desktop-command-2",
    protocol_version: 1,
    command: "lifecycle.snapshot",
    ok: false,
    error: {
      code: "desktop_lifecycle_unavailable",
      sanitized_reason: "lifecycle_unavailable",
      action_required: true,
      retryable: false,
      next_action: "restart_desktop",
    },
  });
  await expect(desktopClient.lifecycleSnapshot()).rejects.toMatchObject({
    name: "DesktopCommandError",
    sanitizedReason: "lifecycle_unavailable",
    message: "lifecycle_unavailable",
  });
});

it("sanitizes invoke transport failures", async () => {
  const desktopClient = createDesktopClient(async () => {
    throw new Error("raw sidecar path and token");
  });

  await expect(desktopClient.lifecycleSnapshot()).rejects.toMatchObject({
    code: "desktop_command_transport_failed",
    nextAction: "restart_desktop",
  });
});
