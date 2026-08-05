import React from "react";
import ReactDOM from "react-dom/client";

import { DesktopRuntime } from "./DesktopRuntime";
import "./styles/tokens.css";
import "./styles/layout.css";

if ("__TAURI_INTERNALS__" in window) {
  document.documentElement.dataset.host = "tauri";
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <DesktopRuntime />
  </React.StrictMode>,
);
