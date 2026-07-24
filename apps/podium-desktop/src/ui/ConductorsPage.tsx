import { useState } from "react";

import { EmptyState, PageHeading, StatusBadge } from "./components";
import { labelFromIdentifier } from "./format";
import { ApiKeyDialog, ProfileDialog } from "./ProfileDialogs";
import type { CommandHandler, ConductorDetailView, ConductorSummaryView, DesktopCommand, PerformerProfileSummaryView, SecretHandler } from "./types";

export function ConductorsPage({
  conductors,
  detail,
  headingRef,
  onSelect,
  onCommand,
  onSecret,
  onBeginCreateConductor,
}: {
  conductors: ConductorSummaryView[];
  detail: ConductorDetailView | undefined;
  headingRef: React.RefObject<HTMLHeadingElement>;
  onSelect: (id: string) => void;
  onCommand: CommandHandler;
  onSecret: SecretHandler;
  onBeginCreateConductor: () => void;
}) {
  const [showProfile, setShowProfile] = useState(false);
  const [editProfile, setEditProfile] = useState<PerformerProfileSummaryView>();
  const [secretProfileId, setSecretProfileId] = useState<string>();
  // Buttons that issue runtime commands show a spinner and lock while the
  // Conductor processes the request; the poll refresh confirms the result.
  const [pendingAction, setPendingAction] = useState<string>();
  const runCommand = async (action: string, command: DesktopCommand) => {
    if (pendingAction) return;
    setPendingAction(action);
    try {
      await onCommand(command);
    } finally {
      setPendingAction(undefined);
    }
  };
  const pendingSpinner = (action: string) =>
    pendingAction === action ? <span className="button-spinner" aria-hidden="true" /> : null;
  if (!detail) {
    return (
      <>
        <PageHeading title="Conductors" description="Manage the local runtime and its Performer Profiles." headingRef={headingRef} />
        {conductors.length === 0 ? (
          <EmptyState title="No Conductor" body="Create one Binding for a Linear Project and Git repository." action={<button className="button primary" onClick={onBeginCreateConductor}>Create Conductor</button>} />
        ) : (
          <ul className="selection-list">
            {conductors.map((conductor) => (
              <li key={conductor.conductorId}>
              <button type="button" onClick={() => onSelect(conductor.conductorId)}>
                  <span>
                    <strong>{conductor.displayName}</strong>
                    <span>{conductor.projectName ?? "Unbound"}</span>
                  </span>
                  <StatusBadge label={labelFromIdentifier(conductor.status)} {...(conductor.status === "online" ? { tone: "positive" } : {})} />
                </button>
              </li>
            ))}
          </ul>
        )}
      </>
    );
  }
  const conductor = detail.summary;
  return (
    <>
      <PageHeading title={conductor.displayName} description={`${conductor.projectName ?? "Unbound"} · ${conductor.repositoryDisplayName ?? "Repository unavailable"}`} headingRef={headingRef} />
      <div className="page-stack">
        <section className="panel action-row">
          <div>
            <h2>Runtime</h2>
            <StatusBadge testId="conductor-runtime-status" label={labelFromIdentifier(conductor.status)} {...(conductor.status === "online" ? { tone: "positive" } : {})} />
          </div>
          <div className="button-row">
            <button className="button" disabled={pendingAction !== undefined} aria-busy={pendingAction === "stop"} onClick={() => void runCommand("stop", { kind: "stop_conductor", conductorId: conductor.conductorId })}>{pendingSpinner("stop")}Stop</button>
            <button className="button primary" disabled={pendingAction !== undefined} aria-busy={pendingAction === "restart"} onClick={() => void runCommand("restart", { kind: "restart_conductor", conductorId: conductor.conductorId })}>{pendingSpinner("restart")}Restart</button>
          </div>
        </section>
        <section className="panel">
          <div className="section-heading">
            <h2>Performer Profiles</h2>
            <button data-testid="configure-profile" className="button primary" onClick={() => setShowProfile(true)}>Configure profile</button>
          </div>
          <ul className="plain-list">
            {detail.profiles.map((profile) => (
              <li data-testid="profile-row" key={profile.profileId}>
                <div>
                  <strong>{profile.displayName}{profile.isActive ? " · Active for new Roots" : ""}</strong>
                  <span>{profile.sanitizedAccountLabel ?? "Account not configured"} · {profile.codexTurnSettings.model} · {labelFromIdentifier(profile.readiness)}</span>
                </div>
                <div className="button-row">
                  <button data-testid="profile-edit" className="button" onClick={() => setEditProfile(profile)}>Edit settings</button>
                  {profile.readiness === "login-required" && profile.authenticationMethod === "chatgpt" && (
                    <button className="button" disabled={pendingAction !== undefined} aria-busy={pendingAction === `login-${profile.profileId}`} onClick={() => void runCommand(`login-${profile.profileId}`, { kind: "start_codex_chatgpt_login", conductorId: conductor.conductorId, profileId: profile.profileId })}>{pendingSpinner(`login-${profile.profileId}`)}Sign in with ChatGPT</button>
                  )}
                  {profile.readiness === "login-required" && profile.authenticationMethod === "api_key" && (
                    <button data-testid="profile-set-api-key" className="button" onClick={() => setSecretProfileId(profile.profileId)}>Set API Key</button>
                  )}
                  {!profile.isActive && profile.readiness === "ready" && (
                    <button data-testid="profile-activate" className="button" disabled={pendingAction !== undefined} aria-busy={pendingAction === `activate-${profile.profileId}`} onClick={() => void runCommand(`activate-${profile.profileId}`, { kind: "activate_performer_profile", conductorId: conductor.conductorId, profileId: profile.profileId })}>{pendingSpinner(`activate-${profile.profileId}`)}Activate</button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        </section>
        <section className="panel"><h2>Recent runtime logs</h2>{detail.logs.length ? detail.logs.map((event) => <p key={event.occurredAt}>{event.summary}</p>) : <p className="quiet">No recent logs.</p>}</section>
      </div>
      {showProfile && <ProfileDialog conductorId={conductor.conductorId} onClose={() => setShowProfile(false)} onCommand={onCommand} />}
      {editProfile && <ProfileDialog conductorId={conductor.conductorId} profile={editProfile} onClose={() => setEditProfile(undefined)} onCommand={onCommand} />}
      {secretProfileId && <ApiKeyDialog conductorId={conductor.conductorId} profileId={secretProfileId} onClose={() => setSecretProfileId(undefined)} onSecret={onSecret} />}
    </>
  );
}
