import type { RuntimeLogPublisherInterface } from "../api/RuntimeLogPublisherInterface.js";

export class PodiumRuntimeLogPublisherImpl implements RuntimeLogPublisherInterface {
  publish(input: {
    level: "info" | "warning" | "error";
    event: string;
    fields: Record<string, string>;
  }): void {
    const line = JSON.stringify({
      event: input.event,
      level: input.level,
      ...Object.fromEntries(Object.entries(input.fields).map(([key, value]) => [
        key,
        value.replace(/(?:Bearer\s+|sk-)[A-Za-z0-9._-]+/gi, "[REDACTED]"),
      ])),
    });
    (input.level === "info" ? process.stdout : process.stderr).write(`${line}\n`);
  }
}
