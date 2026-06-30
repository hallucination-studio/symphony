export async function getJSON(path, options = {}) {
  const response = await fetch(path, {
    headers: { Accept: 'application/json', ...(options.headers || {}) },
    ...options,
  })
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} for ${path}`)
  }
  return response.json()
}

export async function postJSON(path, payload = {}) {
  return getJSON(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
}

export async function deleteJSON(path) {
  return getJSON(path, { method: 'DELETE' })
}
