import { useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { api, ApiError } from "../api/client";
import { Button } from "../components/Button";

export default function LoginPage() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await api.login(email, password);
      await qc.invalidateQueries({ queryKey: ["me"] });
      navigate("/");
    } catch (err) {
      setError(loginErrorMessage(err));
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
        <h1 className="auth-title">Sign in</h1>
        <p className="auth-subtitle">Welcome back — sign in to your workspace.</p>

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
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
            />
          </label>

          {error ? (
            <p className="field-error" role="alert">
              {error}
            </p>
          ) : null}

          <Button type="submit" loading={submitting} className="auth-submit">
            Sign in
          </Button>
        </form>

        <p className="auth-switch">
          Don't have an account? <Link to="/register">Create one</Link>
        </p>
      </div>
    </div>
  );
}

function loginErrorMessage(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.code === "invalid_credentials") {
      return "Invalid email or password";
    }
    return err.message;
  }
  return "Something went wrong. Please try again.";
}
