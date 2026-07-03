import { useState } from "react";
import { useEnrollmentToken, useRuntimes } from "../api/hooks";
import { PageHeader, QueryState } from "../components/PageState";
import { Card } from "../components/Card";
import { EmptyState } from "../components/EmptyState";
import { StatusBadge } from "../components/StatusBadge";
import { Drawer, DetailList } from "../components/Drawer";
import {
  InstallCommandCard,
  type EnrollmentPhase,
} from "../components/InstallCommandCard";
import { useToast } from "../components/Toast";
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
  const generate = useEnrollmentToken();
  const { notify } = useToast();
  const [command, setCommand] = useState<string | null>(null);
  const [token, setToken] = useState<string | null>(null);

  const hostname =
    typeof runtime.metadata?.hostname === "string"
      ? (runtime.metadata.hostname as string)
      : null;

  async function regenerate() {
    try {
      const res = await generate.mutateAsync();
      setCommand(res.install_command);
      setToken(res.enrollment_token);
      notify("New install command ready", "success");
    } catch {
      notify("Couldn't regenerate the command. Try again.", "error");
    }
  }

  const phase: EnrollmentPhase = runtime.online ? "online" : "idle";

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
          {command && token ? (
            <InstallCommandCard
              command={command}
              token={token}
              expiresLabel="Single-use token"
              phase={phase}
              onRegenerate={regenerate}
              regenerating={generate.isPending}
            />
          ) : (
            <button
              type="button"
              className="link-button"
              onClick={regenerate}
              disabled={generate.isPending}
            >
              {generate.isPending
                ? "Generating…"
                : "Regenerate install command"}
            </button>
          )}
        </div>
      ) : null}
    </Drawer>
  );
}
