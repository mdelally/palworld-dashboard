# Palworld Dashboard — MVP Working Spec

> Living document. Update this as decisions land. Build against this spec until MVP ships.

## Goal

A locally hosted live dashboard that runs alongside a Palworld dedicated server on Unraid (Docker). While playing, open it in a browser (LAN / Tailscale) to see server health, online players, metrics, and a live log stream — with light admin actions (announce, save).

**Out of scope for MVP:** public internet exposure, multi-server fleets, deep save-file parsing, Discord bots, auth providers beyond a simple shared secret / LAN trust.

---

## Stack (locked)

| Layer | Choice |
| --- | --- |
| Hosting | Unraid Docker container |
| Backend | **Fastify** (Node.js) |
| Frontend tooling | Vite 8 |
| UI framework | Vue 3 |
| Component library | Nuxt UI 4.10 |
| Realtime | **SSE** (`GET /api/events`) |
| Packaging | **Single container** — Node serves API + Vite static build |
| Config | Env vars (`PALWORLD_*`, `DASHBOARD_*`) |
| RCON | **Out** — REST API only |

---

## Implementation status

Repo: `/home/michael/palworld-dashboard`

| Build step | Status |
| --- | --- |
| 1. Repo scaffold (Node + Vite 8 Vue + Nuxt UI 4.10 + Dockerfile) | Done |
| 2. Palworld REST client + `/api/server` + `/api/players` | Done |
| 3. SSE fan-out + frontend live bindings | Done |
| 4. Log tailer + log panel | Done |
| 5. Announce + Save actions | Done |
| 6. Settings read-only panel | Done |
| 7. Docker polish + Unraid runbook | Done (`Dockerfile`, `docker-compose.yml`, `README.md`) |

### MVP acceptance criteria

- [x] Docker image / compose defined with env + volume mounts documented.
- [x] Dashboard shows live server online state, metrics, and player list from REST API (SSE).
- [x] Log panel tails mounted log path and streams to browser.
- [x] Announce and Save work from UI (with confirmation on Save).
- [x] Palworld API outage does not crash the dashboard process; UI shows clear offline state.
- [x] README / Unraid template notes for ports, mounts, and env vars.

**Remaining for you on Unraid:** wire real `PALWORLD_API_*` + mount paths, enable REST API on the game server, deploy compose.

---

## Deployment model (Unraid)

- Single Docker image with Node serving API + static SPA.
- Volume mounts for Palworld logs / config (read-only preferred for logs).
- Network access to Palworld REST API (`RESTAPIPort`, default `8212`).
- Dashboard port: `8787`.

```env
PALWORLD_API_URL=http://HOST:8212
PALWORLD_API_USER=admin
PALWORLD_API_PASSWORD=********
PALWORLD_LOG_PATH=/data/logs
PALWORLD_CONFIG_PATH=/data/PalWorldSettings.ini
DASHBOARD_PORT=8787
DASHBOARD_TOKEN=
POLL_INTERVAL_MS=2000
```

---

## Backend API

- `GET /api/health`
- `GET /api/server`
- `GET /api/players`
- `GET /api/settings`
- `GET /api/events` (SSE)
- `POST /api/announce` `{ message }`
- `POST /api/save`

Mutating routes optionally gated by `DASHBOARD_TOKEN`.

---

## SSE contract

```text
event: server
data: { info, metrics, ts }

event: players
data: { players: [...], ts }

event: log
data: { line, ts }

event: status
data: { palworldReachable: boolean, error?: string }

event: settings
data: { api, ini, ts }
```

---

## Local commands

```bash
npm install
npm run dev          # API :8787 + Vite :5173
npm run build && npm start
docker compose up -d --build
```

---

## Resolved decisions

| Question | Decision |
| --- | --- |
| Fastify vs Express | **Fastify** |
| Single container vs nginx | **Single Node container** |
| RCON | **REST only** |
| Max players / name | Prefer API; fall back to ini |

---

## Changelog

| Date | Note |
| --- | --- |
| 2026-07-19 | Initial scaffold. |
| 2026-07-19 | Locked Fastify, SSE, single-container; started implementation. |
| 2026-07-19 | MVP implemented: Fastify API, SSE, log tail, Vue/Nuxt UI dashboard, Docker/Unraid docs. |
