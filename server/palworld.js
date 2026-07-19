import { config } from './config.js'

function authHeader() {
  const token = Buffer.from(
    `${config.palworld.user}:${config.palworld.password}`,
    'utf8',
  ).toString('base64')
  return `Basic ${token}`
}

async function request(path, options = {}) {
  const url = `${config.palworld.apiUrl}${path}`
  const res = await fetch(url, {
    ...options,
    headers: {
      Accept: 'application/json',
      Authorization: authHeader(),
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...options.headers,
    },
  })

  const text = await res.text()
  let data = null
  if (text) {
    try {
      data = JSON.parse(text)
    } catch {
      data = { raw: text }
    }
  }

  if (!res.ok) {
    const err = new Error(data?.message || data?.error || `Palworld API ${res.status}`)
    err.status = res.status
    err.data = data
    throw err
  }

  return data
}

export const palworld = {
  info: () => request('/v1/api/info'),
  metrics: () => request('/v1/api/metrics'),
  players: () => request('/v1/api/players'),
  settings: () => request('/v1/api/settings'),
  announce: (message) =>
    request('/v1/api/announce', {
      method: 'POST',
      body: JSON.stringify({ message }),
    }),
  save: () =>
    request('/v1/api/save', {
      method: 'POST',
    }),
}
