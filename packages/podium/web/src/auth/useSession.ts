import { useQuery } from "@tanstack/react-query";
import { api, ApiError } from "../api/client";
import type { AuthUser } from "../api/types";

/**
 * Current-session query. A 401 (`unauthorized`) is a normal "signed out"
 * state, not a UI error — callers read `isUnauthenticated` for that.
 */
export function useMe() {
  const query = useQuery({
    queryKey: ["me"],
    queryFn: () => api.me(),
    retry: false,
    staleTime: 60_000,
  });

  // Main's backend returns 401 with code `unauthorized` for signed-out.
  const isUnauthenticated =
    query.error instanceof ApiError &&
    query.error.status === 401 &&
    (query.error.code === "unauthorized" || query.error.code === undefined);

  const user: AuthUser | undefined = query.data?.user;

  return {
    user,
    isLoading: query.isLoading,
    // Surface only unexpected errors (network, 5xx) as real errors.
    isError: query.isError && !isUnauthenticated,
    isUnauthenticated,
    isAuthenticated: Boolean(user),
  };
}
