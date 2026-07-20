---
taskId: 01KY03CFPYVC3XA8W0YQEQFYY7
title: Phase 3 — Read-only base & pal inspection (save parsing)
status: todo
priority: low
labels:
  - phase-3
  - save-parsing
  - experimental
  - backend
  - frontend
dependsOn:
  - 01KY03B3PTFGTN93RJBJHR8TZQ
effort: max
order: 3
created: '2026-07-20T15:47:46.526Z'
updated: '2026-07-20T15:47:46.526Z'
---
Surface base and pal data in the dashboard by parsing the Palworld save. **Read-only.** This is the hard, experimental phase — scope tightly and set expectations before building.

## Reality check (read first)
- Palworld exposes **no API or RCON** for base contents, per-pal status, or moving pals to the box. The only source of this data is the save file (`Level.sav`, GVAS/UE format), which must be parsed offline.
- **Live editing / "move pal to box" is out of scope** and likely infeasible safely: the running server holds the save and rewrites it on its save interval, so any external write would be clobbered or corrupt the world. Do NOT attempt write-back. If the user still wants it later, that's a separate spike with a "stop server → edit → start" workflow and heavy risk.
- Even read parsing is sensitive: parse a **copy**, never the live file mid-write. Trigger a `save()` (Phase 1) or read the newest sav, and tolerate parse failures gracefully.

## Scope (read-only viewer)
1. **Mount** the save dir read-only: `Pal/Saved/SaveGames/<worldid>` → `/data/saves:ro`. Add `PALWORLD_SAVE_PATH` to config.
2. **Parser** — use an existing implementation rather than writing GVAS parsing from scratch: `palworld-save-tools` (Python, most complete) run as a sidecar/subprocess, or a JS/TS GVAS port if one is current. Evaluate both in a short spike; document the choice. Parsing `Level.sav` is slow and memory-heavy — do it on demand (cached with mtime invalidation), never in the poll loop.
3. **Backend** — `GET /api/bases` returning, per base: location, owner (map to player from the players list where possible), and pals with species, level, and status (working/hungry/injured/idle). Keep the response shape small; don't ship the raw GVAS blob.
4. **Frontend** — a Bases panel: list bases, expand to see each base's pals and status. Read-only. Nuxt UI table/accordion.

## Gotchas
- Save format changes between Palworld versions — pin the parser version and fail loudly with a clear "unsupported save version" message rather than showing garbage.
- Base ownership/pal ownership uses internal GUIDs; mapping to human names requires cross-referencing character save data — budget time for it, and degrade gracefully to GUIDs when a name can't be resolved.
- Large worlds = large saves; guard parse time/memory and cache aggressively.

## Acceptance criteria
- [ ] Bases panel lists all bases with owner + location.
- [ ] Expanding a base shows its pals with species, level, and status.
- [ ] Parsing a live-server world doesn't crash the dashboard and never writes to the save.
- [ ] Unsupported save versions produce a clear message, not corrupt output.

See [[mvp-working-spec]]. Sequenced after [[Phase 1 — REST admin actions: ban / kick / unban + restart]] and [[Phase 2 — Settings .ini editor + backups (CodeMirror)]]. Note: the teleport-to-base / teleport-by-name idea from the original brief is intentionally omitted — Palworld has no command to teleport an arbitrary player to coordinates (RCON teleport only moves the calling admin), so it isn't buildable as envisioned.
