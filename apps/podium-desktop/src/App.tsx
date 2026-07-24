import { useEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";

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

export function App({
  initialState,
  onCommand,
  onSecret,
  onChooseRepository,
  onBeginCreateConductor,
  onSelectConductor,
}: {
  initialState: DesktopState;
  onCommand: CommandHandler;
  onSecret: SecretHandler;
  onChooseRepository: () => Promise<RepositorySelection | undefined>;
  onBeginCreateConductor: () => void;
  onSelectConductor: (conductorId: string) => Promise<void>;
}) {
  const [page, setPage] = useState<Page>("overview");
  const [conductorId, setConductorId] = useState<string>();
  const headingRef = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    headingRef.current?.focus();
  }, [page, conductorId]);

  if (initialState.kind !== "ready") {
    return (
      <SetupView
        state={initialState}
        onCommand={onCommand}
        onSecret={onSecret}
        onChooseRepository={onChooseRepository}
        onBeginCreateConductor={onBeginCreateConductor}
      />
    );
  }

  const { overview, conductorDetail } = initialState;
  function navigate(nextPage: Page) {
    const apply = () => {
      setPage(nextPage);
      setConductorId(undefined);
    };
    // Cross-fade page switches where the host supports View Transitions
    // (WKWebView 18+); older hosts fall back to the CSS cascade alone.
    const host = document as Document & {
      startViewTransition?: (update: () => void) => { finished: Promise<void> };
    };
    if (typeof host.startViewTransition !== "function") {
      apply();
      return;
    }
    host.startViewTransition(() => flushSync(apply));
  }

  return (
    <Shell page={page} onNavigate={navigate}>
      {page === "overview" && (
        <OverviewPage view={overview} headingRef={headingRef} />
      )}
      {page === "conductors" && (
        <ConductorsPage
          conductors={overview.conductors}
          detail={conductorId && conductorDetail?.summary.conductorId === conductorId ? conductorDetail : undefined}
          headingRef={headingRef}
          onSelect={(nextConductorId) => {
            setConductorId(nextConductorId);
            void onSelectConductor(nextConductorId);
          }}
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
