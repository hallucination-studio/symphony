import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import {
  archiveGoldenFailure,
  archiveIssueTree,
  cloneGoldenWorkspace,
  createLinearRoot,
  fetchGoldenCriticResult,
  githubRepositoryFromOrigin,
  MAX_GOLDEN_ISSUE_TREE_DEPTH,
  MAX_DIAGNOSTIC_STREAM_BYTES,
  validateGoldenResultComments,
  validateGoldenVisibleTree,
} from "./golden-fixture.mjs";
import {
  goldenConductorFailureReason,
  preserveGoldenFailureContext,
  requireGoldenPullRequest,
  partitionGoldenEnvironment,
  resolveGoldenRoleConfiguration,
  resolveGoldenLaunchArguments,
  runGoldenScenario,
} from "./golden-runner.mjs";
import { formatLocalTimestamp } from "./linear-driver.mjs";

const execute = promisify(execFile);

test("golden completion requires a pull request and rejects temporary file delivery", () => {
  assert.equal(requireGoldenPullRequest({
    event: "conductor_stopped",
    status: "done",
    delivery: { kind: "pull_request", url: "https://github.com/acme/repo/pull/7", branch: "root/ENG-7" },
  }), "https://github.com/acme/repo/pull/7");
  assert.throws(() => requireGoldenPullRequest({
    event: "conductor_stopped",
    status: "done",
    delivery: { kind: "files", workspace_path: "/tmp/removed-golden-workspace", files: ["result.txt"] },
  }), /golden_delivery_not_pull_request/u);
  assert.throws(() => requireGoldenPullRequest({
    event: "conductor_stopped",
    status: "done",
    delivery: { kind: "branch", branch: "root/ENG-7", remote: "origin" },
  }), /golden_delivery_not_pull_request/u);
});

test("golden resolves only a credential-free GitHub origin", () => {
  assert.equal(
    githubRepositoryFromOrigin("https://github.com/hallucination-studio/symphony.git"),
    "hallucination-studio/symphony",
  );
  assert.throws(() => githubRepositoryFromOrigin("https://token@github.com/org/repo.git"), /golden_origin_invalid/u);
  assert.throws(() => githubRepositoryFromOrigin("https://example.test/org/repo.git"), /golden_origin_invalid/u);
  assert.throws(() => githubRepositoryFromOrigin("https://github.com/org/extra/repo.git"), /golden_origin_invalid/u);
});

test("golden workspace starts from the tested local HEAD and restores the GitHub origin", async (context) => {
  const base = await mkdtemp(path.join(os.tmpdir(), "symphony-golden-clone-test-"));
  context.after(() => rm(base, { recursive: true, force: true }));
  const source = path.join(base, "source");
  const workspace = path.join(base, "workspace");
  await mkdir(source);
  await execute("git", ["init", "--initial-branch=main"], { cwd: source });
  await execute("git", ["config", "user.name", "Golden Test"], { cwd: source });
  await execute("git", ["config", "user.email", "golden@example.invalid"], { cwd: source });
  await writeFile(path.join(source, "current.txt"), "current local baseline\n", "utf8");
  await execute("git", ["add", "current.txt"], { cwd: source });
  await execute("git", ["commit", "-m", "test baseline"], { cwd: source });
  await execute("git", ["remote", "add", "origin", "https://github.com/acme/symphony.git"], { cwd: source });
  const { stdout: sourceHead } = await execute("git", ["rev-parse", "HEAD"], { cwd: source });

  await cloneGoldenWorkspace({
    repositoryRoot: source,
    workspace,
    origin: "https://github.com/acme/symphony.git",
    branch: "symphony/golden-test",
  });

  const [{ stdout: workspaceHead }, { stdout: branch }, { stdout: origin }] = await Promise.all([
    execute("git", ["rev-parse", "HEAD"], { cwd: workspace }),
    execute("git", ["branch", "--show-current"], { cwd: workspace }),
    execute("git", ["remote", "get-url", "origin"], { cwd: workspace }),
  ]);
  assert.equal(workspaceHead.trim(), sourceHead.trim());
  assert.equal(branch.trim(), "symphony/golden-test");
  assert.equal(origin.trim(), "https://github.com/acme/symphony.git");
  assert.equal(await readFile(path.join(workspace, "current.txt"), "utf8"), "current local baseline\n");
});

test("golden keeps only a structured Conductor failure reason", () => {
  assert.equal(goldenConductorFailureReason({
    stderr: "provider secret\n{\"event\":\"conductor_failed\",\"reason_code\":\"workflow_state_missing\"}\n",
  }), "workflow_state_missing");
  assert.equal(goldenConductorFailureReason({
    stderr: "{\"event\":\"conductor_failed\",\"reason_code\":\"Current provider message: retry later\"}\n",
  }), "Current provider message: retry later");
  assert.equal(goldenConductorFailureReason({
    stderr: "{\"event\":\"conductor_failed\",\"reason_code\":\"line one\\nline two\"}\n",
  }), "golden_conductor_process_failed");
  assert.equal(goldenConductorFailureReason({ stderr: "provider secret" }), "golden_conductor_process_failed");
});

test("golden preserves a post-Conductor verification error in existing process context", () => {
  const verificationError = new Error("golden_result_comments_projection_invalid");
  const context = preserveGoldenFailureContext(Object.freeze({
    error: undefined,
    stdout: Buffer.from("conductor stopped"),
    stderr: Buffer.alloc(0),
  }), verificationError);

  assert.equal(context.error, verificationError);
  assert.equal(context.stdout.toString("utf8"), "conductor stopped");
  assert.equal(preserveGoldenFailureContext(context, new Error("later")), context);
});

test("golden leaves all roles on local Codex configuration when unset", () => {
  assert.deepEqual(resolveGoldenRoleConfiguration({}), {
    reconcile: {},
    artist: {},
    critic: {},
  });
});

test("golden resolves independent Reconcile, Artist, and Critic configuration", () => {
  assert.deepEqual(resolveGoldenRoleConfiguration({
    SYMPHONY_GOLDEN_RECONCILE_AGENT: "codex",
    SYMPHONY_GOLDEN_RECONCILE_MODEL: "reconcile-model",
    SYMPHONY_GOLDEN_RECONCILE_REASONING_EFFORT: "medium",
    SYMPHONY_GOLDEN_ARTIST_AGENT: "codex",
    SYMPHONY_GOLDEN_ARTIST_MODEL: "execute-model",
    SYMPHONY_GOLDEN_ARTIST_REASONING_EFFORT: "high",
    SYMPHONY_GOLDEN_CRITIC_AGENT: "codex",
    SYMPHONY_GOLDEN_CRITIC_MODEL: "audit-model",
    SYMPHONY_GOLDEN_CRITIC_REASONING_EFFORT: "xhigh",
  }), {
    reconcile: { agent: "codex", model: "reconcile-model", reasoning_effort: "medium" },
    artist: { agent: "codex", model: "execute-model", reasoning_effort: "high" },
    critic: { agent: "codex", model: "audit-model", reasoning_effort: "xhigh" },
  });
});

test("golden launch omits generic --agent and forwards role options independently", () => {
  const args = resolveGoldenLaunchArguments({
    environment: {
      SYMPHONY_GOLDEN_RECONCILE_AGENT: "codex",
      SYMPHONY_GOLDEN_RECONCILE_MODEL: "reconcile-model",
      SYMPHONY_GOLDEN_RECONCILE_REASONING_EFFORT: "medium",
      SYMPHONY_GOLDEN_ARTIST_AGENT: "codex",
      SYMPHONY_GOLDEN_ARTIST_MODEL: "execute-model",
      SYMPHONY_GOLDEN_CRITIC_REASONING_EFFORT: "xhigh",
      SYMPHONY_GOLDEN_CRITIC_AGENT: "codex",
      SYMPHONY_GOLDEN_MAX_CYCLES: "3",
    },
    root: "ENG-1",
    workspace: "/tmp/root-workspace",
    runDirectory: "/tmp/root-run",
  });
  assert.deepEqual(args, [
    "run",
    "--linear-root", "ENG-1",
    "--workspace", "/tmp/root-workspace",
    "--dir", "/tmp/root-run",
    "--max-cycles", "3",
    "--reconcile-agent", "codex",
    "--reconcile-model", "reconcile-model",
    "--reconcile-reasoning-effort", "medium",
    "--artist-agent", "codex",
    "--artist-model", "execute-model",
    "--critic-agent", "codex",
    "--critic-reasoning-effort", "xhigh",
  ]);
  assert.equal(args.includes("--agent"), false);
});

test("golden forwards only role credentials without fixture or generic secrets", () => {
  const environment = partitionGoldenEnvironment({
    SYMPHONY_RECONCILE_CODEX_API_KEY: "reconcile-secret-never-output",
    SYMPHONY_RECONCILE_CODEX_BASE_URL: "https://reconcile.example.test/v1",
    SYMPHONY_ARTIST_CODEX_API_KEY: "execute-secret-never-output",
    SYMPHONY_ARTIST_CODEX_BASE_URL: "https://execute.example.test/v1",
    SYMPHONY_CRITIC_CODEX_API_KEY: "audit-secret-never-output",
    SYMPHONY_CRITIC_CODEX_BASE_URL: "https://audit.example.test/v1",
    CODEX_API_KEY: "generic-secret-must-not-forward",
    CODEX_BASE_URL: "https://generic.example.test/v1",
    SYMPHONY_E2E_LINEAR_HUMAN_TOKEN: "fixture-secret-never-output",
    SYMPHONY_E2E_PROJECT_SLUG_ID: "fixture-project",
  }, { PATH: "/usr/bin", HOME: "/tmp/home" });
  assert.equal(environment.SYMPHONY_RECONCILE_CODEX_API_KEY, "reconcile-secret-never-output");
  assert.equal(environment.SYMPHONY_RECONCILE_CODEX_BASE_URL, "https://reconcile.example.test/v1");
  assert.equal(environment.SYMPHONY_ARTIST_CODEX_API_KEY, "execute-secret-never-output");
  assert.equal(environment.SYMPHONY_ARTIST_CODEX_BASE_URL, "https://execute.example.test/v1");
  assert.equal(environment.SYMPHONY_CRITIC_CODEX_API_KEY, "audit-secret-never-output");
  assert.equal(environment.SYMPHONY_CRITIC_CODEX_BASE_URL, "https://audit.example.test/v1");
  assert.equal(environment.CODEX_API_KEY, undefined);
  assert.equal(environment.CODEX_BASE_URL, undefined);
  assert.equal(environment.SYMPHONY_E2E_LINEAR_HUMAN_TOKEN, undefined);
  assert.equal(environment.SYMPHONY_E2E_PROJECT_SLUG_ID, undefined);
});

test("golden runner reports blocked when the external launch is not explicitly enabled", async () => {
  const result = await runGoldenScenario({
    environment: {},
    operation: async () => { throw new Error("golden_must_not_run"); },
  });
  assert.deepEqual(result, {
    status: "blocked",
    boundary: "golden",
    reason: "golden_not_enabled",
  });
});

test("golden runner reports blocked when product credentials are present but fixture credentials are absent", async () => {
  const result = await runGoldenScenario({
    environment: {
      SYMPHONY_RUN_GOLDEN: "1",
      LINEAR_API_KEY: "product-linear-token",
      SYMPHONY_ARTIST_CODEX_API_KEY: "product-execute-codex-token",
    },
    operation: async () => "must not run",
  });
  assert.deepEqual(result, {
    status: "blocked",
    boundary: "golden",
    reason: "golden_fixture_credential_missing",
  });
});

test("golden runner needs no preconfigured Root, workspace, or run directory", async () => {
  const result = await runGoldenScenario({
    environment: {
      SYMPHONY_RUN_GOLDEN: "1",
      LINEAR_API_KEY: "product-linear-token",
      SYMPHONY_E2E_LINEAR_HUMAN_TOKEN: "human-linear-token",
      SYMPHONY_E2E_PROJECT_SLUG_ID: "project-slug",
    },
    operation: async () => ({ status: "done", root: "created-by-fixture" }),
  });
  assert.deepEqual(result, {
    status: "passed",
    layer: "golden",
    result: { status: "done", root: "created-by-fixture" },
  });
});

test("golden creates the Root issue in the team's canonical Todo state", async () => {
  const originalFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (_url, options) => {
    const request = JSON.parse(options.body);
    requests.push(request);
    if (request.query.includes("GoldenProject")) {
      return {
        ok: true,
        async json() {
          return {
            data: {
              projects: {
                nodes: [{ id: "project-id", teams: { nodes: [{ id: "team-id" }], pageInfo: { hasNextPage: false } } }],
                pageInfo: { hasNextPage: false },
              },
            },
          };
        },
      };
    }
    if (request.query.includes("GoldenTodoState")) {
      return {
        ok: true,
        async json() {
          return {
            data: {
              workflowStates: {
                nodes: [{ id: "todo-state-id", name: "Todo", type: "unstarted", team: { id: "team-id" } }],
                pageInfo: { hasNextPage: false },
              },
            },
          };
        },
      };
    }
    assert.match(request.query, /GoldenRoot/u);
    return {
      ok: true,
      async json() {
        return { data: { issueCreate: { success: true, issue: { id: "root-id", identifier: "SYM-1", url: "https://linear.app/SYM-1" } } } };
      },
    };
  };
  try {
    const root = await createLinearRoot({
      SYMPHONY_E2E_LINEAR_HUMAN_TOKEN: "human-linear-token",
      SYMPHONY_E2E_PROJECT_SLUG_ID: "project-slug",
    }, "run-id");
    assert.equal(root.identifier, "SYM-1");
    const createRequest = requests.find(({ query }) => query.includes("GoldenRoot"));
    assert.equal(createRequest.variables.input.stateId, "todo-state-id");
    assert.equal(createRequest.variables.input.teamId, "team-id");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("golden rejects a team without one canonical Todo state before Root creation", async () => {
  const originalFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (_url, options) => {
    const request = JSON.parse(options.body);
    requests.push(request);
    if (request.query.includes("GoldenProject")) {
      return {
        ok: true,
        async json() {
          return {
            data: {
              projects: {
                nodes: [{ id: "project-id", teams: { nodes: [{ id: "team-id" }], pageInfo: { hasNextPage: false } } }],
                pageInfo: { hasNextPage: false },
              },
            },
          };
        },
      };
    }
    return {
      ok: true,
      async json() {
        return {
          data: {
            workflowStates: {
              nodes: [{ id: "draft-state-id", name: "Draft", type: "backlog", team: { id: "team-id" } }],
              pageInfo: { hasNextPage: false },
            },
          },
        };
      },
    };
  };
  try {
    await assert.rejects(
      createLinearRoot({
        SYMPHONY_E2E_LINEAR_HUMAN_TOKEN: "human-linear-token",
        SYMPHONY_E2E_PROJECT_SLUG_ID: "project-slug",
      }, "run-id"),
      /golden_team_todo_state_invalid/u,
    );
    assert.equal(requests.some(({ query }) => query.includes("GoldenRoot")), false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("golden visible tree requires Done Root, Cycle, Artist, and Critic issues", () => {
  const done = { name: "Done", type: "completed" };
  const issue = {
    state: done,
    children: {
      nodes: [{
        title: "[Cycle 001] Create the golden file", state: done,
        children: {
          nodes: [
            { title: "[Artist] Cycle 001", state: done, children: { nodes: [], pageInfo: { hasNextPage: false } } },
            { title: "[Critic] Cycle 001", state: done, children: { nodes: [], pageInfo: { hasNextPage: false } } },
          ],
          pageInfo: { hasNextPage: false },
        },
      }],
      pageInfo: { hasNextPage: false },
    },
  };
  assert.doesNotThrow(() => validateGoldenVisibleTree(issue));
  assert.throws(
    () => validateGoldenVisibleTree({
      ...issue,
      children: { ...issue.children, nodes: [{
        ...issue.children.nodes[0],
        title: "[Cycle 001] Create the golden file with an objective that is intentionally too long for the visible title limit",
      }] },
    }),
    /golden_visible_cycle_state_invalid/u,
  );
  assert.throws(
    () => validateGoldenVisibleTree({
      ...issue,
      children: { ...issue.children, nodes: [{
        ...issue.children.nodes[0],
        children: { ...issue.children.nodes[0].children, nodes: [
          { ...issue.children.nodes[0].children.nodes[0], title: "[Artist] Create the golden file" },
          issue.children.nodes[0].children.nodes[1],
        ] },
      }] },
    }),
    /golden_visible_role_topology_invalid/u,
  );
  assert.throws(
    () => validateGoldenVisibleTree({ ...issue, state: { name: "In Review", type: "started" } }),
    /golden_visible_root_state_invalid/u,
  );
  assert.throws(
    () => validateGoldenVisibleTree({
      ...issue,
      children: { ...issue.children, nodes: [{
        ...issue.children.nodes[0],
        children: { nodes: [{ title: "[Artist] Create the golden file", state: done }], pageInfo: { hasNextPage: false } },
      }] },
    }),
    /golden_visible_role_topology_invalid/u,
  );
  assert.throws(
    () => validateGoldenVisibleTree({
      ...issue,
      children: { ...issue.children, pageInfo: undefined },
    }),
    /golden_visible_root_state_invalid/u,
  );
  assert.throws(
    () => validateGoldenVisibleTree({
      ...issue,
      children: {
        ...issue.children,
        nodes: [{
          ...issue.children.nodes[0],
          children: {
            ...issue.children.nodes[0].children,
            nodes: [{
              ...issue.children.nodes[0].children.nodes[0],
              children: {
                nodes: [],
                pageInfo: { hasNextPage: false },
                extra: true,
              },
            }, issue.children.nodes[0].children.nodes[1]],
          },
        }],
      },
    }),
    /golden_visible_role_topology_invalid/u,
  );
});

test("golden result projection uses role descriptions and one visible Critic JSON file", () => {
  const updatedAt = formatLocalTimestamp();
  const artistMarkdown = [
    "## Summary", "Created the golden file.", "", "## File Changes", "### Created",
    "- symphony-golden.txt (+1/-0 lines)", "### Updated", "- README.md (+2/-1 lines)",
    "### Deleted", "- obsolete.txt (-3 lines)",
    "", "## Verification", "- Read back the file.", "",
  ].join("\n");
  const criticMarkdown = [
    "verdict: accepted", "", "## Scope Reviewed", "Inspected the complete workspace diff.", "",
    "## Implementation Review", "The golden file is present.", "", "## Checks", "- file content matches",
    "", "## Evidence", "- read-only inspection passed", "", "## Findings", "- None", "",
    "## Task State", "The golden file is verified.", "",
  ].join("\n");
  const projection = {
    description: [
      "Create the requested golden file.",
      "",
      "# Symphony Harness: Managed Root",
      "",
      "## Metadata",
      "",
      `Updated at: ${updatedAt}`,
      "",
      "### Root State",
      "",
      "```json",
      '{"current_phase":"completed"}',
      "```",
      "",
      "## Result",
      "",
      "### Overview",
      "The complete worktree satisfies the Root requirement.",
      "",
      "### File Changes",
      "#### Created",
      "- symphony-golden.txt: +1 lines",
      "",
      "#### Updated",
      "- None",
      "",
      "#### Deleted",
      "- None",
      "",
      "### Line Changes",
      "+1 / -0 lines",
      "",
      "### Verification",
      "The latest Critic accepted the complete diff.",
      "",
      "### Token Usage",
      "Total tokens: 1.2k",
      "",
      "# Symphony Harness: End Managed Root",
    ].join("\n"),
    comments: {
      nodes: [],
      pageInfo: { hasNextPage: false },
    },
    children: {
      nodes: [{
        title: "[Cycle 001] Create the golden file",
        comments: {
          nodes: [
            { body: [
              "# Symphony Harness: Reconcile", "", "### Why Continue",
              "The requested golden file is not yet present.", "", "### Evidence",
              "No accepted Critic has verified the file.", "", "### Next Cycle",
              "Create and verify the golden file.",
            ].join("\n") },
            { body: [
              "## Cycle Result",
              "- Result: succeeded",
              "- Critic Issue: audit-1",
              "- Critic verdict: accepted",
              "- Reason: The golden file is present.",
              "- Critique: [cycle-001-critique-result.json](https://linear.example/upload/1)",
            ].join("\n") },
          ],
          pageInfo: { hasNextPage: false },
        },
        children: {
          nodes: [
            {
              title: "[Artist] Cycle 001",
              description: `# Task\n\n## Objective\n\nCreate the golden file.\n\n# Symphony Metadata\n\n## Role\n\nArtist\n\n# Result\n\nUpdated at: ${updatedAt}\n\n${artistMarkdown}`,
              comments: {
                nodes: [],
                pageInfo: { hasNextPage: false },
              },
            },
            {
              title: "[Critic] Cycle 001",
              description: `# Task\n\n## Acceptance\n\nVerify the golden file.\n\n# Symphony Metadata\n\n## Role\n\nCritic\n\n# Result\n\nUpdated at: ${updatedAt}\n\n${criticMarkdown}`,
              comments: { nodes: [], pageInfo: { hasNextPage: false } },
            },
          ],
          pageInfo: { hasNextPage: false },
        },
      }],
      pageInfo: { hasNextPage: false },
    },
  };
  assert.doesNotThrow(() => validateGoldenResultComments(projection));
  const independentlyTimedProjection = structuredClone(projection);
  const earlierUpdatedAt = formatLocalTimestamp(new Date(Date.now() - 60_000));
  independentlyTimedProjection.children.nodes[0].children.nodes[0].description =
    independentlyTimedProjection.children.nodes[0].children.nodes[0].description.replace(
      `Updated at: ${updatedAt}`,
      `Updated at: ${earlierUpdatedAt}`,
    );
  assert.notEqual(earlierUpdatedAt, updatedAt);
  assert.doesNotThrow(() => validateGoldenResultComments(independentlyTimedProjection));
  const linearNormalizedProjection = structuredClone(projection);
  linearNormalizedProjection.children.nodes[0].children.nodes[0].description =
    linearNormalizedProjection.children.nodes[0].children.nodes[0].description.replaceAll("\n- ", "\n* ");
  assert.doesNotThrow(() => validateGoldenResultComments(linearNormalizedProjection));
  const artistFailure = structuredClone(projection);
  artistFailure.children.nodes[0].children.nodes[0].description =
    `# Task\n\nArtist the Cycle.\n\n# Symphony Metadata\n\n## Role\n\nArtist\n\n# Result\n\nUpdated at: ${updatedAt}\n\n## Artist Result\n- Result: failure\n- Error: Process timed out`;
  assert.doesNotThrow(() => validateGoldenResultComments(artistFailure));
  const missingRootReport = structuredClone(projection);
  missingRootReport.description = "Create the requested golden file.";
  assert.throws(
    () => validateGoldenResultComments(missingRootReport),
    /golden_root_description_invalid/u,
  );
  for (const rawStatus of ["?? generated.txt", " M README.md", "D obsolete.txt"]) {
    const rawProjection = structuredClone(projection);
    rawProjection.children.nodes[0].children.nodes[0].description += `\n${rawStatus}`;
    assert.throws(
      () => validateGoldenResultComments(rawProjection),
      /golden_result_comments_projection_invalid/u,
    );
  }
  assert.throws(
    () => validateGoldenResultComments({
      ...projection,
      children: {
        ...projection.children,
        nodes: [{
          ...projection.children.nodes[0],
          comments: {
            ...projection.children.nodes[0].comments,
            nodes: [{ body: "## Cycle Result\n- Critique: [cycle-001-critique-result.json](url)" }],
          },
        }],
      },
    }),
    /golden_result_comments_projection_invalid/u,
  );
});

test("golden fetches the linked Critic JSON with the human token and validates its file type", async () => {
  const calls = [];
  const result = await fetchGoldenCriticResult(
    "https://uploads.linear.app/assets/audit.json",
    "human-linear-token",
    async (url, options) => {
      calls.push({ url, options });
      return {
        ok: true,
        headers: { get: (name) => name === "content-type" ? "application/json; charset=utf-8" : null },
        arrayBuffer: async () => Buffer.from(JSON.stringify({
          verdict: "accepted",
          scope_reviewed: "Workspace diff",
          implementation_review: "File change inspected",
          checks: ["read-only check"],
          evidence: ["file read succeeded"],
          findings: [],
          task_state_markdown: "Verified",
        }), "utf8"),
      };
    },
  );

  assert.equal(result.verdict, "accepted");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://uploads.linear.app/assets/audit.json");
  assert.equal(calls[0].options.headers.Authorization, "human-linear-token");
  assert.equal(calls[0].options.headers.Accept, "application/json");
  assert.equal(calls[0].options.method, "GET");
  assert.ok(calls[0].options.signal instanceof AbortSignal);
});

test("golden rejects a linked Critic resource that is not JSON", async () => {
  await assert.rejects(
    fetchGoldenCriticResult(
      "https://uploads.linear.app/assets/audit.md",
      "human-linear-token",
      async () => ({
        ok: true,
        headers: { get: () => "text/markdown" },
        arrayBuffer: async () => Buffer.from("# not JSON", "utf8"),
      }),
    ),
    /golden_critic_file_content_type_invalid/u,
  );
});

test("golden never sends the human token to an external linked host", async () => {
  let calls = 0;
  await assert.rejects(
    fetchGoldenCriticResult("https://attacker.example/audit.json", "human-linear-token", async () => {
      calls += 1;
      return { ok: true };
    }),
    /golden_critic_file_request_invalid/u,
  );
  assert.equal(calls, 0);
});

test("golden rejects a non-standard upload host port before sending the token", async () => {
  let calls = 0;
  await assert.rejects(
    fetchGoldenCriticResult("https://uploads.linear.app:8443/audit.json", "human-linear-token", async () => {
      calls += 1;
      return { ok: true };
    }),
    /golden_critic_file_request_invalid/u,
  );
  assert.equal(calls, 0);
});

test("golden archives raw failure context before fixture cleanup and returns only its private path", async (context) => {
  const base = await mkdtemp(path.join(os.tmpdir(), "symphony-golden-diagnostic-test-"));
  const archiveBase = await mkdtemp(path.join(os.tmpdir(), "symphony-golden-diagnostic-archive-"));
  context.after(() => Promise.all([
    rm(base, { recursive: true, force: true }),
    rm(archiveBase, { recursive: true, force: true }),
  ]));
  const workspace = path.join(base, "workspace");
  const runDirectory = path.join(base, "run");
  const archiveRoot = path.join(archiveBase, "archives");
  await Promise.all([mkdir(workspace), mkdir(runDirectory)]);
  const agentSecret = "agent-jsonl-secret-never-output";
  const stdoutSecret = "child-stdout-secret-never-output";
  const stderrSecret = "child-stderr-secret-never-output";
  await writeFile(path.join(runDirectory, "agent.jsonl"), `${agentSecret}\n`, { encoding: "utf8", mode: 0o600 });
  let cleaned = false;
  let cleanupOptions;
  const fixture = {
    workspace,
    runDirectory,
    async archiveFailure(context_) {
      assert.equal(await readFile(path.join(runDirectory, "agent.jsonl"), "utf8"), `${agentSecret}\n`);
      return archiveGoldenFailure({ archiveRoot, ...context_, workspace, runDirectory });
    },
    async cleanup(_pullRequestUrl, options) {
      assert.equal(await readFile(path.join(runDirectory, "agent.jsonl"), "utf8"), `${agentSecret}\n`);
      cleanupOptions = options;
      cleaned = true;
      await rm(base, { recursive: true, force: true });
    },
  };
  const result = await runGoldenScenario({
    environment: {
      SYMPHONY_RUN_GOLDEN: "1",
      LINEAR_API_KEY: "product-linear-token",
      SYMPHONY_E2E_LINEAR_HUMAN_TOKEN: "human-linear-token",
      SYMPHONY_E2E_PROJECT_SLUG_ID: "project-slug",
    },
    fixture,
    operation: async () => {
      const error = new Error("conductor failure", { cause: new Error("provider cause") });
      error.stdout = stdoutSecret;
      error.stderr = stderrSecret;
      throw error;
    },
  });
  assert.equal(cleaned, true);
  assert.deepEqual(cleanupOptions, { archiveIssueTree: false });
  assert.equal(result.status, "failed");
  assert.equal(result.layer, "golden");
  assert.equal(result.reason, "conductor failure");
  assert.equal(typeof result.diagnostic_ref, "string");
  assert.equal(JSON.stringify(result).includes(stdoutSecret), false);
  assert.equal(JSON.stringify(result).includes(stderrSecret), false);
  assert.equal(JSON.stringify(result).includes(agentSecret), false);
  const diagnosticRef = result.diagnostic_ref;
  const [errorRecord, stdout, stderr, agentJsonl] = await Promise.all([
    readFile(path.join(diagnosticRef, "error.json"), "utf8").then(JSON.parse),
    readFile(path.join(diagnosticRef, "stdout.log"), "utf8"),
    readFile(path.join(diagnosticRef, "stderr.log"), "utf8"),
    readFile(path.join(diagnosticRef, "run_directory", "agent.jsonl"), "utf8"),
  ]);
  assert.equal(errorRecord.name, "Error");
  assert.equal(errorRecord.message, "conductor failure");
  assert.equal(errorRecord.cause.name, "Error");
  assert.equal(errorRecord.cause.message, "provider cause");
  assert.equal(stdout, stdoutSecret);
  assert.equal(stderr, stderrSecret);
  assert.equal(agentJsonl, `${agentSecret}\n`);
  assert.equal((await stat(diagnosticRef)).mode & 0o777, 0o700);
  for (const file of ["error.json", "stdout.log", "stderr.log"]) {
    assert.equal((await stat(path.join(diagnosticRef, file))).mode & 0o777, 0o600);
  }
  assert.equal((await stat(path.join(diagnosticRef, "run_directory"))).mode & 0o777, 0o700);
  assert.equal((await stat(path.join(diagnosticRef, "run_directory", "agent.jsonl"))).mode & 0o777, 0o600);
  assert.deepEqual(await readdir(archiveRoot), [path.basename(diagnosticRef)]);
});

test("golden archives the Linear fixture only after complete visible success", async () => {
  const cleanupCalls = [];
  const fixture = {
    workspace: "/tmp/golden-success-workspace",
    runDirectory: "/tmp/golden-success-run",
    async cleanup(pullRequestUrl, options) {
      cleanupCalls.push({ pullRequestUrl, options });
    },
  };
  const result = await runGoldenScenario({
    environment: {
      SYMPHONY_RUN_GOLDEN: "1",
      LINEAR_API_KEY: "product-linear-token",
      SYMPHONY_E2E_LINEAR_HUMAN_TOKEN: "human-linear-token",
      SYMPHONY_E2E_PROJECT_SLUG_ID: "project-slug",
    },
    fixture,
    operation: async () => ({ status: "done", root: "ENG-1" }),
  });

  assert.equal(result.status, "passed");
  assert.deepEqual(cleanupCalls, [{ pullRequestUrl: undefined, options: { archiveIssueTree: true } }]);
});

test("golden diagnostic archives cap child streams and reject roots inside fixture-owned paths", async (context) => {
  const base = await mkdtemp(path.join(os.tmpdir(), "symphony-golden-diagnostic-bound-"));
  const archiveBase = await mkdtemp(path.join(os.tmpdir(), "symphony-golden-diagnostic-bound-archive-"));
  context.after(() => Promise.all([
    rm(base, { recursive: true, force: true }),
    rm(archiveBase, { recursive: true, force: true }),
  ]));
  const workspace = path.join(base, "workspace");
  const runDirectory = path.join(base, "run");
  await Promise.all([mkdir(workspace), mkdir(runDirectory)]);
  const output = "x".repeat(MAX_DIAGNOSTIC_STREAM_BYTES + 10);
  const { diagnostic_ref } = await archiveGoldenFailure({
    workspace,
    runDirectory,
    archiveRoot: path.join(archiveBase, "archives"),
    error: new Error("bounded"),
    stdout: output,
    stderr: output,
  });
  assert.equal((await stat(path.join(diagnostic_ref, "stdout.log"))).size, MAX_DIAGNOSTIC_STREAM_BYTES);
  assert.equal((await stat(path.join(diagnostic_ref, "stderr.log"))).size, MAX_DIAGNOSTIC_STREAM_BYTES);
  await assert.rejects(
    archiveGoldenFailure({
      workspace,
      runDirectory,
      archiveRoot: path.join(workspace, "archives"),
      error: new Error("unsafe"),
    }),
    /golden_diagnostic_archive_unsafe/u,
  );
  await assert.rejects(
    archiveGoldenFailure({
      workspace,
      runDirectory,
      archiveRoot: path.join(base, "diagnostics"),
      error: new Error("fixture-owned"),
    }),
    /golden_diagnostic_archive_unsafe/u,
  );
});

test("golden issue cleanup stops at its depth bound before issuing archive mutations", async () => {
  const originalFetch = globalThis.fetch;
  const requests = [];
  const childrenById = new Map();
  for (let depth = 0; depth <= MAX_GOLDEN_ISSUE_TREE_DEPTH; depth += 1) {
    const id = depth === 0 ? "root" : `issue-${depth}`;
    childrenById.set(id, [{ id: `issue-${depth + 1}` }]);
  }
  globalThis.fetch = async (_url, options) => {
    const request = JSON.parse(options.body);
    requests.push(request);
    if (request.query.includes("GoldenChildren")) {
      return {
        ok: true,
        async json() {
          return {
            data: {
              issue: {
                children: {
                  nodes: childrenById.get(request.variables.id) ?? [],
                  pageInfo: { hasNextPage: false },
                },
              },
            },
          };
        },
      };
    }
    return { ok: true, async json() { return { data: { issueArchive: { success: true } } }; } };
  };
  try {
    await assert.rejects(
      archiveIssueTree("fixture-token", "root"),
      /golden_issue_cleanup_depth_exceeded/u,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(requests.some(({ query }) => query.includes("GoldenArchive")), false);
  assert.equal(requests.length, MAX_GOLDEN_ISSUE_TREE_DEPTH + 1);
});

test("golden surfaces archive failure without leaking the archive error and still cleans up", async () => {
  let cleaned = false;
  const fixture = {
    workspace: "/tmp/golden-diagnostic-workspace",
    runDirectory: "/tmp/golden-diagnostic-run",
    async archiveFailure() {
      throw new Error("archive secret must stay private");
    },
    async cleanup() {
      cleaned = true;
    },
  };
  const result = await runGoldenScenario({
    environment: {
      SYMPHONY_RUN_GOLDEN: "1",
      LINEAR_API_KEY: "product-linear-token",
      SYMPHONY_E2E_LINEAR_HUMAN_TOKEN: "human-linear-token",
      SYMPHONY_E2E_PROJECT_SLUG_ID: "project-slug",
    },
    fixture,
    operation: async () => { throw new Error("child secret must stay private"); },
  });
  assert.equal(cleaned, true);
  assert.deepEqual(result, {
    status: "failed",
    layer: "golden",
    reason: "golden_diagnostic_archive_failed",
  });
  assert.equal(JSON.stringify(result).includes("secret"), false);
});
