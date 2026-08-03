import {
  parseObservationDigest,
  parseRepositoryId,
  parseRevision,
} from "../contracts/identity.js";
import { parseGitSnapshot } from "../contracts/observation.js";
import {
  asRecord,
  assertExactKeys,
  parseBoundedString,
  parseMarkdownText,
} from "../contracts/validation.js";
import type {
  GitWorkspaceInterface,
  RootWorkspaceIdentity,
} from "../git/api/GitWorkspaceInterface.js";
import type { RootToolExecution } from "./RootToolBoundary.js";
import type { DeclaredRootTool } from "./RootTools.js";

export const ROOT_GIT_READ_TOOL_CAPABILITIES = Object.freeze({
  get_workspace: "git:get_workspace",
  get_status: "git:get_status",
  get_diff: "git:get_diff",
} as const);

type RootGitReadToolName = keyof typeof ROOT_GIT_READ_TOOL_CAPABILITIES;

export interface RootGitDiffReader {
  read(): Promise<unknown>;
}

interface CreateRootGitReadToolsOptions {
  readonly git: Pick<GitWorkspaceInterface, "read">;
  readonly workspace: RootWorkspaceIdentity;
  readonly diff_reader: RootGitDiffReader;
}

const ROOT_GIT_READ_TOOLS = new WeakSet<object>();

function rootGitReadTool(
  name: RootGitReadToolName,
  options: CreateRootGitReadToolsOptions,
): DeclaredRootTool<null, unknown> {
  const capability = ROOT_GIT_READ_TOOL_CAPABILITIES[name];
  const declaration: DeclaredRootTool<null, unknown> = Object.freeze({
    family: "git",
    capability,
    spec: Object.freeze({
      type: "function",
      name,
      description: `Read the exact Root Git ${name.slice(4)} facts.`,
      inputSchema: Object.freeze({
        type: "object",
        additionalProperties: false,
        properties: Object.freeze({ function: Object.freeze({ const: name }) }),
        required: Object.freeze(["function"]),
      }),
    }),
    parseCall(value: unknown): null {
      const record = asRecord(value);
      assertExactKeys(record, [
        "schema_version", "root_id", "runtime_generation", "correlation_id", "capability", "function",
      ]);
      if (record.function !== name) throw new Error("invalid_git_tool_call");
      return null;
    },
    execute(_call: null, execution: RootToolExecution): Promise<unknown> {
      execution.assertActive();
      return name === "get_diff"
        ? options.diff_reader.read()
        : options.git.read(options.workspace);
    },
    parseResult(value: unknown): unknown {
      if (name === "get_diff") {
        const record = asRecord(value);
        assertExactKeys(record, [
          "repository_id", "base_branch", "head_branch", "head_revision", "diff_digest", "diff_markdown",
        ]);
        return Object.freeze({
          repository_id: parseRepositoryId(record.repository_id),
          base_branch: parseBoundedString(record.base_branch, "invalid_base_branch", 255),
          head_branch: parseBoundedString(record.head_branch, "invalid_head_branch", 255),
          head_revision: parseRevision(record.head_revision),
          diff_digest: parseObservationDigest(record.diff_digest),
          diff_markdown: parseMarkdownText(record.diff_markdown, "invalid_git_diff_markdown"),
        });
      }
      const snapshot = parseGitSnapshot(value);
      if (name === "get_workspace") {
        return Object.freeze({
          repository_id: snapshot.repository_id,
          base_branch: snapshot.base_branch,
          head_branch: snapshot.head_branch,
        });
      }
      return Object.freeze({
        head_revision: snapshot.head_revision,
        workspace_state: snapshot.workspace_state,
      });
    },
  });
  ROOT_GIT_READ_TOOLS.add(declaration);
  return declaration;
}

export function createRootGitReadTools(
  options: CreateRootGitReadToolsOptions,
): readonly DeclaredRootTool<null, unknown>[] {
  return Object.freeze((Object.keys(ROOT_GIT_READ_TOOL_CAPABILITIES) as RootGitReadToolName[])
    .map((name) => rootGitReadTool(name, options)));
}

export function isRootGitReadTool(value: unknown): value is DeclaredRootTool<null, unknown> {
  return typeof value === "object"
    && value !== null
    && Object.isFrozen(value)
    && ROOT_GIT_READ_TOOLS.has(value);
}
