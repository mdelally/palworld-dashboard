#!/usr/bin/env python3
"""Prove the save WRITE path before any real migration touches a live save.

Loads a Level.sav, re-serializes it with the *same* custom-property set the
migration will use, recompresses it, then decompresses the result and asserts
the round-tripped GVAS is byte-identical to the original. If this passes, our
load -> edit -> save path is lossless and any later diff is purely our intended
UID edits. If it fails, the migration must not run (or must use the surgical
byte-rewrite fallback).

Read-only: writes nothing to the input .sav (works on a snapshot copy). Prints
one JSON object to stdout, mirroring extract_bases.py's contract.

Requires the MRHRTZ fork of palworld-save-tools (PlM/Oodle, Palworld 0.6+).
"""

from __future__ import annotations

import argparse
import json
import sys
import traceback
from pathlib import Path
from typing import Any

# The migration decodes exactly ONE map:
#   - CharacterSaveParameterMap: player character + owned pals (PlayerUId,
#     OwnerPlayerUId, OldOwnerPlayerUIds).
# GroupSaveDataMap is deliberately NOT decoded: this 0.6+ save's guild
# `player_info` layout desyncs the fork's group.py decoder (reads past EOF), the
# same reason extract_bases.py never decodes it. The migration re-points guild
# UIDs at the raw-byte level instead (see migrate_uid.py), so the group map
# round-trips as verbatim bytes here. Everything else (notably MapObjectSaveData,
# whose GuildSecurity module also dies on a full 0.6+ decode) is likewise raw.
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


def _select_properties(mode: str) -> dict[str, tuple]:
    from palworld_save_tools.paltypes import (
        DISABLED_PROPERTIES,
        PALWORLD_CUSTOM_PROPERTIES,
    )

    if mode == "full":
        # Parity with the fork's own resave_test: decode everything decodable.
        return {
            key: PALWORLD_CUSTOM_PROPERTIES[key]
            for key in PALWORLD_CUSTOM_PROPERTIES
            if key not in DISABLED_PROPERTIES
        }
    if mode == "migrate":
        return {
            key: PALWORLD_CUSTOM_PROPERTIES[key]
            for key in MIGRATE_KEYS
            if key in PALWORLD_CUSTOM_PROPERTIES and key not in DISABLED_PROPERTIES
        }
    raise ValueError(f"unknown property mode: {mode}")


def roundtrip(level_sav: Path, mode: str) -> dict[str, Any]:
    try:
        from palworld_save_tools.gvas import GvasFile
        from palworld_save_tools.palsav import (
            compress_gvas_to_sav,
            decompress_sav_to_gvas,
        )
        from palworld_save_tools.paltypes import PALWORLD_TYPE_HINTS
    except ImportError as err:
        fail(
            "parser_missing",
            "palworld-save-tools is not installed in the parser environment",
            details=str(err),
        )

    custom_properties = _select_properties(mode)

    data = level_sav.read_bytes()
    magic = data[8:11] if len(data) >= 11 else b""

    # 1. Decompress the original to raw GVAS bytes (the comparison baseline).
    try:
        with _StdoutToStderr():
            original_gvas, save_type = decompress_sav_to_gvas(data)
    except Exception as err:
        fail("decompress_failed", "Failed to decompress input Level.sav", details=str(err))

    # 2. Parse -> re-serialize with the SAME custom-property set (no edits).
    try:
        with _StdoutToStderr():
            gvas = GvasFile.read(
                original_gvas, PALWORLD_TYPE_HINTS, custom_properties, allow_nan=True
            )
    except Exception as err:
        fail(
            "parse_failed",
            f"Failed to parse GVAS with the '{mode}' property set",
            details="".join(traceback.format_exception(err)),
        )
    try:
        with _StdoutToStderr():
            resaved_gvas = gvas.write(custom_properties)
    except Exception as err:
        fail(
            "write_failed",
            f"Failed to re-serialize GVAS with the '{mode}' property set",
            details="".join(traceback.format_exception(err)),
        )

    # 3. Recompress -> decompress, then compare at the GVAS level. (Compression
    #    itself need not be byte-deterministic; the decompressed GVAS must be.)
    try:
        with _StdoutToStderr():
            resaved_sav = compress_gvas_to_sav(resaved_gvas, save_type, zlib=False)
            roundtripped_gvas, _ = decompress_sav_to_gvas(resaved_sav)
    except Exception as err:
        fail("recompress_failed", "Failed to recompress/redecompress", details=str(err))

    identical = original_gvas == roundtripped_gvas
    first_diff = None
    if not identical:
        n = min(len(original_gvas), len(roundtripped_gvas))
        for i in range(n):
            if original_gvas[i] != roundtripped_gvas[i]:
                first_diff = i
                break
        if first_diff is None:
            first_diff = n  # one is a prefix of the other (length mismatch)

    return {
        "ok": True,
        "identical": identical,
        "mode": mode,
        "source": {
            "levelSav": str(level_sav),
            "magic": magic.decode("ascii", errors="replace"),
            "saveType": save_type,
        },
        "sizes": {
            "original": len(original_gvas),
            "roundtripped": len(roundtripped_gvas),
            "recompressedSav": len(resaved_sav),
        },
        "firstDiffOffset": first_diff,
        "decodedProperties": sorted(custom_properties.keys()),
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "level_sav",
        type=Path,
        help="Path to a Level.sav copy (never the live file mid-write)",
    )
    parser.add_argument(
        "--set",
        dest="mode",
        choices=("migrate", "full"),
        default="migrate",
        help="Which custom-property set to exercise (default: migrate)",
    )
    args = parser.parse_args(argv)

    if not args.level_sav.is_file():
        fail("not_found", f"Level.sav not found: {args.level_sav}")

    try:
        report = roundtrip(args.level_sav, args.mode)
    except SystemExit:
        raise
    except Exception as err:
        fail(
            "internal_error",
            "Unexpected round-trip failure",
            details="".join(traceback.format_exception(err)),
        )

    print(json.dumps(report, separators=(",", ":"), default=str))
    # Non-zero exit when not byte-identical, so callers can gate on the process code.
    return 0 if report.get("identical") else 3


if __name__ == "__main__":
    raise SystemExit(main())
