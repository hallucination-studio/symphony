import { useRuntimes } from "../api/hooks";
import { PageHeader, QueryState } from "../components/PageState";

export default function RuntimesPage() {
  const { data, isLoading, error } = useRuntimes();
  const runtimes = data?.runtimes ?? [];

  return (
    <>
      <PageHeader
        title="Runtimes"
        description="Enrolled execution runtimes for this workspace."
      />
      <QueryState isLoading={isLoading} error={error}>
        {runtimes.length === 0 ? (
          <div className="card">
            <p className="muted" style={{ margin: 0 }}>
              No runtimes enrolled yet.
            </p>
          </div>
        ) : (
          <div className="card">
            <ul className="step-list">
              {runtimes.map((runtime) => (
                <li className="step" key={runtime.id}>
                  <div className="step-body">
                    <div className="step-title code">{runtime.id}</div>
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
