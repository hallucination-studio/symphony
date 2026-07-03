import { Navigate, NavLink, Route, Routes } from "react-router-dom";
import HomePage from "./pages/HomePage";
import SetupPage from "./pages/SetupPage";
import IntegrationsPage from "./pages/IntegrationsPage";
import RuntimesPage from "./pages/RuntimesPage";
import RunsPage from "./pages/RunsPage";
import AccountPage from "./pages/AccountPage";
import LoginPage from "./pages/LoginPage";
import RegisterPage from "./pages/RegisterPage";
import { useMe } from "./auth/useSession";
import type { AuthUser } from "./api/types";

const NAV = [
  { to: "/", label: "Home", end: true },
  { to: "/setup", label: "Setup", end: false },
  { to: "/integrations", label: "Integrations", end: false },
  { to: "/runtimes", label: "Runtimes", end: false },
  { to: "/runs", label: "Runs", end: false },
  { to: "/account", label: "Account", end: false },
];

export default function App() {
  const { user, isLoading, isAuthenticated } = useMe();

  if (isLoading) {
    return (
      <div className="auth-layout">
        <div className="state-message">Loading…</div>
      </div>
    );
  }

  if (!isAuthenticated) {
    return (
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route path="/register" element={<RegisterPage />} />
        <Route path="*" element={<Navigate to="/login" replace />} />
      </Routes>
    );
  }

  return <AppShell user={user!} />;
}

function AppShell({ user }: { user: AuthUser }) {
  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark">P</span>
          <span>Podium</span>
        </div>
        <nav className="nav">
          {NAV.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.end}
              className={({ isActive }) =>
                isActive ? "nav-link active" : "nav-link"
              }
            >
              {item.label}
            </NavLink>
          ))}
        </nav>
        <AccountChip user={user} />
      </aside>
      <main className="main">
        <Routes>
          <Route path="/" element={<HomePage />} />
          <Route path="/setup" element={<SetupPage />} />
          <Route path="/setup/:step" element={<SetupPage />} />
          <Route path="/integrations" element={<IntegrationsPage />} />
          <Route path="/runtimes" element={<RuntimesPage />} />
          <Route path="/runs" element={<RunsPage />} />
          <Route path="/account" element={<AccountPage />} />
          {/* Signed-in users hitting auth routes go home. */}
          <Route path="/login" element={<Navigate to="/" replace />} />
          <Route path="/register" element={<Navigate to="/" replace />} />
          <Route
            path="*"
            element={<p className="state-message">Page not found.</p>}
          />
        </Routes>
      </main>
    </div>
  );
}

function AccountChip({ user }: { user: AuthUser }) {
  return (
    <NavLink
      to="/account"
      className={({ isActive }) =>
        isActive ? "account-chip active" : "account-chip"
      }
    >
      <span className="account-chip-dot" data-tone="positive" aria-hidden />
      <span className="account-chip-body">
        <span className="account-chip-label">Signed in</span>
        <span className="account-chip-value">{user.email}</span>
      </span>
    </NavLink>
  );
}
