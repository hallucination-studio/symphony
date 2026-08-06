import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";

import { createProductionRootRun } from "./composition/Production.js";
import { loadStartup } from "./composition/startup.js";
import { writeFailureEvidence } from "./diagnostics/DiagnosticEvidence.js";

function line(stream: NodeJS.WritableStream, value: object): void {
  stream.write(`${JSON.stringify(value)}\n`);
}

function reasonCode(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return (message.length === 0 ? "Unknown error" : message).slice(0, 50);
}

export async function runMain(
  argv: readonly string[],
  environment: Readonly<Record<string, string | undefined>>,
  stdout: NodeJS.WritableStream,
  stderr: NodeJS.WritableStream,
  signal?: AbortSignal,
): Promise<number> {
  const runId = randomUUID();
  let runDirectory: string | undefined;
  let phase = "startup";
  try {
    const startup = await loadStartup(argv, environment);
    runDirectory = startup.request.run_directory;
    phase = "composition";
    const conductor = await createProductionRootRun(
      startup,
      (event) => line(stdout, { ...event, run_id: runId }),
    );
    phase = "runtime";
    line(stdout, { event: "conductor_started", run_id: runId, root: startup.request.linear_root });
    const result = await conductor.run(startup.request.linear_root, signal);
    line(stdout, { event: "conductor_stopped", run_id: runId, ...result });
    return 0;
  } catch (error) {
    let diagnosticRef: string | undefined;
    if (runDirectory !== undefined) {
      try {
        diagnosticRef = await writeFailureEvidence({ runDirectory, runId, phase, error });
      } catch {
        diagnosticRef = undefined;
      }
    }
    line(stderr, {
      event: "conductor_failed",
      run_id: runId,
      reason_code: reasonCode(error),
      ...(diagnosticRef === undefined ? {} : { diagnostic_ref: diagnosticRef }),
    });
    return 1;
  }
}

async function main(): Promise<void> {
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    process.exitCode = await runMain(
      process.argv.slice(2), process.env, process.stdout, process.stderr, controller.signal,
    );
  } finally {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
