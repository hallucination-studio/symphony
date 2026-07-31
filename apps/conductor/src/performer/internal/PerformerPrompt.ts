export function encodePerformerPrompt(
  value: unknown,
  maxBytes: number,
  tooLargeCode: string,
): string {
  const encoded = JSON.stringify(value)
    .replaceAll("$", "\\u0024")
    .replaceAll("plugin://", "\\u0070lugin://");
  if (Buffer.byteLength(encoded, "utf8") > maxBytes) throw new Error(tooLargeCode);
  return encoded;
}
