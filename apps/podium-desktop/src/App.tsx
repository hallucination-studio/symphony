import { useEffect, useRef, useState } from "react";

import { ConductorsPage } from "./ui/ConductorsPage";
import { OverviewPage } from "./ui/OverviewPage";
import { SetupView } from "./ui/SetupViews";
import { Shell, PageHeading } from "./ui/components";
import type {
  CommandHandler,
  DesktopState,
  Page,
  RepositorySelection,
  SecretHandler,
} from "./ui/types";
import { WorkPage } from "./ui/WorkPage";

const noCommand: CommandHandler = async () => ({ kind: "accepted" });
const noSecret: SecretHandler = async () => ({ kind: "accepted" });

export function App({
  initialState = { kind: "loading" },
  onCommand = noCommand,
  onSecret = noSecret,
  onChooseRepository = async () => undefined,
  onBeginCreateConductor = () => undefined,
  onOpenExternal = () => undefined,
}: {
  initialState?: DesktopState;
  onCommand?: CommandHandler;
  onSecret?: SecretHandler;
  onChooseRepository?: () => Promise<RepositorySelection | undefined>;
  onBeginCreateConductor?: () => void;
  onOpenExternal?: (url: string) => void;
}) {
  const [page, setPage] = useState<Page>("overview");
  const [rootId, setRootId] = useState<string>();
  const [conductorId, setConductorId] = useState<string>();
  const headingRef = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    headingRef.current?.focus();
  }, [page, rootId, conductorId]);

  if (initialState.kind !== "ready") {
    return (
      <SetupView
        state={initialState}
        onCommand={onCommand}
        onSecret={onSecret}
        onChooseRepository={onChooseRepository}
      />
    );
  }

  const { overview, rootDetail, conductorDetail } = initialState;
  function navigate(nextPage: Page) {
    setPage(nextPage);
    setRootId(undefined);
    setConductorId(undefined);
  }

  return (
    <Shell page={page} onNavigate={navigate}>
      {page === "overview" && (
        <OverviewPage view={overview} headingRef={headingRef} onOpenExternal={onOpenExternal} />
      )}
      {page === "work" && (
        <WorkPage
          roots={[...overview.activeRoots, ...overview.reviewRoots]}
          detail={rootId && rootDetail?.summary.rootIssueId === rootId ? rootDetail : undefined}
          headingRef={headingRef}
          onSelect={setRootId}
          onOpenExternal={onOpenExternal}
        />
      )}
      {page === "conductors" && (
        <ConductorsPage
          conductors={overview.conductors}
          detail={conductorId && conductorDetail?.summary.conductorId === conductorId ? conductorDetail : undefined}
          headingRef={headingRef}
          onSelect={setConductorId}
          onCommand={onCommand}
          onSecret={onSecret}
          onBeginCreateConductor={onBeginCreateConductor}
        />
      )}
      {page === "settings" && (
        <SettingsPage state={initialState} headingRef={headingRef} onCommand={onCommand} />
      )}
    </Shell>
  );
}

function SettingsPage({
  state,
  headingRef,
  onCommand,
}: {
  state: Extract<DesktopState, { kind: "ready" }>;
  headingRef: React.RefObject<HTMLHeadingElement>;
  onCommand: CommandHandler;
}) {
  const connection = state.overview.linearConnection;
  return (
    <>
      <PageHeading title="Settings" description="Desktop connection and application information." headingRef={headingRef} />
      <div className="page-stack">
        <section className="panel action-row">
          <div>
            <h2>Linear</h2>
            <p>{connection.workspaceName ?? "Workspace unavailable"} · {connection.status === "connected" ? "Connected" : "Reconnect required"}</p>
          </div>
          <button className="button primary" onClick={() => onCommand({ kind: "reconnect_linear" })}>Reconnect Linear</button>
        </section>
        <section className="panel">
          <h2>Application</h2>
          <dl className="readiness-list">
            <div><dt>Desktop version</dt><dd>0.1.0</dd></div>
            <div><dt>Runtime bundle</dt><dd>V1</dd></div>
            <div><dt>App data</dt><dd>Available</dd></div>
          </dl>
        </section>
      </div>
    </>
  );
}
