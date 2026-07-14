import { useState } from "react";
import { useRuntimes } from "../api/hooks";
import { PageHeader, QueryState } from "../components/PageState";
import { Card } from "../components/Card";
import { EmptyState } from "../components/EmptyState";
import { StatusBadge } from "../components/StatusBadge";
import { Button } from "../components/Button";
import { relativeTime } from "../lib/format";
import type { ConductorBinding, ConductorRecord, RuntimeRecord } from "../api/types";
import { useI18n } from "../i18n";
import {
  ConductorCard,
  ReconnectDrawer,
} from "./RuntimesPage.components";
import { RuntimesPerformerDrawer } from "./RuntimesPerformerDrawer";
import { RuntimesAddConductorDrawer } from "./RuntimesAddConductorDrawer";
import { RuntimesBindProjectDrawer } from "./RuntimesBindProjectDrawer";

interface SelectedPerformer {
  conductor: ConductorRecord;
  performer: ConductorBinding;
}

export default function RuntimesPage() {
  const { data, isLoading, error } = useRuntimes();
  const conductors = data?.conductors ?? [];
  const runtimes = data?.runtimes ?? [];
  const [selected, setSelected] = useState<SelectedPerformer | null>(null);
  const [reconnect, setReconnect] = useState<RuntimeRecord | null>(null);
  const [installing, setInstalling] = useState<ConductorRecord | "new" | null>(null);
  const [binding, setBinding] = useState<ConductorRecord | null>(null);

  // Conductors that have never posted a report show only as bare runtimes;
  // surface those separately so the operator can still reconnect them.
  const reportedIds = new Set(conductors.map((c) => c.conductor_id));
  const unreported = runtimes.filter((r) => !reportedIds.has(r.runtime_id));
  const isEmpty = conductors.length === 0 && runtimes.length === 0;
  const { t } = useI18n();

  return (
    <>
      <div className="runtimes-heading">
        <PageHeader
          title={t("Runtimes")}
          description={t("Conductors on your machines and the Performers they operate.")}
        />
        <Button type="button" onClick={() => setInstalling("new")}>
          {t("Add Conductor")}
        </Button>
      </div>
      <QueryState isLoading={isLoading} error={error}>
        {isEmpty ? (
          <Card>
            <EmptyState
              title={t("No runtimes yet")}
              description={t("Install your first Conductor to start operating Performers.")}
            />
          </Card>
        ) : (
          <div className="conductor-stack">
            {conductors.map((conductor) => (
              <ConductorCard
                key={conductor.conductor_id}
                conductor={conductor}
                selectedId={selected?.performer.id ?? null}
                onSelect={(performer) => setSelected({ conductor, performer })}
                onContinueInstall={() => setInstalling(conductor)}
                onBind={() => setBinding(conductor)}
              />
            ))}
            {unreported.length > 0 ? (
              <Card
                title={t("Awaiting first report")}
                description={t("Enrolled runtimes that haven't reported Performers yet.")}
              >
                <ul className="runtime-list">
                  {unreported.map((runtime) => (
                    <li key={runtime.runtime_id}>
                      <button
                        type="button"
                        className="runtime-row"
                        onClick={() => setReconnect(runtime)}
                      >
                        <div>
                          <div className="runtime-id">{runtime.runtime_id}</div>
                          <div className="runtime-sub">
                            {runtime.last_heartbeat
                              ? t("heartbeat {time}", { time: relativeTime(runtime.last_heartbeat) })
                              : t("no heartbeat")}
                          </div>
                        </div>
                        <StatusBadge status={runtime.online ? "online" : "offline"} />
                      </button>
                    </li>
                  ))}
                </ul>
              </Card>
            ) : null}
          </div>
        )}
      </QueryState>

      {selected ? (
        <RuntimesPerformerDrawer
          conductorId={selected.conductor.conductor_id}
          performerName={selected.performer.name}
          conductor={selected.conductor}
          performer={selected.performer}
          onClose={() => setSelected(null)}
        />
      ) : null}
      {reconnect ? (
        <ReconnectDrawer runtime={reconnect} onClose={() => setReconnect(null)} />
      ) : null}
      {installing ? (
        <RuntimesAddConductorDrawer
          conductor={installing === "new" ? null : installing}
          onClose={() => setInstalling(null)}
        />
      ) : null}
      {binding ? (
        <RuntimesBindProjectDrawer
          conductor={binding}
          onClose={() => setBinding(null)}
        />
      ) : null}
    </>
  );
}
