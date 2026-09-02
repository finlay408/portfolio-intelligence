"""
Load `.env` for the analytics jobs.

The Node scripts get this from `node --env-file-if-exists`. Python has no
equivalent, so without this `python analytics/run_nightly.py` fails with
"DATABASE_URL is not set" on a machine whose `.env` is perfectly correct —
which looks like a configuration problem and is really a missing loader.

Deliberately dependency-free. GitHub Actions supplies the environment from
repository secrets and has no `.env` at all, so a missing file is not an error,
and a variable already set in the real environment always wins over the file.
"""

from __future__ import annotations

import os
from pathlib import Path

# `.env.local` is loaded second so it overrides `.env`, matching Next.js.
CANDIDATES = (".env", ".env.local")


def _parse(text: str) -> dict[str, str]:
    values: dict[str, str] = {}
    for raw in text.splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        key = key.strip()
        if key.startswith("export "):
            key = key[len("export ") :].strip()
        value = value.strip()
        # Strip matching quotes, which a hand-edited file often has and which
        # would otherwise end up inside the connection string.
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
            value = value[1:-1]
        values[key] = value
    return values


def load(start: Path | None = None) -> list[str]:
    """
    Populate os.environ from the nearest `.env`, without overwriting anything
    already set. Returns the files that were read.
    """
    here = (start or Path(__file__).resolve().parent).resolve()
    # Walk up so the job works whether it is run from the repo root or from
    # inside analytics/.
    roots = [here, *here.parents]

    loaded: list[str] = []
    for name in CANDIDATES:
        for root in roots:
            path = root / name
            if not path.is_file():
                continue
            for key, value in _parse(path.read_text(encoding="utf-8")).items():
                # A real environment variable beats the file every time: that is
                # how CI overrides local settings.
                os.environ.setdefault(key, value)
            loaded.append(str(path))
            break
    return loaded
