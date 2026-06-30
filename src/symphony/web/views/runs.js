import { getJSON } from '../lib/api.js'
import { formatCurrency, formatDuration, formatTimestamp, formatTokens } from '../lib/format.js'

export async function renderRunsView(root, { onSummary = null } = {}) {
  const { runs } = await getJSON('/api/runs')
  if (onSummary) onSummary(runs)

  root.innerHTML = `
    <section class="page-head">
      <div>
        <p class="eyebrow">Run → Attempt → Turn → Trace</p>
        <h2>Runs</h2>
      </div>
      <div class="inline-kpis">
        <span>Total Tokens ${formatTokens(sum(runs, 'total_tokens'))}</span>
        <span>Estimated Cost ${formatCurrency(sum(runs, 'estimated_cost_usd'))}</span>
      </div>
    </section>
    <section class="split-view">
      <div class="data-list">
        ${renderRunRows(runs)}
      </div>
      <aside class="detail-pane" id="run-detail">
        <h3>Run detail</h3>
        <p class="muted">Select a run to inspect attempts, turns, timing, retry count, failure reason, and trace events.</p>
      </aside>
    </section>
  `

  root.querySelectorAll('[data-run-id]').forEach((row) => {
    row.addEventListener('click', async () => {
      await renderRunDetail(root, row.dataset.runId)
    })
  })
}

async function renderRunDetail(root, runId) {
  const { run } = await getJSON(`/api/runs/${encodeURIComponent(runId)}`)
  const detail = root.querySelector('#run-detail')
  detail.innerHTML = `
    <div class="detail-head">
      <div>
        <p class="eyebrow">${escapeHTML(run.issue_identifier || run.issue_id || 'Issue')}</p>
        <h3>${escapeHTML(run.run_id)}</h3>
      </div>
      <span class="status-pill">${escapeHTML(run.status || 'unknown')}</span>
    </div>
    <p class="state-note">${escapeHTML(run.failure_summary || run.last_reason_summary || 'Run is available for attempt and turn drill-down.')}</p>
    <div class="metric-row">
      <span>Attempts <strong>${(run.attempts || []).length}</strong></span>
      <span>Turns <strong>${run.turn_count || 0}</strong></span>
      <span>Retry Count <strong>${run.retry_count || 0}</strong></span>
    </div>
    <div class="metric-row">
      <span>Total Tokens <strong>${formatTokens(run.total_tokens)}</strong></span>
      <span>Estimated Cost <strong>${formatCurrency(run.estimated_cost_usd)}</strong></span>
      <span>Duration <strong>${formatDuration(run.duration_ms)}</strong></span>
    </div>
    <div class="metric-row">
      <span>First Output <strong>${formatDuration(run.time_to_first_output_ms)}</strong></span>
      <span>First Tool Call <strong>${formatDuration(run.time_to_first_tool_call_ms)}</strong></span>
      <span>Last Activity <strong>${formatTimestamp(run.last_activity_at)}</strong></span>
    </div>
    <div class="timeline">
      <h4>Attempts and turns</h4>
      ${(run.attempts || []).map(renderAttempt).join('') || '<p class="muted">No attempts recorded.</p>'}
    </div>
  `
}

function renderRunRows(runs) {
  if (!runs.length) {
    return '<div class="empty-state"><h3>No runs</h3><p>No execution runs have been recorded yet.</p></div>'
  }
  return runs.map((run) => `
    <button class="row-card" data-run-id="${escapeHTML(run.run_id)}" type="button">
      <span>
        <strong>${escapeHTML(run.run_id)}</strong>
        <small>${escapeHTML(run.issue_id || '')}</small>
      </span>
      <span>${escapeHTML(run.status || 'unknown')}</span>
      <span>${run.turn_count || 0} turns</span>
      <span>${formatTokens(run.total_tokens)}</span>
      <span>${formatTimestamp(run.last_activity_at)}</span>
    </button>
  `).join('')
}

function renderAttempt(attempt) {
  return `
    <div class="trace-row">
      <strong>Attempt ${attempt.attempt_number || attempt.attempt_id}</strong>
      <span>${escapeHTML(attempt.status || 'unknown')} · ${(attempt.turns || []).length} turns · ${formatTokens(attempt.total_tokens)} tokens</span>
    </div>
  `
}

function sum(records, key) {
  return records.reduce((total, record) => total + Number(record[key] || 0), 0)
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
