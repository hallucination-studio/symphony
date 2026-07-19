import { decodeContract, type JsonValue } from "@symphony/contracts";

const requestDefinitions: Readonly<Record<string, string>> = {
  "linear.read": "LinearReadCommand",
  "linear.issue.create_child": "CreateChildCommand",
  "linear.issue.update": "UpdateIssueCommand",
  "linear.status.set": "SetStatusCommand",
  "linear.assignee.set": "SetAssigneeCommand",
  "linear.label.set": "SetLabelCommand",
  "linear.comment.create": "CreateCommentCommand",
  "git.status": "GitStatusCommand",
  "git.diff": "GitDiffCommand",
  "git.checks": "GitChecksCommand",
  "git.commit": "GitCommitCommand",
  "root.deliver": "RootDeliverCommand",
};

type CommandDefinition = Readonly<{
  name: string;
  cli: string;
  description: string;
  mutation: boolean;
  handler: string;
  argsReference: string;
  exampleArgs: Readonly<Record<string, JsonValue>>;
}>;

const definitions = [
  define("linear.read", "linear read", "Read bounded facts from the current Root Tree.", false, "linearRead", "LinearReadArgs", { issue_id: "root-1", include: ["issue", "children"], limit: 50 }),
  define("linear.issue.create_child", "linear issue create-child", "Create a Work, Human, or Rework child.", true, "createChild", "CreateChildArgs", { parent_issue_id: "root-1", kind: "work", title: "Implement change", description: "Complete the scoped work.", write_id: "write-1", expected_remote_version: "version-1", expected_git_head: "abc123" }),
  define("linear.issue.update", "linear issue update", "Update declared fields on an Issue in the Root Tree.", true, "updateIssue", "UpdateIssueArgs", { issue_id: "child-1", title: "Updated title", expected_remote_version: "version-1", expected_git_head: "abc123" }),
  define("linear.status.set", "linear status set", "Set an Issue native status.", true, "setStatus", "SetStatusArgs", { issue_id: "child-1", status: "In Progress", expected_remote_version: "version-1", expected_git_head: "abc123" }),
  define("linear.assignee.set", "linear assignee set", "Set an Issue assignee.", true, "setAssignee", "SetAssigneeArgs", { issue_id: "child-1", assignee_id: "user-1", expected_remote_version: "version-1", expected_git_head: "abc123" }),
  define("linear.label.set", "linear label set", "Add or remove one Issue label.", true, "setLabel", "SetLabelArgs", { issue_id: "child-1", label: "Activity: Work", operation: "add", expected_remote_version: "version-1", expected_git_head: "abc123" }),
  define("linear.comment.create", "linear comment create", "Create an Issue comment with a stable write ID.", true, "createComment", "CreateCommentArgs", { issue_id: "root-1", body: "Progress is visible here.", write_id: "write-1", expected_remote_version: "version-1", expected_git_head: "abc123" }),
  define("git.status", "git status", "Read bounded status for the current Root worktree.", false, "gitStatus", "EmptyArgs", {}),
  define("git.diff", "git diff", "Read a bounded diff from the current Root worktree.", false, "gitDiff", "GitDiffArgs", { staged: false }),
  define("git.checks", "git checks", "Run declared checks in the current Root worktree.", false, "gitChecks", "GitChecksArgs", { check_names: ["test"] }),
  define("git.commit", "git commit", "Create an identity-checked commit at the expected HEAD.", true, "gitCommit", "GitCommitArgs", { issue_id: "root-1", message: "feat: implement scoped change", expected_head: "abc123" }),
  define("root.deliver", "root deliver", "Request preconditioned delivery for the current Root.", true, "rootDeliver", "RootDeliverArgs", { expected_head: "abc123", expected_root_version: "version-1" }),
] as const satisfies readonly CommandDefinition[];

function define(
  name: string,
  cli: string,
  description: string,
  mutation: boolean,
  handler: string,
  argsDefinition: string,
  exampleArgs: Readonly<Record<string, JsonValue>>,
): CommandDefinition {
  return {
    name,
    cli,
    description,
    mutation,
    handler,
    argsReference: `agent-command.schema.json#/$defs/${argsDefinition}`,
    exampleArgs,
  };
}

const byName = new Map(definitions.map((definition) => [definition.name, definition]));

export interface AgentCommand extends Record<string, JsonValue> {
  protocol_version: string;
  request_id: string;
  turn_id: string;
  root_issue_id: string;
  performer_id: string;
  command: string;
  args: Record<string, JsonValue>;
}

export function agentCommandCatalog(): ReadonlyArray<{
  name: string;
  cli: string;
  description: string;
  mutation: boolean;
  args_reference: string;
}> {
  return definitions.map(({ name, cli, description, mutation, argsReference }) => ({
    name,
    cli: `symphony ${cli}`,
    description,
    mutation,
    args_reference: argsReference,
  }));
}

export function agentCommandHelp(): string {
  return definitions
    .map(({ cli, description }) => `symphony ${cli}\n  ${description}`)
    .join("\n\n");
}

export function agentCommandExamples(): readonly AgentCommand[] {
  return definitions.map(({ name, exampleArgs }) => ({
    protocol_version: "1",
    request_id: `example-${name.replaceAll(".", "-").replaceAll("_", "-")}`,
    turn_id: "turn-1",
    root_issue_id: "root-1",
    performer_id: "conversation-1",
    command: name,
    args: { ...exampleArgs },
  }));
}

export function parseAgentCommand(value: unknown): AgentCommand {
  if (!isJsonObject(value)) throw new Error("Agent command must be an object");
  const commandName = value.command;
  if (typeof commandName !== "string" || !byName.has(commandName)) {
    throw new Error(`unknown Agent command: ${String(commandName)}`);
  }
  const definitionName = requestDefinitions[commandName];
  if (!definitionName) throw new Error(`unknown Agent command: ${commandName}`);
  return decodeContract(
    `agent-command.schema.json#/$defs/${definitionName}`,
    value,
  ) as AgentCommand;
}

export function dispatchAgentCommand(command: AgentCommand): {
  name: string;
  mutation: boolean;
  handler: string;
} {
  const definition = byName.get(command.command);
  if (!definition) throw new Error(`unknown Agent command: ${command.command}`);
  return {
    name: definition.name,
    mutation: definition.mutation,
    handler: definition.handler,
  };
}

function isJsonObject(value: unknown): value is Record<string, JsonValue> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  return Object.values(value).every(isJsonValue);
}

function isJsonValue(value: unknown): value is JsonValue {
  if (value === null || ["boolean", "number", "string"].includes(typeof value)) return true;
  if (Array.isArray(value)) return value.every(isJsonValue);
  return isJsonObject(value);
}
