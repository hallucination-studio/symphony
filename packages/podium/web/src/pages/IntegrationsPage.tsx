import { useBootstrap, useLinearProjectSelection } from "../api/hooks";
import { PageHeader, QueryState } from "../components/PageState";
import { Card } from "../components/Card";
import { LinearApplicationSetup } from "../components/LinearApplicationSetup";
import { ActionPanel } from "../components/ActionPanel";
import { Button } from "../components/Button";
import { LinearProjectSelector } from "../components/LinearProjectSelector";
import { useToast } from "../components/Toast";
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
          <>
            <Card
              title={t("Linear")}
              description={t("Application authorization and polling health.")}
            >
              <LinearApplicationSetup linear={bootstrap.data.linear} />
            </Card>
            {bootstrap.data.linear.state === "connected" ? <LinearProjectsCard /> : null}
          </>
        ) : null}
      </QueryState>
    </>
  );
}

function LinearProjectsCard() {
  const selection = useLinearProjectSelection();
  const { notify } = useToast();
  const { t } = useI18n();

  async function save() {
    try {
      await selection.save();
      notify(t("Projects saved"), "success");
    } catch {
      notify(t("Couldn't save projects. Try again."), "error");
    }
  }

  return (
    <Card
      title={t("Linear projects")}
      description={t("Choose the projects Symphony may bind to Conductors.")}
      actions={
        <Button
          onClick={save}
          loading={selection.saving}
          disabled={!selection.canSave || selection.query.isLoading || selection.query.isError}
        >
          {t("Save projects")}
        </Button>
      }
    >
      {selection.query.isLoading ? (
        <p className="state-message">{t("Loading Linear projects…")}</p>
      ) : selection.query.isError ? (
        <ActionPanel
          tone="critical"
          title={t("Couldn't load Linear projects")}
          description={t("Reauthorize Linear, then review the available projects again.")}
        />
      ) : (
        <LinearProjectSelector
          projects={selection.projects}
          selected={selection.selected}
          disabled={selection.saving}
          onToggle={selection.toggle}
          onSelectAll={selection.selectAll}
        />
      )}
    </Card>
  );
}
