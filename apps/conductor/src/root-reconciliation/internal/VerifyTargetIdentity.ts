export const IMMUTABLE_VERIFY_TARGET_TITLE_PREFIX = "Immutable Verify target: ";

export function immutableVerifyTargetTitle(revision: string): string {
  return `${IMMUTABLE_VERIFY_TARGET_TITLE_PREFIX}${revision}`;
}
