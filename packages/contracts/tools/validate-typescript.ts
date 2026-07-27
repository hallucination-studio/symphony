import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { decodeContract, type JsonValue } from "../generated/typescript/contracts.js";

interface Fixture {
  schema: string;
  value: JsonValue;
}

async function fixtures(directory: string): Promise<Array<[string, Fixture]>> {
  const names = (await readdir(directory))
    .filter((name) => name.endsWith(".json"))
    .sort();
  return Promise.all(
    names.map(async (name) => [
      path.join(directory, name),
      JSON.parse(await readFile(path.join(directory, name), "utf8")) as Fixture,
    ]),
  );
}

const suppliedDirectories = process.argv.slice(2);
if (suppliedDirectories.length !== 0 && suppliedDirectories.length !== 2) {
  throw new Error("expected zero or two fixture directories");
}

const fixtureRoot = fileURLToPath(new URL("../fixtures/cross-language/", import.meta.url));
const [validDirectory, invalidDirectory] = suppliedDirectories.length === 0
  ? [path.join(fixtureRoot, "valid"), path.join(fixtureRoot, "invalid")]
  : suppliedDirectories;
for (const [, fixture] of await fixtures(validDirectory)) {
  decodeContract(fixture.schema, fixture.value);
}
for (const [fixturePath, fixture] of await fixtures(invalidDirectory)) {
  try {
    decodeContract(fixture.schema, fixture.value);
  } catch {
    continue;
  }
  throw new Error(`invalid fixture was accepted: ${fixturePath}`);
}
