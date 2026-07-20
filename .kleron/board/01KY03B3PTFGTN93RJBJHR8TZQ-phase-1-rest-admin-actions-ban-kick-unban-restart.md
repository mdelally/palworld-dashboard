---
taskId: 01KY03B3PTFGTN93RJBJHR8TZQ
title: 'Phase 1 — REST admin actions: ban / kick / unban + restart'
status: in-review
priority: high
labels:
  - phase-1
  - admin
  - rest-api
  - backend
  - frontend
effort: high
order: 0
created: '2026-07-20T15:47:01.466Z'
updated: '2026-07-20T17:03:16.059Z'
---
Add mutating admin controls to the dashboard. Almost all of this is a thin routing layer over the Palworld REST API the app already authenticates against (`server/palworld.js`) — no RCON, no filesystem. Restart is the one exception (uses the Docker socket, already mounted).

## Context for a fresh agent
- **Server**: Fastify. REST wrapper `server/palworld.js` (`request(path, opts)` does Basic Auth). Routes `server/routes.js` — mutating routes use `requireToken(request, reply)` and return `{ ok: true }`; copy the existing `/api/announce` and `/api/save` handlers as the template. Live state + SSE fan-out in `server/state.js` (`broadcast(event, data)`).
- **Client**: Vue 3 + Nuxt UI. Composable `client/src/composables/useDashboard.ts` — copy the `announce()` / `saveWorld()` fetch pattern for each new action. UI patterns in `client/src/components/ActionsPanel.vue` (UCard/UButton/UModal confirm) and `PlayersPanel.vue` (per-player row actions). Types in `client/src/types.ts`.
- Player identity for kick/ban comes from the players list — use the `userId` field (`steam_7656…`), NOT the display name.

## Scope
1. **palworld.js** — add methods:
   - `kick(userid, message)` → `POST /v1/api/kick` body `{ userid, message }`
   - `ban(userid, message)` → `POST /v1/api/ban` body `{ userid, message }`
   - `unban(userid)` → `POST /v1/api/unban` body `{ userid }`
   - `shutdown(waittime, message)` → `POST /v1/api/shutdown` body `{ waittime, message }`
   - `stop()` → `POST /v1/api/stop`
2. **routes.js** — `POST /api/kick`, `/api/ban`, `/api/unban` (token-guarded, validate `userid`), each broadcasting a `status` notice on success. Return upstream error status/message like the announce handler does.
3. **Banlist** — Palworld has no "list bans" endpoint. Keep a local JSON list (persist to a small file under a writable `/data` volume, or in-memory + rehydrate). Record `{ userid, name, reason, ts }` on ban; remove on unban. Expose `GET /api/bans` and surface in the UI so unban has something to target.
4. **Restart** — new `server/dockerControl.js` using the mounted Docker socket (see `server/dockerLogs.js` for the `http.request({ socketPath })` pattern). `restartContainer()` → `POST /containers/{PALWORLD_CONTAINER}/restart?t=10`. Route `POST /api/restart` (token-guarded, behind a typed confirm modal). **Recommended UX**: announce + `save()` + then restart, so players get warning and the world is flushed first.
5. **UI** — per-player Kick/Ban buttons in PlayersPanel (confirm modal), a Bans panel with Unban, and a Restart button (danger-styled, typed confirmation) in ActionsPanel.

## Gotchas
- **Pre-existing bug to fix here**: the client `announce()`/`saveWorld()` calls do NOT send the `x-dashboard-token` header, so any mutating action 401s whenever `DASHBOARD_TOKEN` is set. Add the header to a shared fetch helper in the composable and use it for all mutating calls (existing + new).
- REST can stop the server but cannot start it — restart relies on the game container's `restart: unless-stopped` (via REST shutdown) OR the Docker `restart` call. Prefer the Docker `restart` call for determinism.
- `/v1/api/shutdown` waittime is seconds; validate it's a positive int.
- Kick/ban error if the userid isn't currently connected (ban) — surface the API's message rather than swallowing it.

## Acceptance criteria
- [ ] Kick a connected player from the UI; they disconnect.
- [ ] Ban a player; they're added to the local banlist and can't rejoin.
- [ ] Unban from the banlist; entry removed.
- [ ] Restart button (typed confirm) announces + saves + restarts the container; dashboard reconnects to logs after it comes back.
- [ ] All mutating calls send the dashboard token and work with `DASHBOARD_TOKEN` set.

See [[mvp-working-spec]]. Follow-ups: [[Phase 2 — Settings .ini editor + backups (CodeMirror)]], [[Phase 3 — Read-only base & pal inspection (save parsing)]].
