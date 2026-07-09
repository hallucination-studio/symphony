import { useEffect } from "react";
import type { LinearScope } from "../../api/types";

export function useDefaultTeamSelection({
  scope,
  teams,
  projects,
  setTeams,
}: {
  scope: LinearScope | undefined;
  teams: Set<string>;
  projects: Set<string>;
  setTeams: (teams: Set<string>) => void;
}) {
  // Safe narrow default: preselect the first team once, nothing else.
  useEffect(() => {
    if (scope?.teams?.length && teams.size === 0 && projects.size === 0) {
      setTeams(new Set([scope.teams[0].id]));
    }
    // Only seed once when data first arrives.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope]);
}

export function toggleSelection(set: Set<string>, id: string): Set<string> {
  const next = new Set(set);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  return next;
}
