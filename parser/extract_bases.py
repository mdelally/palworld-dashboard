#!/usr/bin/env python3
"""Extract a compact bases/pals/resources report from a Palworld Level.sav copy.

Read-only. Prints one JSON object to stdout. Never writes the input .sav.

Requires the MRHRTZ fork of palworld-save-tools (PlM/Oodle, Palworld 0.6+).
Stock cheahjs 0.24.0 only understands PlZ/zlib and will fail loudly here.
"""

from __future__ import annotations

import argparse
import json
import sys
import traceback
from collections import defaultdict
from pathlib import Path
from typing import Any

ZERO_UUID = "00000000-0000-0000-0000-000000000000"
HUNGRY_STOMACH = 30.0
# Pocketpair default base names look like 新規生成拠点テンプレート名0(仮)
DEFAULT_BASE_NAME_MARKERS = ("新規生成拠点", "テンプレート名")

# Selective custom-property decode: full MapObject decode still dies on
# GuildSecurity (and similar) modules in 0.6+. Item containers are safe;
# map-object → base links are decoded per-object below (Model + ItemContainer
# module only).
CUSTOM_PREFIXES = ("BaseCamp", "CharacterSave", "WorkSave", "ItemContainer")


def fail(code: str, message: str, *, details: str | None = None, exit_code: int = 2) -> None:
    payload: dict[str, Any] = {
        "ok": False,
        "error": {"code": code, "message": message},
    }
    if details:
        payload["error"]["details"] = details
    print(json.dumps(payload, separators=(",", ":")))
    raise SystemExit(exit_code)


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
    """Unwrap common GVAS property envelopes."""
    if isinstance(value, dict) and "value" in value and "type" in value:
        return prop(value["value"])
    return value


def enum_tail(value: Any) -> str | None:
    """Turn EPalFoo::Bar / {'value': 'EPalFoo::Bar'} into 'Bar' (None if unset)."""
    raw = prop(value)
    if isinstance(raw, dict) and "value" in raw:
        raw = prop(raw["value"])
    if not isinstance(raw, str) or not raw or raw == "None":
        return None
    if "::" in raw:
        raw = raw.rsplit("::", 1)[-1]
    if raw in ("None", "None_"):
        return None
    return raw


def name_list(value: Any) -> list[str]:
    raw = prop(value)
    if isinstance(raw, dict) and "values" in raw:
        raw = raw["values"]
    if not isinstance(raw, list):
        return []
    out: list[str] = []
    for item in raw:
        s = as_str(prop(item)) if not isinstance(item, str) else item
        if s:
            out.append(s)
    return out


def byte_or_int(value: Any) -> int | None:
    value = prop(value)
    if isinstance(value, bool):
        return int(value)
    if isinstance(value, (int, float)):
        return int(value)
    if isinstance(value, dict) and "value" in value:
        return byte_or_int(value["value"])
    return None


def fixed_hp(value: Any) -> int | None:
    """Palworld stores HP as FixedPoint64 (value / 1000 ≈ display HP)."""
    value = prop(value)
    if isinstance(value, dict) and "Value" in value:
        raw = byte_or_int(value["Value"])
        if raw is None:
            return None
        return raw // 1000
    raw = byte_or_int(value)
    if raw is None:
        return None
    # Heuristic: large ints are fixed-point.
    return raw // 1000 if raw > 10_000 else raw


def container_id_from_slot(slot: Any) -> str | None:
    slot = prop(slot)
    if not isinstance(slot, dict):
        return None
    return as_str(slot.get("ContainerId"))


def slot_index_from_slot(slot: Any) -> int | None:
    slot = prop(slot)
    if not isinstance(slot, dict):
        return None
    return byte_or_int(slot.get("SlotIndex"))


def is_default_base_name(name: str | None) -> bool:
    if not name:
        return True
    return any(marker in name for marker in DEFAULT_BASE_NAME_MARKERS)


def soft_base_name(
    raw_name: str | None,
    *,
    index: int,
    owner_names: list[str],
) -> str:
    if raw_name and not is_default_base_name(raw_name):
        return raw_name
    if len(owner_names) == 1:
        return f"{owner_names[0]}'s base"
    if owner_names:
        return f"Base {index} ({', '.join(owner_names[:2])})"
    return f"Base {index}"


class _ArchiveParent:
    """Minimal parent for palworld-save-tools rawdata decode_bytes helpers."""

    def internal_copy(self, data: bytes, debug: bool = False):
        from palworld_save_tools.archive import FArchiveReader

        return FArchiveReader(data, debug=debug)


def _map_object_list(wsd: dict[str, Any]) -> list[Any]:
    mos = prop(wsd.get("MapObjectSaveData"))
    if isinstance(mos, dict):
        vals = mos.get("values")
        if isinstance(vals, list):
            return vals
        inner = mos.get("value")
        if isinstance(inner, dict) and isinstance(inner.get("values"), list):
            return inner["values"]
        if isinstance(inner, list):
            return inner
    if isinstance(mos, list):
        return mos
    return []


def extract_items_by_container(wsd: dict[str, Any]) -> dict[str, dict[str, int]]:
    """container_id → { static_id → count } for nonempty item containers."""
    out: dict[str, dict[str, int]] = {}
    for entry in wsd.get("ItemContainerSaveData", {}).get("value", []) or []:
        cid = as_str(entry.get("key"))
        if not cid:
            continue
        slots_wrap = prop((entry.get("value") or {}).get("Slots"))
        if not isinstance(slots_wrap, dict):
            continue
        slots = slots_wrap.get("values")
        if not isinstance(slots, list):
            continue
        stacks: dict[str, int] = defaultdict(int)
        for slot in slots:
            if not isinstance(slot, dict):
                continue
            raw_slot = (slot.get("RawData") or {}).get("value")
            if not isinstance(raw_slot, dict):
                continue
            item = raw_slot.get("item") or {}
            static_id = item.get("static_id") if isinstance(item, dict) else None
            count = raw_slot.get("count") or 0
            if (
                isinstance(static_id, str)
                and static_id
                and static_id not in ("None", "None_")
                and isinstance(count, int)
                and count > 0
            ):
                stacks[static_id] += count
        if stacks:
            out[cid] = dict(stacks)
    return out


def extract_container_base_ids(wsd: dict[str, Any]) -> dict[str, str]:
    """ItemContainer module target_container_id → base_camp_id_belong_to.

    Avoids the full MapObject custom decoder (GuildSecurity EOF). Decodes each
    object's Model RawData + ItemContainer module bytes only.
    """
    from palworld_save_tools.archive import FArchiveReader
    from palworld_save_tools.rawdata import map_concrete_model_module, map_model

    parent = _ArchiveParent()
    links: dict[str, str] = {}

    for obj in _map_object_list(wsd):
        if not isinstance(obj, dict):
            continue
        model = prop(obj.get("Model")) or {}
        if not isinstance(model, dict):
            continue
        mraw = prop(model.get("RawData"))
        if not isinstance(mraw, dict) or "values" not in mraw:
            continue
        try:
            decoded_model = map_model.decode_bytes(parent, mraw["values"])
        except Exception:
            continue
        if not isinstance(decoded_model, dict):
            continue
        base_camp_id = as_str(decoded_model.get("base_camp_id_belong_to"))
        if not base_camp_id or base_camp_id == ZERO_UUID:
            continue

        concrete = prop(obj.get("ConcreteModel")) or {}
        if not isinstance(concrete, dict):
            continue
        mmap = prop(concrete.get("ModuleMap"))
        modules: list[Any] = []
        if isinstance(mmap, list):
            modules = mmap
        elif isinstance(mmap, dict):
            if isinstance(mmap.get("value"), list):
                modules = mmap["value"]
            elif isinstance(mmap.get("values"), list):
                modules = mmap["values"]

        for mod in modules:
            if not isinstance(mod, dict):
                continue
            if mod.get("key") != "EPalMapObjectConcreteModelModuleType::ItemContainer":
                continue
            mbytes_wrap = prop((mod.get("value") or {}).get("RawData"))
            if not isinstance(mbytes_wrap, dict) or "values" not in mbytes_wrap:
                continue
            tid: str | None = None
            try:
                md = map_concrete_model_module.decode_bytes(
                    parent, mbytes_wrap["values"], mod["key"]
                )
                if isinstance(md, dict):
                    tid = as_str(md.get("target_container_id"))
            except Exception:
                try:
                    reader = FArchiveReader(bytes(mbytes_wrap["values"]))
                    tid = as_str(reader.guid())
                except Exception:
                    continue
            if tid and tid != ZERO_UUID:
                links[tid] = base_camp_id

    return links


def resources_for_base(
    base_id: str | None,
    *,
    items_by_container: dict[str, dict[str, int]],
    container_base_ids: dict[str, str],
) -> list[dict[str, Any]]:
    if not base_id:
        return []
    totals: dict[str, int] = defaultdict(int)
    for cid, stacks in items_by_container.items():
        if container_base_ids.get(cid) != base_id:
            continue
        for static_id, count in stacks.items():
            totals[static_id] += count
    return [
        {"id": item_id, "count": count}
        for item_id, count in sorted(totals.items(), key=lambda kv: (-kv[1], kv[0]))
    ]


def classify_status(
    *,
    at_base: bool,
    full_stomach: float | None,
    hunger_type: str | None,
    physical_health: str | None,
    worker_sick: str | None,
    worker_event: str | None,
) -> str:
    # Priority: injured > sick > starving/hungry > slacking > working > idle
    if physical_health and physical_health.lower() not in ("healthy", "none"):
        return "injured"
    if worker_sick:
        return "sick"
    if hunger_type and hunger_type.lower() in ("starvation", "starve"):
        return "starving"
    if hunger_type and hunger_type.lower() in ("hunger", "hungry"):
        return "hungry"
    if full_stomach is not None and full_stomach < HUNGRY_STOMACH:
        return "hungry"
    if worker_event and "dodge" in worker_event.lower():
        return "slacking"
    if at_base:
        return "working"
    return "idle"


class _StdoutToStderr:
    """MRHRTZ palsav prints decompress progress to stdout — keep stdout JSON-clean."""

    def __enter__(self):
        self._stdout = sys.stdout
        sys.stdout = sys.stderr
        return self

    def __exit__(self, *args):
        sys.stdout = self._stdout


def load_gvas(level_sav: Path):
    try:
        from palworld_save_tools.palsav import decompress_sav_to_gvas
        from palworld_save_tools.gvas import GvasFile
        from palworld_save_tools.paltypes import (
            PALWORLD_CUSTOM_PROPERTIES,
            PALWORLD_TYPE_HINTS,
        )
    except ImportError as err:
        fail(
            "parser_missing",
            "palworld-save-tools is not installed in the parser environment",
            details=str(err),
        )

    data = level_sav.read_bytes()
    magic = data[8:11] if len(data) >= 11 else b""
    try:
        with _StdoutToStderr():
            raw, save_type = decompress_sav_to_gvas(data)
    except Exception as err:
        msg = str(err)
        if "PlM" in msg or magic == b"PlM":
            fail(
                "unsupported_save_version",
                "Save uses PlM/Oodle compression (Palworld 0.6+) but Oodle support failed. "
                "Install the MRHRTZ palworld-save-tools fork with pyooz.",
                details=msg,
            )
        if "PlZ" in msg or "not a compressed" in msg:
            fail(
                "unsupported_save_version",
                f"Unrecognized or unsupported save header (magic={magic!r})",
                details=msg,
            )
        fail("decompress_failed", "Failed to decompress Level.sav", details=msg)

    wanted = {
        key: PALWORLD_CUSTOM_PROPERTIES[key]
        for key in PALWORLD_CUSTOM_PROPERTIES
        if any(prefix in key for prefix in CUSTOM_PREFIXES)
    }
    try:
        with _StdoutToStderr():
            gvas = GvasFile.read(raw, PALWORLD_TYPE_HINTS, wanted, allow_nan=True)
    except Exception as err:
        fail(
            "parse_failed",
            "Failed to parse GVAS world data (save format may be newer than the parser)",
            details=str(err),
        )

    return gvas, save_type, magic.decode("ascii", errors="replace")


def extract_report(level_sav: Path) -> dict[str, Any]:
    gvas, save_type, magic = load_gvas(level_sav)
    props = gvas.properties
    try:
        wsd = props["worldSaveData"]["value"]
    except Exception:
        fail("parse_failed", "worldSaveData missing from Level.sav")

    players_by_uid: dict[str, dict[str, Any]] = {}
    pals_by_container: dict[str, list[dict[str, Any]]] = defaultdict(list)
    pals_by_group: dict[str, list[str]] = defaultdict(list)

    for entry in wsd.get("CharacterSaveParameterMap", {}).get("value", []) or []:
        key = entry.get("key") or {}
        player_uid = as_str(prop(key.get("PlayerUId"))) or ZERO_UUID
        instance_id = as_str(prop(key.get("InstanceId")))
        raw = prop(entry.get("value", {}).get("RawData"))
        if not isinstance(raw, dict):
            continue
        group_id = as_str(raw.get("group_id"))
        obj = raw.get("object") or {}
        save_parameter = prop((obj.get("SaveParameter") if isinstance(obj, dict) else None))
        if not isinstance(save_parameter, dict):
            continue

        if player_uid != ZERO_UUID:
            players_by_uid[player_uid] = {
                "playerUid": player_uid,
                "instanceId": instance_id,
                "name": prop(save_parameter.get("NickName")) or None,
                "level": byte_or_int(save_parameter.get("Level")),
                "groupId": group_id,
            }
            continue

        species = prop(save_parameter.get("CharacterID"))
        if not isinstance(species, str):
            species = as_str(species) or "Unknown"
        level = byte_or_int(save_parameter.get("Level"))
        full_stomach = prop(save_parameter.get("FullStomach"))
        if isinstance(full_stomach, (int, float)):
            stomach = float(full_stomach)
        else:
            stomach = None
        sanity_raw = prop(save_parameter.get("SanityValue"))
        sanity = float(sanity_raw) if isinstance(sanity_raw, (int, float)) else None
        hp = fixed_hp(save_parameter.get("Hp"))
        owner_uid = as_str(prop(save_parameter.get("OwnerPlayerUId")))
        container_id = container_id_from_slot(save_parameter.get("SlotId"))
        slot_index = slot_index_from_slot(save_parameter.get("SlotId"))
        nick = prop(save_parameter.get("NickName"))
        if not isinstance(nick, str) or not nick.strip():
            nick = None
        hunger_type = enum_tail(save_parameter.get("HungerType"))
        physical_health = enum_tail(save_parameter.get("PhysicalHealth"))
        worker_sick = enum_tail(save_parameter.get("WorkerSick"))
        worker_event = enum_tail(save_parameter.get("BaseCampWorkerEventType"))
        passives = name_list(save_parameter.get("PassiveSkillList"))
        is_rare = bool(prop(save_parameter.get("IsRarePal")))
        rank = byte_or_int(save_parameter.get("Rank"))
        if group_id:
            pals_by_group[group_id].append(species)

        pal = {
            "instanceId": instance_id,
            "species": species,
            "nickName": nick,
            "level": level,
            "hp": hp,
            "fullStomach": round(stomach, 1) if stomach is not None else None,
            "sanity": round(sanity, 1) if sanity is not None else None,
            "hungerType": hunger_type,
            "physicalHealth": physical_health,
            "workerSick": worker_sick,
            "workerEvent": worker_event,
            "passives": passives,
            "isRare": is_rare,
            "rank": rank,
            "ownerPlayerUid": owner_uid,
            "ownerName": None,
            "containerId": container_id,
            "slotIndex": slot_index,
            "groupId": group_id,
            "status": "idle",
        }
        if container_id:
            pals_by_container[container_id].append(pal)

    for pal_list in pals_by_container.values():
        for pal in pal_list:
            owner = players_by_uid.get(pal["ownerPlayerUid"] or "")
            if owner and owner.get("name"):
                pal["ownerName"] = owner["name"]

    items_by_container = extract_items_by_container(wsd)
    container_base_ids = extract_container_base_ids(wsd)

    bases: list[dict[str, Any]] = []
    for base_index, entry in enumerate(
        wsd.get("BaseCampSaveData", {}).get("value", []) or [],
        start=1,
    ):
        base_id = as_str(entry.get("key"))
        value = entry.get("value") or {}
        raw = prop(value.get("RawData"))
        if not isinstance(raw, dict):
            raw = {}
        transform = raw.get("transform") or {}
        translation = transform.get("translation") or {}
        worker_dir = prop(value.get("WorkerDirector")) or {}
        worker = prop(worker_dir.get("RawData")) if isinstance(worker_dir, dict) else {}
        if not isinstance(worker, dict):
            worker = {}
        worker_container = as_str(worker.get("container_id"))
        group_id = as_str(raw.get("group_id_belong_to"))
        raw_name = raw.get("name") if isinstance(raw.get("name"), str) else None

        owner_names: list[str] = []
        owner_uids: list[str] = []
        for player in players_by_uid.values():
            if group_id and player.get("groupId") == group_id:
                owner_uids.append(player["playerUid"])
                if player.get("name"):
                    owner_names.append(player["name"])

        pals = []
        for pal in pals_by_container.get(worker_container or "", []):
            status = classify_status(
                at_base=True,
                full_stomach=pal.get("fullStomach"),
                hunger_type=pal.get("hungerType"),
                physical_health=pal.get("physicalHealth"),
                worker_sick=pal.get("workerSick"),
                worker_event=pal.get("workerEvent"),
            )
            pals.append({**pal, "status": status})
        pals.sort(
            key=lambda p: (
                0 if p.get("status") in ("injured", "sick", "starving") else 1,
                p.get("species") or "",
                p.get("level") or 0,
            )
        )

        resources = resources_for_base(
            base_id,
            items_by_container=items_by_container,
            container_base_ids=container_base_ids,
        )

        bases.append(
            {
                "id": base_id,
                "name": soft_base_name(
                    raw_name, index=base_index, owner_names=owner_names
                ),
                "rawName": raw_name,
                "nameIsDefault": is_default_base_name(raw_name),
                "state": raw.get("state"),
                "areaRange": raw.get("area_range"),
                "groupId": group_id,
                "ownerNames": owner_names,
                "ownerPlayerUids": owner_uids,
                "location": {
                    "x": translation.get("x"),
                    "y": translation.get("y"),
                    "z": translation.get("z"),
                },
                "workerContainerId": worker_container,
                "palCount": len(pals),
                "pals": pals,
                "resourceCount": len(resources),
                "resources": resources,
            }
        )

    bases.sort(key=lambda b: (b.get("name") or "", b.get("id") or ""))

    header = getattr(gvas, "header", None)
    header_info = {}
    if isinstance(header, dict):
        header_info = {
            "saveGameVersion": header.get("save_game_version"),
            "engineVersion": {
                "major": header.get("engine_version_major"),
                "minor": header.get("engine_version_minor"),
                "patch": header.get("engine_version_patch"),
            },
        }
    elif header is not None:
        header_info = {
            "saveGameVersion": getattr(header, "save_game_version", None),
        }

    return {
        "ok": True,
        "source": {
            "levelSav": str(level_sav),
            "magic": magic,
            "saveType": save_type,
        },
        "header": header_info,
        "world": {
            "version": prop(props.get("Version")),
            "revision": prop(props.get("Revision")),
        },
        "players": list(players_by_uid.values()),
        "bases": bases,
        "stats": {
            "baseCount": len(bases),
            "playerCount": len(players_by_uid),
            "palAtBases": sum(b["palCount"] for b in bases),
            "resourceTypesAtBases": sum(b["resourceCount"] for b in bases),
        },
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "level_sav",
        type=Path,
        help="Path to a Level.sav copy (never the live file mid-write)",
    )
    args = parser.parse_args(argv)

    if not args.level_sav.is_file():
        fail("not_found", f"Level.sav not found: {args.level_sav}")

    try:
        report = extract_report(args.level_sav)
    except SystemExit:
        raise
    except Exception as err:
        fail(
            "internal_error",
            "Unexpected parser failure",
            details="".join(traceback.format_exception(err)),
        )

    print(json.dumps(report, separators=(",", ":"), default=str))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
