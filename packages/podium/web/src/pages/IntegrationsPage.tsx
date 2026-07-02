import { useBootstrap } from "../api/hooks";
import { PageHeader, QueryState } from "../components/PageState";
import { StatusBadge } from "../components/StatusBadge";

export default function IntegrationsPage() {
  const { data, isLoading, error } = useBootstrap();

  return (
    <>
      <PageHeader
        title="Integrations"
        description="Connected services for this workspace."
      />
      <QueryState isLoading={isLoading} error={error}>
        {data ? (
          <div className="card">
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
              }}
            >
              <div>
                <div className="step-title">Linear</div>
                <div className="step-summary">
                  Workspace{" "}
                  <span className="code">{data.linear.workspace_id}</span>
                </div>
              </div>
              <StatusBadge
                status={
                  data.linear.state === "connected"
                    ? "completed"
                    : "not_started"
                }
              />
            </div>
          </div>
        ) : null}
      </QueryState>
    </>
  );
}
