import type { ReactNode } from "react";

/**
 * Base surface for a bordered content block. Optional title/description header
 * and an actions slot (rendered top-right) keep card headers consistent.
 */
export function Card({
  title,
  description,
  actions,
  children,
  className,
}: {
  title?: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  children?: ReactNode;
  className?: string;
}) {
  const hasHeader = title || description || actions;
  return (
    <section className={className ? `card ${className}` : "card"}>
      {hasHeader ? (
        <div className="card-header">
          <div>
            {title ? <h2 className="card-title">{title}</h2> : null}
            {description ? (
              <p className="card-description">{description}</p>
            ) : null}
          </div>
          {actions ? <div className="card-actions">{actions}</div> : null}
        </div>
      ) : null}
      {children}
    </section>
  );
}
