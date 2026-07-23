#!/usr/bin/env python3
"""Re-point a Palworld player from a SOURCE PlayerUId to a TARGET PlayerUId.

Same-server UID migration (e.g. Xbox `gdk_` -> Steam). Makes the TARGET identity
inherit everything the SOURCE character owns (level, pals, bases, guild,
inventory) and overwrites the throwaway fresh TARGET character.

Adapts the canonical xNul/palworld-host-save-fix algorithm to the 0.6+ PlM/Oodle
format via the MRHRTZ fork, with two deliberate changes:

  1. Selective decode. Only CharacterSaveParameterMap is decoded (the exact set
     roundtrip_test.py proves lossless). GroupSaveDataMap is NOT decoded — this
     0.6+ save's guild `player_info` layout desyncs the fork's group.py decoder
     (reads past EOF), the same reason extract_bases.py never decodes it; it is
     re-pointed at the raw-byte level instead (see below). MapObjectSaveData
     (whose GuildSecurity module also dies on a full 0.6+ decode) stays raw too.
  2. Scoped re-point, two mechanisms for the two maps:
     - CharacterSaveParameterMap (decoded): every reference to the SOURCE
       PlayerUId is rewritten to the TARGET in-place. A PlayerUId is a
       globally-unique GUID distinct from any InstanceId, so InstanceIds are
       preserved untouched and the character re-key (key.PlayerUId) plus pal
       OwnerPlayerUId / OldOwnerPlayerUIds are all caught in one pass.
     - GroupSaveDataMap (raw bytes): the SOURCE PlayerUId's 16 raw stream bytes
       (UUID.from_str(...).raw_bytes) are byte-replaced with the TARGET's inside
       each group's RawData. This is length-preserving (16 -> 16) and catches
       guild members, admin/handle ids, and last-modifier without decoding the
       struct. InstanceIds are distinct 16-byte GUIDs, so they never collide.

Operates on a copy: with --dry-run it writes nothing and only reports the diff;
otherwise it writes the modified Level.sav and Players/<TARGET>.sav in place in
the working copy. Prints one JSON object to stdout (extract_bases.py contract).
"""

from __future__ import annotations

import argparse
import json
import shutil
import sys
import traceback
from pathlib import Path
from typing import Any

ZERO_HEX = "0" * 32

# The lossless-proven migrate set (see parser/roundtrip_test.py MIGRATE_KEYS).
# GroupSaveDataMap is intentionally absent — it is re-pointed at the byte level.
MIGRATE_KEYS = (".worldSaveData.CharacterSaveParameterMap.Value.RawData",)


def fail(code: str, message: str, *, details: str | None = None, exit_code: int = 2) -> None:
    payload: dict[str, Any] = {"ok": False, "error": {"code": code, "message": message}}
    if details:
        payload["error"]["details"] = details
    print(json.dumps(payload, separators=(",", ":")))
    raise SystemExit(exit_code)


class _StdoutToStderr:
    """MRHRTZ palsav prints (de)compress progress to stdout — keep stdout JSON-clean."""

    def __enter__(self):
        self._stdout = sys.stdout
        sys.stdout = sys.stderr
        return self

    def __exit__(self, *args):
        sys.stdout = self._stdout


def norm_hex(value: str) -> str:
    """Any GUID form (dashed / 32-hex / with .sav) -> bare 32-hex lowercase."""
    s = str(value or "").strip()
    if s.lower().endswith(".sav"):
        s = s[:-4]
    s = s.replace("-", "").lower()
    return s


def dashed(hex32: str) -> str:
    h = norm_hex(hex32)
    return f"{h[:8]}-{h[8:12]}-{h[12:16]}-{h[16:20]}-{h[20:]}"


def _uuid_cls():
    from palworld_save_tools.archive import UUID

    return UUID


def uuid_hex(value: Any) -> str | None:
    """32-hex lowercase for a UUID object or GUID string; None otherwise."""
    UUID = _uuid_cls()
    if isinstance(value, UUID):
        return str(value).replace("-", "").lower()
    if isinstance(value, str):
        s = value.replace("-", "").lower()
        return s if len(s) == 32 and all(c in "0123456789abcdef" for c in s) else None
    return None


def count_uuid(node: Any, target_hex: str) -> int:
    """Count leaf values (UUID or GUID string) equal to target_hex in a subtree."""
    total = 0
    if isinstance(node, dict):
        for v in node.values():
            total += count_uuid(v, target_hex)
    elif isinstance(node, list):
        for v in node:
            total += count_uuid(v, target_hex)
    else:
        if uuid_hex(node) == target_hex:
            total += 1
    return total


def replace_uuid(node: Any, src_hex: str, dst_dashed: str) -> int:
    """Replace every UUID/GUID-string leaf equal to src_hex with the target,
    in-place. Returns the number of replacements. Matches the original leaf type
    (UUID object -> UUID object, string -> dashed string)."""
    UUID = _uuid_cls()
    count = 0
    if isinstance(node, dict):
        for k, v in node.items():
            if uuid_hex(v) == src_hex:
                node[k] = UUID.from_str(dst_dashed) if isinstance(v, UUID) else dst_dashed
                count += 1
            else:
                count += replace_uuid(v, src_hex, dst_dashed)
    elif isinstance(node, list):
        for i, v in enumerate(node):
            if uuid_hex(v) == src_hex:
                node[i] = UUID.from_str(dst_dashed) if isinstance(v, UUID) else dst_dashed
                count += 1
            else:
                count += replace_uuid(v, src_hex, dst_dashed)
    return count


def uuid_raw_bytes(hex32: str) -> bytes:
    """The exact 16 in-stream bytes reader.guid() would produce for this GUID.

    Palworld stores GUIDs byte-swapped (see archive.UUID.from_str); reusing that
    codec guarantees the byte pattern we search for matches what's on disk.
    """
    UUID = _uuid_cls()
    return bytes(UUID.from_str(dashed(hex32)).raw_bytes)


def _group_bytes_ref(entry: Any) -> dict | None:
    """The dict whose ['values'] is a group's raw RawData bytes, or None.

    Only present when GroupSaveDataMap is left undecoded (our case). Returns the
    container so callers can mutate ['values'] in place.
    """
    value = entry.get("value") if isinstance(entry, dict) else None
    raw = value.get("RawData") if isinstance(value, dict) else None
    inner = raw.get("value") if isinstance(raw, dict) else None
    if isinstance(inner, dict) and isinstance(inner.get("values"), (list, bytes, bytearray)):
        return inner
    return None


def count_group_uid(group_map: list, src_raw: bytes) -> int:
    """Number of group entries whose raw bytes contain the source GUID."""
    hits = 0
    for entry in group_map:
        inner = _group_bytes_ref(entry)
        if inner is not None and src_raw in bytes(inner["values"]):
            hits += 1
    return hits


def replace_group_uid(group_map: list, src_raw: bytes, dst_raw: bytes) -> tuple[int, int]:
    """Byte-replace src GUID -> dst GUID in each undecoded group's raw bytes.

    Length-preserving (both are 16 bytes), so no size/count fixups are needed.
    Returns (entriesTouched, totalReplacements).
    """
    entries = 0
    total = 0
    for entry in group_map:
        inner = _group_bytes_ref(entry)
        if inner is None:
            continue
        data = bytes(inner["values"])
        n = data.count(src_raw)
        if not n:
            continue
        inner["values"] = list(data.replace(src_raw, dst_raw))
        entries += 1
        total += n
    return entries, total


def load_sav(path: Path, custom_properties: dict):
    from palworld_save_tools.gvas import GvasFile
    from palworld_save_tools.palsav import decompress_sav_to_gvas
    from palworld_save_tools.paltypes import PALWORLD_TYPE_HINTS

    data = path.read_bytes()
    with _StdoutToStderr():
        raw, save_type = decompress_sav_to_gvas(data)
        gvas = GvasFile.read(raw, PALWORLD_TYPE_HINTS, custom_properties, allow_nan=True)
    return gvas, save_type


def write_sav(gvas, save_type: int, custom_properties: dict, path: Path) -> None:
    from palworld_save_tools.palsav import compress_gvas_to_sav

    with _StdoutToStderr():
        encoded = gvas.write(custom_properties)
        sav = compress_gvas_to_sav(encoded, save_type, zlib=False)
    path.write_bytes(sav)


def migrate_properties() -> dict:
    from palworld_save_tools.paltypes import DISABLED_PROPERTIES, PALWORLD_CUSTOM_PROPERTIES

    return {
        key: PALWORLD_CUSTOM_PROPERTIES[key]
        for key in MIGRATE_KEYS
        if key in PALWORLD_CUSTOM_PROPERTIES and key not in DISABLED_PROPERTIES
    }


def find_players_file(players_dir: Path, hex32: str) -> Path | None:
    """Case-insensitive lookup of Players/<hex>.sav."""
    if not players_dir.is_dir():
        return None
    for entry in players_dir.iterdir():
        if entry.is_file() and entry.suffix.lower() == ".sav":
            if norm_hex(entry.stem) == hex32:
                return entry
    return None


def survey_level(
    char_map: list, group_map: list, source_hex: str, target_hex: str, src_raw: bytes
) -> dict:
    """Read-only scope survey for the dry-run diff (before any replacement)."""
    source_instance = None
    source_player_entries = 0
    target_player_entries = 0
    owned_pals = 0

    for entry in char_map:
        key = entry.get("key") or {}
        key_uid = uuid_hex(_unwrap(key.get("PlayerUId")))
        if key_uid == source_hex:
            source_player_entries += 1
            source_instance = uuid_hex(_unwrap(key.get("InstanceId")))
        elif key_uid == target_hex:
            target_player_entries += 1
        elif key_uid == ZERO_HEX:
            # A pal entry: does it reference the source (OwnerPlayerUId etc.)?
            if count_uuid(entry.get("value"), source_hex) > 0:
                owned_pals += 1

    # GroupSaveDataMap is undecoded (raw bytes) — count guilds referencing the
    # source at the byte level, matching how the apply step re-points them.
    guild_hits = count_group_uid(group_map, src_raw)

    return {
        "sourceInstanceId": source_instance,
        "sourcePlayerEntries": source_player_entries,
        "targetPlayerEntries": target_player_entries,
        "ownedPalCount": owned_pals,
        "guildMemberships": guild_hits,
    }


def _unwrap(value: Any) -> Any:
    while isinstance(value, dict) and "value" in value and ("type" in value or "struct_type" in value):
        value = value["value"]
    return value


def world_maps(gvas) -> tuple[list, list]:
    wsd = gvas.properties["worldSaveData"]["value"]
    char_map = (wsd.get("CharacterSaveParameterMap") or {}).get("value") or []
    group_map = (wsd.get("GroupSaveDataMap") or {}).get("value") or []
    return char_map, group_map


def run(args) -> dict[str, Any]:
    source_hex = norm_hex(args.source)
    target_hex = norm_hex(args.target)
    if len(source_hex) != 32 or len(target_hex) != 32:
        fail("bad_uid", "source and target must be 32-hex GUIDs (dashed or bare)")
    if source_hex == target_hex:
        fail("bad_uid", "source and target must differ")

    level_sav = args.level_sav
    if not level_sav.is_file():
        fail("not_found", f"Level.sav not found: {level_sav}")

    players_dir = args.players_dir or (level_sav.parent / "Players")
    source_file = find_players_file(players_dir, source_hex)
    target_file = find_players_file(players_dir, target_hex)

    props = migrate_properties()
    gvas, level_save_type = load_sav(level_sav, props)
    try:
        char_map, group_map = world_maps(gvas)
    except Exception as err:
        fail("parse_failed", "worldSaveData/maps missing from Level.sav", details=str(err))

    src_raw = uuid_raw_bytes(source_hex)
    dst_raw = uuid_raw_bytes(target_hex)

    survey = survey_level(char_map, group_map, source_hex, target_hex, src_raw)
    if survey["sourcePlayerEntries"] == 0:
        fail(
            "source_not_found",
            f"Source PlayerUId {dashed(source_hex)} has no character in Level.sav",
            details=json.dumps(survey),
        )

    target_players_file = f"{target_hex.upper()}.sav"
    source_players_file = f"{source_hex.upper()}.sav"

    diffs = [
        {
            "field": "Player character",
            "detail": "re-key PlayerUId (level, appearance, inventory follow)",
            "sourceValue": dashed(source_hex),
            "targetValue": dashed(target_hex),
            "changeType": "modified",
            "count": survey["sourcePlayerEntries"],
        },
        {
            "field": "Fresh target character",
            "detail": "throwaway new-account character overwritten by the source",
            "changeType": "removed",
            "count": survey["targetPlayerEntries"],
        },
        {
            "field": "Owned pals",
            "detail": "OwnerPlayerUId re-pointed to target",
            "changeType": "modified",
            "count": survey["ownedPalCount"],
        },
        {
            "field": "Guild / base ownership",
            "detail": "guild membership + character handles re-pointed",
            "changeType": "modified",
            "count": survey["guildMemberships"],
        },
        {
            "field": "Player save file",
            "detail": f"{source_players_file} -> {target_players_file}",
            "changeType": "renamed",
            "count": 1,
        },
    ]

    result: dict[str, Any] = {
        "ok": True,
        "dryRun": bool(args.dry_run),
        "source": {
            "uid": dashed(source_hex),
            "hex": source_hex,
            "instanceId": survey["sourceInstanceId"],
            "playersFile": source_players_file,
            "playersFileExists": source_file is not None,
            "inLevel": survey["sourcePlayerEntries"] > 0,
            "ownedPalCount": survey["ownedPalCount"],
        },
        "target": {
            "uid": dashed(target_hex),
            "hex": target_hex,
            "playersFile": target_players_file,
            "playersFileExists": target_file is not None,
            "inLevel": survey["targetPlayerEntries"] > 0,
        },
        "diffs": diffs,
    }

    if args.dry_run:
        # Warnings that don't block a preview but the user should see.
        warnings = []
        if source_file is None:
            warnings.append(f"Source player file {source_players_file} not found in {players_dir}")
        if target_file is None:
            warnings.append(
                f"Target player file {target_players_file} not found — the target must have "
                "joined the server at least once on the new account"
            )
        result["warnings"] = warnings
        return result

    # --- Apply (working copy only) -----------------------------------------
    if source_file is None:
        fail("source_file_missing", f"Source player file not found: {source_players_file}")
    if target_file is None:
        fail(
            "target_file_missing",
            f"Target player file not found: {target_players_file} (target must have joined once)",
        )

    src_dashed = dashed(source_hex)
    dst_dashed = dashed(target_hex)

    # 0. Drop the throwaway TARGET character entry(ies) BEFORE re-keying, so the
    #    map doesn't end up with two characters sharing the target UID (the fresh
    #    join vs. the migrated source). Its player file is overwritten below; any
    #    pals it caught keep OwnerPlayerUId == target and carry over harmlessly.
    #    Must run before the re-key, while target entries are still distinguishable.
    removed_target_entries = 0
    if survey["targetPlayerEntries"]:
        kept = [
            e
            for e in char_map
            if uuid_hex(_unwrap((e.get("key") or {}).get("PlayerUId"))) != target_hex
        ]
        removed_target_entries = len(char_map) - len(kept)
        char_map[:] = kept  # in-place: char_map is the live gvas list

    # 1. Level.sav re-point:
    #    - CharacterSaveParameterMap (decoded): re-key + pal owners via UUID walk.
    #    - GroupSaveDataMap (raw bytes): length-preserving GUID byte-replace.
    level_char_hits = replace_uuid(char_map, source_hex, dst_dashed)
    level_group_entries, level_group_hits = replace_group_uid(group_map, src_raw, dst_raw)
    write_sav(gvas, level_save_type, props, level_sav)

    # 2. Player file: patch PlayerUId + IndividualId.PlayerUId (InstanceId kept),
    #    write it as the TARGET file, and drop the working SOURCE file so the
    #    working copy never contains two files claiming the same instance id.
    pgvas, p_save_type = load_sav(source_file, {})
    player_hits = replace_uuid(pgvas.properties, source_hex, dst_dashed)
    out_target = players_dir / target_players_file
    write_sav(pgvas, p_save_type, {}, out_target)
    if source_file.resolve() != out_target.resolve():
        source_file.unlink(missing_ok=True)

    result["replacements"] = {
        "levelCharacterMap": level_char_hits,
        "levelGroupMap": level_group_hits,
        "levelGroupEntries": level_group_entries,
        "removedTargetEntries": removed_target_entries,
        "playerFile": player_hits,
        "total": level_char_hits + level_group_hits + player_hits,
    }
    result["output"] = {
        "levelSav": level_sav.name,
        "playersFile": target_players_file,
        "removedPlayersFile": source_players_file,
    }
    # Silence unused-var linters for the captured dashed source id.
    _ = src_dashed
    return result


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("level_sav", type=Path, help="Path to a Level.sav (a working copy)")
    parser.add_argument("--source", required=True, help="Source PlayerUId (dashed or 32-hex)")
    parser.add_argument("--target", required=True, help="Target PlayerUId (dashed or 32-hex)")
    parser.add_argument(
        "--players-dir",
        type=Path,
        default=None,
        help="Players/ folder (defaults to <level_sav dir>/Players)",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Report the diff without writing anything",
    )
    args = parser.parse_args(argv)

    try:
        report = run(args)
    except SystemExit:
        raise
    except Exception as err:
        fail(
            "internal_error",
            "Unexpected migration failure",
            details="".join(traceback.format_exception(err)),
        )

    print(json.dumps(report, separators=(",", ":"), default=str))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
