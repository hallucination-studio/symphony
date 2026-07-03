import { Button } from "./Button";
import { StatusBadge } from "./StatusBadge";
import { useCopy } from "../lib/useCopy";
import { useI18n } from "../i18n";

export type EnrollmentPhase = "idle" | "waiting" | "online";

/**
 * The runtime install card: a copyable one-liner plus the live enrollment
 * state. While waiting it polls (driven by the parent); once a runtime comes
 * online it flips to a connected confirmation.
 */
export function InstallCommandCard({
  command,
  token,
  expiresLabel,
  phase,
  onRegenerate,
  regenerating,
}: {
  command: string;
  token?: string;
  expiresLabel?: string;
  phase: EnrollmentPhase;
  onRegenerate?: () => void;
  regenerating?: boolean;
}) {
  const copy = useCopy();
  const { t } = useI18n();

  return (
    <div className="install-card">
      <div className="install-command">
        <code className="install-command-text">{command}</code>
        <Button
          variant="secondary"
          onClick={() => copy(command, t("Install command copied"))}
        >
          {t("Copy")}
        </Button>
      </div>

      <div className="install-meta">
        {token ? (
          <span className="install-meta-item">
            {t("Enrollment token")}{" "}
            <code className="code install-token">{token}</code>
          </span>
        ) : null}
        {expiresLabel ? (
          <span className="install-meta-item muted">{expiresLabel}</span>
        ) : null}
        {onRegenerate ? (
          <button
            type="button"
            className="link-button"
            onClick={onRegenerate}
            disabled={regenerating}
          >
            {regenerating ? t("Regenerating…") : t("Regenerate command")}
          </button>
        ) : null}
      </div>

      <div className="install-status" data-phase={phase}>
        {phase === "online" ? (
          <>
            <StatusBadge status="online" />
            <span>{t("Runtime connected. You're ready for the next step.")}</span>
          </>
        ) : phase === "waiting" ? (
          <>
            <span className="btn-spinner dark" aria-hidden />
            <span>{t("Waiting for the runtime to check in…")}</span>
          </>
        ) : (
          <span className="muted">
            {t("Run the command above on your runtime machine.")}
          </span>
        )}
      </div>
    </div>
  );
}
