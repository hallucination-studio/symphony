import type { ButtonHTMLAttributes } from "react";
import { Link } from "react-router-dom";

type Variant = "primary" | "secondary" | "ghost" | "danger";

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  loading?: boolean;
}

/** Standard button. `loading` disables and swaps in a spinner label. */
export function Button({
  variant = "primary",
  loading = false,
  disabled,
  children,
  className,
  ...rest
}: ButtonProps) {
  return (
    <button
      className={cx("btn", `btn-${variant}`, className)}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...rest}
    >
      {loading ? <span className="btn-spinner" aria-hidden /> : null}
      {children}
    </button>
  );
}

/** Anchor styled as a button, for in-app navigation. */
export function LinkButton({
  to,
  variant = "primary",
  children,
  className,
}: {
  to: string;
  variant?: Variant;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <Link className={cx("btn", `btn-${variant}`, className)} to={to}>
      {children}
    </Link>
  );
}

function cx(...parts: (string | undefined | false)[]): string {
  return parts.filter(Boolean).join(" ");
}
