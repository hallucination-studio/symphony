from __future__ import annotations

from pathlib import Path
import struct
import zlib


def render_console_html() -> str:
    return """<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Conductor</title>
  <style>
    :root {
      --ink: #1f231f;
      --muted: #716a61;
      --paper: #fbf7f1;
      --paper-2: #f2eadf;
      --line: #e2d5c4;
      --green: #1b241f;
      --green-2: #28372f;
      --green-3: #34473c;
      --accent: #b9844e;
      --accent-2: #d7b184;
      --danger: #a94d3f;
      --ok: #4d8b61;
      --warn: #bd8a39;
      color-scheme: light;
      font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }

    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100dvh;
      color: var(--ink);
      background:
        linear-gradient(135deg, rgba(255, 255, 255, 0.34), transparent 28%),
        radial-gradient(circle at 88% 6%, rgba(255, 247, 235, 0.92), transparent 24rem),
        linear-gradient(135deg, #f3efe7 0%, #e7dccd 46%, #d4c1aa 100%);
    }

    button, input, select, textarea {
      font: inherit;
    }

    button {
      min-height: 36px;
      border: 0;
      border-radius: 8px;
      cursor: pointer;
    }

    button:disabled {
      cursor: not-allowed;
      opacity: 0.55;
    }

    button:active:not(:disabled) {
      transform: translateY(1px);
    }

    .shell {
      display: grid;
      grid-template-columns: 254px minmax(0, 1fr);
      min-height: 100dvh;
      padding: 28px;
      gap: 0;
    }

    .sidebar {
      display: flex;
      flex-direction: column;
      gap: 28px;
      padding: 30px;
      color: #f7f1e8;
      background: var(--green);
      border-radius: 8px 0 0 8px;
      min-height: calc(100dvh - 56px);
    }

    .brand strong {
      display: block;
      font-size: 32px;
      line-height: 1;
      letter-spacing: 0;
    }

    .brand span {
      display: block;
      margin-top: 10px;
      color: #b7c3b6;
      font-size: 14px;
    }

    .nav {
      display: grid;
      gap: 10px;
    }

    .nav button {
      width: 100%;
      padding: 12px 14px;
      text-align: left;
      color: #c8d1c8;
      background: #202b25;
      border: 1px solid rgba(255,255,255,0.04);
    }

    .nav button.active,
    .nav button:hover {
      color: #fffaf3;
      background: var(--green-2);
    }

    .sidebar-foot {
      margin-top: auto;
      display: grid;
      gap: 10px;
      color: #98a796;
      font-size: 13px;
    }

    .main {
      min-width: 0;
      background: rgba(251, 247, 241, 0.94);
      border: 1px solid rgba(255,255,255,0.55);
      border-left: 0;
      border-radius: 0 8px 8px 0;
      padding: 34px;
      min-height: calc(100dvh - 56px);
      box-shadow: 0 24px 50px rgba(109, 91, 69, 0.16);
    }

    .topbar {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: 20px;
      margin-bottom: 28px;
    }

    h1, h2, h3, p { margin: 0; }
    h1 {
      max-width: 780px;
      font-size: clamp(34px, 4vw, 52px);
      line-height: 1.02;
      letter-spacing: 0;
    }

    h2 {
      font-size: 24px;
      line-height: 1.15;
      letter-spacing: 0;
    }

    h3 {
      font-size: 16px;
      line-height: 1.2;
    }

    .subtle {
      margin-top: 10px;
      color: var(--muted);
      font-size: 15px;
      line-height: 1.45;
      max-width: 720px;
    }

    .toolbar {
      display: flex;
      gap: 10px;
      align-items: center;
      flex-wrap: wrap;
      justify-content: flex-end;
    }

    .primary {
      padding: 0 16px;
      color: #fffaf4;
      background: var(--green);
      font-weight: 700;
    }

    .secondary {
      padding: 0 14px;
      color: #2b241f;
      background: #e7d6c1;
      border: 1px solid #d8c7b3;
    }

    .danger {
      color: #fffaf4;
      background: var(--danger);
    }

    .fabric {
      padding: 28px;
      border-radius: 8px;
      color: #f7f1e8;
      background: linear-gradient(135deg, var(--green) 0%, var(--green-3) 100%);
      margin-bottom: 24px;
    }

    .fabric-title {
      color: #b8c7b8;
      font-size: 14px;
      margin-bottom: 20px;
    }

    .stats {
      display: grid;
      grid-template-columns: repeat(7, minmax(110px, 1fr));
      gap: 12px;
    }

    .stat {
      min-width: 0;
      padding: 16px;
      border-radius: 8px;
      background: rgba(245, 238, 227, 0.96);
      color: var(--ink);
    }

    .stat span {
      display: block;
      color: #7b6c5a;
      font-size: 13px;
    }

    .stat strong {
      display: block;
      margin-top: 7px;
      font-size: 30px;
      line-height: 1;
    }

    .grid {
      display: grid;
      grid-template-columns: minmax(360px, 1.25fr) minmax(320px, 0.75fr);
      gap: 20px;
      align-items: start;
    }

    .panel {
      min-width: 0;
      padding: 22px;
      border-radius: 8px;
      background: linear-gradient(180deg, #fffdfa 0%, #f6efe6 100%);
      border: 1px solid rgba(226, 213, 196, 0.85);
      box-shadow: 0 12px 24px rgba(70, 57, 42, 0.06);
    }

    .panel.dark {
      color: #f7f1e8;
      background: #1f2621;
      border-color: #29372f;
    }

    .panel.dark .muted,
    .panel.dark label {
      color: #b2beb1;
    }

    .panel-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      margin-bottom: 18px;
    }

    .stack {
      display: grid;
      gap: 12px;
    }

    .metric-row {
      display: grid;
      grid-template-columns: repeat(4, minmax(80px, 1fr));
      gap: 10px;
      margin-bottom: 14px;
    }

    .mini-stat {
      padding: 10px 12px;
      border-radius: 8px;
      background: #f4eadf;
      border: 1px solid #e1d1bd;
    }

    .mini-stat span {
      display: block;
      color: var(--muted);
      font-size: 12px;
    }

    .mini-stat strong {
      display: block;
      margin-top: 4px;
      font-size: 18px;
      line-height: 1;
    }

    .row {
      display: flex;
      align-items: center;
      gap: 10px;
      flex-wrap: wrap;
    }

    .instance {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      gap: 14px;
      align-items: center;
      padding: 14px;
      border: 1px solid var(--line);
      border-radius: 8px;
      background: #fffaf3;
    }

    .instance.selected {
      border-color: var(--accent);
      box-shadow: inset 0 0 0 1px rgba(185, 132, 78, 0.35);
    }

    .instance-main {
      min-width: 0;
    }

    .instance-title {
      display: flex;
      align-items: center;
      gap: 9px;
      min-width: 0;
      font-weight: 800;
    }

    .instance-title span:last-child {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .dot {
      width: 9px;
      height: 9px;
      border-radius: 999px;
      flex: 0 0 auto;
      background: #a8a196;
    }

    .dot.running { background: var(--ok); }
    .dot.stopped { background: #a8a196; }
    .dot.unhealthy,
    .dot.exited,
    .dot.crash_loop { background: var(--danger); }
    .dot.starting { background: var(--warn); }

    .meta {
      margin-top: 6px;
      color: var(--muted);
      font-size: 13px;
      line-height: 1.35;
      overflow-wrap: anywhere;
    }

    .actions {
      display: flex;
      gap: 8px;
      flex-wrap: wrap;
      justify-content: flex-end;
    }

    .actions button {
      min-width: 64px;
      padding: 0 10px;
      background: #efe2d2;
      color: #3b3026;
      border: 1px solid #e0d2bf;
    }

    .actions .primary {
      color: #fffaf4;
      background: var(--green);
      border-color: var(--green);
    }

    .view {
      display: none;
    }

    .view.active {
      display: block;
    }

    form {
      display: grid;
      gap: 12px;
    }

    label {
      display: grid;
      gap: 6px;
      color: #514a42;
      font-size: 13px;
      font-weight: 700;
    }

    .label-row {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      min-width: 0;
    }

    .help {
      position: relative;
      display: inline-grid;
      place-items: center;
      width: 18px;
      height: 18px;
      border: 1px solid #d4c2ad;
      border-radius: 999px;
      background: #f4eadf;
      color: #5a4d42;
      cursor: help;
      font-size: 12px;
      font-weight: 900;
      line-height: 1;
    }

    .help-tip {
      position: absolute;
      right: -10px;
      bottom: calc(100% + 8px);
      z-index: 10;
      width: min(260px, calc(100vw - 40px));
      padding: 10px 12px;
      border: 1px solid #344237;
      border-radius: 8px;
      background: #1f2a24;
      box-shadow: 0 12px 28px rgba(31, 42, 36, 0.22);
      color: #f7f1e8;
      font-size: 12px;
      font-weight: 600;
      line-height: 1.45;
      opacity: 0;
      pointer-events: none;
      transform: translateY(4px);
      transition: opacity 120ms ease, transform 120ms ease;
    }

    .help:hover .help-tip,
    .help:focus .help-tip {
      opacity: 1;
      transform: translateY(0);
    }

    input, select, textarea {
      width: 100%;
      min-width: 0;
      border: 1px solid #d8c9b7;
      border-radius: 8px;
      background: #fffaf3;
      color: var(--ink);
      padding: 10px 11px;
      outline: none;
    }

    input:focus, select:focus, textarea:focus {
      border-color: var(--accent);
      box-shadow: 0 0 0 3px rgba(185, 132, 78, 0.16);
    }

    textarea {
      min-height: 260px;
      resize: vertical;
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace;
      font-size: 13px;
      line-height: 1.5;
    }

    pre {
      margin: 0;
      min-height: 180px;
      max-height: 420px;
      overflow: auto;
      white-space: pre-wrap;
      word-break: break-word;
      border: 1px solid #d8c9b7;
      border-radius: 8px;
      background: #fffaf3;
      color: var(--ink);
      padding: 14px;
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace;
      font-size: 13px;
      line-height: 1.5;
    }

    .panel.dark pre {
      border-color: #334338;
      background: #151b17;
      color: #e9eee5;
    }

    .muted {
      color: var(--muted);
      font-size: 13px;
      line-height: 1.45;
    }

    .pill {
      display: inline-flex;
      align-items: center;
      min-height: 28px;
      padding: 0 10px;
      border-radius: 999px;
      color: #2d251e;
      background: #ead9c4;
      border: 1px solid #dccab5;
      font-size: 12px;
      font-weight: 800;
    }

    .split {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 12px;
    }

    .status-line {
      min-height: 20px;
      color: var(--muted);
      font-size: 13px;
    }

    .error {
      color: var(--danger);
      font-weight: 700;
    }

    .empty {
      padding: 22px;
      border-radius: 8px;
      border: 1px dashed #d8c9b7;
      color: var(--muted);
      background: rgba(255, 250, 243, 0.58);
    }

    @media (max-width: 980px) {
      .shell {
        grid-template-columns: 1fr;
        padding: 14px;
      }

      .sidebar {
        min-height: auto;
        border-radius: 8px 8px 0 0;
      }

      .main {
        border-left: 1px solid rgba(255,255,255,0.55);
        border-radius: 0 0 8px 8px;
        padding: 20px;
        min-height: auto;
      }

      .grid,
      .split {
        grid-template-columns: 1fr;
      }

      .stats {
        grid-template-columns: repeat(2, minmax(0, 1fr));
      }

      .topbar {
        display: grid;
      }

      .toolbar {
        justify-content: flex-start;
      }
    }

    @media (max-width: 620px) {
      .stats {
        grid-template-columns: 1fr;
      }

      .instance {
        grid-template-columns: 1fr;
      }

      .actions {
        justify-content: flex-start;
      }
    }
  </style>
</head>
<body>
  <div class="shell" id="app">
    <aside class="sidebar">
      <div class="brand">
        <strong>Conductor</strong>
        <span>Symphony Control Plane</span>
      </div>
      <nav class="nav" aria-label="Sections">
        <button class="active" data-view-target="overview">Overview</button>
        <button data-view-target="instances">Instances</button>
        <button data-view-target="workflow">Workflow Studio</button>
        <button data-view-target="linear">Linear Views</button>
        <button data-view-target="logs">Logs</button>
        <button data-view-target="settings">Settings</button>
      </nav>
      <div class="sidebar-foot">
        <span id="side-running">0 running Symphony daemons</span>
        <span id="side-workflows">0 workflow templates</span>
      </div>
    </aside>

    <main class="main">
      <div class="topbar">
        <div>
          <h1>Orchestrate Multiple Symphony Workers</h1>
          <p class="subtle">Local repos, Linear filters, generated workflows, runtime state, and logs in one control surface.</p>
        </div>
        <div class="toolbar">
          <button class="secondary" id="refresh-button" type="button">Refresh</button>
          <button class="primary" type="button" data-view-target="instances">New Instance</button>
        </div>
      </div>

      <section class="fabric" aria-label="Active Fabric">
        <div class="fabric-title">Active Fabric</div>
        <div class="stats">
          <div class="stat"><span>Instances</span><strong id="stat-instances">0</strong></div>
          <div class="stat"><span>Running</span><strong id="stat-running">0</strong></div>
          <div class="stat"><span>Workflow Drafts</span><strong id="stat-drafts">0</strong></div>
          <div class="stat"><span>Invalid</span><strong id="stat-invalid">0</strong></div>
          <div class="stat"><span>Tokens</span><strong id="stat-tokens">0</strong></div>
          <div class="stat"><span>Runtime</span><strong id="stat-runtime">0s</strong></div>
          <div class="stat"><span>Failures / Retries</span><strong id="stat-failures">0 / 0</strong></div>
        </div>
      </section>

      <section class="view active" id="view-overview">
        <div class="grid">
          <section class="panel">
            <div class="panel-head">
              <h2>Symphony Instances</h2>
              <span class="pill" id="overview-status">0 active</span>
            </div>
            <div class="stack" id="overview-instances"></div>
          </section>
          <section class="panel dark">
            <div class="panel-head">
              <h2>Workflow Status</h2>
              <button class="secondary" type="button" id="overview-generate">Generate</button>
            </div>
            <div class="stack" id="overview-workflow-summary"></div>
          </section>
        </div>
      </section>

      <section class="view" id="view-instances">
        <div class="grid">
          <section class="panel">
            <div class="panel-head">
              <h2>Instances</h2>
              <span class="pill" id="instance-count">0 total</span>
            </div>
            <div class="stack" id="instances-list"></div>
          </section>
          <section class="panel">
            <div class="panel-head">
              <h2>Create Instance</h2>
              <span class="pill">local_path</span>
            </div>
            <form id="create-form">
              <label>Name<input name="name" autocomplete="off" required></label>
              <label>Local repo path<input name="repo_source_value" autocomplete="off" required></label>
              <div class="split">
                <label>
                  <span class="label-row">
                    Linear project slug
                    <span class="help" tabindex="0" aria-describedby="linear-project-slug-help">?
                      <span class="help-tip" id="linear-project-slug-help" role="tooltip">Use the Linear project slug, also shown as the issue key prefix. Find it in Linear under Project settings for that project.</span>
                    </span>
                  </span>
                  <input name="linear_project" autocomplete="off" required>
                </label>
                <label>Labels<input name="labels" autocomplete="off" placeholder="codex, api"></label>
              </div>
              <label>
                <span class="label-row">
                  Goal (optional)
                  <span class="help" tabindex="0" aria-describedby="goal-help">?
                    <span class="help-tip" id="goal-help" role="tooltip">This becomes the Instance goal in the generated WORKFLOW.md. Leave this blank to use the default goal.</span>
                  </span>
                </span>
                <textarea name="goal"></textarea>
              </label>
              <label>Workflow profile<select name="workflow_profile" id="workflow-profile-select"></select></label>
              <div class="row">
                <button class="primary" type="submit">Create</button>
                <button class="secondary" type="button" id="preview-workflow-button">Preview Workflow</button>
                <button class="secondary" type="button" id="inspect-repo-button">Inspect Repo</button>
              </div>
              <div class="status-line" id="create-status"></div>
              <pre id="workflow-preview" aria-label="Workflow preview"></pre>
            </form>
          </section>
        </div>
      </section>

      <section class="view" id="view-workflow">
        <div class="grid">
          <section class="panel">
            <div class="panel-head">
              <h2>WORKFLOW.md</h2>
              <span class="pill" id="workflow-instance-pill">No instance</span>
            </div>
            <textarea id="workflow-editor" spellcheck="false"></textarea>
            <div class="row" style="margin-top: 12px;">
              <button class="primary" type="button" id="generate-workflow-button">Generate Workflow</button>
              <button class="secondary" type="button" id="validate-workflow-button">Validate</button>
            </div>
          </section>
          <section class="panel dark">
            <div class="panel-head">
              <h2>Diagnostics</h2>
              <span class="pill" id="workflow-status-pill">draft</span>
            </div>
            <pre id="workflow-diagnostics"></pre>
          </section>
        </div>
      </section>

      <section class="view" id="view-linear">
        <div class="panel">
          <div class="panel-head">
            <h2>Linear Views</h2>
            <span class="pill" id="linear-count">0 views</span>
          </div>
          <div class="stack" id="linear-views"></div>
        </div>
      </section>

      <section class="view" id="view-logs">
        <div class="grid">
          <section class="panel dark">
            <div class="panel-head">
              <h2>Logs</h2>
              <select id="logs-instance-select" aria-label="Log instance"></select>
            </div>
            <pre id="logs-output"></pre>
          </section>
          <section class="panel">
            <div class="panel-head">
              <h2>Runtime Snapshot</h2>
              <button class="secondary" id="load-logs-button" type="button">Load Logs</button>
            </div>
            <div class="metric-row" id="runtime-metrics"></div>
            <div class="status-line" id="workspace-note"></div>
            <h3>Issue Runtime</h3>
            <div class="stack" id="runtime-issues"></div>
            <pre id="runtime-output"></pre>
          </section>
        </div>
      </section>

      <section class="view" id="view-settings">
        <div class="grid">
          <section class="panel">
            <div class="panel-head">
              <h2>Conductor Settings</h2>
              <span class="pill" id="settings-key-status">API key not configured</span>
            </div>
            <form id="settings-form">
              <label>Linear API key<input type="password" name="linear_api_key" autocomplete="off"></label>
              <div class="row">
                <button class="primary" type="submit">Save Settings</button>
              </div>
              <div class="status-line" id="settings-status"></div>
            </form>
          </section>
          <section class="panel dark">
            <div class="panel-head">
              <h2>Runtime Env</h2>
              <span class="pill">LINEAR_API_KEY</span>
            </div>
            <pre id="settings-summary"></pre>
          </section>
        </div>
      </section>
    </main>
  </div>

  <script>
    const state = {
      dashboard: null,
      instances: [],
      profiles: [],
      settings: { linear_api_key_configured: false },
      selectedId: null,
      view: "overview",
      busy: false
    };

    const $ = (selector) => document.querySelector(selector);
    const $$ = (selector) => Array.from(document.querySelectorAll(selector));

    async function api(path, options = {}) {
      const init = { headers: { "Content-Type": "application/json" }, ...options };
      if (init.body && typeof init.body !== "string") init.body = JSON.stringify(init.body);
      const response = await fetch(path, init);
      const text = await response.text();
      const payload = text ? JSON.parse(text) : {};
      if (!response.ok) {
        const message = payload.error?.message || `Request failed: ${response.status}`;
        const error = new Error(message);
        error.payload = payload;
        throw error;
      }
      return payload;
    }

    function setView(view) {
      state.view = view;
      $$(".view").forEach((node) => node.classList.toggle("active", node.id === `view-${view}`));
      $$("[data-view-target]").forEach((node) => node.classList.toggle("active", node.dataset.viewTarget === view));
      if (view === "logs") loadLogs();
    }

    function compactFilters(filters) {
      if (!filters || Object.keys(filters).length === 0) return "no filters";
      return Object.entries(filters).map(([key, value]) => `${key}: ${Array.isArray(value) ? value.join(", ") : value}`).join(" / ");
    }

    function statusDot(status) {
      return `<span class="dot ${status || "stopped"}"></span>`;
    }

    function instanceMeta(instance) {
      const error = instance.last_error ? ` / error: ${instance.last_error}` : "";
      return `${instance.resolved_repo_path || instance.repo_source_value} / Linear: ${instance.linear_project} / ${compactFilters(instance.linear_filters)} / port: ${instance.http_port} / workflow: ${instance.workflow_generation_status} / process: ${instance.process_status} / pid: ${instance.pid || "none"}${error}`;
    }

    function instanceCard(instance) {
      const selected = instance.id === state.selectedId ? " selected" : "";
      const running = instance.process_status === "running";
      return `<article class="instance${selected}" data-instance-id="${instance.id}">
        <div class="instance-main">
          <div class="instance-title">${statusDot(instance.process_status)}<span>${instance.name}</span></div>
          <div class="meta">${instanceMeta(instance)}</div>
        </div>
        <div class="actions">
          <button type="button" data-action="open" data-id="${instance.id}">Open</button>
          <button class="primary" type="button" data-action="start" data-id="${instance.id}" ${running ? "disabled" : ""}>Start</button>
          <button type="button" data-action="stop" data-id="${instance.id}" ${running ? "" : "disabled"}>Stop</button>
          <button type="button" data-action="restart" data-id="${instance.id}">Restart</button>
          <button type="button" data-action="logs" data-id="${instance.id}">Logs</button>
          <button class="danger" type="button" data-action="delete" data-id="${instance.id}" ${running ? "disabled" : ""}>Delete</button>
        </div>
      </article>`;
    }

    function renderInstances() {
      const markup = state.instances.length ? state.instances.map(instanceCard).join("") : `<div class="empty">No instances yet.</div>`;
      $("#overview-instances").innerHTML = markup;
      $("#instances-list").innerHTML = markup;
      $("#instance-count").textContent = `${state.instances.length} total`;
      $("#overview-status").textContent = `${state.dashboard?.counts?.running || 0} active`;

      const options = state.instances.map((instance) => `<option value="${instance.id}" ${instance.id === state.selectedId ? "selected" : ""}>${instance.name}</option>`).join("");
      $("#logs-instance-select").innerHTML = options;
    }

    function renderDashboard() {
      const dashboard = state.dashboard || { counts: {}, totals: {}, workflow_statuses: {}, linear_views: [] };
      $("#stat-instances").textContent = dashboard.counts.instances || 0;
      $("#stat-running").textContent = dashboard.counts.running || 0;
      $("#stat-drafts").textContent = dashboard.counts.workflow_draft || 0;
      $("#stat-invalid").textContent = dashboard.counts.workflow_invalid || 0;
      $("#stat-tokens").textContent = dashboard.totals.tokens || 0;
      $("#stat-runtime").textContent = formatDuration(dashboard.totals.runtime_seconds || 0);
      $("#stat-failures").textContent = `${dashboard.totals.failures || 0} / ${dashboard.totals.retries || 0}`;
      $("#side-running").textContent = `${dashboard.counts.running || 0} running Symphony daemons`;
      $("#side-workflows").textContent = `${state.profiles.length} workflow templates`;

      const workflowEntries = Object.entries(dashboard.workflow_statuses || {});
      $("#overview-workflow-summary").innerHTML = workflowEntries.length
        ? workflowEntries.map(([status, count]) => `<div class="row"><span class="pill">${status}</span><strong>${count}</strong></div>`).join("")
        : `<div class="empty">No workflows.</div>`;

      const views = dashboard.linear_views || [];
      $("#linear-count").textContent = `${views.length} views`;
      $("#linear-views").innerHTML = views.length
        ? views.map((view) => `<article class="instance">
            <div class="instance-main">
              <div class="instance-title">${statusDot("running")}<span>${view.project}</span></div>
              <div class="meta">${compactFilters(view.filters)} / instances: ${view.instances}</div>
            </div>
          </article>`).join("")
        : `<div class="empty">No Linear project filters configured.</div>`;
    }

    function renderSettings() {
      const configured = Boolean(state.settings?.linear_api_key_configured);
      $("#settings-key-status").textContent = configured ? "API key configured" : "API key not configured";
      $("#settings-summary").textContent = JSON.stringify({
        LINEAR_API_KEY: configured ? "configured by Conductor" : "missing"
      }, null, 2);
    }

    async function loadSelectedDetail() {
      const selected = state.instances.find((instance) => instance.id === state.selectedId);
      if (!selected) {
        $("#workflow-instance-pill").textContent = "No instance";
        $("#workflow-status-pill").textContent = "draft";
        $("#workflow-editor").value = "";
        $("#workflow-diagnostics").textContent = "";
        return;
      }
      const detail = await api(`/api/instances/${selected.id}`);
      const instance = detail.instance;
      $("#workflow-instance-pill").textContent = instance.name;
      $("#workflow-status-pill").textContent = instance.workflow_generation_status;
      $("#workflow-editor").value = instance.workflow_content || "";
      $("#workflow-diagnostics").textContent = "Ready";
    }

    function formatDuration(seconds) {
      if (seconds < 60) return `${seconds}s`;
      const minutes = Math.floor(seconds / 60);
      if (minutes < 60) return `${minutes}m`;
      return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
    }

    async function refresh() {
      const [dashboard, instances, profiles, settings] = await Promise.all([
        api("/api/dashboard"),
        api("/api/instances"),
        api("/api/templates/workflow-profiles"),
        api("/api/settings")
      ]);
      state.dashboard = dashboard.dashboard;
      state.instances = instances.instances;
      state.profiles = profiles.profiles;
      state.settings = settings.settings;
      if (!state.selectedId && state.instances[0]) state.selectedId = state.instances[0].id;
      if (state.selectedId && !state.instances.some((instance) => instance.id === state.selectedId)) {
        state.selectedId = state.instances[0]?.id || null;
      }
      $("#workflow-profile-select").innerHTML = state.profiles.map((profile) => `<option value="${profile.name}">${profile.name}</option>`).join("");
      renderDashboard();
      renderInstances();
      renderSettings();
      await loadSelectedDetail();
    }

    async function actionInstance(action, id) {
      const instance = state.instances.find((item) => item.id === id);
      if (!instance) return;
      state.selectedId = id;
      if (action === "open") {
        window.open(`http://127.0.0.1:${instance.http_port}/`, "_blank", "noopener");
        return;
      }
      if (action === "logs") {
        setView("logs");
        await loadLogs();
        return;
      }
      if (action === "delete") {
        if (!window.confirm(`Delete instance "${instance.name}"?`)) return;
        await api(`/api/instances/${id}`, { method: "DELETE" });
        if (state.selectedId === id) state.selectedId = null;
        await refresh();
        setView("instances");
        return;
      }
      await api(`/api/instances/${id}/${action}`, { method: "POST", body: {} });
      await refresh();
    }

    async function loadLogs() {
      const id = $("#logs-instance-select").value || state.selectedId;
      if (!id) {
        $("#logs-output").textContent = "";
        $("#runtime-output").textContent = "";
        renderRuntime(null);
        return;
      }
      state.selectedId = id;
      const [logs, runtime] = await Promise.all([
        api(`/api/instances/${id}/logs`),
        api(`/api/instances/${id}/runtime`)
      ]);
      $("#logs-output").textContent = logs.logs || "";
      $("#runtime-output").textContent = JSON.stringify(runtime.runtime, null, 2);
      renderRuntime(runtime.runtime);
    }

    function renderRuntime(runtime) {
      if (!runtime) {
        $("#runtime-metrics").innerHTML = "";
        $("#workspace-note").textContent = "";
        $("#runtime-issues").innerHTML = `<div class="empty">No runtime selected.</div>`;
        return;
      }
      const metrics = runtime.metrics || { tokens: {}, turns: 0, running: 0, retrying: 0 };
      $("#runtime-metrics").innerHTML = [
        ["Tokens", metrics.tokens?.total_tokens || 0],
        ["Turns", metrics.turns || 0],
        ["Running", metrics.running || 0],
        ["Retrying", metrics.retrying || 0]
      ].map(([label, value]) => `<div class="mini-stat"><span>${label}</span><strong>${value}</strong></div>`).join("");
      $("#workspace-note").textContent = runtime.workspace?.description || "";
      const issues = runtime.symphony?.issues || [];
      $("#runtime-issues").innerHTML = issues.length
        ? issues.map((issue) => `<article class="instance">
            <div class="instance-main">
              <div class="instance-title">${statusDot(issue.phase === "running" ? "running" : issue.phase === "retrying" ? "starting" : "exited")}<span>${issue.issue_identifier}</span></div>
              <div class="meta">${issue.status_label || issue.phase || "unknown"} / turns: ${issue.turn_count || 0} / tokens: ${issue.tokens?.total_tokens || 0} / last: ${issue.last_message || issue.error || issue.last_event || "none"}</div>
              <div class="meta">${issue.workspace_path || ""}</div>
            </div>
          </article>`).join("")
        : `<div class="empty">No issue runtime details yet.</div>`;
    }

    function labelsFromInput(value) {
      return value.split(",").map((label) => label.trim()).filter(Boolean);
    }

    function createPayloadFromForm(form) {
      const data = new FormData(form);
      return {
        name: data.get("name"),
        repo_source_type: "local_path",
        repo_source_value: data.get("repo_source_value"),
        linear_project: data.get("linear_project"),
        linear_filters: { labels: labelsFromInput(data.get("labels") || "") },
        workflow_profile: data.get("workflow_profile") || "default",
        workflow_inputs: { goal: data.get("goal") }
      };
    }

    document.addEventListener("click", async (event) => {
      const target = event.target.closest("button, article.instance");
      if (!target) return;
      try {
        if (target.dataset.viewTarget) setView(target.dataset.viewTarget);
        if (target.dataset.instanceId) {
          state.selectedId = target.dataset.instanceId;
          renderInstances();
          await loadSelectedDetail();
        }
        if (target.dataset.action) await actionInstance(target.dataset.action, target.dataset.id);
      } catch (error) {
        $("#workflow-diagnostics").textContent = error.payload ? JSON.stringify(error.payload, null, 2) : error.message;
      }
    });

    $("#refresh-button").addEventListener("click", refresh);
    $("#overview-generate").addEventListener("click", () => setView("workflow"));
    $("#logs-instance-select").addEventListener("change", loadLogs);
    $("#load-logs-button").addEventListener("click", loadLogs);

    $("#inspect-repo-button").addEventListener("click", async () => {
      const form = $("#create-form");
      const status = $("#create-status");
      try {
        const data = new FormData(form);
        const repo = await api("/api/repo/inspect", {
          method: "POST",
          body: { repo_source_type: "local_path", repo_source_value: data.get("repo_source_value") }
        });
        status.textContent = `${repo.repo.resolved_path} / git: ${repo.repo.git ? "yes" : "no"}`;
        status.classList.remove("error");
      } catch (error) {
        status.textContent = error.message;
        status.classList.add("error");
      }
    });

    $("#preview-workflow-button").addEventListener("click", async () => {
      const form = $("#create-form");
      const status = $("#create-status");
      try {
        if (!form.reportValidity()) return;
        const preview = await api("/api/instances/preview-workflow", { method: "POST", body: createPayloadFromForm(form) });
        $("#workflow-preview").textContent = preview.workflow_content || "";
        status.textContent = "Preview generated. Review it before creating the instance.";
        status.classList.remove("error");
      } catch (error) {
        status.textContent = error.payload ? `${error.message}: ${(error.payload.error?.diagnostics || []).join("; ")}` : error.message;
        status.classList.add("error");
      }
    });

    $("#create-form").addEventListener("submit", async (event) => {
      event.preventDefault();
      const form = event.currentTarget;
      const status = $("#create-status");
      try {
        const payload = createPayloadFromForm(form);
        const created = await api("/api/instances", { method: "POST", body: payload });
        state.selectedId = created.instance.id;
        status.textContent = `Created ${created.instance.name}`;
        status.classList.remove("error");
        $("#workflow-preview").textContent = "";
        form.reset();
        await refresh();
        setView("instances");
      } catch (error) {
        status.textContent = error.payload ? `${error.message}: ${(error.payload.error?.diagnostics || []).join("; ")}` : error.message;
        status.classList.add("error");
      }
    });

    $("#settings-form").addEventListener("submit", async (event) => {
      event.preventDefault();
      const form = event.currentTarget;
      const status = $("#settings-status");
      try {
        const data = new FormData(form);
        const result = await api("/api/settings", {
          method: "PATCH",
          body: { linear_api_key: data.get("linear_api_key") || "" }
        });
        state.settings = result.settings;
        renderSettings();
        status.textContent = "Settings saved";
        status.classList.remove("error");
        form.reset();
      } catch (error) {
        status.textContent = error.payload ? JSON.stringify(error.payload, null, 2) : error.message;
        status.classList.add("error");
      }
    });

    $("#generate-workflow-button").addEventListener("click", async () => {
      if (!state.selectedId) return;
      const result = await api(`/api/instances/${state.selectedId}/generate-workflow`, { method: "POST", body: {} });
      $("#workflow-editor").value = result.instance.workflow_content || "";
      $("#workflow-status-pill").textContent = result.instance.workflow_generation_status;
      $("#workflow-diagnostics").textContent = "Generated";
      await refresh();
    });

    $("#validate-workflow-button").addEventListener("click", async () => {
      if (!state.selectedId) return;
      const result = await api(`/api/instances/${state.selectedId}/validate-workflow`, {
        method: "POST",
        body: { workflow_content: $("#workflow-editor").value }
      });
      $("#workflow-diagnostics").textContent = JSON.stringify(result.validation, null, 2);
      $("#workflow-status-pill").textContent = result.validation.ok ? "valid" : "invalid";
    });

    refresh().catch((error) => {
      $("#overview-instances").innerHTML = `<div class="empty error">${error.message}</div>`;
    });
  </script>
</body>
</html>
"""


def manage_web_concept_svg() -> str:
    concept_path = Path(__file__).resolve().parents[2] / "tmp" / "manage-web-concept.svg"
    if concept_path.exists():
        return concept_path.read_text(encoding="utf-8")
    return """<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360" viewBox="0 0 640 360">
  <rect width="640" height="360" fill="#f3efe7"/>
  <rect x="32" y="28" width="576" height="304" rx="8" fill="#fbf7f1"/>
  <rect x="32" y="28" width="132" height="304" rx="8" fill="#1b241f"/>
  <text x="56" y="76" fill="#f7f1e8" font-family="Arial, Helvetica, sans-serif" font-size="24" font-weight="700">Conductor</text>
  <text x="56" y="102" fill="#b7c3b6" font-family="Arial, Helvetica, sans-serif" font-size="12">Symphony Control Plane</text>
  <rect x="188" y="68" width="380" height="92" rx="8" fill="#1f2a24"/>
  <text x="212" y="118" fill="#f7f1e8" font-family="Arial, Helvetica, sans-serif" font-size="28" font-weight="700">Active Fabric</text>
  <rect x="188" y="188" width="220" height="96" rx="8" fill="#fffaf3" stroke="#e2d5c4"/>
  <rect x="428" y="188" width="140" height="96" rx="8" fill="#fffaf3" stroke="#e2d5c4"/>
</svg>
"""


def favicon_ico() -> bytes:
    png = _favicon_png()
    header = struct.pack("<HHH", 0, 1, 1)
    directory = struct.pack("<BBBBHHII", 32, 32, 0, 0, 1, 32, len(png), 22)
    return header + directory + png


def _favicon_png() -> bytes:
    width = 32
    height = 32
    rows = []
    for y in range(height):
        row = bytearray([0])
        for x in range(width):
            row.extend(_favicon_pixel(x, y))
        rows.append(bytes(row))
    raw = b"".join(rows)
    chunks = [
        _png_chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0)),
        _png_chunk(b"IDAT", zlib.compress(raw, level=9)),
        _png_chunk(b"IEND", b""),
    ]
    return b"\x89PNG\r\n\x1a\n" + b"".join(chunks)


def _favicon_pixel(x: int, y: int) -> tuple[int, int, int, int]:
    corner = 6
    if (x < corner and y < corner and (corner - x) ** 2 + (corner - y) ** 2 > corner**2) or (
        x >= 32 - corner and y < corner and (x - (31 - corner)) ** 2 + (corner - y) ** 2 > corner**2
    ) or (
        x < corner and y >= 32 - corner and (corner - x) ** 2 + (y - (31 - corner)) ** 2 > corner**2
    ) or (
        x >= 32 - corner
        and y >= 32 - corner
        and (x - (31 - corner)) ** 2 + (y - (31 - corner)) ** 2 > corner**2
    ):
        return (0, 0, 0, 0)

    green = (27, 36, 31, 255)
    green_light = (43, 58, 49, 255)
    accent = (215, 177, 132, 255)
    cream = (251, 247, 241, 255)
    shadow = (15, 21, 18, 255)

    if 15 <= x <= 17 and 17 <= y <= 23:
        return accent

    if (x - 16) ** 2 + (y - 8) ** 2 <= 18:
        return cream
    if 11 <= x <= 21 and 4 <= y <= 7 and (x - 16) ** 2 / 34 + (y - 7) ** 2 / 8 <= 1:
        return shadow
    if 11 <= x <= 13 and 8 <= y <= 10:
        return shadow

    baton_points = {
        (20, 12),
        (21, 11),
        (22, 10),
        (23, 9),
        (24, 8),
        (25, 7),
        (26, 6),
        (27, 5),
        (22, 8),
        (23, 7),
        (24, 6),
        (25, 5),
        (26, 4),
    }
    if (x, y) in baton_points or (x - 1, y) in baton_points:
        return accent
    if (19 <= x <= 22 and 13 <= y <= 18 and abs((x - 19) - (18 - y)) <= 1) or (21 <= x <= 23 and 15 <= y <= 19):
        return cream

    if 7 <= x <= 25 and 19 <= y <= 27:
        shoulder = (x - 16) ** 2 / 120 + (y - 28) ** 2 / 42
        if shoulder <= 1:
            return green_light
    if 13 <= x <= 19 and 17 <= y <= 26:
        coat = abs(x - 16) <= max(1, y - 18)
        if coat:
            return shadow

    return green


def _png_chunk(chunk_type: bytes, data: bytes) -> bytes:
    checksum = zlib.crc32(chunk_type + data) & 0xFFFFFFFF
    return struct.pack(">I", len(data)) + chunk_type + data + struct.pack(">I", checksum)
