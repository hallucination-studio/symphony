const MAX_STRING_LENGTH = 4_096;

export function createE2ELogger({
  runId,
  secrets = [],
  now = () => new Date().toISOString(),
  write = (line) => process.stderr.write(line),
} = {}) {
  const redactions = [...new Set(secrets.filter((value) => typeof value === "string" && value.length > 0))]
    .sort((left, right) => right.length - left.length);
  return (event) => {
    const value = sanitizeValue({
      timestamp: now(),
      run_id: runId,
      ...event,
    }, redactions);
    write(`${JSON.stringify(value)}\n`);
  };
}

function sanitizeValue(value, redactions) {
  if (typeof value === "string") return redact(value.slice(0, MAX_STRING_LENGTH), redactions);
  if (Array.isArray(value)) return value.map((item) => sanitizeValue(item, redactions));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [
    key,
    sanitizeValue(item, redactions),
  ]));
}

function redact(value, redactions) {
  let result = value;
  for (const secret of redactions) result = result.replaceAll(secret, "[REDACTED]");
  return result.replace(/(?:Bearer\s+|sk-)[A-Za-z0-9._-]+/giu, "[REDACTED]");
}
