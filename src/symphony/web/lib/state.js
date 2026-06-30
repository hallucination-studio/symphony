export const state = {
  route: 'issues',
  selectedIssueId: null,
  selectedRunId: null,
  filters: {},
}

export function setRoute(route) {
  state.route = route
}

export function setFilter(key, value) {
  state.filters[key] = value
}
