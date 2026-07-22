---
taskId: 01KY03CFPYVC3XA8W0YQEQFYY7
title: Phase 3 — Read-only base & pal inspection (save parsing)
status: in-progress
priority: low
labels:
  - phase-3
  - save-parsing
  - experimental
  - backend
  - frontend
dependsOn:
  - 01KY52VHTYBZSVTWAA260HNYCC
effort: max
order: 2
created: '2026-07-20T15:47:46.526Z'
updated: '2026-07-22T19:26:30.926Z'
---
Surface base and pal data in the dashboard by parsing the Palworld save. **Read-only.** Prefer the **logout-snapshot** trigger over live on-demand parsing.

## Preferred trigger (revised)
At empty-world autostop (or any logout that leaves the world empty and leads to a stop):
1. `save()`
2. **Copy** `Level.sav` (+ related files) to a safe snapshot dir
3. Stop container
4. Parse the **copy** asynchronously → "state at logout" report

This avoids racing the live save and matches the mental model (inspect without booting the server).

## Reality check (read first)
- Palworld exposes **no API or RCON** for base contents, per-pal status, or moving pals to the box. The only source of this data is the save file (`Level.sav`, GVAS/UE format), which must be parsed offline.
- **Live editing / "move pal to box" is out of scope** and likely infeasible safely: the running server holds the save and rewrites it on its save interval, so any external write would be clobbered or corrupt the world. Do NOT attempt write-back.
- Even read parsing is sensitive: parse a **copy**, never the live file mid-write.

## Scope (read-only viewer)
1. **Mount** the save dir read-only: `Pal/Saved/SaveGames/<worldid>` → `/data/saves:ro`. Add `PALWORLD_SAVE_PATH` to config. Writable snapshot dir under dashboard data volume.
2. **Parser** — use an existing implementation rather than writing GVAS parsing from scratch: `palworld-save-tools` (Python, most complete) run as a sidecar/subprocess, or a JS/TS GVAS port if one is current. Evaluate both in a short spike; document the choice. Parsing `Level.sav` is slow and memory-heavy — do it on snapshot events (cached), never in the poll loop.
3. **Backend** — `GET /api/bases` / logout reports returning, per base: location, owner, and pals with species, level, and status (working/hungry/injured/idle). Keep the response shape small; don't ship the raw GVAS blob.
4. **Frontend** — Bases / logout-report panel: list bases, expand to see pals and status. Read-only.

## Implementation notes (2026-07-22)
- Spike confirmed fixtures are **PlM/Oodle (0.6+)**. Stock `cheahjs/palworld-save-tools@0.24.0` cannot read them.
- Pinned **MRHRTZ fork + pyooz** in `parser/requirements.txt`; extract script `parser/extract_bases.py`.
- Node: `server/saveReport.js` copies into `DASHBOARD_DATA_DIR/save-snapshots/`, parses async, caches `bases-report.json`, SSE `bases` event.
- Hooks: autostop `fireStop` + `POST /api/stop`. Manual `POST /api/bases/refresh`.
- UI: `BasesPanel` (“Bases at logout”).
- Guild RawData custom decoder still EOF-fails on this save; base owners resolved via players sharing `group_id`.
- Injured status not inferred yet (no reliable max-HP); hungry/working/idle are.
- **Per-base resources (2026-07-22):** each base now includes `resources: [{ id, count }, …]` aggregated from map objects with `base_camp_id_belong_to` + `ItemContainerSaveData`. Full MapObject custom-decode still skipped (GuildSecurity); Model + ItemContainer modules decoded selectively. Verified on fixture (e.g. Stone ×6053, CopperOre ×1212, PalFluid ×106).

## Gotchas
- Save format changes between Palworld versions — pin the parser version and fail loudly with a clear "unsupported save version" message rather than showing garbage.
- Base ownership/pal ownership uses internal GUIDs; mapping to human names requires cross-referencing character save data — budget time for it, and degrade gracefully to GUIDs when a name can't be resolved.
- Large worlds = large saves; guard parse time/memory and cache aggressively.

## Acceptance criteria
- [x] Snapshot taken on autostop / empty-world stop (copy, never mutate live)
- [x] Bases panel or logout report lists bases with owner + location
- [x] Expanding a base shows its pals with species, level, and status
- [x] Parsing never writes to the live save; unsupported versions produce a clear message
- [x] Expanding a base shows aggregated resource totals (Ore, Pal Fluid, etc.)

Depends on [[Autostop idle timer + Start/Stop container]]. See [[mvp-working-spec]].
