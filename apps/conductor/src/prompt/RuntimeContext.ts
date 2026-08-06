export function renderRuntimeContext(name: string, value: string): string {
  const end = `<<< END ${name} >>>`;
  const escaped = value.replaceAll(end, `<<< ESCAPED END ${name} >>>`);
  return `<<< BEGIN ${name} >>>\n${escaped}\n${end}`;
}
