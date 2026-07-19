import { useState } from "react";

import { EmptyState, PageHeading, StatusBadge } from "./components";
import { labelFromIdentifier } from "./format";
import { ApiKeyDialog, ProfileDialog } from "./ProfileDialogs";
import type { CommandHandler, ConductorDetailView, ConductorSummaryView, PerformerProfileSummaryView, SecretHandler } from "./types";

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
                  <span><strong>{conductor.displayName}</strong>{conductor.projectName ?? "Unbound"}</span>
                  <StatusBadge label={labelFromIdentifier(conductor.status)} {...(conductor.status === "ready" ? { tone: "positive" } : {})} />
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
          <div><h2>Runtime</h2><StatusBadge testId="conductor-runtime-status" label={labelFromIdentifier(conductor.status)} /></div>
          <div className="button-row">
            <button className="button" onClick={() => onCommand({ kind: "stop_conductor", conductorId: conductor.conductorId })}>Stop</button>
            <button className="button primary" onClick={() => onCommand({ kind: "restart_conductor", conductorId: conductor.conductorId })}>Restart</button>
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
                    <button className="button" onClick={() => onCommand({ kind: "start_codex_chatgpt_login", conductorId: conductor.conductorId, profileId: profile.profileId })}>Sign in with ChatGPT</button>
                  )}
                  {profile.readiness === "login-required" && profile.authenticationMethod === "api_key" && (
                    <button data-testid="profile-set-api-key" className="button" onClick={() => setSecretProfileId(profile.profileId)}>Set API Key</button>
                  )}
                  {!profile.isActive && profile.readiness === "ready" && (
                    <button data-testid="profile-activate" className="button" onClick={() => onCommand({ kind: "activate_performer_profile", conductorId: conductor.conductorId, profileId: profile.profileId })}>Activate</button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        </section>
        <section className="panel"><h2>Recent runtime events</h2>{detail.events.length ? detail.events.map((event) => <p key={event.occurredAt}>{event.summary}</p>) : <p className="quiet">No recent events.</p>}</section>
      </div>
      {showProfile && <ProfileDialog conductorId={conductor.conductorId} onClose={() => setShowProfile(false)} onCommand={onCommand} />}
      {editProfile && <ProfileDialog conductorId={conductor.conductorId} profile={editProfile} onClose={() => setEditProfile(undefined)} onCommand={onCommand} />}
      {secretProfileId && <ApiKeyDialog conductorId={conductor.conductorId} profileId={secretProfileId} onClose={() => setSecretProfileId(undefined)} onSecret={onSecret} />}
    </>
  );
}
