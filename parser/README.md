# Save parser (Phase 3)

Read-only extract of bases + assigned pals from a **copied** `Level.sav`.

## Why a Python sidecar

Palworld 0.6+ saves use **PlM / Oodle** compression. Stock
`cheahjs/palworld-save-tools==0.24.0` only understands **PlZ / zlib**. We pin the
**MRHRTZ fork** + `pyooz` (see `requirements.txt`).

Node never parses GVAS itself — it copies the world folder, then runs:

```bash
$PALWORLD_PARSER_PYTHON parser/extract_bases.py /path/to/copy/Level.sav
```

Stdout is a single JSON object (`ok: true` report, or `ok: false` with an
`unsupported_save_version` / parse error). The live save is never written.

## Local setup

```bash
uv venv --python 3.12 .venv-save-tools
uv pip install --python .venv-save-tools/bin/python -r parser/requirements.txt
# pyooz comes in transitively from the MRHRTZ fork — do not also pin it.
```

## Docker

The image builds `/opt/parser-venv` from `requirements.txt` and sets
`PALWORLD_PARSER_PYTHON` accordingly.
