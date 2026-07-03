import { useQuery } from "@tanstack/react-query";
import { api, ApiError } from "../api/client";
import type { AuthUser } from "../api/types";

/**
 * Current-session query. A 401 (`unauthorized`) is a normal signed-out state.
 */
export function useMe() {
  const query = useQuery({
    queryKey: ["me"],
    queryFn: () => api.me(),
    retry: false,
    staleTime: 60_000,
  });

  const isUnauthenticated =
    query.error instanceof ApiError &&
    query.error.status === 401 &&
    query.error.code === "unauthorized";
  const hasUnexpectedError = query.isError && !isUnauthenticated;
  const user: AuthUser | undefined = query.data?.user;

  return {
    user,
    isLoading: query.isLoading || hasUnexpectedError,
    isAuthenticated: Boolean(user),
  };
}
