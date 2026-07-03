type TurnstileTokenProvider = () => string;

let provider: TurnstileTokenProvider = defaultTurnstileToken;

export function getTurnstileToken(): string {
  return provider();
}

export function setTurnstileTokenProvider(next: TurnstileTokenProvider): void {
  provider = next;
}

export function resetTurnstileTokenProvider(): void {
  provider = defaultTurnstileToken;
}

function defaultTurnstileToken(): string {
  return "";
}
