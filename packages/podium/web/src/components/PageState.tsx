import type { ReactNode } from "react";

export function PageHeader({
  title,
  description,
}: {
  title: string;
  description?: string;
}) {
  return (
    <header className="page-header">
      <h1>{title}</h1>
      {description ? <p>{description}</p> : null}
    </header>
  );
}

export function QueryState({
  isLoading,
  error,
  children,
}: {
  isLoading: boolean;
  error: unknown;
  children: ReactNode;
}) {
  if (isLoading) {
    return <div className="state-message">Loading…</div>;
  }
  if (error) {
    const message =
      error instanceof Error ? error.message : "Something went wrong.";
    return <div className="state-message error">{message}</div>;
  }
  return <>{children}</>;
}
