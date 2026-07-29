export interface HumanActionScope {
  targetIdentifiers: string[];
  contextIdentifiers: string[];
}

export function humanActionScopeFromBody(body: string): HumanActionScope | undefined {
  const targetIdentifiers = humanActionTargetIdentifiersFromBody(body);
  const contextIdentifiers = canonicalListSection(body, "### Verify 与 Cycle");
  return targetIdentifiers && contextIdentifiers
    ? { targetIdentifiers, contextIdentifiers }
    : undefined;
}

export function humanActionTargetIdentifiersFromBody(body: string): string[] | undefined {
  return canonicalListSection(body, "### 相关对象");
}

function canonicalListSection(body: string, heading: string): string[] | undefined {
  const lines = body.split("\n");
  const start = lines.indexOf(heading);
  if (start < 0 || lines.indexOf(heading, start + 1) >= 0) return undefined;
  const values: string[] = [];
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (line.startsWith("### ")) break;
    if (!line.trim()) continue;
    if (!line.startsWith("- ") || line.length <= 2) return undefined;
    values.push(line.slice(2));
  }
  return values.length > 0 && new Set(values).size === values.length ? values : undefined;
}
