import type { MarkdownText } from "../contracts/validation.js";

export const HARNESS_COMMENT_MARKER = "# Symphony Harness:";
export const ROOT_STATE_COMMENT_MARKER = `${HARNESS_COMMENT_MARKER} Root State`;

export function isHarnessComment(body: MarkdownText): boolean {
  return body.startsWith(HARNESS_COMMENT_MARKER);
}

export function isRootStateComment(body: MarkdownText): boolean {
  return body.startsWith(ROOT_STATE_COMMENT_MARKER);
}
