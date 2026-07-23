# Palworld same-server UID migration (e.g. Xbox → Steam)

Re-points a player's entire character (level, Pals, guild, base ownership,
inventory) from a **source PlayerUId** to a **target PlayerUId** on the **same
dedicated server save**. Use when a player who already joined under one platform
identity (e.g. Xbox `gdk_`) wants to keep playing under a different one (e.g.
Steam) and has **already logged in at least once** under the new identity.

> This is NOT for importing an Xbox Game Pass *local* (`.wgs` container) save.
> That requires unpacking the encrypted container first and is out of scope here.

**This is now a built-in dashboard tool** — the **Migration** tab. You do not run
any scripts or move any files by hand; the dashboard reads and writes the save in
place (server stopped), takes a backup, validates, and can roll back. The manual
procedure below is retained only as the conceptual reference and the advanced /
break-glass path.

## How it works (Migration tab)

1. **Write-path self-test** — copies the live `Level.sav` and proves it
   round-trips byte-identical (load → re-serialize → recompress). This is the
   go/no-go gate; if it isn't "byte-identical", stop. Safe to run anytime (works
   on a copy, server up or down).
2. **Choose players & preview** — pick **Source** (the character with progress)
   and **Target** (the identity that inherits it) from the parsed player list,
   then Preview. The dry-run runs on a throwaway copy and shows exactly what
   would change (character re-key, N pals re-pointed, guild memberships, the
   player-file rename). Nothing is written.
3. **Apply** — requires the self-test passed, the **game server stopped**, a
   completed preview, and a typed `MIGRATE` confirmation. The dashboard then:
   backup → migrate a working copy → **re-parse it to confirm it loads and the
   target owns everything** → promote over the live save. On any failure the live
   save is left untouched.
4. **Roll back** — one click restores the pristine pre-migration backup.

Requires the admin token (Migration actions are token-guarded) and, in Docker,
the world-save mounted `:rw` (see `docker-compose.yml`).

## What gets rewritten

| Data | Location in save | Change |
|---|---|---|
| Player character | `Level.sav` → `CharacterSaveParameterMap` key `PlayerUId` | source → target (re-key) |
| Owned Pals | `Level.sav` → same map, `OwnerPlayerUId` / `OldOwnerPlayerUIds` | source → target |
| Fresh target character | `Level.sav` → `CharacterSaveParameterMap` entry keyed by the target UID | removed (overwritten by the source) before the re-key |
| Guild + base ownership | `Level.sav` → `GroupSaveDataMap` raw bytes (`players[].player_uid`, handle `guid`s, `last_guild_name_modifier_player_uid`) | source → target, at the byte level |
| Inventory / tech / recipes | `Players/<source>.sav` | patch internal `PlayerUId` (keep `InstanceId`) → write as `Players/<target>.sav`; live source file removed |

The migration decodes **only `CharacterSaveParameterMap`** and re-points every
reference to the source PlayerUId within it — the character re-key plus pal
`OwnerPlayerUId` / `OldOwnerPlayerUIds` all fall out of one pass (a PlayerUId is a
unique GUID distinct from any InstanceId, so InstanceIds are preserved). Before the
re-key it drops the target UID's throwaway fresh-join character so the map never
holds two characters for the target.

`GroupSaveDataMap` is **not decoded** — this 0.6+ save's guild `player_info`
layout desyncs the fork's `group.py` decoder and reads past EOF (the same reason
`extract_bases.py` never decodes it). Instead the guild's raw bytes are edited
directly: the source PlayerUId's 16 in-stream bytes are byte-replaced with the
target's (length-preserving, so no size fixups), which catches guild members,
character-handle ids, and the last-name-modifier without touching InstanceIds.
`MapObjectSaveData` / `GuildSecurity` likewise stay raw and round-trip verbatim.
The round-trip self-test therefore only needs to prove the `CharacterSaveParameterMap`
re-serialize — the sole decode/re-encode in the whole migration.

**Known benign artifact:** the target's original empty solo-guild remains in
`GroupSaveDataMap` listing the target UID, now orphaned (the character's `group_id`
points at the source's real guild). It's harmless and Palworld prunes empty guilds;
removing it would require a non-length-preserving edit, so the tool leaves it.

## Why a custom tool and not magicbear / xNul directly

This server runs **Palworld 0.6+**, whose saves use **PlM / Oodle** compression.
Stock `cheahjs/palworld-save-tools` and the tools built on it (magicbear
`MigratePlayer`, xNul `fix_host_save.py`) speak PlZ/zlib and/or do a full decode
that dies on 0.6+ `GuildSecurity`. We build on the **pinned MRHRTZ fork** the
dashboard's `parser/` already proves works on this exact save
(`parser/requirements.txt`), gate the real run behind the round-trip self-test,
and adapt the canonical xNul UID-remap algorithm (InstanceId preserved, matched
across `Level.sav` + the player file) to the selective-decode 0.6+ path.

## Prerequisites

- **Server fully stopped** to apply (the dashboard enforces this via the Docker
  engine — `getContainerState().running === false`). Self-test and preview work
  while it's up.
- Target identity has **joined the server at least once** → a
  `Players/<target>.sav` and a `CharacterSaveParameterMap` entry exist.

## Advanced / break-glass: the same steps by hand

The dashboard wraps these scripts (`parser/`, run with the pinned venv, e.g.
`/opt/parser-venv/bin/python` in the container). Operate on a **copy**, server
stopped, with a backup taken first.

```bash
# 0. Backup the whole world folder (Level.sav + Players/)
cp -a /save "/save-backup-$(date +%Y%m%d-%H%M%S)"

# 1. Write-path self-test (go/no-go)
python parser/roundtrip_test.py /save-copy/Level.sav --set migrate   # expect "identical": true

# 2. Dry-run the migration (no writes) — inspect the diff
python parser/migrate_uid.py /save-copy/Level.sav \
  --source <sourceUID> --target <targetUID> \
  --players-dir /save-copy/Players --dry-run

# 3. Apply on the copy, then validate it re-parses
python parser/migrate_uid.py /save-copy/Level.sav \
  --source <sourceUID> --target <targetUID> --players-dir /save-copy/Players
python parser/extract_bases.py /save-copy/Level.sav   # confirm target owns pals/bases

# 4. Promote the validated copy over the live save (server stopped); keep the backup.
```

## Rollback
Server stopped → restore the backup over the live folder → start. In the
dashboard this is the **Roll back** button (uses the backup captured at apply).
