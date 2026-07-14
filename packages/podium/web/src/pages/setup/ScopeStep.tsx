import { ActionPanel } from "../../components/ActionPanel";
import { useLinearProjectSelection } from "../../api/hooks";
import { LinearProjectSelector } from "../../components/LinearProjectSelector";
import { SetupStepShell } from "../../components/SetupStepShell";
import { useToast } from "../../components/Toast";
import { useI18n } from "../../i18n";
import type { StepProps } from "./types";

export function ScopeStep({
  stepNumber,
  stepCount,
  onNext,
  onBack,
}: StepProps) {
  const selection = useLinearProjectSelection();
  const { notify } = useToast();
  const { t } = useI18n();

  async function handleSave() {
    try {
      await selection.save();
      notify(t("Projects saved"), "success");
      onNext();
    } catch {
      notify(t("Couldn't save projects. Try again."), "error");
    }
  }

  return (
    <SetupStepShell
      stepNumber={stepNumber}
      stepCount={stepCount}
      title="Choose projects"
      description="Select the Linear projects Symphony may operate. You can manage this selection later from Integrations."
      onBack={onBack}
      onNext={handleSave}
      nextLabel="Save and continue"
      nextDisabled={!selection.canSave || selection.query.isLoading || selection.query.isError}
      nextLoading={selection.saving}
    >
      {selection.query.isLoading ? (
        <div className="state-message">{t("Loading Linear projects…")}</div>
      ) : selection.query.isError ? (
        <ActionPanel
          tone="critical"
          title={t("Couldn't load Linear projects")}
          description={t("Check the Linear connection on the previous step, then try again.")}
          actionLabel={t("Back to Connect Linear")}
          onAction={onBack ?? (() => {})}
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
    </SetupStepShell>
  );
}
