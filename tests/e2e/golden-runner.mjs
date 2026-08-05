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
    execute: Object.freeze({
      ...(environment.SYMPHONY_GOLDEN_EXECUTE_AGENT === undefined
        ? {} : { agent: environment.SYMPHONY_GOLDEN_EXECUTE_AGENT }),
      ...(environment.SYMPHONY_GOLDEN_EXECUTE_MODEL === undefined
        ? {} : { model: environment.SYMPHONY_GOLDEN_EXECUTE_MODEL }),
      ...(environment.SYMPHONY_GOLDEN_EXECUTE_REASONING_EFFORT === undefined
        ? {} : { reasoning_effort: environment.SYMPHONY_GOLDEN_EXECUTE_REASONING_EFFORT }),
    }),
    audit: Object.freeze({
      ...(environment.SYMPHONY_GOLDEN_AUDIT_AGENT === undefined
        ? {} : { agent: environment.SYMPHONY_GOLDEN_AUDIT_AGENT }),
      ...(environment.SYMPHONY_GOLDEN_AUDIT_MODEL === undefined
        ? {} : { model: environment.SYMPHONY_GOLDEN_AUDIT_MODEL }),
      ...(environment.SYMPHONY_GOLDEN_AUDIT_REASONING_EFFORT === undefined
        ? {} : { reasoning_effort: environment.SYMPHONY_GOLDEN_AUDIT_REASONING_EFFORT }),
    }),
  });
}

const GOLDEN_ENVIRONMENT_KEYS = Object.freeze([
  "PATH", "HOME", "CODEX_HOME", "TMPDIR", "LANG", "LC_ALL",
  "LINEAR_API_KEY",
  "SYMPHONY_RECONCILE_CODEX_API_KEY", "SYMPHONY_RECONCILE_CODEX_BASE_URL",
  "SYMPHONY_EXECUTE_CODEX_API_KEY", "SYMPHONY_EXECUTE_CODEX_BASE_URL",
  "SYMPHONY_AUDIT_CODEX_API_KEY", "SYMPHONY_AUDIT_CODEX_BASE_URL",
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
  workspace,
  runDirectory,
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
  if (configuration.execute.agent !== undefined) {
    args.push("--execute-agent", configuration.execute.agent);
  }
  if (configuration.execute.model !== undefined) {
    args.push("--execute-model", configuration.execute.model);
  }
  if (configuration.execute.reasoning_effort !== undefined) {
    args.push("--execute-reasoning-effort", configuration.execute.reasoning_effort);
  }
  if (configuration.audit.agent !== undefined) {
    args.push("--audit-agent", configuration.audit.agent);
  }
  if (configuration.audit.model !== undefined) {
    args.push("--audit-model", configuration.audit.model);
  }
  if (configuration.audit.reasoning_effort !== undefined) {
    args.push("--audit-reasoning-effort", configuration.audit.reasoning_effort);
  }
  return Object.freeze(args);
}

export async function runGoldenScenario({
  environment = process.env,
  inheritedEnvironment = process.env,
  operation,
  createFixture = createGoldenFixture,
  fixtureFactory,
  fixture: fixtureOverride,
  diagnosticRoot,
} = {}) {
  if (environment.SYMPHONY_RUN_GOLDEN !== "1") return blocked("golden", "golden_not_enabled");
  const linear = boundaryPrerequisite(environment, "linear", { allow: true });
  if (linear !== null) return blocked("golden", linear.reason);
  for (const key of ["SYMPHONY_E2E_LINEAR_HUMAN_TOKEN", "SYMPHONY_E2E_PROJECT_SLUG_ID"]) {
    if (typeof environment[key] !== "string" || environment[key].length === 0) {
      return blocked("golden", "golden_fixture_credential_missing");
    }
  }
  let fixture = fixtureOverride;
  let pullRequestUrl;
  let failureContext;
  const createFixtureOperation = fixtureFactory ?? createFixture;
  const run = operation ?? (async () => {
    fixture ??= await createFixtureOperation({
      environment,
      inheritedEnvironment,
      repositoryRoot: REPOSITORY_ROOT,
      diagnosticRoot,
    });
    const entry = path.join(REPOSITORY_ROOT, "apps/conductor/dist/main.js");
    const args = [entry, ...resolveGoldenLaunchArguments({
      environment,
      root: fixture.root.identifier,
      workspace: fixture.workspace,
      runDirectory: fixture.runDirectory,
    })];
    let result;
    try {
      result = await execute(process.execPath, args, {
        cwd: REPOSITORY_ROOT,
        env: partitionGoldenEnvironment(environment, inheritedEnvironment),
        encoding: "buffer",
        timeout: 240_000,
        maxBuffer: MAX_DIAGNOSTIC_STREAM_BYTES,
      });
    } catch (error) {
      const reason = goldenConductorFailureReason(error);
      failureContext = Object.freeze({ error, stdout: error?.stdout, stderr: error?.stderr, reason });
      throw new Error(reason, { cause: error });
    }
    failureContext = Object.freeze({ error: undefined, stdout: result.stdout, stderr: result.stderr });
    const output = Buffer.isBuffer(result.stdout) ? result.stdout.toString("utf8") : result.stdout;
    const lines = output.trim().split("\n").filter(Boolean);
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
    if (terminal?.event !== "conductor_stopped" || terminal.status !== "done") {
      const status = typeof terminal?.status === "string" && /^[a-z][a-z0-9_]{0,31}$/u.test(terminal.status)
        ? terminal.status
        : "invalid";
      const error = new Error(`golden_conductor_${status}`);
      const reason = `golden_conductor_${status}`;
      failureContext = Object.freeze({ error, stdout: result.stdout, stderr: result.stderr, reason });
      throw error;
    }
    await fixture.verifyVisibleCompletion?.();
    pullRequestUrl = terminal.pull_request_url;
    return { status: terminal.status, root: fixture.root.identifier };
  });
  let outcome;
  let diagnosticRef;
  let archiveError;
  let cleanupError;
  try {
    const result = await run();
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
            workspace: fixture.workspace,
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
  } finally {
    try {
      await fixture?.cleanup?.(pullRequestUrl);
    } catch (error) {
      cleanupError = error;
    }
  }
  if (cleanupError !== undefined) {
    const cleanupFailure = failed("golden", new Error(
      archiveError === undefined ? "golden_cleanup_failed" : "golden_diagnostic_archive_failed",
      { cause: cleanupError },
    ));
    return diagnosticRef === undefined
      ? cleanupFailure
      : Object.freeze({ ...cleanupFailure, diagnostic_ref: diagnosticRef });
  }
  return outcome;
}
