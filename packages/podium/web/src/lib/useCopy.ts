import { useCallback } from "react";
import { useToast } from "../components/Toast";

/**
 * Returns a copy function that writes text to the clipboard and shows a toast.
 * Falls back to a legacy execCommand path where the async clipboard API is
 * unavailable (older browsers, insecure contexts, jsdom).
 */
export function useCopy() {
  const { notify } = useToast();

  return useCallback(
    async (text: string, confirmation = "Copied to clipboard") => {
      try {
        if (navigator.clipboard?.writeText) {
          await navigator.clipboard.writeText(text);
        } else {
          legacyCopy(text);
        }
        notify(confirmation, "success");
        return true;
      } catch {
        notify("Couldn't copy. Select the text and copy manually.", "error");
        return false;
      }
    },
    [notify],
  );
}

function legacyCopy(text: string): void {
  const el = document.createElement("textarea");
  el.value = text;
  el.setAttribute("readonly", "");
  el.style.position = "absolute";
  el.style.left = "-9999px";
  document.body.appendChild(el);
  el.select();
  document.execCommand("copy");
  document.body.removeChild(el);
}
