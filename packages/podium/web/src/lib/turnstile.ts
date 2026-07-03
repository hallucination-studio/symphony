type TurnstileTokenProvider = () => string;

let provider: TurnstileTokenProvider = envTurnstileToken;

export function getTurnstileToken(): string {
  return provider();
}

export function setTurnstileTokenProvider(next: TurnstileTokenProvider): void {
  provider = next;
}

export function resetTurnstileTokenProvider(): void {
  provider = envTurnstileToken;
}

function envTurnstileToken(): string {
  const token = import.meta.env.VITE_TURNSTILE_TOKEN;
  if (!token) {
    throw new Error(
      "Turnstile token is not configured. Set VITE_TURNSTILE_TOKEN or install a Turnstile widget provider.",
    );
  }
  return token;
}
