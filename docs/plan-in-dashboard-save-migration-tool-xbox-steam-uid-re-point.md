# Plan: In-Dashboard Save Migration Tool (Xbox → Steam UID re-point)

## Context

A friend's Palworld character exists under his **Xbox** UID (`gdk_2533274809762117` →
Player id `F240834E000000000000000000000000`) and he has since joined the same server on
**Steam** (`steam_76561197988976595` → `B8EA2006000000000000000000000000`), creating a fresh,
empty character. The goal: make the Steam identity inherit all the Xbox character's progress
(level, pals, bases, guild, inventory), overwriting the throwaway Steam character.

The user does not want to shuttle multi-hundred-MB save folders on and off the Unraid host.
**The dashboard already reads these files in place** — `PALWORLD_SAVE_PATH` is mounted into the
container and `saveReport.js` already snapshots + parses `Level.sav` with the pinned MRHRTZ
`palworld-save-tools` fork (the only lib that handles this server's 0.6+ PlM/Oodle format).
So the migration should ride on that existing access path and run as a gated, one-button
action in the dashboard, with the game container stopped, an automatic backup, and one-click
rollback. **No file-moving.**

The one genuinely-unproven piece is the **write path**: the fork *does* ship a real Oodle
compressor (`oozlib.compress`) and a round-trip self-test (`commands/resave_test.py`), but
whether a *full re-serialize* of this specific save survives the 0.6+ `GuildSecurity` module
(the one `extract_bases.py` deliberately avoids decoding) is unverified. The plan therefore
**proves the write path on a snapshot copy before building anything that writes the live save.**

## The one infrastructure change

`docker-compose.yml:54` mounts the world save **read-only**:

```yaml
- /mnt/user/.../SaveGames/0/75D4220D2E304791995D2E787E4B4856:/data/saves:ro   # → change to :rw
```

Flip `:ro` → `:rw`. This is the only infra change, and it mirrors the existing precedent one
line up (`PalWorldSettings.ini` is already mounted `:rw` for the in-dashboard config editor,
with the same "root + docker.sock already = host-root-equivalent" reasoning). The same change
must be applied in `docker-compose.portainer.yml`. Writes to the live folder happen **only** in
the final promote/rollback step, server stopped, after validation.

## Build order (each stage gates the next)

### Stage 0 — Prove the write path (de-risk before building)
Add `parser/roundtrip_test.py` (thin wrapper over the fork's `commands/resave_test.py` logic):
load a `Level.sav`, decode with the custom-property set we intend to use, re-serialize via
`compress_gvas_to_sav(..., zlib=False)`, and assert the re-decompressed GVAS is byte-identical.
Wire it to a temporary `POST /api/migration/selftest` route that runs it against a **fresh
snapshot copy** (`takeSaveSnapshot()` → `save-snapshots/<ts>/Level.sav`) — never the live file.

- **If it passes** → the clean full-decode migration path (Stage 2A) is viable.
- **If it fails on `GuildSecurity`/EOF** → fall back to the surgical byte-rewrite path (Stage 2B),
  and/or the `zlib=True` (PlZ) write which the game also loads. The self-test decides; we do not
  guess. This route can be removed once the approach is locked.

### Stage 1 — Backend migration module (read-only + orchestration skeleton)
Create `server/saveMigration.js`, modelled directly on `server/saveReport.js`
(state machine + `spawn()` runner + `broadcast()`). Reuse, do not reinvent:
- `resolveLevelSav()` and `takeSaveSnapshot()` from `saveReport.js` (backup + working copies).
- `getContainerState()` from `server/dockerControl.js` — **canonical stopped check:**
  `const info = await getContainerState(); if (info?.running !== false) throw ...` before any write.
- The `runExtract()` spawn pattern for invoking Python (`resolvePythonBin()` → `.venv-save-tools`
  in dev, `/opt/parser-venv` in prod via `PALWORLD_PARSER_PYTHON`).

Routes (register in `server/routes.js`, mirror the `/api/bases/*` block, token-guard mutations
via `requireToken`):
- `GET  /api/migration/status` — current state (idle/preview/applying/done/error) + last backup id.
- `POST /api/migration/preview` — body `{ sourceUid, targetUid }`. Runs entirely on a working
  **copy**: validates both UIDs exist on disk + in `Level.sav`, computes the rewrite diff
  (dry-run), runs the Stage-0 round-trip check, returns `{ diffs, validation, counts }`. Never
  touches the live save; safe while the server is running.
- `POST /api/migration/apply` — body `{ sourceUid, targetUid, confirm: true }`. Gates:
  token → `getContainerState().running === false` → source ≠ target → both exist. Then:
  **backup snapshot** (pristine, kept for rollback) → second working copy → run migrate →
  **re-parse migrated `Level.sav` with `extract_bases.py` to confirm it loads and the target UID
  now owns the pals/bases** → only then **promote** (copy migrated `Level.sav` + renamed
  `Players/<target>.sav` into `/data/saves`). If validation fails, abort and leave the live save
  untouched. Returns `{ backupId }`.
- `POST /api/migration/rollback` — body `{ backupId }`. Token + stopped check, then restore the
  backup snapshot over `/data/saves`.

### Stage 2 — The rewrite script `parser/migrate_uid.py`
Modelled on `extract_bases.py` (same MRHRTZ loader, same `_StdoutToStderr` guard, same
selective-custom-property discipline). CLI: `migrate_uid.py <level.sav> --source <uid> --target
<uid> [--players-dir <dir>] [--dry-run] [--out <dir>]`. Emits one JSON object (like the parser)
describing the diff/result. It adapts the **canonical cheahjs `fix_host_save.py` UID-remap
algorithm** (the identical "move a player from old UID to new UID" operation) to the 0.6+ loader:

Rewrite set (source `F240834E…` → target `B8EA2006…`):
1. **`Players/<source>.sav` → `Players/<target>.sav`** — copy the file, patch the internal
   `IndividualId.PlayerUId` to target while **preserving its `InstanceId`** (that instance id is
   what links the file to the character entry in `Level.sav`; the delicate part).
2. **`CharacterSaveParameterMap`** — the player-character entry keyed by `PlayerUId == source`:
   re-key to target (overwriting/removing the fresh target character entry).
3. **Owned pals** — every entry with `OwnerPlayerUId == source` (and `OldOwnerPlayerUIds`):
   re-point to target.
4. **`GroupSaveDataMap`** (guild) — `players[].player_uid`, `admin_player_uid`, and
   `individual_character_handle_ids` referencing source's UID/handle: re-point to target.

Decode with a custom-property set tuned to decode exactly the maps above while leaving the
`MapObject`/`GuildSecurity` module **undecoded (raw bytes)** so it round-trips verbatim — the
Stage-0 self-test confirms this is safe. Write via `compress_gvas_to_sav(gvas.write(...),
save_type, zlib=False)`; keep `zlib=True` as the documented fallback. **2B fallback:** if full
decode of `GroupSaveDataMap` proves unsafe, rewrite the 16-byte GUID references at the GVAS byte
level instead — same validation gate applies.

Reuse the existing `scripts/save-migration/discovery.py` logic as the validation/inspection step
(it already reports players, owned-pal counts, and guild membership per UID); the manual
`docs/uid-migration-runbook.md` is superseded by this in-dashboard flow and will be updated to
point at the tool (kept as reference for the rollback contract).

### Stage 3 — Client panel
- `client/src/types.ts` — add `MigrationDiff { field, sourceValue, targetValue, changeType }`
  and `MigrationState { status, diffs?, backupId?, error? }`.
- `client/src/composables/useDashboard.ts` — add `previewMigration()`, `applyMigration()`,
  `rollbackMigration()` using the existing `getJson()` / `mutate()` / `runAction()` helpers
  (token header + busy/error state handled automatically), and a `migration` SSE listener in
  `connect()` alongside the existing `bases` handler.
- `client/src/components/MigrationPanel.vue` — modelled on `BasesPanel.vue`. Two
  `USelectMenu` dropdowns populated from `bases.players` (the parsed `{ playerUid, name, level,
  groupId }` list — the source of truth, not the live REST roster). "Preview" → diff table
  (reuse the `BaseResourcesTable.vue` `UTable` pattern, read-only). A prominent
  "Server must be stopped" guard state driven by `autostop.containerRunning`. "Apply migration"
  (color `error`, requires typed confirm) and, post-apply, "Rollback" (uses returned `backupId`).
- `client/src/pages/DashboardPage.vue` — register a `{ label:'Migration', icon:
  'i-lucide-arrow-right-left', value:'migration', slot:'migration' }` tab and a
  `<template #migration>` wiring props/events to the composable methods.

## Safety model (invariants)
- **Preview is read-only** w.r.t. the live save (works with the server up); only Apply/Rollback write.
- **Apply/Rollback require the container stopped** (`getContainerState().running === false`), a
  valid token, and explicit confirmation; source ≠ target and both UIDs must exist.
- **Backup before write** (`takeSaveSnapshot()`), **validate-before-promote** (re-parse the
  migrated save; abort leaving the live save untouched on failure), **one-click rollback** from
  the pristine backup.
- Live-save writes are confined to the final promote/rollback copy, into the now-`:rw` mount.

## Files
- **New:** `parser/roundtrip_test.py`, `parser/migrate_uid.py`, `server/saveMigration.js`,
  `client/src/components/MigrationPanel.vue`.
- **Modified:** `server/routes.js` (migration routes), `client/src/composables/useDashboard.ts`,
  `client/src/pages/DashboardPage.vue`, `client/src/types.ts`, `docker-compose.yml` +
  `docker-compose.portainer.yml` (`:ro`→`:rw`), `docs/uid-migration-runbook.md` (point at tool).
- **Reused as-is:** `parser/extract_bases.py` (loader + validation), `saveReport.js`
  (`resolveLevelSav`/`takeSaveSnapshot`), `dockerControl.js` (`getContainerState`/stop/start),
  `scripts/save-migration/discovery.py`.

## Verification (end-to-end, on the real save via the dashboard — nothing moved by hand)
1. **Write-path proof:** call `/api/migration/selftest` against a fresh snapshot → expect
   "byte-identical" pass. This is the go/no-go gate for the whole feature.
2. **Preview:** with the server running, Preview `F240834E…` → `B8EA2006…`; confirm the diff
   shows the Xbox character + its pals/bases/guild re-pointing to the Steam UID, and both UIDs
   are detected on disk.
3. **Apply (dry-run first):** run `migrate_uid.py --dry-run` via preview; inspect counts against
   `discovery.py` expectations (owned-pal count, guild membership).
4. **Apply for real:** stop the server from the dashboard → Apply → confirm the module re-parses
   the promoted save and the Steam UID now owns everything; start the server; friend logs in on
   Steam and sees his progress.
5. **Rollback rehearsal:** before trusting Apply, verify Rollback restores the pre-migration
   backup byte-for-byte (compare `discovery.py` output before/after).
6. **Lint/build:** `npm run lint && npm run build` (client) per commit; server is ESM Node, no build.

## Open decision folded into this plan
Making the save mount `:rw` is a deliberate, security-relevant change (the dashboard becomes able
to write the live world). It is required for the "no file-moving" goal and is consistent with the
existing `:rw` config-file mount. Approving this plan approves that mount change.
