import { readFile } from "node:fs/promises";

const design = await readFile(new URL("../DESIGN.md", import.meta.url), "utf8");
const tokens = await readFile(
  new URL("../src/styles/tokens.css", import.meta.url),
  "utf8",
);
const layout = await readFile(
  new URL("../src/styles/layout.css", import.meta.url),
  "utf8",
);

const declaredValues = [
  ...design.matchAll(/^\s+[a-z][a-z-]+:\s+"?([^"\n]+)"?$/gm),
].map((match) => match[1].trim());

const missingValues = declaredValues.filter(
  (value) =>
    (value.startsWith("#") || value.startsWith("rgba(")) &&
    !tokens.includes(value),
);
if (missingValues.length > 0) {
  throw new Error(`DESIGN.md values missing from tokens.css: ${missingValues.join(", ")}`);
}

const rawColors = layout.match(/#[0-9a-f]{3,8}|rgba?\([^)]*\)/gi) ?? [];
if (rawColors.length > 0) {
  throw new Error(`layout.css must consume color tokens: ${rawColors.join(", ")}`);
}

console.log("Podium Desktop design tokens: 0 errors, 0 warnings");
