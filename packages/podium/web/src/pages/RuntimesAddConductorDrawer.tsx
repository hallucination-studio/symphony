import { useState, type FormEvent } from "react";
import type { ConductorRecord } from "../api/types";
import { ActionPanel } from "../components/ActionPanel";
import { Button } from "../components/Button";
import { DetailList, Drawer } from "../components/Drawer";
import { InstallCommandCard } from "../components/InstallCommandCard";
import { useI18n } from "../i18n";
import { useEnrollment } from "../lib/enrollment";

export function RuntimesAddConductorDrawer({
  conductor,
  onClose,
}: {
  conductor?: ConductorRecord | null;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const [name, setName] = useState("");
  const enrollment = useEnrollment({
    pollRuntimes: true,
    initialConductor: conductor ?? null,
    successMessage: "New install command ready",
  });
  const identity = enrollment.conductor;
  const publicIdentity = identity
    ? `${identity.name}-${identity.public_id}`
    : null;

  function close() {
    enrollment.clearTransient();
    onClose();
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    void enrollment.regenerate(name.trim());
  }

  return (
    <Drawer
      title={conductor ? t("Continue Conductor installation") : t("Add Conductor")}
      onClose={close}
    >
      {identity ? (
        <DetailList
          rows={[
            { key: t("Conductor"), value: <code className="code">{publicIdentity}</code> },
            { key: t("Status"), value: enrollment.isOnline ? t("Online") : t("Pending") },
          ]}
        />
      ) : null}

      {enrollment.isOnline ? (
        <div className="runtime-install-section">
          <ActionPanel
            tone="success"
            title={t("Runtime connected")}
            description={t("The Conductor is online and remains unbound until you bind a project.")}
          />
        </div>
      ) : enrollment.command && enrollment.token ? (
        <div className="runtime-install-section">
          <InstallCommandCard
            command={enrollment.command}
            token={enrollment.token}
            expiresLabel={enrollment.expiresLabel}
            phase={enrollment.phase}
            onRegenerate={() => void enrollment.regenerate()}
            regenerating={enrollment.regenerating}
          />
        </div>
      ) : identity ? (
        <div className="runtime-install-section">
          <ActionPanel
            tone="info"
            title={t("Generate an install command")}
            description={t("Creates a replacement single-use command for this pending Conductor.")}
            actionLabel={t("Generate install command")}
            onAction={() => void enrollment.regenerate()}
            actionLoading={enrollment.regenerating}
          />
        </div>
      ) : (
        <form onSubmit={submit}>
          <div className="field">
            <label className="field-label" htmlFor="conductor-name">
              {t("Conductor name")}
            </label>
            <input
              id="conductor-name"
              className="text-input"
              value={name}
              onChange={(event) => setName(event.target.value)}
              required
              maxLength={16}
              pattern="[A-Za-z][A-Za-z0-9]{0,15}"
              autoComplete="off"
            />
            <span className="field-hint">
              {t("Use one ASCII word, starting with a letter, up to 16 characters.")}
            </span>
          </div>
          <Button type="submit" loading={enrollment.regenerating}>
            {t("Generate install command")}
          </Button>
        </form>
      )}
    </Drawer>
  );
}
