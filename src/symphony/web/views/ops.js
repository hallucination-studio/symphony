import { getJSON, postJSON } from '../lib/api.js'
import { formatTimestamp, formatTokens } from '../lib/format.js'

export async function renderRetentionView(root, { onSummary = null } = {}) {
  const { retention } = await getJSON('/api/retention')
  if (onSummary) onSummary(retention)

  root.innerHTML = `
    <section class="page-head">
      <div>
        <p class="eyebrow">Layered Retention</p>
        <h2>Retention</h2>
      </div>
      <button class="small-button" id="collect-retention" type="button">Collect</button>
    </section>
    <section class="ops-grid">
      <article class="metric-card">
        <span>Pinned Issues</span>
        <strong>${retention.pinned_issue_count || 0}</strong>
      </article>
      <article class="metric-card">
        <span>Summary Events</span>
        <strong>${retention.event_counts?.summary || 0}</strong>
      </article>
      <article class="metric-card">
        <span>Trace Events</span>
        <strong>${retention.event_counts?.trace || 0}</strong>
      </article>
      <article class="metric-card">
        <span>Raw Events</span>
        <strong>${retention.event_counts?.raw || 0}</strong>
      </article>
    </section>
    <section class="detail-pane">
      <h3>Pin and purge controls</h3>
      <p class="muted">Pinned records are exempt from automatic cleanup. Raw logs stay available as a fallback while structured traces remain the primary workflow.</p>
    </section>
  `

  root.querySelector('#collect-retention')?.addEventListener('click', async () => {
    await postJSON('/api/retention/collect')
    await renderRetentionView(root, { onSummary })
  })
}

export async function renderInstancesView(root) {
  const { instances } = await getJSON('/api/instances')
  root.innerHTML = `
    <section class="page-head">
      <div>
        <p class="eyebrow">Execution Process</p>
        <h2>Instances</h2>
      </div>
    </section>
    <section class="data-list">
      ${instances.map(renderInstance).join('') || '<div class="empty-state"><h3>No instances</h3><p>Create an instance to begin emitting ops snapshots.</p></div>'}
    </section>
  `
}

export function renderLinearView(root) {
  root.innerHTML = `
    <section class="page-head">
      <div>
        <p class="eyebrow">Milestone Summaries</p>
        <h2>Linear Views</h2>
      </div>
    </section>
    <section class="detail-pane">
      <h3>Concise milestone layer</h3>
      <p class="muted">Linear receives summaries and debug links; the Conductor Ops Console remains the deep-debug surface.</p>
    </section>
  `
}

export function renderWorkflowView(root) {
  root.innerHTML = `
    <section class="page-head">
      <div>
        <p class="eyebrow">Runtime Workflow</p>
        <h2>Workflow</h2>
      </div>
    </section>
    <section class="detail-pane">
      <h3>Workflow diagnostics</h3>
      <p class="muted">Instance workflow generation and validation remain available through the existing instance APIs.</p>
    </section>
  `
}

export function renderSettingsView(root) {
  root.innerHTML = `
    <section class="page-head">
      <div>
        <p class="eyebrow">Console Settings</p>
        <h2>Settings</h2>
      </div>
    </section>
    <section class="detail-pane">
      <h3>Configuration</h3>
      <p class="muted">Settings use the existing Conductor settings endpoint and stay outside the issue drill-down path.</p>
    </section>
  `
}

function renderInstance(instance) {
  return `
    <div class="row-card">
      <span>
        <strong>${escapeHTML(instance.name || instance.instance_id)}</strong>
        <small>${escapeHTML(instance.instance_id)}</small>
      </span>
      <span>${escapeHTML(instance.status || 'unknown')}</span>
      <span>${formatTokens(instance.runtime?.total_tokens || 0)}</span>
      <span>${escapeHTML(instance.linear_project || '')}</span>
      <span>${formatTimestamp(instance.updated_at)}</span>
    </div>
  `
}

function escapeHTML(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[char])
}
