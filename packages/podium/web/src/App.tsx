import { Navigate, NavLink, Route, Routes } from "react-router-dom";
import HomePage from "./pages/HomePage";
import SetupPage from "./pages/SetupPage";
import IntegrationsPage from "./pages/IntegrationsPage";
import RuntimesPage from "./pages/RuntimesPage";
import PipelinePage from "./pages/PipelinePage";
import AccountPage from "./pages/AccountPage";
import LoginPage from "./pages/LoginPage";
import RegisterPage from "./pages/RegisterPage";
import { useMe } from "./auth/useSession";
import { BrandMark } from "./components/BrandMark";
import type { AuthUser } from "./api/types";
import { useI18n, type Locale } from "./i18n";

const NAV = [
  { to: "/", label: "Home", end: true },
  { to: "/setup", label: "Setup", end: false },
  { to: "/integrations", label: "Integrations", end: false },
  { to: "/runtimes", label: "Runtimes", end: false },
  { to: "/pipeline", label: "Pipeline", end: false },
  { to: "/account", label: "Account", end: false },
];

export default function App() {
  const { user, isLoading, isAuthenticated } = useMe();
  const { t } = useI18n();

  if (isLoading) {
    return (
      <div className="auth-layout">
        <div className="state-message">{t("Loading…")}</div>
      </div>
    );
  }

  if (!isAuthenticated) {
    if (debugAuthEnabled()) {
      return (
        <div className="auth-layout">
          <div className="state-message">{t("Debug sign-in enabled. Waiting for session…")}</div>
        </div>
      );
    }
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
  const { t } = useI18n();
  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">
          <BrandMark />
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
              {t(item.label)}
            </NavLink>
          ))}
        </nav>
        <LanguageSwitch />
        <AccountChip user={user} />
      </aside>
      <main className="main">
        <Routes>
          <Route path="/" element={<HomePage />} />
          <Route path="/setup" element={<SetupPage />} />
          <Route path="/setup/:step" element={<SetupPage />} />
          <Route path="/integrations" element={<IntegrationsPage />} />
          <Route path="/runtimes" element={<RuntimesPage />} />
          <Route path="/pipeline" element={<PipelinePage />} />
          <Route path="/account" element={<AccountPage />} />
          {/* Signed-in users hitting auth routes go home. */}
          <Route path="/login" element={<Navigate to="/" replace />} />
          <Route path="/register" element={<Navigate to="/" replace />} />
          <Route
            path="*"
            element={<p className="state-message">{t("Page not found.")}</p>}
          />
        </Routes>
      </main>
    </div>
  );
}

function debugAuthEnabled(): boolean {
  return import.meta.env.VITE_PODIUM_DEBUG_AUTH === "true";
}

function AccountChip({ user }: { user: AuthUser }) {
  const { t } = useI18n();
  return (
    <NavLink
      to="/account"
      className={({ isActive }) =>
        isActive ? "account-chip active" : "account-chip"
      }
    >
      <span className="account-chip-dot" data-tone="positive" aria-hidden />
      <span className="account-chip-body">
        <span className="account-chip-label">{t("Signed in")}</span>
        <span className="account-chip-value">{user.email}</span>
      </span>
    </NavLink>
  );
}

function LanguageSwitch() {
  const { locale, setLocale, t } = useI18n();
  return (
    <label className="language-switch">
      <span>{t("Language")}</span>
      <select
        value={locale}
        aria-label={t("Language")}
        onChange={(e) => setLocale(e.target.value as Locale)}
      >
        <option value="en">EN</option>
        <option value="zh">中文</option>
      </select>
    </label>
  );
}
