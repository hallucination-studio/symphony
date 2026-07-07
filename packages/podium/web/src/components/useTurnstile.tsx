import { useState } from "react";
import { TurnstileWidget } from "./TurnstileWidget";

export function useTurnstile() {
  const [token, setToken] = useState("");
  const [ready, setReady] = useState(false);

  return {
    token,
    ready,
    widget: (
      <TurnstileWidget onToken={setToken} onReadyChange={setReady} />
    ),
  };
}
