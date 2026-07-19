import { fireEvent, render, screen, within } from "@testing-library/react";
import type { ComponentProps } from "react";
import { expect, test, vi } from "vitest";

import { App as DesktopApp } from "./App";
import {
  connectedOverview,
  conductorDetail,
  rootDetail,
} from "./test/fixtures";

type AppProps = ComponentProps<typeof DesktopApp>;

function App({
  initialState,
  onCommand = async () => ({ kind: "accepted" }),
  onSecret = async () => ({ kind: "accepted" }),
  onChooseRepository = async () => undefined,
  onBeginCreateConductor = () => undefined,
  onOpenExternal = () => undefined,
  onSelectRoot = async () => undefined,
  onSelectConductor = async () => undefined,
}: Pick<AppProps, "initialState"> & Partial<Omit<AppProps, "initialState">>) {
  return (
    <DesktopApp
      initialState={initialState}
      onCommand={onCommand}
      onSecret={onSecret}
      onChooseRepository={onChooseRepository}
      onBeginCreateConductor={onBeginCreateConductor}
      onOpenExternal={onOpenExternal}
      onSelectRoot={onSelectRoot}
      onSelectConductor={onSelectConductor}
    />
  );
}

test("shows conditional Linear setup without persistent navigation", () => {
  render(<App initialState={{ kind: "linear-setup" }} />);

  expect(
    screen.getByRole("heading", { name: "Connect Symphony to Linear" }),
  ).toBeInTheDocument();
  expect(screen.queryByRole("navigation")).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Connect Linear" })).toBeEnabled();
});

test("renders exactly the four approved persistent entries", () => {
  render(<App initialState={{ kind: "ready", overview: connectedOverview }} />);

  const navigation = screen.getByRole("navigation", { name: "Primary" });
  expect(within(navigation).getAllByRole("button")).toHaveLength(4);
  expect(
    within(navigation).getAllByRole("button").map((button) => button.textContent),
  ).toEqual(["Overview", "Work", "Conductors", "Settings"]);
});

test("creates a Conductor only after Project and native repository selection", async () => {
  const sendCommand = vi.fn().mockResolvedValue({ kind: "confirmed" });
  render(
    <App
      initialState={{
        kind: "conductor-setup",
        projects: [{ id: "project-1", name: "Symphony" }],
      }}
      onCommand={sendCommand}
      onChooseRepository={vi.fn().mockResolvedValue({
        repositoryHandle: "repo-handle",
        displayName: "acme/symphony",
        baseBranch: "main",
        baseBranches: ["main"],
      })}
    />,
  );

  fireEvent.click(screen.getByRole("button", { name: "Choose Git repository" }));
  expect(await screen.findByText("acme/symphony · main")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Create Conductor" }));
  expect(sendCommand).toHaveBeenCalledWith({
    kind: "create_conductor",
    projectId: "project-1",
    repository: {
      repositoryHandle: "repo-handle",
      displayName: "acme/symphony",
      baseBranch: "main",
      baseBranches: ["main"],
    },
  });
});

test("prevents duplicate Conductor creation while confirmation is pending", async () => {
  let confirmCreation!: (value: { kind: "confirmed" }) => void;
  const sendCommand = vi.fn().mockReturnValue(
    new Promise((resolve) => {
      confirmCreation = resolve;
    }),
  );
  render(
    <App
      initialState={{
        kind: "conductor-setup",
        projects: [{ id: "project-1", name: "Symphony" }],
      }}
      onCommand={sendCommand}
      onChooseRepository={vi.fn().mockResolvedValue({
        repositoryHandle: "repo-handle",
        displayName: "acme/symphony",
        baseBranch: "main",
        baseBranches: ["main"],
      })}
    />,
  );

  fireEvent.click(screen.getByRole("button", { name: "Choose Git repository" }));
  await screen.findByText("acme/symphony · main");
  const createButton = screen.getByRole("button", { name: "Create Conductor" });
  fireEvent.click(createButton);

  expect(screen.getByRole("button", { name: "Creating…" })).toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: "Creating…" }));
  expect(sendCommand).toHaveBeenCalledTimes(1);
  confirmCreation({ kind: "confirmed" });
});

test("keeps Conductor setup retryable when repository validation fails", async () => {
  render(
    <App
      initialState={{
        kind: "conductor-setup",
        projects: [{ id: "project-1", name: "Symphony" }],
      }}
      onChooseRepository={vi.fn().mockRejectedValue(new Error("raw path failure"))}
    />,
  );

  fireEvent.click(screen.getByRole("button", { name: "Choose Git repository" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Repository selection or validation failed",
  );
  expect(document.body).not.toHaveTextContent("raw path failure");
  expect(screen.getByRole("button", { name: "Create Conductor" })).toBeDisabled();
});

test("prioritizes the next action and marks stale usage", () => {
  render(<App initialState={{ kind: "ready", overview: connectedOverview }} />);

  expect(screen.getByText("Approve the current plan")).toBeInTheDocument();
  expect(screen.getByText("Last confirmed 16 Jul 09:40")).toBeInTheDocument();
  expect(screen.getByText("12,480")).toBeInTheDocument();
});

test("keeps workflow read only and delegates human actions to Linear", () => {
  const openExternal = vi.fn();
  render(
    <App
      initialState={{
        kind: "ready",
        overview: connectedOverview,
        rootDetail,
      }}
      onOpenExternal={openExternal}
    />,
  );

  fireEvent.click(screen.getByRole("button", { name: "Work" }));
  fireEvent.click(screen.getByRole("button", { name: /SYM-42/ }));

  expect(screen.getByRole("tree", { name: "Workflow tree" })).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: /approve/i })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Open in Linear" }));
  expect(openExternal).toHaveBeenCalledWith("https://linear.app/acme/issue/SYM-42");
});

test("acknowledges only the displayed Root retry observation", () => {
  const sendCommand = vi.fn().mockResolvedValue({ kind: "confirmed" });
  render(<App initialState={{
    kind: "ready", overview: connectedOverview,
    rootDetail: { ...rootDetail, retryObservedAt: "2026-07-19T00:00:03Z" },
  }} onCommand={sendCommand} />);

  fireEvent.click(screen.getByRole("button", { name: "Work" }));
  fireEvent.click(screen.getByRole("button", { name: /SYM-42/ }));
  fireEvent.click(screen.getByRole("button", { name: "Retry conversation" }));

  expect(sendCommand).toHaveBeenCalledWith({
    kind: "acknowledge_root_retry_block",
    rootIssueId: rootDetail.summary.rootIssueId,
    retryObservedAt: "2026-07-19T00:00:03Z",
  });
});

test("never redisplays an API key and waits for confirmed profile activation", () => {
  const sendSecret = vi.fn().mockResolvedValue({ kind: "accepted" });
  render(
    <App
      initialState={{
        kind: "ready",
        overview: connectedOverview,
        conductorDetail,
      }}
      onSecret={sendSecret}
    />,
  );

  fireEvent.click(screen.getByRole("button", { name: "Conductors" }));
  fireEvent.click(screen.getByRole("button", { name: /Studio conductor/ }));
  fireEvent.click(screen.getByRole("button", { name: "Set API Key" }));
  const dialog = screen.getByRole("dialog", { name: "Set Codex API Key" });
  fireEvent.change(screen.getByLabelText("API Key"), {
    target: { value: "not-a-real-api-key" },
  });
  fireEvent.click(within(dialog).getByRole("button", { name: "Set API Key" }));

  expect(screen.queryByDisplayValue("not-a-real-api-key")).not.toBeInTheDocument();
  expect(screen.getByText("Waiting for Conductor confirmation")).toBeInTheDocument();
  expect(sendSecret).toHaveBeenCalledWith(
    "conductor-1",
    "profile-2",
    "not-a-real-api-key",
  );
});

test("submits the selected reasoning and Fast settings for a ChatGPT profile", () => {
  const sendCommand = vi.fn().mockResolvedValue({ kind: "accepted" });
  render(
    <App
      initialState={{
        kind: "ready",
        overview: connectedOverview,
        conductorDetail,
      }}
      onCommand={sendCommand}
    />,
  );

  fireEvent.click(screen.getByRole("button", { name: "Conductors" }));
  fireEvent.click(screen.getByRole("button", { name: /Studio conductor/ }));
  fireEvent.click(screen.getByRole("button", { name: "Configure profile" }));
  fireEvent.change(screen.getByLabelText("Reasoning effort"), {
    target: { value: "medium" },
  });
  fireEvent.click(screen.getByLabelText("Fast mode"));
  fireEvent.click(screen.getByRole("button", { name: "Save profile" }));

  expect(sendCommand).toHaveBeenCalledWith(
    expect.objectContaining({
      kind: "create_performer_profile",
      authenticationMethod: "chatgpt",
      codexTurnSettings: {
        model: "gpt-5",
        reasoningEffort: "medium",
        isFastModeEnabled: false,
      },
      executionPolicy: {
        sandboxMode: "workspace_write",
        commandAllowlist: [],
        commandDenylist: [],
      },
    }),
  );
});

test("round-trips structured execution policy when editing a Profile", () => {
  const sendCommand = vi.fn().mockResolvedValue({ kind: "accepted" });
  render(
    <App
      initialState={{
        kind: "ready",
        overview: connectedOverview,
        conductorDetail,
      }}
      onCommand={sendCommand}
    />,
  );

  fireEvent.click(screen.getByRole("button", { name: "Conductors" }));
  fireEvent.click(screen.getByRole("button", { name: /Studio conductor/ }));
  fireEvent.click(screen.getAllByRole("button", { name: "Edit settings" })[0]!);
  fireEvent.change(screen.getByLabelText("Sandbox mode"), {
    target: { value: "read_only" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Add deny rule" }));
  fireEvent.change(screen.getByLabelText("Denied commands executable 1"), {
    target: { value: "git" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Add argument" }));
  fireEvent.change(screen.getByLabelText("Denied commands rule 1 argument 1"), {
    target: { value: "push" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Save profile" }));

  expect(sendCommand).toHaveBeenCalledWith(expect.objectContaining({
    kind: "update_performer_profile",
    profileId: "profile-1",
    executionPolicy: {
      sandboxMode: "read_only",
      commandAllowlist: [],
      commandDenylist: [{ executable: "git", argvPrefix: ["push"] }],
    },
  }));
});

test("shows a retryable sanitized error when a profile command is rejected", async () => {
  render(
    <App
      initialState={{
        kind: "ready",
        overview: connectedOverview,
        conductorDetail,
      }}
      onCommand={vi.fn().mockRejectedValue(new Error("raw provider failure"))}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Conductors" }));
  fireEvent.click(screen.getByRole("button", { name: /Studio conductor/ }));
  fireEvent.click(screen.getByRole("button", { name: "Configure profile" }));
  fireEvent.click(screen.getByRole("button", { name: "Save profile" }));

  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Profile was not created",
  );
  expect(document.body).not.toHaveTextContent("raw provider failure");
});

test("moves focus into dialogs and closes them with Escape", () => {
  render(
    <App
      initialState={{
        kind: "ready",
        overview: connectedOverview,
        conductorDetail,
      }}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Conductors" }));
  fireEvent.click(screen.getByRole("button", { name: /Studio conductor/ }));
  const trigger = screen.getByRole("button", { name: "Configure profile" });
  trigger.focus();
  fireEvent.click(trigger);

  expect(screen.getByLabelText("Display name")).toHaveFocus();
  fireEvent.keyDown(document, { key: "Escape" });
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  expect(trigger).toHaveFocus();
});

test("moves focus to the selected page heading", () => {
  render(<App initialState={{ kind: "ready", overview: connectedOverview }} />);

  fireEvent.click(screen.getByRole("button", { name: "Settings" }));
  expect(screen.getByRole("heading", { name: "Settings" })).toHaveFocus();
});

test("shows a sanitized unavailable state", () => {
  render(
    <App
      initialState={{
        kind: "unavailable",
        summary: "Podium could not provide a current Desktop view.",
        nextAction: "Try again after the local runtime is available.",
      }}
    />,
  );

  expect(screen.getByRole("alert")).toHaveTextContent(
    "Podium could not provide a current Desktop view.",
  );
  expect(document.body.textContent).not.toMatch(/token|auth\.json|performer_id/i);
});
