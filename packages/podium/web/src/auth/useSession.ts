import { useQuery } from "@tanstack/react-query";
import { api, ApiError } from "../api/client";
import type { AuthUser } from "../api/types";

/**
 * Current-session query. A 401 (`unauthenticated`) is a normal "signed out"
 * state, not a UI error — callers read `isUnauthenticated` for that.
 */
export function useMe() {
  const query = useQuery({
    queryKey: ["me"],
    queryFn: () => api.me(),
    retry: false,
    staleTime: 60_000,
  });

  const isUnauthenticated =
    query.error instanceof ApiError && query.error.status === 401;

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
