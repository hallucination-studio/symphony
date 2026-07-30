import { pathToFileURL } from "node:url";

import { createProductionConductor, type ProductionConductor } from "./composition/ProductionConductor.js";
import { loadStartup } from "./composition/startup.js";

const POLL_INTERVAL_MS = 1_000;

interface ForegroundControl {
  stopRequested(): boolean;
  wait(): Promise<void>;
}

export async function runForeground(
  production: ProductionConductor,
  control: ForegroundControl,
): Promise<void> {
  try {
    while (!control.stopRequested()) {
      const candidates = await production.linear.discoverRoots();
      for (const candidate of candidates) {
        if (candidate.status === "Done" && production.runtimes.has(candidate.root_id)) {
          await production.retirement.retireIfDone(candidate.root_id);
        }
      }
      if (control.stopRequested()) break;
      await production.serial.tick();
      if (!control.stopRequested()) await control.wait();
    }
  } finally {
    await production.runtimes.closeAll();
  }
}

function line(stream: NodeJS.WritableStream, value: Record<string, unknown>): void {
  stream.write(`${JSON.stringify(value)}\n`);
}

async function main(): Promise<void> {
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
    const production = await createProductionConductor(startup);
    line(process.stdout, { event: "conductor_ready" });
    await runForeground(production, {
      stopRequested: () => stopping,
      wait: () => new Promise<void>((resolve) => {
        releaseWait = resolve;
        const timer = setTimeout(resolve, POLL_INTERVAL_MS);
        const release = releaseWait;
        releaseWait = () => { clearTimeout(timer); release(); };
      }),
    });
    line(process.stdout, { event: "conductor_stopped" });
  } catch {
    line(process.stderr, { event: "conductor_failed", reason_code: "startup_or_runtime_failed" });
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
