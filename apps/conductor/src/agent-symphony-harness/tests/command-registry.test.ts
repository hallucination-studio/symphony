import assert from "node:assert/strict";
import test from "node:test";

import {
  agentCommandCatalog,
  agentCommandExamples,
  agentCommandHelp,
  dispatchAgentCommand,
  parseAgentCommand,
} from "../internal/AgentCommandRegistry.js";

const correlation = {
  protocol_version: "1",
  request_id: "request-1",
  turn_id: "turn-1",
  root_issue_id: "root-1",
  performer_id: "conversation-1",
};

test("command registry derives help, catalog, examples, and dispatch metadata", () => {
  const catalog = agentCommandCatalog();
  assert.deepEqual(
    catalog.map(({ name }) => name),
    [
      "linear.read",
      "linear.issue.create_child",
      "linear.issue.update",
      "linear.status.set",
      "linear.assignee.set",
      "linear.label.set",
      "linear.comment.create",
      "git.status",
      "git.diff",
      "git.checks",
      "git.commit",
      "root.deliver",
    ],
  );
  assert.ok(catalog.every(({ mutation, args_reference }) =>
    typeof mutation === "boolean" && args_reference.startsWith("agent-command.schema.json#/$defs/"),
  ));
  assert.match(agentCommandHelp(), /symphony linear issue create-child/);
  assert.match(agentCommandHelp(), /symphony root deliver/);
  assert.equal(agentCommandExamples().length, catalog.length);
  assert.ok(agentCommandExamples().every((example) => parseAgentCommand(example)));

  const command = parseAgentCommand({
    ...correlation,
    command: "git.status",
    args: {},
  });
  assert.deepEqual(dispatchAgentCommand(command), {
    name: "git.status",
    mutation: false,
    handler: "gitStatus",
  });
});

test("command registry validates bounded correlated command envelopes", () => {
  assert.deepEqual(
    parseAgentCommand({
      ...correlation,
      command: "linear.comment.create",
      args: {
        issue_id: "child-1",
        body: "A bounded comment",
        write_id: "write-1",
        expected_remote_version: "version-1",
        expected_git_head: "abc123",
      },
    }),
    {
      ...correlation,
      command: "linear.comment.create",
      args: {
        issue_id: "child-1",
        body: "A bounded comment",
        write_id: "write-1",
        expected_remote_version: "version-1",
        expected_git_head: "abc123",
      },
    },
  );

  assert.throws(
    () => parseAgentCommand({ ...correlation, command: "git.push", args: {} }),
    /unknown Agent command/,
  );
  assert.throws(
    () => parseAgentCommand({ ...correlation, command: "git.status", args: { force: true } }),
    /unknown field/,
  );
  assert.throws(
    () => parseAgentCommand({ ...correlation, command: "git.status", args: {}, token: "secret" }),
    /unknown field/,
  );
});
