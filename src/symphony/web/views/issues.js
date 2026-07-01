import { getJSON, postJSON, deleteJSON } from '../lib/api.js'
import { formatCurrency, formatDuration, formatTimestamp, formatTokens } from '../lib/format.js'

export async function renderIssuesView(root, { onSummary = null } = {}) {
  const { issues } = await getJSON('/api/issues')
  if (onSummary) await onSummary(issues)

  root.innerHTML = `
    <section class="page-head">
      <div>
        <p class="eyebrow">Issue → Run → Attempt → Turn → Trace</p>
        <h2>Active Issues</h2>
      </div>
      <div class="inline-kpis">
        <span>Total Tokens ${formatTokens(sum(issues, 'total_tokens'))}</span>
        <span>Estimated Cost ${formatCurrency(sum(issues, 'total_estimated_cost_usd'))}</span>
      </div>
    </section>
    <section class="split-view">
      <div class="data-list" id="issues-table">
        ${renderIssueRows(issues)}
      </div>
      <aside class="detail-pane" id="issue-detail">
        <h3>Issue detail</h3>
        <p class="muted">Select an issue to inspect runs, attempts, turns, trace preview, tokens, costs, failure reason, and last activity.</p>
      </aside>
    </section>
  `

  root.querySelectorAll('[data-issue-id]').forEach((row) => {
    row.addEventListener('click', async () => {
      await renderIssueDetail(root, row.dataset.issueId)
    })
  })
}

async function renderIssueDetail(root, issueId) {
  const { issue } = await getJSON(`/api/issues/${encodeURIComponent(issueId)}`)
  const detail = root.querySelector('#issue-detail')
  const tracePreview = (issue.events || []).slice(0, 6)
  detail.innerHTML = `
    <div class="detail-head">
      <div>
        <p class="eyebrow">${escapeHTML(issue.issue_identifier || issue.issue_id)}</p>
        <h3>${escapeHTML(issue.title || 'Untitled issue')}</h3>
      </div>
      <button class="small-button" data-pin-issue="${escapeHTML(issue.issue_id)}" type="button">${issue.pinned ? 'Unpin' : 'Pin'}</button>
    </div>
    <p class="state-note">${escapeHTML(issue.state_explanation || 'No state explanation available.')}</p>
    <div class="metric-row">
      <span>Attempts <strong>${metric(issue.metrics, 'attempts')}</strong></span>
      <span>Turns <strong>${metric(issue.metrics, 'turns')}</strong></span>
      <span>Tool Calls <strong>${metric(issue.metrics, 'tool_calls')}</strong></span>
    </div>
    <div class="metric-row">
      <span>Input Tokens <strong>${formatTokens(metric(issue.metrics, 'input_tokens'))}</strong></span>
      <span>Output Tokens <strong>${formatTokens(metric(issue.metrics, 'output_tokens'))}</strong></span>
      <span>Cached Tokens <strong>${formatTokens(metric(issue.metrics, 'cached_tokens'))}</strong></span>
    </div>
    <div class="metric-row">
      <span>Total Tokens <strong>${formatTokens(metric(issue.metrics, 'total_tokens'))}</strong></span>
      <span>Estimated Cost <strong>${formatCurrency(metric(issue.metrics, 'estimated_cost_usd'))}</strong></span>
      <span>Duration <strong>${formatDuration(metric(issue.metrics, 'duration_ms'))}</strong></span>
    </div>
    <div class="timeline">
      <h4>Run history</h4>
      ${(issue.runs || []).map(renderRunLink).join('') || '<p class="muted">No runs recorded.</p>'}
    </div>
    <div class="timeline">
      <h4>Codex trace preview</h4>
      ${tracePreview.map(renderTimelineEvent).join('') || '<p class="muted">No trace events recorded.</p>'}
    </div>
  `

  detail.querySelector('[data-pin-issue]')?.addEventListener('click', async () => {
    if (issue.pinned) {
      await deleteJSON(`/api/issues/${encodeURIComponent(issue.issue_id)}/pin`)
    } else {
      await postJSON(`/api/issues/${encodeURIComponent(issue.issue_id)}/pin`)
    }
    await renderIssueDetail(root, issue.issue_id)
  })
}

function renderIssueRows(issues) {
  if (!issues.length) {
    return '<div class="empty-state"><h3>No issues</h3><p>No ops snapshots have emitted issue telemetry yet.</p></div>'
  }
  return issues.map((issue) => `
    <button class="row-card" data-issue-id="${escapeHTML(issue.issue_id)}" type="button">
      <span>
        <strong>${escapeHTML(issue.issue_identifier || issue.issue_id)}</strong>
        <small>${escapeHTML(issue.title || '')}</small>
      </span>
      <span>${escapeHTML(issue.state || issue.status || 'unknown')}</span>
      <span>${formatTokens(issue.total_tokens)}</span>
      <span>${formatCurrency(issue.total_estimated_cost_usd)}</span>
      <span>${formatTimestamp(issue.last_activity_at)}</span>
    </button>
  `).join('')
}

function renderRunLink(run) {
  return `
    <div class="trace-row">
      <strong>${escapeHTML(run.run_id)}</strong>
      <span>${escapeHTML(run.status || 'unknown')} · ${formatTokens(run.total_tokens)} tokens · ${formatCurrency(run.estimated_cost_usd)}</span>
    </div>
  `
}

function renderTimelineEvent(event) {
  return `
    <div class="trace-row">
      <strong>${escapeHTML(event.event_type)}</strong>
      <span>${formatTimestamp(event.timestamp)} · ${escapeHTML(event.summary || event.retention_tier || 'trace')}</span>
    </div>
  `
}

function metric(metrics = {}, key) {
  return Number(metrics[key] || 0)
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
