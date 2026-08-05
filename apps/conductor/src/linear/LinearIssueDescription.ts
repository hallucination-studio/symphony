import { parseMarkdownText, type MarkdownText } from "../contracts/validation.js";

import { parseLinearDescriptionTimestamp } from "./LinearDescriptionTimestamp.js";

const TASK_HEADING = "# Task";
const METADATA_HEADING = "# Symphony Metadata";
const RESULT_HEADING = "# Result";
const UPDATED_AT_PREFIX = "Updated at: ";

export interface ManagedIssueDescription {
  readonly task: MarkdownText;
  readonly metadata: MarkdownText;
  readonly result?: MarkdownText | undefined;
  readonly updated_at?: string | undefined;
}

function malformed(): never {
  throw new Error("linear_issue_description_malformed");
}

function markdown(value: unknown): MarkdownText {
  try {
    return parseMarkdownText(value, "linear_issue_description_malformed");
  } catch {
    return malformed();
  }
}

export function renderManagedIssueDescription(input: {
  readonly task: MarkdownText | string;
  readonly metadata: MarkdownText | string;
}): MarkdownText {
  return markdown([TASK_HEADING, "", markdown(input.task), "", METADATA_HEADING, "", markdown(input.metadata)].join("\n"));
}

export function parseManagedIssueDescription(value: unknown): ManagedIssueDescription {
  const source = markdown(value).replace(/\r\n?/gu, "\n").trim();
  const taskMarker = `${TASK_HEADING}\n\n`;
  const metadataMarker = `\n\n${METADATA_HEADING}\n\n`;
  const resultMarker = `\n\n${RESULT_HEADING}\n\n`;
  if (!source.startsWith(taskMarker)) malformed();
  const metadataIndex = source.indexOf(metadataMarker, taskMarker.length);
  if (metadataIndex < 0 || source.indexOf(metadataMarker, metadataIndex + 1) >= 0) malformed();
  const resultIndex = source.indexOf(resultMarker, metadataIndex + metadataMarker.length);
  if (resultIndex >= 0 && source.indexOf(resultMarker, resultIndex + 1) >= 0) malformed();

  const task = markdown(source.slice(taskMarker.length, metadataIndex));
  const metadataEnd = resultIndex < 0 ? source.length : resultIndex;
  const metadata = markdown(source.slice(metadataIndex + metadataMarker.length, metadataEnd));
  if (resultIndex < 0) return Object.freeze({ task, metadata });

  const terminal = source.slice(resultIndex + resultMarker.length);
  const newline = terminal.indexOf("\n");
  if (newline < 0 || !terminal.startsWith(UPDATED_AT_PREFIX)) malformed();
  let updated_at: string;
  try {
    updated_at = parseLinearDescriptionTimestamp(terminal.slice(UPDATED_AT_PREFIX.length, newline));
  } catch {
    return malformed();
  }
  const result = markdown(terminal.slice(newline).replace(/^\n+/u, ""));
  return Object.freeze({ task, metadata, result, updated_at });
}

export function appendManagedIssueResult(
  description: string,
  updatedAt: string,
  result: MarkdownText | string,
): MarkdownText {
  const parsed = parseManagedIssueDescription(description);
  if (parsed.result !== undefined) throw new Error("linear_issue_description_result_exists");
  let timestamp: string;
  try {
    timestamp = parseLinearDescriptionTimestamp(updatedAt);
  } catch {
    return malformed();
  }
  return markdown(`${description}\n\n${RESULT_HEADING}\n\n${UPDATED_AT_PREFIX}${timestamp}\n\n${markdown(result)}`);
}
