import type { SmokeCheckResult } from "../api/types";
import { humanize } from "../lib/format";
import { useI18n } from "../i18n";

// Human titles + the recommended action for each known check. The backend
// reports checks as {name, passed}; we translate a failure into something the
// user can act on rather than a bare check name.
const CHECK_META: Record<
  string,
  { title: string; action: string }
> = {
  linear_connection: {
    title: "Linear connected",
    action: "Reconnect Linear in the Connect step.",
  },
  repository_mapping: {
    title: "Repository mapped",
    action: "Map a valid repository in the Map repository step.",
  },
  runtime_online: {
    title: "Runtime online",
    action: "Install and start a runtime in the Install runtime step.",
  },
};

export function SmokeCheckList({ result }: { result: SmokeCheckResult }) {
  const { t } = useI18n();
  return (
    <ul className="check-list">
      {result.checks.map((check) => {
        const meta = CHECK_META[check.name];
        return (
          <li className="check-item" key={check.name}>
            <span className="check-icon" data-passed={check.passed}>
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
