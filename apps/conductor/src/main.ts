import { pathToFileURL } from "node:url";

import { loadStartup } from "./composition/startup.js";

function line(stream: NodeJS.WritableStream, value: Record<string, unknown>): void {
  stream.write(`${JSON.stringify(value)}\n`);
}

function reasonCode(error: unknown): string {
  if (error instanceof Error && /^[a-z][a-z0-9_]{0,63}$/u.test(error.message)) return error.message;
  return "startup_or_runtime_failed";
}

async function main(): Promise<void> {
  try {
    await loadStartup(process.argv.slice(2), process.env);
    throw new Error("target_runtime_not_ready");
  } catch (error) {
    line(process.stderr, { event: "conductor_failed", reason_code: reasonCode(error) });
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
