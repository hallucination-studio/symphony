import { useEffect, useRef, useState, type RefObject } from "react";

import { ConductorsPage } from "./ui/ConductorsPage";
import { OverviewPage } from "./ui/OverviewPage";
import { Shell, PageHeading } from "./ui/components";
import type { CommandHandler, DesktopCommandResult, DesktopState, Page } from "./ui/types";
import { SettingsPage } from "./ui/SettingsPage";

export function App({
  initialState,
  onCommand,
}: {
  initialState: DesktopState;
  onCommand?: CommandHandler;
}) {
  const [page, setPage] = useState<Page>("overview");
  const headingRef = useRef<HTMLHeadingElement>(null);
  const command = onCommand ?? (async (): Promise<DesktopCommandResult> => ({ kind: "confirmed" }));

  useEffect(() => {
    headingRef.current?.focus();
  }, [page, initialState.kind]);

  if (initialState.kind !== "ready") {
    return <UnavailableView state={initialState} headingRef={headingRef} />;
  }

  function navigate(nextPage: Page) {
    const apply = () => setPage(nextPage);
    const host = document as Document & {
      startViewTransition?: (update: () => void) => { finished: Promise<void> };
    };
    if (typeof host.startViewTransition !== "function") {
      apply();
      return;
    }
    host.startViewTransition(() => apply());
  }

  return (
    <Shell page={page} onNavigate={navigate}>
      {page === "overview" && (
        <OverviewPage
          view={initialState.overview}
          headingRef={headingRef}
          onOpenConductors={() => navigate("conductors")}
        />
      )}
      {page === "conductors" && (
        <ConductorsPage
          bindings={initialState.overview.bindings}
          slots={initialState.overview.slots}
          headingRef={headingRef}
          onCommand={command}
        />
      )}
      {page === "settings" && (
        <SettingsPage
          bindings={initialState.overview.bindings}
          headingRef={headingRef}
          onCommand={command}
        />
      )}
    </Shell>
  );
}

function UnavailableView({
  state,
  headingRef,
}: {
  state: Exclude<DesktopState, { kind: "ready" }>;
  headingRef: RefObject<HTMLHeadingElement>;
}) {
  const title = state.kind === "loading" ? "Loading Desktop" : state.summary;
  const description = state.kind === "loading" ? `Reading ${state.objectLabel ?? "local bindings"}.` : state.nextAction;
  return (
    <main className="setup-layout" aria-busy={state.kind === "loading" || undefined}>
      <section className="empty-state" role={state.kind === "unavailable" ? "alert" : undefined}>
        <PageHeading title={title} description={description} headingRef={headingRef} />
      </section>
    </main>
  );
}

export type StaticCommand = CommandHandler;
