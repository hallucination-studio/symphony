import { useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { api, ApiError } from "../api/client";
import { Button } from "../components/Button";
import { BrandMark } from "../components/BrandMark";
import { useTurnstile } from "../components/TurnstileWidget";
import { useI18n } from "../i18n";

export default function LoginPage() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const turnstile = useTurnstile();
  const { t } = useI18n();

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (!turnstile.ready) return;
    setSubmitting(true);
    try {
      await api.login(email, password, turnstile.token);
      await qc.invalidateQueries({ queryKey: ["me"] });
      navigate("/");
    } catch (err) {
      setError(t(loginErrorMessage(err)));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="auth-layout">
      <div className="auth-card">
        <div className="auth-brand">
          <BrandMark />
          <span>Podium</span>
        </div>
        <h1 className="auth-title">{t("Sign in")}</h1>
        <p className="auth-subtitle">{t("Welcome back — sign in to your workspace.")}</p>

        <form onSubmit={onSubmit} noValidate>
          <label className="field">
            <span className="field-label">{t("Email")}</span>
            <input
              className="text-input"
              type="email"
              aria-label={t("Email")}
              autoComplete="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
            />
          </label>
          <label className="field">
            <span className="field-label">{t("Password")}</span>
            <input
              className="text-input"
              type="password"
              aria-label={t("Password")}
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
            />
          </label>

          {turnstile.widget}

          {error ? (
            <p className="field-error" role="alert">
              {error}
            </p>
          ) : null}

          <Button
            type="submit"
            loading={submitting}
            disabled={!turnstile.ready}
            className="auth-submit"
          >
            {t("Sign in")}
          </Button>
        </form>

        <p className="auth-switch">
          {t("Don't have an account?")} <Link to="/register">{t("Create one")}</Link>
        </p>
      </div>
    </div>
  );
}

function loginErrorMessage(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.code === "invalid_login") {
      return "Invalid email or password";
    }
    return err.message;
  }
  return "Something went wrong. Please try again.";
}
