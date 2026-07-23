#!/usr/bin/env python3
"""Read-only discovery for a Palworld same-server UID migration (e.g. Xbox -> Steam).

Confirms the SOURCE (old) and TARGET (new) players exist on disk, identifies
them by name/level, and reports the exact rewrite scope (owned Pals, guild
membership) BEFORE any migration writes a single byte. This script NEVER writes
any .sav file.

Requires the MRHRTZ fork of palworld-save-tools -- the same one the dashboard's
parser/ sidecar uses (parser/requirements.txt). Stock cheahjs 0.24.0 only speaks
PlZ/zlib and cannot read current 0.6+ (PlM/Oodle) dedicated-server saves.

Usage:
    python discovery.py --save-dir /path/to/SaveGames/0/<WorldID>
    python discovery.py --save-dir <dir> --source-uid <old_uid> --target-uid <new_uid>
    python discovery.py --save-dir <dir> ... --json     # machine-readable output

<save-dir> is the world folder that directly contains Level.sav and Players/.
UIDs may be given as a 32-hex Players/ filename or a dashed GUID; either matches.
"""

from __future__ import annotations

import argparse
import json
import sys
from collections import defaultdict
from pathlib import Path
from typing import Any

ZERO_UUID = "00000000-0000-0000-0000-000000000000"

# Custom-property decoders we need. CharacterSave -> Pal ownership; Group ->
# guild membership. We deliberately do NOT request BaseCamp/MapObject decoders:
# full MapObject decode (GuildSecurity) hits EOF on 0.6+ saves. If the Group
# decoder itself trips, we retry without it and flag guild info as unavailable.
CUSTOM_PREFIXES_FULL = ("CharacterSave", "Group")
CUSTOM_PREFIXES_SAFE = ("CharacterSave",)


def normalize_uid(raw: str | None) -> str | None:
    """Lowercase, strip dashes, drop a .sav suffix. Makes filename vs GUID compare."""
    if not raw:
        return None
    s = raw.strip().lower()
    if s.endswith(".sav"):
        s = s[:-4]
    s = s.replace("-", "")
    return s or None


def uid_to_filename(guid: str | None) -> str | None:
    """Dashed GUID -> the 32-uppercase-hex Players/<name>.sav stem Palworld uses."""
    n = normalize_uid(guid)
    return n.upper() if n else None


def as_str(value: Any) -> str | None:
    if value is None:
        return None
    try:
        from palworld_save_tools.archive import UUID

        if isinstance(value, UUID):
            return str(value)
    except Exception:
        pass
    if isinstance(value, str):
        return value
    if isinstance(value, dict):
        if "value" in value:
            return as_str(value["value"])
        if "ID" in value:
            return as_str(value["ID"])
    return str(value)


def prop(value: Any) -> Any:
    """Unwrap common GVAS property envelopes ({'value':..,'type':..})."""
    if isinstance(value, dict) and "value" in value and "type" in value:
        return prop(value["value"])
    return value


def byte_or_int(value: Any) -> int | None:
    value = prop(value)
    if isinstance(value, bool):
        return int(value)
    if isinstance(value, (int, float)):
        return int(value)
    if isinstance(value, dict) and "value" in value:
        return byte_or_int(value["value"])
    return None


class _StdoutToStderr:
    """MRHRTZ palsav prints decompress progress to stdout -- keep our stdout clean."""

    def __enter__(self):
        self._stdout = sys.stdout
        sys.stdout = sys.stderr
        return self

    def __exit__(self, *args):
        sys.stdout = self._stdout


def _read_gvas(level_sav: Path, prefixes: tuple[str, ...]):
    from palworld_save_tools.palsav import decompress_sav_to_gvas
    from palworld_save_tools.gvas import GvasFile
    from palworld_save_tools.paltypes import (
        PALWORLD_CUSTOM_PROPERTIES,
        PALWORLD_TYPE_HINTS,
    )

    data = level_sav.read_bytes()
    with _StdoutToStderr():
        raw, save_type = decompress_sav_to_gvas(data)
    wanted = {
        key: PALWORLD_CUSTOM_PROPERTIES[key]
        for key in PALWORLD_CUSTOM_PROPERTIES
        if any(p in key for p in prefixes)
    }
    with _StdoutToStderr():
        gvas = GvasFile.read(raw, PALWORLD_TYPE_HINTS, wanted, allow_nan=True)
    return gvas, save_type


def load_level(level_sav: Path):
    """Load Level.sav, decoding guild data if it survives; flag it if not."""
    try:
        gvas, save_type = _read_gvas(level_sav, CUSTOM_PREFIXES_FULL)
        return gvas, save_type, True
    except Exception:
        # Group decoder tripped on this save -- fall back to Pal-ownership only.
        gvas, save_type = _read_gvas(level_sav, CUSTOM_PREFIXES_SAFE)
        return gvas, save_type, False


def collect_players(wsd: dict[str, Any]) -> dict[str, dict[str, Any]]:
    """PlayerUId(normalized) -> {name, level, groupId, instanceId, playerUid}."""
    players: dict[str, dict[str, Any]] = {}
    for entry in wsd.get("CharacterSaveParameterMap", {}).get("value", []) or []:
        key = entry.get("key") or {}
        player_uid = as_str(prop(key.get("PlayerUId"))) or ZERO_UUID
        if player_uid == ZERO_UUID:
            continue  # a Pal / non-player character
        instance_id = as_str(prop(key.get("InstanceId")))
        raw = prop(entry.get("value", {}).get("RawData"))
        if not isinstance(raw, dict):
            continue
        obj = raw.get("object") or {}
        sp = prop(obj.get("SaveParameter") if isinstance(obj, dict) else None)
        if not isinstance(sp, dict):
            continue
        norm = normalize_uid(player_uid)
        players[norm] = {
            "playerUid": player_uid,
            "normalized": norm,
            "instanceId": instance_id,
            "name": prop(sp.get("NickName")) or None,
            "level": byte_or_int(sp.get("Level")),
            "groupId": as_str(raw.get("group_id")),
        }
    return players


def count_owned_pals(wsd: dict[str, Any]) -> dict[str, int]:
    """normalized OwnerPlayerUId -> number of Pals owned."""
    owned: dict[str, int] = defaultdict(int)
    for entry in wsd.get("CharacterSaveParameterMap", {}).get("value", []) or []:
        key = entry.get("key") or {}
        if (as_str(prop(key.get("PlayerUId"))) or ZERO_UUID) != ZERO_UUID:
            continue  # only Pals (player-character entries have a nonzero key UID)
        raw = prop(entry.get("value", {}).get("RawData"))
        if not isinstance(raw, dict):
            continue
        obj = raw.get("object") or {}
        sp = prop(obj.get("SaveParameter") if isinstance(obj, dict) else None)
        if not isinstance(sp, dict):
            continue
        owner = normalize_uid(as_str(prop(sp.get("OwnerPlayerUId"))))
        if owner and owner != normalize_uid(ZERO_UUID):
            owned[owner] += 1
    return dict(owned)


def collect_guilds(wsd: dict[str, Any]) -> list[dict[str, Any]]:
    """Best-effort guild membership from GroupSaveDataMap (if it decoded)."""
    guilds: list[dict[str, Any]] = []
    for entry in wsd.get("GroupSaveDataMap", {}).get("value", []) or []:
        gid = as_str(entry.get("key"))
        raw = prop(entry.get("value", {}).get("RawData"))
        if not isinstance(raw, dict):
            continue  # left raw (undecoded) -- skip; migration handles it directly
        members = []
        for p in raw.get("players", []) or []:
            p = prop(p)
            if not isinstance(p, dict):
                continue
            uid = as_str(prop(p.get("player_uid")))
            info = prop(p.get("player_info")) or {}
            members.append(
                {
                    "playerUid": uid,
                    "normalized": normalize_uid(uid),
                    "name": as_str(prop(info.get("player_name")))
                    if isinstance(info, dict)
                    else None,
                }
            )
        guilds.append(
            {
                "groupId": gid,
                "guildName": as_str(raw.get("guild_name")),
                "adminPlayerUid": as_str(raw.get("admin_player_uid")),
                "adminNormalized": normalize_uid(as_str(raw.get("admin_player_uid"))),
                "memberCount": len(members),
                "members": members,
            }
        )
    return guilds


def build_report(save_dir: Path, source: str | None, target: str | None) -> dict[str, Any]:
    level_sav = save_dir / "Level.sav"
    players_dir = save_dir / "Players"
    if not level_sav.is_file():
        raise SystemExit(f"Level.sav not found in {save_dir}")

    gvas, save_type, guild_ok = load_level(level_sav)
    wsd = gvas.properties["worldSaveData"]["value"]

    players = collect_players(wsd)
    owned = count_owned_pals(wsd)
    guilds = collect_guilds(wsd) if guild_ok else []

    on_disk = []
    if players_dir.is_dir():
        for f in sorted(players_dir.glob("*.sav")):
            on_disk.append(
                {
                    "file": f.name,
                    "normalized": normalize_uid(f.stem),
                    "sizeBytes": f.stat().st_size,
                    "inLevelSav": normalize_uid(f.stem) in players,
                }
            )

    src_n = normalize_uid(source)
    tgt_n = normalize_uid(target)

    def player_slice(n: str | None) -> dict[str, Any] | None:
        if not n:
            return None
        rec = dict(players.get(n) or {})
        rec["normalized"] = n
        rec["ownedPalCount"] = owned.get(n, 0)
        rec["playersFile"] = f"{uid_to_filename(n)}.sav"
        rec["playersFileExists"] = any(d["normalized"] == n for d in on_disk)
        rec["inLevelSav"] = n in players
        rec["guilds"] = [
            {"groupId": g["groupId"], "guildName": g["guildName"],
             "isAdmin": g["adminNormalized"] == n,
             "isMember": any(m["normalized"] == n for m in g["members"])}
            for g in guilds
            if g["adminNormalized"] == n or any(m["normalized"] == n for m in g["members"])
        ]
        return rec

    return {
        "ok": True,
        "saveDir": str(save_dir),
        "saveType": save_type,
        "guildDataDecoded": guild_ok,
        "playerCount": len(players),
        "playersOnDisk": on_disk,
        "players": list(players.values()),
        "ownedPalCounts": owned,
        "guilds": guilds,
        "source": player_slice(src_n),
        "target": player_slice(tgt_n),
    }


def print_human(rep: dict[str, Any]) -> None:
    out = sys.stdout
    p = lambda *a: print(*a, file=out)  # noqa: E731
    p(f"\nSave dir : {rep['saveDir']}")
    p(f"Format   : {rep['saveType']}  (guild data decoded: {rep['guildDataDecoded']})")
    p(f"Players in Level.sav: {rep['playerCount']}\n")

    p("Players on disk (Players/*.sav):")
    for d in rep["playersOnDisk"]:
        flag = "" if d["inLevelSav"] else "   [!] no matching character in Level.sav"
        p(f"  {d['file']}  ({d['sizeBytes']:,} bytes){flag}")

    p("\nCharacters (from Level.sav):")
    for pl in sorted(rep["players"], key=lambda x: (x.get("level") or 0), reverse=True):
        n = pl["normalized"]
        pals = rep["ownedPalCounts"].get(n, 0)
        p(f"  {pl.get('name') or '(no name)'!s:<20} "
          f"Lv {str(pl.get('level') or '?'):<3}  "
          f"pals={pals:<4}  uid={pl['playerUid']}")

    for role in ("source", "target"):
        rec = rep.get(role)
        if not rec:
            continue
        p(f"\n=== {role.upper()} ===")
        p(f"  name           : {rec.get('name')}")
        p(f"  level          : {rec.get('level')}")
        p(f"  normalized uid : {rec.get('normalized')}")
        p(f"  Players file   : {rec['playersFile']}  (exists: {rec['playersFileExists']})")
        p(f"  in Level.sav   : {rec['inLevelSav']}")
        p(f"  owned pals     : {rec['ownedPalCount']}")
        if rec["guilds"]:
            for g in rec["guilds"]:
                tags = []
                if g["isAdmin"]:
                    tags.append("ADMIN")
                if g["isMember"]:
                    tags.append("member")
                p(f"  guild          : {g['guildName']} [{','.join(tags)}] ({g['groupId']})")
        else:
            p("  guild          : (none found / guild data not decoded)")

    if rep.get("source") and rep.get("target"):
        s, t = rep["source"], rep["target"]
        p("\n--- MIGRATION SCOPE (source -> target) ---")
        if not s["inLevelSav"]:
            p("  [!] SOURCE has no character in Level.sav -- wrong UID?")
        if not t["playersFileExists"]:
            p("  [!] TARGET has no Players/*.sav -- has he logged in on Steam yet?")
        p(f"  Pals to re-point  : {s['ownedPalCount']}")
        p(f"  Guilds to update  : {len(s['guilds'])}")
        p("  Target character (fresh Steam) will be OVERWRITTEN by the source character.")
    p("")


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--save-dir", required=True, type=Path,
                    help="World folder containing Level.sav and Players/")
    ap.add_argument("--source-uid", default=None,
                    help="Old UID (Xbox) -- 32-hex filename or dashed GUID")
    ap.add_argument("--target-uid", default=None,
                    help="New UID (Steam) -- 32-hex filename or dashed GUID")
    ap.add_argument("--json", action="store_true", help="Emit JSON instead of a summary")
    args = ap.parse_args(argv)

    try:
        rep = build_report(args.save_dir, args.source_uid, args.target_uid)
    except ImportError as err:
        print(json.dumps({"ok": False, "error": "palworld-save-tools not installed: "
                          + str(err)}))
        return 2

    if args.json:
        print(json.dumps(rep, separators=(",", ":"), default=str))
    else:
        print_human(rep)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
