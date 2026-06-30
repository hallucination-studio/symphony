import { getJSON } from './lib/api.js'
import { formatCurrency, formatTokens } from './lib/format.js'
import { state, setRoute } from './lib/state.js'
import { renderIssuesView } from './views/issues.js'
import { renderRunsView } from './views/runs.js'
import { renderTraceView } from './views/trace.js'
import { renderInstancesView, renderLinearView, renderRetentionView, renderSettingsView, renderWorkflowView } from './views/ops.js'

const root = document.querySelector('#view-root')
const navItems = Array.from(document.querySelectorAll('.nav-item'))
const refreshEndpoints = ['/api/issues', '/api/runs', '/api/retention']

navItems.forEach((item) => {
  item.addEventListener('click', () => {
    setRoute(item.dataset.route || 'issues')
    render()
  })
})

async function render() {
  navItems.forEach((item) => {
    item.classList.toggle('active', item.dataset.route === state.route)
  })

  if (state.route === 'issues') {
    await renderIssuesView(root, { onSummary: updateIssueSummary })
    return
  }
  if (state.route === 'runs') {
    await renderRunsView(root, { onSummary: updateRunSummary })
    return
  }
  if (state.route === 'trace') {
    await renderTraceView(root)
    return
  }
  if (state.route === 'retention') {
    await renderRetentionView(root, { onSummary: updateRetentionSummary })
    return
  }
  if (state.route === 'instances') {
    await renderInstancesView(root)
    return
  }
  if (state.route === 'linear') {
    renderLinearView(root)
    return
  }
  if (state.route === 'workflow') {
    renderWorkflowView(root)
    return
  }
  if (state.route === 'settings') {
    renderSettingsView(root)
    return
  }
  root.innerHTML = `<div class="empty-state"><h2>${titleForRoute(state.route)}</h2><p>Loading ${state.route} operations surface.</p></div>`
}

async function updateIssueSummary(issues) {
  const dashboard = await getJSON('/api/dashboard')
  document.querySelector('#active-issues').textContent = String(issues.length)
  document.querySelector('#total-tokens').textContent = formatTokens(sum(issues, 'total_tokens'))
  document.querySelector('#estimated-cost').textContent = formatCurrency(sum(issues, 'total_estimated_cost_usd'))
  document.querySelector('#retention-state').textContent = dashboard.dashboard ? 'Ready' : 'Unknown'
}

function updateRunSummary(runs) {
  document.querySelector('#run-count').textContent = String(runs.length)
}

function updateRetentionSummary(retention) {
  document.querySelector('#retention-state').textContent = String(retention.pinned_issue_count || 0)
}

function sum(records, key) {
  return records.reduce((total, record) => total + Number(record[key] || 0), 0)
}

function titleForRoute(route) {
  return route.charAt(0).toUpperCase() + route.slice(1)
}

render().catch((error) => {
  root.innerHTML = `<div class="empty-state"><h2>Issues</h2><p>${error.message}</p></div>`
})
