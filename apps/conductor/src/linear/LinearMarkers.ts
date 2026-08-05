import type { MarkdownText } from "../contracts/validation.js";

export const HARNESS_COMMENT_MARKER = "# Symphony Harness:";

export function isHarnessComment(body: MarkdownText): boolean {
  return body.startsWith(HARNESS_COMMENT_MARKER);
}
