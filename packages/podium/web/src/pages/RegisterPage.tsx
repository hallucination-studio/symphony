import { useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { api, ApiError } from "../api/client";
import { Button } from "../components/Button";
import { BrandMark } from "../components/BrandMark";
import { useTurnstile } from "../components/useTurnstile";
import { useI18n } from "../i18n";

export default function RegisterPage() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const turnstile = useTurnstile();
  const { t } = useI18n();

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);

    if (password.length < 8) {
      setError(t("Password must be at least 8 characters."));
      return;
    }
    if (password !== confirm) {
      setError(t("Passwords don't match."));
      return;
    }
    if (!turnstile.ready) return;

    setSubmitting(true);
    try {
      await api.register(email, password, turnstile.token);
      await qc.invalidateQueries({ queryKey: ["me"] });
      navigate("/");
    } catch (err) {
      setError(t(registerErrorMessage(err)));
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
        <h1 className="auth-title">{t("Create your account")}</h1>
        <p className="auth-subtitle">
          {t("Get a personal Podium workspace in seconds.")}
        </p>

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
              autoComplete="new-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
            />
            <span className="field-hint">{t("At least 8 characters.")}</span>
          </label>
          <label className="field">
            <span className="field-label">{t("Confirm password")}</span>
            <input
              className="text-input"
              type="password"
              aria-label={t("Confirm password")}
              autoComplete="new-password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
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
            {t("Create account")}
          </Button>
        </form>

        <p className="auth-switch">
          {t("Already have an account?")} <Link to="/login">{t("Sign in")}</Link>
        </p>
      </div>
    </div>
  );
}

function registerErrorMessage(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.code === "email_already_registered") {
      return "That email is already registered — sign in instead.";
    }
    if (err.code === "invalid_credentials") {
      return "Enter a valid email and a password of at least 8 characters.";
    }
    return err.message;
  }
  return "Something went wrong. Please try again.";
}
