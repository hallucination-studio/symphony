import { useBootstrap } from "../api/hooks";
import { PageHeader, QueryState } from "../components/PageState";
import { Card } from "../components/Card";
import { LinearApplicationSetup } from "../components/LinearApplicationSetup";
import { useI18n } from "../i18n";

export default function IntegrationsPage() {
  const bootstrap = useBootstrap();
  const { t } = useI18n();

  return (
    <>
      <PageHeader
        title={t("Integrations")}
        description={t("Connected services for this workspace.")}
      />
      <QueryState isLoading={bootstrap.isLoading} error={bootstrap.error}>
        {bootstrap.data ? (
          <Card
            title={t("Linear")}
            description={t("Application authorization and polling health.")}
          >
            <LinearApplicationSetup linear={bootstrap.data.linear} />
          </Card>
        ) : null}
      </QueryState>
    </>
  );
}
