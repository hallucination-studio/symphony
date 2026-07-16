export interface ProtocolError {
  code: string;
  category: string;
  sanitizedReason: string;
  retryable: boolean;
  actionRequired: string;
  nextAction: string;
}

export class PodiumError extends Error {
  readonly protocolError: ProtocolError;

  constructor(protocolError: ProtocolError) {
    super(`${protocolError.code}: ${protocolError.sanitizedReason}`);
    this.name = "PodiumError";
    this.protocolError = protocolError;
  }
}

export function podiumError(
  code: string,
  sanitizedReason: string,
  options: Partial<Omit<ProtocolError, "code" | "sanitizedReason">> = {},
): PodiumError {
  return new PodiumError({
    code,
    category: options.category ?? "podium",
    sanitizedReason,
    retryable: options.retryable ?? false,
    actionRequired: options.actionRequired ?? "none",
    nextAction: options.nextAction ?? "Retry the operation.",
  });
}
