import { useEffect, useRef, useState, type MutableRefObject, type RefObject } from "react";
import { useConfig } from "../api/hooks";

const TURNSTILE_SCRIPT_SRC =
  "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";

type TurnstileOptions = {
  sitekey: string;
  callback: (token: string) => void;
  "expired-callback": () => void;
  "error-callback": () => void;
};

type TurnstileApi = {
  render: (container: HTMLElement, options: TurnstileOptions) => string;
  remove?: (widgetId: string) => void;
  reset?: (widgetId: string) => void;
};

declare global {
  interface Window {
    turnstile?: TurnstileApi;
  }
}

let scriptPromise: Promise<void> | null = null;

export function TurnstileWidget({
  onToken,
  onReadyChange,
}: {
  onToken: (token: string) => void;
  onReadyChange: (ready: boolean) => void;
}) {
  const { data: config, isLoading, isError } = useConfig();
  const containerRef = useRef<HTMLDivElement | null>(null);
  const widgetIdRef = useRef<string | null>(null);
  const [scriptReady, setScriptReady] = useState(false);
  const enabled = Boolean(config?.turnstile.enabled && config.turnstile.site_key);

  useTurnstileReadiness({ enabled, isError, isLoading, onReadyChange, onToken });
  useTurnstileScript({ enabled, onReadyChange, onToken, setScriptReady });
  useTurnstileRender({ config, containerRef, enabled, onReadyChange, onToken, scriptReady, widgetIdRef });

  if (!enabled) return null;

  return (
    <div
      ref={containerRef}
      className="turnstile-widget"
      data-testid="turnstile-widget"
    />
  );
}

function useTurnstileReadiness({ enabled, isError, isLoading, onReadyChange, onToken }: { enabled: boolean; isError: boolean; isLoading: boolean; onReadyChange: (ready: boolean) => void; onToken: (token: string) => void }) {
  useEffect(() => {
    if (isLoading) {
      onReadyChange(false);
      onToken("");
      return;
    }
    if (isError || !enabled) {
      onToken("");
      onReadyChange(!isError);
      return;
    }
    onToken("");
    onReadyChange(false);
  }, [enabled, isError, isLoading, onReadyChange, onToken]);
}

function useTurnstileScript({ enabled, onReadyChange, onToken, setScriptReady }: { enabled: boolean; onReadyChange: (ready: boolean) => void; onToken: (token: string) => void; setScriptReady: (ready: boolean) => void }) {
  useEffect(() => {
    if (!enabled) {
      setScriptReady(false);
      return;
    }
    let cancelled = false;
    setScriptReady(false);
    loadTurnstileScript()
      .then(() => {
        if (!cancelled) setScriptReady(true);
      })
      .catch(() => {
        if (!cancelled) {
          onToken("");
          onReadyChange(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [enabled, onReadyChange, onToken, setScriptReady]);
}

function useTurnstileRender({ config, containerRef, enabled, onReadyChange, onToken, scriptReady, widgetIdRef }: { config: ReturnType<typeof useConfig>["data"]; containerRef: RefObject<HTMLDivElement | null>; enabled: boolean; onReadyChange: (ready: boolean) => void; onToken: (token: string) => void; scriptReady: boolean; widgetIdRef: MutableRefObject<string | null> }) {
  useEffect(() => {
    if (!enabled || !scriptReady || !containerRef.current || !config) return;
    if (!window.turnstile) {
      onToken("");
      onReadyChange(false);
      return;
    }

    const widgetId = window.turnstile.render(containerRef.current, {
      sitekey: config.turnstile.site_key,
      callback: (token: string) => {
        onToken(token);
        onReadyChange(Boolean(token));
      },
      "expired-callback": () => {
        onToken("");
        onReadyChange(false);
      },
      "error-callback": () => {
        onToken("");
        onReadyChange(false);
      },
    });
    widgetIdRef.current = widgetId;

    return () => {
      if (widgetIdRef.current && window.turnstile?.remove) {
        window.turnstile.remove(widgetIdRef.current);
      } else if (widgetIdRef.current && window.turnstile?.reset) {
        window.turnstile.reset(widgetIdRef.current);
      }
      widgetIdRef.current = null;
      onToken("");
      onReadyChange(false);
    };
  }, [config, containerRef, enabled, onReadyChange, onToken, scriptReady, widgetIdRef]);
}

function loadTurnstileScript(): Promise<void> {
  if (window.turnstile) return Promise.resolve();
  if (scriptPromise) return scriptPromise;

  const existing = document.querySelector<HTMLScriptElement>(
    `script[src="${TURNSTILE_SCRIPT_SRC}"]`,
  );
  if (existing) {
    scriptPromise = new Promise((resolve, reject) => {
      existing.addEventListener("load", () => resolve(), { once: true });
      existing.addEventListener("error", () => reject(new Error("turnstile_script_error")), {
        once: true,
      });
    });
    return scriptPromise;
  }

  scriptPromise = new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = TURNSTILE_SCRIPT_SRC;
    script.async = true;
    script.defer = true;
    script.addEventListener("load", () => resolve(), { once: true });
    script.addEventListener("error", () => reject(new Error("turnstile_script_error")), {
      once: true,
    });
    document.head.appendChild(script);
  });
  return scriptPromise;
}
