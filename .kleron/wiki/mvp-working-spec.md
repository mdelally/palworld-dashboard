---
title: Palworld Dashboard — MVP Working Spec
created: '2026-07-19T18:17:03.324Z'
updated: '2026-07-22T16:24:28.646Z'
---
# Palworld Dashboard — MVP Working Spec

> Living document. Update this as decisions land. Build against this spec until MVP ships.

## Goal

A locally hosted live dashboard that runs alongside a Palworld dedicated server on Unraid (Docker). While playing, open it in a browser (LAN / Tailscale) to see server health, online players, metrics, and a live log stream — with light admin actions (announce, save).

**Out of scope for MVP:** public internet exposure, multi-server fleets, Discord bots, auth providers beyond a simple shared secret / LAN trust. Deep save write-back / move-pal remains out of scope; **read-only logout snapshot parsing** is in (Phase 3).

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
| Packaging | **Single container** — Node serves API + Vite static build; Python parser venv for saves |
| Config | Env vars (`PALWORLD_*`, `DASHBOARD_*`) |
| RCON | **Out** — REST API only |
| Save parser | MRHRTZ `palworld-save-tools` + `pyooz` (PlM/Oodle). Stock cheahjs 0.24.0 cannot read 0.6+ saves. |

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
| 8. Phase 1 admin (kick/ban/unban/restart) | Done |
| 9. Phase 2 settings.ini editor | In progress |
| 10. Autostop idle timer + Start/Stop | Done |
| 11. Phase 3 bases at logout (save snapshot + parse) | Done (read-only) |

### MVP acceptance criteria

- [x] Docker image / compose defined with env + volume mounts documented.
- [x] Dashboard shows live server online state, metrics, and player list from REST API (SSE).
- [x] Log panel tails mounted log path and streams to browser.
- [x] Announce and Save work from UI (with confirmation on Save).
- [x] Palworld API outage does not crash the dashboard process; UI shows clear offline state.
- [x] README / Unraid template notes for ports, mounts, and env vars.

**Remaining for you on Unraid:** wire real `PALWORLD_API_*` + mount paths (including `PALWORLD_SAVE_PATH`), enable REST API on the game server, deploy compose.

---

## Deployment model (Unraid)

- Single Docker image with Node serving API + static SPA + Python parser venv.
- Volume mounts for Palworld logs / config / **saves (:ro)**.
- Network access to Palworld REST API (`RESTAPIPort`, default `8212`).
- Dashboard port: `8787`.

```env
PALWORLD_API_URL=http://HOST:8212
PALWORLD_API_USER=admin
PALWORLD_API_PASSWORD=********
PALWORLD_LOG_PATH=/data/logs
PALWORLD_CONFIG_PATH=/data/PalWorldSettings.ini
PALWORLD_SAVE_PATH=/data/saves
PALWORLD_PARSER_PYTHON=/opt/parser-venv/bin/python
DASHBOARD_PORT=8787
DASHBOARD_TOKEN=
POLL_INTERVAL_MS=2000
PALWORLD_CONTAINER=palworld
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
- `POST /api/start` / `POST /api/stop` / `POST /api/restart` (Docker)
- `GET|PUT /api/autostop` + `POST /api/autostop/cancel`
- `GET /api/bases` + `POST /api/bases/refresh` (logout snapshot report)

Mutating routes optionally gated by `DASHBOARD_TOKEN`.

---

## Autostop

When enabled: last player leaves → arm configurable delay (30/45/60/120 min) → on expiry `save()` + **snapshot copy** + Docker stop (leave down). Join cancels. Start button brings container back. Settings in `autostop.json` under data dir.

---

## Bases at logout (Phase 3)

On autostop / manual stop: copy `Level.sav` (+ Players) into `DASHBOARD_DATA_DIR/save-snapshots/`, parse the copy with `parser/extract_bases.py`, cache report, SSE `bases`. UI panel lists bases (owner, location) and expands pals (species, level, working/hungry). Never writes the live save.

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

event: autostop
data: { enabled, delayMinutes, armed, deadlineAt, remainingMs, stopping, containerRunning, ... }

event: bases
data: { status, bases: [...], stats, error?, ... }
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
| Phase 3 parsing | Prefer snapshot-on-autostop, not live parse |
| Parser library | MRHRTZ fork + pyooz (PlM/Oodle) |

---

## Changelog

| Date | Note |
| --- | --- |
| 2026-07-19 | Initial scaffold. |
| 2026-07-19 | Locked Fastify, SSE, single-container; started implementation. |
| 2026-07-19 | MVP implemented: Fastify API, SSE, log tail, Vue/Nuxt UI dashboard, Docker/Unraid docs. |
| 2026-07-22 | Autostop idle timer + Start/Stop container; Phase 3 reframed as logout snapshot. |
| 2026-07-22 | Phase 3 implemented: PlM parser sidecar, snapshot-on-stop, `/api/bases`, Bases panel. |
