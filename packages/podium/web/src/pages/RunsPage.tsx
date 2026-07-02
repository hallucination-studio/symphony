import { useRecentRuns } from "../api/hooks";
import { PageHeader, QueryState } from "../components/PageState";

export default function RunsPage() {
  const { data, isLoading, error } = useRecentRuns();
  const runs = data?.runs ?? [];

  return (
    <>
      <PageHeader
        title="Runs"
        description="Recent agent runs across your runtimes."
      />
      <QueryState isLoading={isLoading} error={error}>
        {runs.length === 0 ? (
          <div className="card">
            <p className="muted" style={{ margin: 0 }}>
              No runs recorded yet.
            </p>
          </div>
        ) : (
          <div className="card">
            <ul className="step-list">
              {runs.map((run) => (
                <li className="step" key={run.id}>
                  <div className="step-body">
                    <div className="step-title code">{run.id}</div>
                  </div>
                </li>
              ))}
            </ul>
          </div>
        )}
      </QueryState>
    </>
  );
}
