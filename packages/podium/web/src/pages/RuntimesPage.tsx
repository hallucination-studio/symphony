import { useState } from "react";
import { useRuntimes } from "../api/hooks";
import { PageHeader, QueryState } from "../components/PageState";
import { Card } from "../components/Card";
import { EmptyState } from "../components/EmptyState";
import { StatusBadge } from "../components/StatusBadge";
import { Drawer, DetailList } from "../components/Drawer";
import { InstallCommandCard } from "../components/InstallCommandCard";
import { useEnrollment } from "../lib/enrollment";
import { formatDateTime, relativeTime } from "../lib/format";
import type { RuntimeRecord } from "../api/types";

export default function RuntimesPage() {
  const { data, isLoading, error } = useRuntimes();
  const runtimes = data?.runtimes ?? [];
  const [selected, setSelected] = useState<RuntimeRecord | null>(null);

  return (
    <>
      <PageHeader
        title="Runtimes"
        description="Machines enrolled to execute agent work."
      />
      <QueryState isLoading={isLoading} error={error}>
        {runtimes.length === 0 ? (
          <Card>
            <EmptyState
              icon="🖥️"
              title="No runtimes yet"
              description="Install your first runtime to start executing agent work."
              actionLabel="Install a runtime"
              actionTo="/setup/runtime"
            />
          </Card>
        ) : (
          <Card>
            <ul className="runtime-list">
              {runtimes.map((runtime) => (
                <li key={runtime.runtime_id}>
                  <button
                    type="button"
                    className="runtime-row"
                    data-selected={
                      runtime.runtime_id === selected?.runtime_id || undefined
                    }
                    onClick={() => setSelected(runtime)}
                  >
                    <div>
                      <div className="runtime-id">{runtime.runtime_id}</div>
                      <div className="runtime-sub">
                        {runtime.version
                          ? `v${runtime.version}`
                          : "version unknown"}
                        {" · "}
                        {runtime.last_heartbeat
                          ? `heartbeat ${relativeTime(runtime.last_heartbeat)}`
                          : "no heartbeat"}
                      </div>
                    </div>
                    <div className="runtime-meta">
                      <StatusBadge
                        status={runtime.online ? "online" : "offline"}
                      />
                    </div>
                  </button>
                </li>
              ))}
            </ul>
          </Card>
        )}
      </QueryState>

      {selected ? (
        <RuntimeDrawer
          runtime={selected}
          onClose={() => setSelected(null)}
        />
      ) : null}
    </>
  );
}

function RuntimeDrawer({
  runtime,
  onClose,
}: {
  runtime: RuntimeRecord;
  onClose: () => void;
}) {
  const enrollment = useEnrollment({
    online: runtime.online,
    successMessage: "New install command ready",
    errorMessage: "Couldn't regenerate the command. Try again.",
  });

  const hostname =
    typeof runtime.metadata?.hostname === "string"
      ? (runtime.metadata.hostname as string)
      : null;

  return (
    <Drawer title={runtime.runtime_id} onClose={onClose}>
      <div className="row-between" style={{ marginBottom: "var(--space-4)" }}>
        <span className="muted">Status</span>
        <StatusBadge status={runtime.online ? "online" : "offline"} />
      </div>

      <DetailList
        rows={[
          { key: "Runtime ID", value: <code className="code">{runtime.runtime_id}</code> },
          { key: "Version", value: runtime.version ?? "—" },
          { key: "Hostname", value: hostname ?? "—" },
          {
            key: "Last heartbeat",
            value: formatDateTime(runtime.last_heartbeat),
          },
        ]}
      />

      {!runtime.online ? (
        <div style={{ marginTop: "var(--space-5)" }}>
          <div className="scope-section-title">Reconnect this runtime</div>
          {enrollment.command && enrollment.token ? (
            <InstallCommandCard
              command={enrollment.command}
              token={enrollment.token}
              expiresLabel={enrollment.expiresLabel}
              phase={enrollment.phase}
              onRegenerate={enrollment.regenerate}
              regenerating={enrollment.regenerating}
            />
          ) : (
            <button
              type="button"
              className="link-button"
              onClick={enrollment.regenerate}
              disabled={enrollment.regenerating}
            >
              {enrollment.regenerating
                ? "Generating…"
                : "Regenerate install command"}
            </button>
          )}
        </div>
      ) : null}
    </Drawer>
  );
}
