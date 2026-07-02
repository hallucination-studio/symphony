import type { RunSummary } from "../api/types";
import { StatusBadge } from "./StatusBadge";
import { relativeTime } from "../lib/format";

/**
 * Compact run list shared by Home (a few recent) and Runs (full list).
 * Each row is issue + status + timing + a short failure reason when present.
 */
export function RunSummaryList({
  runs,
  onSelect,
  selectedId,
}: {
  runs: RunSummary[];
  onSelect?: (run: RunSummary) => void;
  selectedId?: string | null;
}) {
  return (
    <ul className="run-list">
      {runs.map((run) => {
        const interactive = Boolean(onSelect);
        return (
          <li
            key={run.run_id}
            className="run-row"
            data-selected={run.run_id === selectedId || undefined}
          >
            <RowInner
              run={run}
              interactive={interactive}
              onSelect={onSelect}
            />
          </li>
        );
      })}
    </ul>
  );
}

function RowInner({
  run,
  interactive,
  onSelect,
}: {
  run: RunSummary;
  interactive: boolean;
  onSelect?: (run: RunSummary) => void;
}) {
  const content = (
    <>
      <div className="run-row-main">
        <span className="run-identifier">
          {run.issue_identifier ?? run.run_id}
        </span>
        {run.failure_reason ? (
          <span className="run-failure">{run.failure_reason}</span>
        ) : null}
      </div>
      <div className="run-row-meta">
        <span className="muted run-time">
          {run.completed_at
            ? `Ended ${relativeTime(run.completed_at)}`
            : run.started_at
              ? `Started ${relativeTime(run.started_at)}`
              : "Not started"}
        </span>
        <StatusBadge status={run.status} />
      </div>
    </>
  );

  if (interactive) {
    return (
      <button
        type="button"
        className="run-row-button"
        onClick={() => onSelect?.(run)}
      >
        {content}
      </button>
    );
  }
  return <div className="run-row-static">{content}</div>;
}
