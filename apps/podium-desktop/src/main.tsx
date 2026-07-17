import React from "react";
import ReactDOM from "react-dom/client";

import { DesktopRuntime } from "./DesktopRuntime";
import "./styles/tokens.css";
import "./styles/layout.css";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <DesktopRuntime />
  </React.StrictMode>
);
