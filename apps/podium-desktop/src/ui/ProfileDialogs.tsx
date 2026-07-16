import { useEffect, useRef, useState } from "react";

import type {
  CodexTurnSettings,
  CommandHandler,
  DesktopCommandResult,
  SecretHandler,
} from "./types";

type SubmissionStatus = "editing" | "pending" | "confirmed" | "error";

export function ProfileDialog({ conductorId, onClose, onCommand }: { conductorId: string; onClose: () => void; onCommand: CommandHandler }) {
  const [authenticationMethod, setAuthenticationMethod] = useState<"chatgpt" | "api_key">("chatgpt");
  const [isFastModeEnabled, setIsFastModeEnabled] = useState(true);
  const [status, setStatus] = useState<SubmissionStatus>("editing");
  const dialogRef = useRef<HTMLElement>(null);
  useDialogFocus(dialogRef, onClose);

  async function submit(form: HTMLFormElement) {
    const formData = new FormData(form);
    form.reset();
    setStatus("pending");
    try {
      const result = await onCommand({
        kind: "create_performer_profile",
        conductorId,
        displayName: String(formData.get("displayName") ?? ""),
        authenticationMethod,
        codexTurnSettings: {
          model: String(formData.get("model") ?? ""),
          reasoningEffort: String(
            formData.get("reasoningEffort"),
          ) as CodexTurnSettings["reasoningEffort"],
          isFastModeEnabled:
            authenticationMethod === "chatgpt" && isFastModeEnabled,
        },
      });
      setStatus(statusFromResult(result));
    } catch {
      setStatus("error");
    }
  }

  return (
    <DialogFrame dialogRef={dialogRef} labelId="profile-title">
      <h2 id="profile-title">Configure Codex profile</h2>
      {status === "pending" && <StatusMessage title="Waiting for Conductor confirmation" body="Settings remain unchanged until Conductor accepts them." />}
      {status === "confirmed" && <StatusMessage title="Profile confirmed" body="Complete login, then activate it for new Roots." action={<button className="button primary" onClick={onClose}>Done</button>} />}
      {status === "error" && <StatusMessage isError title="Profile was not created" body="Conductor rejected the change. Review the settings and try again." action={<button className="button" onClick={() => setStatus("editing")}>Try again</button>} />}
      {status === "editing" && (
        <form onSubmit={(event) => { event.preventDefault(); void submit(event.currentTarget); }}>
          <label>Display name<input name="displayName" required defaultValue="Codex" /></label>
          <fieldset>
            <legend>Authentication</legend>
            <label><input type="radio" name="authentication" checked={authenticationMethod === "chatgpt"} onChange={() => setAuthenticationMethod("chatgpt")} /> Sign in with ChatGPT</label>
            <label><input type="radio" name="authentication" aria-label="Use API Key" checked={authenticationMethod === "api_key"} onChange={() => { setAuthenticationMethod("api_key"); setIsFastModeEnabled(false); }} /> Use API Key</label>
          </fieldset>
          <label>Model<input name="model" required defaultValue="gpt-5" /></label>
          <label>Reasoning effort<select name="reasoningEffort" aria-label="Reasoning effort" defaultValue="high"><option value="none">None</option><option value="minimal">Minimal</option><option value="low">Low</option><option value="medium">Medium</option><option value="high">High</option><option value="xhigh">Extra high</option></select></label>
          <label><input type="checkbox" aria-label="Fast mode" checked={isFastModeEnabled} disabled={authenticationMethod === "api_key"} onChange={(event) => setIsFastModeEnabled(event.target.checked)} /> Fast mode</label>
          <p className="quiet">{authenticationMethod === "api_key" ? "Fast unavailable for API Key Profiles." : "Fast applies on the next Turn."}</p>
          <div className="button-row"><button className="button" type="button" onClick={onClose}>Cancel</button><button className="button primary" type="submit">Save profile</button></div>
        </form>
      )}
    </DialogFrame>
  );
}

export function ApiKeyDialog({ conductorId, profileId, onClose, onSecret }: { conductorId: string; profileId: string; onClose: () => void; onSecret: SecretHandler }) {
  const [status, setStatus] = useState<SubmissionStatus>("editing");
  const dialogRef = useRef<HTMLElement>(null);
  useDialogFocus(dialogRef, onClose);

  async function submit(form: HTMLFormElement) {
    const secret = String(new FormData(form).get("apiKey") ?? "");
    form.reset();
    setStatus("pending");
    try {
      const result = await onSecret(conductorId, profileId, secret);
      setStatus(statusFromResult(result));
    } catch {
      setStatus("error");
    }
  }

  return (
    <DialogFrame dialogRef={dialogRef} labelId="api-key-title">
      <h2 id="api-key-title">Set Codex API Key</h2>
      {status === "pending" && <StatusMessage title="Waiting for Conductor confirmation" body="The key will not be displayed again." />}
      {status === "confirmed" && <StatusMessage title="API Key configured" body="The key will not be displayed again." action={<button className="button primary" onClick={onClose}>Done</button>} />}
      {status === "error" && <StatusMessage isError title="API Key was not accepted" body="Nothing was saved. Enter the key again to retry." action={<button className="button" onClick={() => setStatus("editing")}>Try again</button>} />}
      {status === "editing" && (
        <form onSubmit={(event) => { event.preventDefault(); void submit(event.currentTarget); }}>
          <label>API Key<input name="apiKey" aria-label="API Key" type="password" autoComplete="off" required /></label>
          <div className="button-row"><button className="button" type="button" onClick={onClose}>Cancel</button><button className="button primary" type="submit">Set API Key</button></div>
        </form>
      )}
    </DialogFrame>
  );
}

function DialogFrame({ dialogRef, labelId, children }: { dialogRef: React.RefObject<HTMLElement>; labelId: string; children: React.ReactNode }) {
  return <div className="dialog-backdrop"><section ref={dialogRef} className="dialog" role="dialog" aria-modal="true" aria-labelledby={labelId}>{children}</section></div>;
}

function StatusMessage({ title, body, action, isError = false }: { title: string; body: string; action?: React.ReactNode; isError?: boolean }) {
  return <div role={isError ? "alert" : "status"}><strong>{title}</strong><p>{body}</p>{action}</div>;
}

function statusFromResult(result: DesktopCommandResult): SubmissionStatus {
  if (result.kind === "confirmed") return "confirmed";
  if (result.kind === "rejected") return "error";
  return "pending";
}

function useDialogFocus(dialogRef: React.RefObject<HTMLElement>, onClose: () => void) {
  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const dialog = dialogRef.current;
    const selector = 'button:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';
    dialog?.querySelector<HTMLElement>(selector)?.focus();
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== "Tab" || !dialog) return;
      const focusable = [...dialog.querySelectorAll<HTMLElement>(selector)];
      const first = focusable[0];
      const last = focusable.at(-1);
      if (!first || !last) return;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      previousFocus?.focus();
    };
  }, [dialogRef, onClose]);
}
