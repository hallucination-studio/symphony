import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

const design = await readFile(new URL("../DESIGN.md", import.meta.url), "utf8");
const tokens = await readFile(
  new URL("../src/styles/tokens.css", import.meta.url),
  "utf8",
);
const layout = await readFile(
  new URL("../src/styles/layout.css", import.meta.url),
  "utf8",
);

const errors = [];

// DESIGN.md YAML manifest scalar values (kebab-case or camelCase keys).
const declaredValues = [
  ...design.matchAll(/^\s+[a-zA-Z0-9][a-zA-Z0-9-]*:\s+"?([^"\n]+)"?$/gm),
].map((match) => match[1].trim());

// Forward: every color declared in DESIGN.md must exist in tokens.css.
const missingColors = declaredValues.filter(
  (value) =>
    (value.startsWith("#") || value.startsWith("rgba(")) &&
    !tokens.includes(value),
);
if (missingColors.length > 0) {
  errors.push(`DESIGN.md values missing from tokens.css: ${missingColors.join(", ")}`);
}

// Forward: every numeric metric (px/em/bare number) declared in DESIGN.md must
// exist in tokens.css.
const missingMetrics = declaredValues.filter(
  (value) => /^[\d.]+(px|em)?$/.test(value) && !tokens.includes(value),
);
if (missingMetrics.length > 0) {
  errors.push(
    `DESIGN.md metrics missing from tokens.css: ${missingMetrics.join(", ")}`,
  );
}

// Reverse: every raw color in tokens.css must be declared in DESIGN.md so the
// manifest stays the single source of truth.
const tokenColors = tokens.match(/#[0-9a-f]{3,8}\b|rgba?\([^)]*\)/gi) ?? [];
const undeclaredColors = [
  ...new Set(tokenColors.filter((value) => !design.includes(value))),
];
if (undeclaredColors.length > 0) {
  errors.push(
    `tokens.css colors missing from DESIGN.md: ${undeclaredColors.join(", ")}`,
  );
}

// layout.css must consume tokens instead of raw values.
const rawColors = layout.match(/#[0-9a-f]{3,8}\b|rgba?\([^)]*\)/gi) ?? [];
if (rawColors.length > 0) {
  errors.push(`layout.css must consume color tokens: ${rawColors.join(", ")}`);
}

const rawWeights = layout.match(/font-weight:\s*\d/g) ?? [];
if (rawWeights.length > 0) {
  errors.push(
    `layout.css must consume font-weight tokens: ${rawWeights.join(", ")}`,
  );
}

// The spacing scale (4/8/12/16/24/32/48px) must be referenced via --space-*
// tokens in margin, padding, and gap declarations.
const rawSpacing = [
  ...layout.matchAll(
    /(?:margin|padding|gap)(?:-[a-z]+)?:\s*[^;{]*\b(?:4|8|12|16|24|32|48)px\b/g,
  ),
].map((match) => match[0].trim());
if (rawSpacing.length > 0) {
  errors.push(
    `layout.css must consume spacing tokens: ${rawSpacing.join(" | ")}`,
  );
}

// Durations and easings must come from the motion tokens. Raw time values
// are only allowed inside the reduced-motion guard (marked !important).
const rawTimes = [...layout.matchAll(/^.*\b\d+(?:\.\d+)?m?s\b.*$/gm)]
  .map((match) => match[0].trim())
  .filter(
    (line) =>
      !line.includes("!important") &&
      !line.startsWith("/*") &&
      !line.startsWith("*"),
  );
if (rawTimes.length > 0) {
  errors.push(
    `layout.css must consume motion tokens: ${rawTimes.join(" | ")}`,
  );
}

// Components must not carry inline styles; presentation lives in the
// token-driven stylesheets.
const srcDir = new URL("../src", import.meta.url);
async function listTsx(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const path = join(dir.pathname ?? dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listTsx(path)));
    } else if (entry.name.endsWith(".tsx")) {
      files.push(path);
    }
  }
  return files;
}
const inlineStyleFiles = [];
for (const file of await listTsx(srcDir)) {
  if ((await readFile(file, "utf8")).includes("style={{")) {
    inlineStyleFiles.push(file.split("/src/")[1]);
  }
}
if (inlineStyleFiles.length > 0) {
  errors.push(`inline styles are not allowed: ${inlineStyleFiles.join(", ")}`);
}

if (errors.length > 0) {
  throw new Error(errors.map((error) => `- ${error}`).join("\n"));
}

console.log("Podium Desktop design tokens: 0 errors, 0 warnings");
