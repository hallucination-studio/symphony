import { NavLink, Route, Routes } from "react-router-dom";
import HomePage from "./pages/HomePage";
import SetupPage from "./pages/SetupPage";
import IntegrationsPage from "./pages/IntegrationsPage";
import RuntimesPage from "./pages/RuntimesPage";
import RunsPage from "./pages/RunsPage";

const NAV = [
  { to: "/", label: "Home", end: true },
  { to: "/setup", label: "Setup", end: false },
  { to: "/integrations", label: "Integrations", end: false },
  { to: "/runtimes", label: "Runtimes", end: false },
  { to: "/runs", label: "Runs", end: false },
];

export default function App() {
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
      </aside>
      <main className="main">
        <Routes>
          <Route path="/" element={<HomePage />} />
          <Route path="/setup" element={<SetupPage />} />
          <Route path="/setup/:step" element={<SetupPage />} />
          <Route path="/integrations" element={<IntegrationsPage />} />
          <Route path="/runtimes" element={<RuntimesPage />} />
          <Route path="/runs" element={<RunsPage />} />
          <Route
            path="*"
            element={<p className="state-message">Page not found.</p>}
          />
        </Routes>
      </main>
    </div>
  );
}
