import { useOnboardingStatus } from "../api/hooks";
import { OnboardingSteps } from "../components/OnboardingSteps";
import { PageHeader, QueryState } from "../components/PageState";

export default function SetupPage() {
  const { data, isLoading, error } = useOnboardingStatus();

  return (
    <>
      <PageHeader
        title="Setup"
        description="Complete each step to connect Linear, map a repository, and enroll a runtime."
      />
      <QueryState isLoading={isLoading} error={error}>
        {data ? (
          <div className="card">
            <OnboardingSteps progress={data} />
          </div>
        ) : null}
      </QueryState>
    </>
  );
}
