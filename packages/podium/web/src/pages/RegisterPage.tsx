import { useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { api, ApiError } from "../api/client";
import { Button } from "../components/Button";

export default function RegisterPage() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);

    if (password.length < 8) {
      setError("Password must be at least 8 characters.");
      return;
    }
    if (password !== confirm) {
      setError("Passwords don't match.");
      return;
    }

    setSubmitting(true);
    try {
      await api.register(email, password, "dev");
      await qc.invalidateQueries({ queryKey: ["me"] });
      navigate("/");
    } catch (err) {
      setError(registerErrorMessage(err));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="auth-layout">
      <div className="auth-card">
        <div className="auth-brand">
          <span className="brand-mark">P</span>
          <span>Podium</span>
        </div>
        <h1 className="auth-title">Create your account</h1>
        <p className="auth-subtitle">
          Get a personal Podium workspace in seconds.
        </p>

        <form onSubmit={onSubmit} noValidate>
          <label className="field">
            <span className="field-label">Email</span>
            <input
              className="text-input"
              type="email"
              aria-label="Email"
              autoComplete="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
            />
          </label>
          <label className="field">
            <span className="field-label">Password</span>
            <input
              className="text-input"
              type="password"
              aria-label="Password"
              autoComplete="new-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
            />
            <span className="field-hint">At least 8 characters.</span>
          </label>
          <label className="field">
            <span className="field-label">Confirm password</span>
            <input
              className="text-input"
              type="password"
              aria-label="Confirm password"
              autoComplete="new-password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              required
            />
          </label>

          {error ? (
            <p className="field-error" role="alert">
              {error}
            </p>
          ) : null}

          <Button type="submit" loading={submitting} className="auth-submit">
            Create account
          </Button>
        </form>

        <p className="auth-switch">
          Already have an account? <Link to="/login">Sign in</Link>
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
