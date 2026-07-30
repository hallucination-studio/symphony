import { spawn } from "node:child_process";

import { parseRevision, type Revision } from "../../contracts/identity.js";
import type { PullRequestSnapshot } from "../../contracts/observation.js";
import { asRecord, assertExactKeys, parseBoundedString, parseEnum } from "../../contracts/validation.js";
import type { DeliveryIdentity } from "../api/DeliveryInterface.js";
import type { ScmBoundary } from "./GitScmDelivery.js";

const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u;
const MAX_OUTPUT_BYTES = 1024 * 1024;
const COMMAND_TIMEOUT_MS = 30_000;

export interface GitHubCommand {
  run(args: readonly string[]): Promise<string>;
}

export class GhCommand implements GitHubCommand {
  constructor(private readonly cwd: string) {}

  run(args: readonly string[]): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      const child = spawn("gh", args, {
        cwd: this.cwd,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          HOME: process.env.HOME,
          PATH: process.env.PATH,
          LANG: "C.UTF-8",
          LC_ALL: "C",
          GH_PAGER: "cat",
        },
      });
      const chunks: Buffer[] = [];
      let bytes = 0;
      let settled = false;
      const fail = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        child.kill("SIGKILL");
        reject(new Error("github_command_failed"));
      };
      const timer = setTimeout(fail, COMMAND_TIMEOUT_MS);
      child.stdout.on("data", (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > MAX_OUTPUT_BYTES) fail();
        else chunks.push(chunk);
      });
      child.stderr.on("data", (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > MAX_OUTPUT_BYTES) fail();
      });
      child.once("error", fail);
      child.once("close", (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (code !== 0) reject(new Error("github_command_failed"));
        else resolve(Buffer.concat(chunks).toString("utf8").trim());
      });
    });
  }
}

export async function discoverGitHubRepository(command: GitHubCommand): Promise<string> {
  const repository = (await command.run(["repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"])).trim();
  if (!REPOSITORY_PATTERN.test(repository)) throw new Error("github_repository_identity_invalid");
  return repository;
}

function state(value: unknown): PullRequestSnapshot["state"] {
  const parsed = parseEnum(value, ["OPEN", "CLOSED", "MERGED"] as const);
  if (parsed === "OPEN") return "open";
  if (parsed === "MERGED") return "merged";
  return "closed";
}

export class GitHubScm implements ScmBoundary {
  readonly #repository: string;

  constructor(repository: string, private readonly command: GitHubCommand) {
    if (!REPOSITORY_PATTERN.test(repository)) throw new Error("github_repository_identity_invalid");
    this.#repository = repository;
  }

  async read(identity: DeliveryIdentity): Promise<readonly PullRequestSnapshot[]> {
    this.#assertIdentity(identity);
    let raw: unknown;
    try {
      raw = JSON.parse(await this.command.run([
        "pr", "list", "--repo", this.#repository,
        "--base", identity.base_branch,
        "--head", identity.head_branch,
        "--state", "all",
        "--json", "url,state,baseRefName,headRefName,headRefOid",
      ]));
    } catch {
      throw new Error("github_pr_readback_unavailable");
    }
    if (!Array.isArray(raw) || raw.length > 1) throw new Error("github_pr_readback_invalid");
    try {
      return Object.freeze(raw.map((value): PullRequestSnapshot => {
        const record = asRecord(value);
        assertExactKeys(record, ["url", "state", "baseRefName", "headRefName", "headRefOid"]);
        const url = parseBoundedString(record.url, "invalid_pr_url", 2048);
        if (!URL.canParse(url) || new URL(url).protocol !== "https:") throw new Error("invalid_pr_url");
        const baseBranch = parseBoundedString(record.baseRefName, "invalid_base_branch", 255);
        const headBranch = parseBoundedString(record.headRefName, "invalid_head_branch", 255);
        if (baseBranch !== identity.base_branch || headBranch !== identity.head_branch) {
          throw new Error("github_delivery_identity_mismatch");
        }
        return Object.freeze({
          provider: "github",
          repository_id: identity.repository_id,
          base_branch: baseBranch,
          head_branch: headBranch,
          state: state(record.state),
          head_revision: parseRevision(record.headRefOid),
          url,
        });
      }));
    } catch {
      throw new Error("github_pr_readback_invalid");
    }
  }

  async create(identity: DeliveryIdentity, revision: Revision): Promise<"accepted" | "unknown"> {
    this.#assertIdentity(identity);
    parseRevision(revision);
    try {
      await this.command.run([
        "pr", "create", "--repo", this.#repository,
        "--base", identity.base_branch,
        "--head", identity.head_branch,
        "--title", `Symphony delivery for ${identity.root_id}`,
        "--body", `Verified revision: ${revision}`,
      ]);
      return "accepted";
    } catch {
      return "unknown";
    }
  }

  #assertIdentity(identity: DeliveryIdentity): void {
    if (identity.provider !== "github") throw new Error("github_delivery_identity_mismatch");
  }
}
