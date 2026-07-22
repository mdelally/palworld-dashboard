# Palworld Dashboard

Live ops dashboard for a Palworld dedicated server on Unraid. Node (Fastify) polls the Palworld REST API, tails logs, and serves a Vue 3 + Nuxt UI 4.10 frontend over SSE.

## Features (MVP)

- Server status: online/offline, name, version, FPS, uptime, player/base counts
- Live player list (name, level, ping, location)
- Live log tail from mounted server logs
- Announce + force save (admin password stays on the server)
- Admin actions: kick / ban / unban players, and restart the game container
- Read-only settings from REST API + `PalWorldSettings.ini`

## Quick start (dev)

```bash
cp .env.example .env
# edit PALWORLD_API_* as needed
npm install
npm run dev
```

- API: http://127.0.0.1:8787
- UI (Vite): http://127.0.0.1:5173 (proxies `/api` to the backend)

## Production / Docker (Unraid)

```bash
docker compose build
docker compose up -d
```

Open http://\<unraid-ip\>:8787 (or via Tailscale).

### Environment

| Variable | Default | Notes |
| --- | --- | --- |
| `PALWORLD_API_URL` | `http://172.17.0.1:8212` | Host gateway to Palworld REST API |
| `PALWORLD_API_USER` | `admin` | Basic auth user |
| `PALWORLD_API_PASSWORD` | — | Same as `AdminPassword` in Palworld settings |
| `PALWORLD_LOG_PATH` | `/data/logs` | File or directory (newest `.log` used) |
| `PALWORLD_CONFIG_PATH` | `/data/PalWorldSettings.ini` | Optional ini summary |
| `DASHBOARD_PORT` | `8787` | HTTP listen port |
| `DASHBOARD_TOKEN` | empty | If set, required for all mutating actions |
| `POLL_INTERVAL_MS` | `2000` | REST poll interval |
| `PALWORLD_CONTAINER` | `palworld` | Game container name — used for log streaming, restart/start/stop, and autostop |
| `DASHBOARD_DATA_DIR` | `/data` | Writable dir for dashboard state (banlist, autostop settings). Mounted as a persistent volume in Docker |
| `RESTART_GRACE_SECONDS` | `10` | Warning window (announce + save) before a restart takes the container down |
| `LOG_SOURCE` | `auto` | `auto`/`docker`/`file` — `auto` streams the game container's stdout when `PALWORLD_CONTAINER` is set, else tails `PALWORLD_LOG_PATH` |
| `LOG_EXCLUDE` | `/v1/api/` | Regex; matching log lines are hidden from the panel. Default hides the dashboard's own REST poll traffic. Set empty to see all |
| `LOG_BUFFER_LINES` | `500` | Max log lines retained and streamed to the panel |

### Unraid notes

1. Enable Palworld REST API in `PalWorldSettings.ini`:
   `RESTAPIEnabled=True`, `RESTAPIPort=8212`, set `AdminPassword`.
2. Keep `8212` on LAN / Docker network only — do not publish it to the internet.
3. Mount your Palworld log folder and settings file read-only into `/data/...` (see `docker-compose.yml`). Paths vary by community container; adjust as needed.
4. Point `PALWORLD_API_URL` at the game container/host IP that serves port `8212`.

### Optional dashboard token

If `DASHBOARD_TOKEN` is set, mutating calls must send:

```http
Authorization: Bearer <token>
```

or

```http
X-Dashboard-Token: <token>
```

In the UI, click the lock icon in the header to paste the token — it's stored
in the browser and sent automatically with admin actions.

### Banlist persistence

Palworld has no "list bans" endpoint, so the dashboard keeps its own record
(`bans.json`) under `DASHBOARD_DATA_DIR` purely so the UI has something to
target for unban — the in-game ban is authoritative. The compose files mount a
named `palworld-dashboard-data` volume at `/data` so this survives restarts and
image updates. Without a writable volume the banlist falls back to in-memory
(bans still work; the list resets on restart).

### Restart / start / stop

Admin actions control the game container via the mounted Docker socket
(`PALWORLD_CONTAINER`):

- **Restart** — typed confirmation; announces, saves, waits
  `RESTART_GRACE_SECONDS`, then `POST /containers/<name>/restart`.
- **Start** — `POST /containers/<name>/start` (brings a stopped container back
  without going through Unraid).
- **Stop** — best-effort save, then `POST /containers/<name>/stop` and leave it
  down until Start (or Unraid) brings it back.

These work even when the REST API is unreachable. Note: a read-only (`:ro`)
docker.sock mount does **not** block this — `:ro` only protects the socket
inode, not API calls sent over it.

### Autostop

When enabled, the dashboard watches the player list. After the last player
leaves (a real N→0 transition, not dashboard boot into an empty world), it arms
a configurable idle timer (30 / 45 / 60 / 120 minutes). If anyone joins before
the timer fires, the countdown is cancelled. On expiry it saves the world and
Docker-stops the container, leaving it down until you hit Start.

Settings persist in `autostop.json` under `DASHBOARD_DATA_DIR`. The UI shows a
live countdown over SSE and can cancel an armed timer.

## API

| Method | Path | Description |
| --- | --- | --- |
| GET | `/api/health` | Process + reachability |
| GET | `/api/server` | Cached info + metrics |
| GET | `/api/players` | Cached players |
| GET | `/api/settings` | API + ini snapshot |
| GET | `/api/events` | SSE stream |
| POST | `/api/announce` | `{ "message": "..." }` |
| POST | `/api/save` | Force world save |
| GET | `/api/bans` | Local banlist |
| POST | `/api/kick` | `{ "userid": "..." }` |
| POST | `/api/ban` | `{ "userid": "...", "name": "...", "message": "..." }` |
| POST | `/api/unban` | `{ "userid": "..." }` |
| POST | `/api/restart` | Announce + save + restart container |
| POST | `/api/start` | Start game container |
| POST | `/api/stop` | Save (best-effort) + stop game container |
| GET | `/api/autostop` | Autostop settings + countdown state |
| PUT | `/api/autostop` | `{ "enabled": true, "delayMinutes": 60 }` |
| POST | `/api/autostop/cancel` | Cancel an armed countdown |

## Spec

Working product spec lives in the Kleron wiki: `mvp-working-spec`.
