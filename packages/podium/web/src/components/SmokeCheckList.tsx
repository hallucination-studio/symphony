import type {
  SmokeCheckItem,
  SmokeCheckResult,
  SmokeConductorResult,
} from "../api/types";
import { humanize } from "../lib/format";
import { useI18n } from "../i18n";
import { StatusBadge } from "./StatusBadge";

const CHECK_META: Record<string, { title: string; action: string }> = {
  callback_acceptance: {
    title: "OAuth callback accepted",
    action: "Reconnect Linear and complete application authorization.",
  },
  installation_identity: {
    title: "Application identity and scopes",
    action: "Reconnect Linear with an app actor and the required scopes.",
  },
  selected_project_access: {
    title: "Selected project access",
    action: "Review selected projects and application access.",
  },
  intake_health: {
    title: "Delegation polling",
    action: "Restore installation access and reconciliation polling.",
  },
  ready_bindings: {
    title: "Project bindings ready",
    action: "Bind each selected project to an online Conductor.",
  },
  runtime_connectivity: {
    title: "Conductor connectivity",
    action: "Start the bound Conductor and wait for its report.",
  },
  runtime_config_validity: {
    title: "Runtime configuration",
    action: "Publish and apply a valid runtime configuration.",
  },
  binding_identity: {
    title: "Binding identity",
    action: "Rebind this Conductor to the selected project.",
  },
  repository_readiness: {
    title: "Repository readiness",
    action: "Fix the bound repository path or Git checkout.",
  },
  linear_proxy_access: {
    title: "Linear proxy access",
    action: "Restore the Conductor Linear proxy connection.",
  },
  project_label_state: {
    title: "Project label installed",
    action: "Restore the managed project label on this project.",
  },
};

export function SmokeCheckList({ result }: { result: SmokeCheckResult }) {
  const { t } = useI18n();
  return (
    <div className="smoke-check-groups">
      <section className="smoke-check-group">
        <h2 className="smoke-check-group-title">{t("Podium prerequisites")}</h2>
        <CheckList checks={result.checks} />
        {result.status === "failed" && result.error_code ? (
          <SmokeError
            code={result.error_code}
            reason={result.sanitized_reason}
            action={result.action_required || result.next_action}
          />
        ) : null}
      </section>
      {result.conductors.map((conductor) => (
        <ConductorChecks key={conductor.binding_id} conductor={conductor} />
      ))}
    </div>
  );
}

function ConductorChecks({ conductor }: { conductor: SmokeConductorResult }) {
  const { t } = useI18n();
  const project = conductor.project_slug || conductor.linear_project_id;
  return (
    <section className="smoke-check-group">
      <header className="smoke-check-group-header">
        <div className="smoke-check-group-identity">
          <h2 className="smoke-check-group-title">{project} Conductor</h2>
          <code className="smoke-check-runtime">{conductor.runtime_id}</code>
        </div>
        <StatusBadge status={conductor.status} />
      </header>
      {conductor.status === "running" && conductor.checks.length === 0 ? (
        <p className="smoke-check-wait" role="status">
          {t("Waiting for Conductor result.")}
        </p>
      ) : (
        <CheckList checks={conductor.checks} />
      )}
      {conductor.error_code ? (
        <SmokeError
          code={conductor.error_code}
          reason={conductor.sanitized_reason}
          action={conductor.action_required || conductor.next_action}
        />
      ) : null}
    </section>
  );
}

function CheckList({ checks }: { checks: SmokeCheckItem[] }) {
  const { t } = useI18n();
  return (
    <ul className="check-list">
      {checks.map((check) => {
        const meta = CHECK_META[check.name];
        return (
          <li className="check-item" key={check.name}>
            <span
              className="check-icon"
              data-passed={check.passed}
              role="img"
              aria-label={t(check.passed ? "Passed" : "Failed")}
            >
              {check.passed ? "✓" : "!"}
            </span>
            <div className="step-body">
              <div className="check-title">
                {meta ? t(meta.title) : humanize(check.name)}
              </div>
              {!check.passed ? (
                <div className="check-action">
                  {meta ? t(meta.action) : t("Resolve this check and run again.")}
                </div>
              ) : null}
            </div>
          </li>
        );
      })}
    </ul>
  );
}

function SmokeError({ code, reason, action }: { code: string; reason: string; action: string }) {
  const { t } = useI18n();
  return (
    <div className="smoke-check-error" role="alert">
      <code className="smoke-check-error-code">{code}</code>
      {reason ? <p className="smoke-check-error-reason">{reason}</p> : null}
      {action ? (
        <p className="smoke-check-error-action">
          {t("Next action")}: {sentenceCase(action)}
        </p>
      ) : null}
    </div>
  );
}

function sentenceCase(value: string): string {
  const words = humanize(value).toLowerCase();
  return words ? `${words[0].toUpperCase()}${words.slice(1)}` : "";
}
