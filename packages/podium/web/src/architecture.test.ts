import { expect, it } from "vitest";
import * as ts from "typescript";

const sourceModules = import.meta.glob("./**/*.{ts,tsx}", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

function contractSurface(path: string, source: string) {
  const identifiers = new Set<string>();
  const strings = new Set<string>();
  const sourceFile = ts.createSourceFile(
    path,
    source,
    ts.ScriptTarget.Latest,
    true,
    path.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );

  function visit(node: ts.Node) {
    if (ts.isIdentifier(node)) identifiers.add(node.text);
    if (ts.isStringLiteralLike(node)) strings.add(node.text);
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  return { identifiers, strings };
}

it("keeps retired run contracts out of the browser production surface", () => {
  const forbiddenIdentifiers = new Set([
    "RunStatus",
    "RunSummary",
    "recentRuns",
    "recent_runs",
    "record_run",
    "list_runs",
  ]);
  const forbiddenRoutes = ["/api/v1/runs", "/api/runs"];
  const findings: string[] = [];

  for (const [path, source] of Object.entries(sourceModules)) {
    if (/\.test\.tsx?$/.test(path)) continue;
    const surface = contractSurface(path, source);
    for (const identifier of forbiddenIdentifiers) {
      if (surface.identifiers.has(identifier)) findings.push(`${path}:identifier:${identifier}`);
    }
    for (const route of forbiddenRoutes) {
      if ([...surface.strings].some((value) => value.includes(route))) {
        findings.push(`${path}:route:${route}`);
      }
    }
  }

  expect(findings).toEqual([]);
});
