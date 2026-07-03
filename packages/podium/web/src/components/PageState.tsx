import type { ReactNode } from "react";
import { useI18n } from "../i18n";

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
  const { t } = useI18n();
  if (isLoading) {
    return <div className="state-message">{t("Loading…")}</div>;
  }
  if (error) {
    const message =
      error instanceof Error ? error.message : t("Something went wrong.");
    return <div className="state-message error">{message}</div>;
  }
  return <>{children}</>;
}
