import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";

import {
  createProductionConductor,
  runProductionPoll,
  type ProductionConductor,
} from "./composition/ProductionConductor.js";
import { loadStartup } from "./composition/startup.js";

function line(stream: NodeJS.WritableStream, value: object): void {
  stream.write(`${JSON.stringify(value)}\n`);
}

function reasonCode(error: unknown): string {
  if (error instanceof Error && /^[a-z][a-z0-9_]{0,63}$/u.test(error.message)) return error.message;
  return "startup_or_runtime_failed";
}

interface ForegroundControl {
  stopRequested(): boolean;
  wait(milliseconds: number): Promise<void>;
}

export async function runForeground(
  production: ProductionConductor,
  control: ForegroundControl,
): Promise<void> {
  while (!control.stopRequested()) {
    const poll = await runProductionPoll(production);
    if (poll.stopped) return;
    if (!control.stopRequested()) await control.wait(production.polling_interval_ms);
  }
}

async function main(): Promise<void> {
  const correlationId = `process:${randomUUID()}`;
  let stopping = false;
  let releaseWait: (() => void) | null = null;
  const stop = () => {
    stopping = true;
    releaseWait?.();
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    const startup = await loadStartup(process.argv.slice(2), process.env);
    const production = await createProductionConductor(startup, (entry) => line(process.stdout, entry));
    line(process.stdout, { event: "conductor_ready", correlation_id: correlationId });
    await runForeground(production, {
      stopRequested: () => stopping,
      wait: (milliseconds) => new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, milliseconds);
        const release = () => { clearTimeout(timer); resolve(); };
        releaseWait = release;
      }),
    });
    line(process.stdout, { event: "conductor_stopped", correlation_id: correlationId });
  } catch (error) {
    line(process.stderr, {
      event: "conductor_failed",
      correlation_id: correlationId,
      reason_code: reasonCode(error),
    });
    process.exitCode = 1;
  } finally {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
