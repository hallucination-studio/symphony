import { execFile } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { blocked, failed, passed, safeReason } from "./black-box-runner.mjs";
import { boundaryPrerequisite } from "./real-boundary-runners.mjs";
import {
  archiveGoldenFailure,
  createGoldenFixture,
  MAX_DIAGNOSTIC_STREAM_BYTES,
} from "./golden-fixture.mjs";
import { GOLDEN_SCENARIOS, assertScenario } from "./scenario-catalog.mjs";

const execute = promisify(execFile);
const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

function parseJsonLines(source) {
  if (!(typeof source === "string" || Buffer.isBuffer(source))) return [];
  const text = Buffer.isBuffer(source) ? source.toString("utf8") : source;
  return text.split("\n").flatMap((line) => {
    try { return [JSON.parse(line)]; } catch { return []; }
  });
}

export function goldenConductorFailureReason(error) {
  const records = [error?.stderr, error?.stdout].flatMap(parseJsonLines);
  const failure = records.findLast((record) => record?.event === "conductor_failed");
  return typeof failure?.reason_code === "string"
    && failure.reason_code.length > 0
    && failure.reason_code.length <= 50
    && [...failure.reason_code].every((character) => {
      const codePoint = character.codePointAt(0);
      return codePoint !== undefined && codePoint >= 32 && codePoint !== 127;
    })
    ? failure.reason_code
    : "golden_conductor_process_failed";
}

export function resolveGoldenRoleConfiguration(environment = {}) {
  return Object.freeze({
    reconcile: Object.freeze({
      ...(environment.SYMPHONY_GOLDEN_RECONCILE_AGENT === undefined
        ? {} : { agent: environment.SYMPHONY_GOLDEN_RECONCILE_AGENT }),
      ...(environment.SYMPHONY_GOLDEN_RECONCILE_MODEL === undefined
        ? {} : { model: environment.SYMPHONY_GOLDEN_RECONCILE_MODEL }),
      ...(environment.SYMPHONY_GOLDEN_RECONCILE_REASONING_EFFORT === undefined
        ? {} : { reasoning_effort: environment.SYMPHONY_GOLDEN_RECONCILE_REASONING_EFFORT }),
    }),
    artist: Object.freeze({
      ...(environment.SYMPHONY_GOLDEN_ARTIST_AGENT === undefined
        ? {} : { agent: environment.SYMPHONY_GOLDEN_ARTIST_AGENT }),
      ...(environment.SYMPHONY_GOLDEN_ARTIST_MODEL === undefined
        ? {} : { model: environment.SYMPHONY_GOLDEN_ARTIST_MODEL }),
      ...(environment.SYMPHONY_GOLDEN_ARTIST_REASONING_EFFORT === undefined
        ? {} : { reasoning_effort: environment.SYMPHONY_GOLDEN_ARTIST_REASONING_EFFORT }),
    }),
    critic: Object.freeze({
      ...(environment.SYMPHONY_GOLDEN_CRITIC_AGENT === undefined
        ? {} : { agent: environment.SYMPHONY_GOLDEN_CRITIC_AGENT }),
      ...(environment.SYMPHONY_GOLDEN_CRITIC_MODEL === undefined
        ? {} : { model: environment.SYMPHONY_GOLDEN_CRITIC_MODEL }),
      ...(environment.SYMPHONY_GOLDEN_CRITIC_REASONING_EFFORT === undefined
        ? {} : { reasoning_effort: environment.SYMPHONY_GOLDEN_CRITIC_REASONING_EFFORT }),
    }),
  });
}

const GOLDEN_ENVIRONMENT_KEYS = Object.freeze([
  "PATH", "HOME", "CODEX_HOME", "TMPDIR", "LANG", "LC_ALL",
  "LINEAR_API_KEY",
  "SYMPHONY_RECONCILE_CODEX_API_KEY", "SYMPHONY_RECONCILE_CODEX_BASE_URL",
  "SYMPHONY_ARTIST_CODEX_API_KEY", "SYMPHONY_ARTIST_CODEX_BASE_URL",
  "SYMPHONY_CRITIC_CODEX_API_KEY", "SYMPHONY_CRITIC_CODEX_BASE_URL",
  "GH_TOKEN", "GITHUB_TOKEN",
]);

export function preserveGoldenFailureContext(context, error) {
  return context?.error === undefined
    ? Object.freeze({
      ...context,
      error,
      ...(context?.stdout === undefined ? { stdout: error?.stdout } : {}),
      ...(context?.stderr === undefined ? { stderr: error?.stderr } : {}),
    })
    : context;
}

export function requireGoldenPullRequest(terminal) {
  const delivery = terminal?.delivery;
  if (delivery?.kind !== "pull_request" || typeof delivery.url !== "string") {
    throw new Error("golden_delivery_not_pull_request");
  }
  let url;
  try { url = new URL(delivery.url); } catch { throw new Error("golden_delivery_not_pull_request"); }
  if (url.protocol !== "https:" || url.hostname !== "github.com" || !/^\/[^/]+\/[^/]+\/pull\/[1-9][0-9]*$/u.test(url.pathname)) {
    throw new Error("golden_delivery_not_pull_request");
  }
  return delivery.url;
}

export function partitionGoldenEnvironment(environment = {}, inherited = process.env) {
  const result = {};
  for (const key of GOLDEN_ENVIRONMENT_KEYS) {
    const value = environment[key] ?? inherited[key];
    if (value !== undefined) result[key] = value;
  }
  if (result.LINEAR_API_KEY === undefined) {
    const linearToken = environment.SYMPHONY_LINEAR_TOKEN ?? inherited.SYMPHONY_LINEAR_TOKEN;
    if (linearToken !== undefined) result.LINEAR_API_KEY = linearToken;
  }
  return result;
}

export function resolveGoldenLaunchArguments({
  environment = {},
  root,
  runDirectory,
  workspace,
} = {}) {
  const configuration = resolveGoldenRoleConfiguration(environment);
  const args = [
    "run",
    "--linear-root", root,
    "--workspace", workspace,
    "--dir", runDirectory,
    "--max-cycles", environment.SYMPHONY_GOLDEN_MAX_CYCLES ?? "4",
  ];
  if (configuration.reconcile.agent !== undefined) {
    args.push("--reconcile-agent", configuration.reconcile.agent);
  }
  if (configuration.reconcile.model !== undefined) {
    args.push("--reconcile-model", configuration.reconcile.model);
  }
  if (configuration.reconcile.reasoning_effort !== undefined) {
    args.push("--reconcile-reasoning-effort", configuration.reconcile.reasoning_effort);
  }
  if (configuration.artist.agent !== undefined) {
    args.push("--artist-agent", configuration.artist.agent);
  }
  if (configuration.artist.model !== undefined) {
    args.push("--artist-model", configuration.artist.model);
  }
  if (configuration.artist.reasoning_effort !== undefined) {
    args.push("--artist-reasoning-effort", configuration.artist.reasoning_effort);
  }
  if (configuration.critic.agent !== undefined) {
    args.push("--critic-agent", configuration.critic.agent);
  }
  if (configuration.critic.model !== undefined) {
    args.push("--critic-model", configuration.critic.model);
  }
  if (configuration.critic.reasoning_effort !== undefined) {
    args.push("--critic-reasoning-effort", configuration.critic.reasoning_effort);
  }
  return Object.freeze(args);
}

export async function runGoldenScenario({
  scenario = "single-cycle",
  environment = process.env,
  inheritedEnvironment = process.env,
  operation,
  createFixture = createGoldenFixture,
  fixtureFactory,
  fixture: fixtureOverride,
  diagnosticRoot,
  executeCommand = execute,
  signal,
} = {}) {
  assertScenario(scenario);
  if (!GOLDEN_SCENARIOS.includes(scenario)) return blocked("golden", "golden_scenario_not_supported");
  if (environment.SYMPHONY_RUN_GOLDEN !== "1") return blocked("golden", "golden_not_enabled");
  const linear = boundaryPrerequisite(environment, "linear", { allow: true });
  if (linear !== null) return blocked("golden", linear.reason);
  for (const key of ["SYMPHONY_E2E_LINEAR_HUMAN_TOKEN", "SYMPHONY_E2E_PROJECT_SLUG_ID"]) {
    if (typeof environment[key] !== "string" || environment[key].length === 0) {
      return blocked("golden", "golden_fixture_credential_missing");
    }
  }
  let fixture = fixtureOverride;
  let failureContext;
  const createFixtureOperation = fixtureFactory ?? createFixture;
  const run = operation ?? (async () => {
    fixture ??= await createFixtureOperation({
      scenario,
      environment,
      inheritedEnvironment,
      repositoryRoot: REPOSITORY_ROOT,
      diagnosticRoot,
      signal,
    });
    const entry = path.join(REPOSITORY_ROOT, "apps/conductor/dist/main.js");
    const args = [entry, ...resolveGoldenLaunchArguments({
      environment,
      root: fixture.root.identifier,
      runDirectory: fixture.runDirectory,
      workspace: fixture.workspace,
    })];
    const launch = async (expectedStatus) => {
      let result;
      try {
        result = await executeCommand(process.execPath, args, {
          cwd: REPOSITORY_ROOT,
          env: partitionGoldenEnvironment(environment, inheritedEnvironment),
          encoding: "buffer",
          timeout: 240_000,
          maxBuffer: MAX_DIAGNOSTIC_STREAM_BYTES,
          ...(signal === undefined ? {} : { signal }),
        });
      } catch (error) {
        const reason = goldenConductorFailureReason(error);
        failureContext = Object.freeze({ error, stdout: error?.stdout, stderr: error?.stderr, reason });
        throw new Error(reason, { cause: error });
      }
      failureContext = Object.freeze({ error: undefined, stdout: result.stdout, stderr: result.stderr });
      const output = Buffer.isBuffer(result.stdout) ? result.stdout.toString("utf8") : result.stdout;
      const lines = typeof output === "string" ? output.trim().split("\n").filter(Boolean) : [];
      let terminal;
      try {
        terminal = JSON.parse(lines.at(-1) ?? "null");
      } catch (error) {
        failureContext = Object.freeze({
          error,
          stdout: result.stdout,
          stderr: result.stderr,
          reason: "golden_conductor_process_failed",
        });
        throw error;
      }
      if (terminal?.event !== "conductor_stopped" || terminal.status !== expectedStatus) {
        const status = typeof terminal?.status === "string" && /^[a-z][a-z0-9_]{0,31}$/u.test(terminal.status)
          ? terminal.status
          : "invalid";
        const reason = expectedStatus === "needs_human" && status === "done"
          ? "golden_conductor_needs_human_required"
          : `golden_conductor_${status}`;
        const error = new Error(reason);
        failureContext = Object.freeze({ error, stdout: result.stdout, stderr: result.stderr, reason });
        throw error;
      }
      return terminal;
    };
    const humanRequired = [
      "single-cycle-human-action",
      "cycle-human-action-cycle",
      "human-action-rejected-supplement",
      "human-action-unanswered",
    ].includes(scenario);
    if (humanRequired) {
      await launch("needs_human");
      if (typeof fixture.verifyNeedsHumanBoundary !== "function"
        || (scenario !== "human-action-unanswered" && typeof fixture.replyToNeedsHuman !== "function")) {
        throw new Error("golden_needs_human_fixture_invalid");
      }
      await fixture.verifyNeedsHumanBoundary();
      if (scenario === "human-action-unanswered") {
        if (typeof fixture.verifyUnansweredNeedsHuman !== "function") {
          throw new Error("golden_needs_human_fixture_invalid");
        }
        await fixture.verifyUnansweredNeedsHuman();
        return { status: "needs_human", root: fixture.root.identifier, scenario };
      }
      if (scenario === "human-action-rejected-supplement") {
        if (typeof fixture.rejectNeedsHumanReplies !== "function"
          || typeof fixture.verifyRejectedNeedsHumanBoundary !== "function") {
          throw new Error("golden_needs_human_fixture_invalid");
        }
        await fixture.rejectNeedsHumanReplies();
        await launch("needs_human");
        await fixture.verifyRejectedNeedsHumanBoundary();
      }
      await fixture.replyToNeedsHuman();
    }
    const terminal = await launch("done");
    await fixture.verifyVisibleCompletion?.();
    requireGoldenPullRequest(terminal);
    return { status: terminal.status, root: fixture.root.identifier, scenario };
  });
  let outcome;
  let diagnosticRef;
  let archiveError;
  try {
    const result = await run({ signal });
    outcome = passed("golden", { result });
  } catch (error) {
    const context = preserveGoldenFailureContext(failureContext, error) ?? Object.freeze({
      error, stdout: error?.stdout, stderr: error?.stderr,
    });
    try {
      if (fixture !== undefined) {
        const archive = typeof fixture.archiveFailure === "function"
          ? await fixture.archiveFailure(context)
          : await archiveGoldenFailure({
            archiveRoot: diagnosticRoot,
            runDirectory: fixture.runDirectory,
            ...context,
          });
        diagnosticRef = archive?.diagnostic_ref;
      }
    } catch (error_) {
      archiveError = error_;
      diagnosticRef = undefined;
    }
    const failure = failed("golden", new Error(
      archiveError === undefined
        ? (typeof context.reason === "string"
          ? context.reason
          : safeReason(context.error, "golden_conductor_process_failed"))
        : "golden_diagnostic_archive_failed",
    ));
    outcome = diagnosticRef === undefined
      ? failure
      : Object.freeze({ ...failure, diagnostic_ref: diagnosticRef });
  }
  return outcome;
}
