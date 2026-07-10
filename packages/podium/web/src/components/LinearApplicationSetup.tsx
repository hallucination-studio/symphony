import type { LinearStatus } from "../api/types";
import { useLinearApplication, useLinearInstallations } from "../api/hooks";
import { ActionPanel } from "./ActionPanel";
import {
  ApplicationSourceControl,
  CustomApplicationForm,
  DefaultApplicationPanel,
} from "./LinearApplicationFields";
import { LinearInstallationStatus } from "./LinearInstallationStatus";
import { useLinearApplicationSetup } from "./useLinearApplicationSetup";
import { useI18n } from "../i18n";

export function LinearApplicationSetup({ linear }: { linear: LinearStatus }) {
  const applicationQuery = useLinearApplication();
  const installationsQuery = useLinearInstallations();
  const controller = useLinearApplicationSetup(applicationQuery.data?.application ?? null);
  const { t } = useI18n();
  const loading = applicationQuery.isLoading || installationsQuery.isLoading;
  const failed = applicationQuery.isError || installationsQuery.isError;

  if (loading) return <p className="state-message">{t("Loading Linear settings...")}</p>;
  if (failed || !controller.application || !installationsQuery.data) {
    return (
      <ActionPanel
        tone="critical"
        title={t("Linear application unavailable")}
        description={t("Ask an administrator to configure the Podium application.")}
      />
    );
  }

  const busy = controller.switching || controller.saving || controller.authorizing;
  return (
    <div className="linear-application-setup">
      <ApplicationSourceControl mode={controller.mode} disabled={busy} onChange={controller.selectMode} />
      {controller.mode === "default" ? (
        <DefaultApplicationPanel
          connected={linear.state === "connected"}
          loading={controller.switching || controller.authorizing}
          onAuthorize={controller.authorize}
        />
      ) : (
        <CustomApplicationForm
          clientId={controller.clientId}
          clientSecret={controller.clientSecret}
          callbackUrl={controller.application.callback_url}
          error={controller.error}
          loading={controller.saving || controller.authorizing}
          onClientIdChange={controller.setClientId}
          onClientSecretChange={controller.setClientSecret}
          onSubmit={controller.saveAndAuthorize}
        />
      )}
      <LinearInstallationStatus installations={installationsQuery.data} />
    </div>
  );
}
