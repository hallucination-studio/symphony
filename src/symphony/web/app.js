import { getJSON } from './lib/api.js'
import { formatCurrency, formatTokens } from './lib/format.js'
import { state, setRoute } from './lib/state.js'

const root = document.querySelector('#view-root')
const navItems = Array.from(document.querySelectorAll('.nav-item'))

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
    await renderIssues()
    return
  }
  if (state.route === 'runs') {
    await renderRuns()
    return
  }
  root.innerHTML = `<div class="empty-state"><h2>${titleForRoute(state.route)}</h2><p>Loading ${state.route} operations surface.</p></div>`
}

async function renderIssues() {
  const dashboard = await getJSON('/api/dashboard')
  const { issues } = await getJSON('/api/issues')
  document.querySelector('#active-issues').textContent = String(issues.length)
  document.querySelector('#retention-state').textContent = dashboard.dashboard ? 'Ready' : 'Unknown'
  root.innerHTML = `
    <div class="empty-state">
      <h2>Issues</h2>
      <p>${issues.length} issue records. Total tokens ${formatTokens(sum(issues, 'total_tokens'))}. Estimated cost ${formatCurrency(sum(issues, 'total_estimated_cost_usd'))}.</p>
    </div>
  `
}

async function renderRuns() {
  const { runs } = await getJSON('/api/runs')
  document.querySelector('#run-count').textContent = String(runs.length)
  root.innerHTML = `
    <div class="empty-state">
      <h2>Runs</h2>
      <p>${runs.length} run records available for issue-first drill-down.</p>
    </div>
  `
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
