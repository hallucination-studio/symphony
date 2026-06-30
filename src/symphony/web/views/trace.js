import { getJSON } from '../lib/api.js'
import { formatTimestamp } from '../lib/format.js'

export async function renderTraceView(root, { issueId = null, runId = null } = {}) {
  const query = new URLSearchParams()
  if (issueId) query.set('issue_id', issueId)
  if (runId) query.set('run_id', runId)
  const path = `/api/traces${query.toString() ? `?${query.toString()}` : ''}`
  const { events } = await getJSON(path)

  root.innerHTML = `
    <section class="page-head">
      <div>
        <p class="eyebrow">Turn → Trace</p>
        <h2>Trace Viewer</h2>
      </div>
      <div class="inline-kpis">
        <span>${events.length} Events</span>
        <span>Raw Logs Fallback</span>
      </div>
    </section>
    <section class="trace-grid">
      <div class="trace-toolbar">
        <input id="trace-filter" type="search" placeholder="Filter event type, issue, run">
        <select id="trace-tier" aria-label="Retention tier">
          <option value="">All tiers</option>
          <option value="summary">Summary</option>
          <option value="trace">Trace</option>
          <option value="raw">Raw</option>
        </select>
      </div>
      <div class="trace-list" id="trace-list">
        ${renderTraceRows(events)}
      </div>
      <aside class="detail-pane" id="trace-detail">
        <h3>Event detail</h3>
        <p class="muted">Select an event to inspect payload, timing, tool call context, and retention tier.</p>
      </aside>
    </section>
  `

  root.querySelectorAll('[data-event-index]').forEach((row) => {
    row.addEventListener('click', () => {
      const event = events[Number(row.dataset.eventIndex)]
      renderEventDetail(root, event)
    })
  })
}

function renderTraceRows(events) {
  if (!events.length) {
    return '<div class="empty-state"><h3>No trace events</h3><p>No structured telemetry has been recorded for this filter.</p></div>'
  }
  return events.map((event, index) => `
    <button class="trace-row trace-button" data-event-index="${index}" type="button">
      <strong>${escapeHTML(event.event_type)}</strong>
      <span>${formatTimestamp(event.timestamp)} · ${escapeHTML(event.issue_id || 'no issue')} · ${escapeHTML(event.run_id || 'no run')}</span>
    </button>
  `).join('')
}

function renderEventDetail(root, event) {
  const detail = root.querySelector('#trace-detail')
  detail.innerHTML = `
    <div class="detail-head">
      <div>
        <p class="eyebrow">${escapeHTML(event.retention_tier || 'trace')}</p>
        <h3>${escapeHTML(event.event_type)}</h3>
      </div>
      <span class="status-pill">${formatTimestamp(event.timestamp)}</span>
    </div>
    <div class="metric-row">
      <span>Issue <strong>${escapeHTML(event.issue_id || 'none')}</strong></span>
      <span>Run <strong>${escapeHTML(event.run_id || 'none')}</strong></span>
      <span>Turn <strong>${escapeHTML(event.turn_id || 'none')}</strong></span>
    </div>
    <pre class="json-panel">${escapeHTML(JSON.stringify(event, null, 2))}</pre>
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
