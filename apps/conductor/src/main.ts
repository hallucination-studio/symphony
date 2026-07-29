import { pathToFileURL } from "node:url";

export type RuntimeStatus = "idle" | "running" | "stopped";

export class ConductorRuntime {
  #status: RuntimeStatus = "idle";

  get status(): RuntimeStatus {
    return this.#status;
  }

  start(): void {
    if (this.#status !== "idle") {
      throw new Error("conductor_runtime_already_started");
    }
    this.#status = "running";
  }

  stop(): void {
    if (this.#status === "running") {
      this.#status = "stopped";
    }
  }
}

async function main(): Promise<void> {
  const runtime = new ConductorRuntime();
  runtime.start();
  process.stdout.write(`${JSON.stringify({ event: "conductor_ready" })}\n`);

  await new Promise<void>((resolve) => {
    const keepAlive = setInterval(() => undefined, 2_147_483_647);
    const stop = () => {
      clearInterval(keepAlive);
      runtime.stop();
      process.stdout.write(`${JSON.stringify({ event: "conductor_stopped" })}\n`);
      resolve();
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
