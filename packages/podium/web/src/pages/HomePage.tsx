import { useBootstrap } from "../api/hooks";
import { OnboardingSteps } from "../components/OnboardingSteps";
import { PageHeader, QueryState } from "../components/PageState";

export default function HomePage() {
  const { data, isLoading, error } = useBootstrap();

  return (
    <>
      <PageHeader
        title="Welcome to Podium"
        description="Set up your Symphony workspace and track onboarding progress."
      />
      <QueryState isLoading={isLoading} error={error}>
        {data ? (
          <>
            <div className="card">
              <h2 style={{ fontSize: 16, marginBottom: 4 }}>
                Onboarding
              </h2>
              <p className="muted" style={{ marginTop: 0, marginBottom: 16 }}>
                Workspace <span className="code">{data.session.workspace_id}</span>
                {" · "}Linear <span className="code">{data.linear.state}</span>
              </p>
              <OnboardingSteps progress={data.onboarding} />
            </div>
          </>
        ) : null}
      </QueryState>
    </>
  );
}
