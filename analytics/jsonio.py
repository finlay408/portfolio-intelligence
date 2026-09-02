"""
JSON encoding for analytics payloads.

Separate from `db.py` on purpose: turning numpy scalars, Decimals and
Timestamps into JSON has nothing to do with the database driver, and keeping it
here means the payload tools run without psycopg installed.

`allow_nan=False` is used at every call site. A NaN in a payload becomes the
literal `NaN` token, which is not valid JSON and which Postgres will reject —
better to fail loudly at the boundary than to store something no reader can
parse.
"""

from __future__ import annotations

import json
import math
from datetime import date, datetime
from decimal import Decimal
from typing import Any


class PayloadEncoder(json.JSONEncoder):
    def default(self, o: Any) -> Any:
        if isinstance(o, Decimal):
            return float(o)
        if isinstance(o, (datetime, date)):
            return str(o)[:10]
        # numpy scalars expose .item(); pandas Timestamps hit the branch above.
        if hasattr(o, "item"):
            value = o.item()
            return None if isinstance(value, float) and not math.isfinite(value) else value
        if isinstance(o, float) and not math.isfinite(o):
            return None
        return super().default(o)


def scrub(value: Any) -> Any:
    """
    Replace every non-finite float with null, recursively.

    NaN reaches a payload whenever a statistic is undefined — a Sharpe ratio on
    a zero-variance series, a correlation against a constant. Those are real
    outcomes, and `null` is how they should be stored; `allow_nan=False` would
    otherwise reject the whole payload for one of them.
    """
    if isinstance(value, float):
        return value if math.isfinite(value) else None
    if isinstance(value, dict):
        return {k: scrub(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [scrub(v) for v in value]
    if hasattr(value, "item") and not isinstance(value, (str, bytes)):
        try:
            return scrub(value.item())
        except (ValueError, AttributeError):
            return value
    return value


def dumps(payload: Any, **kwargs: Any) -> str:
    return json.dumps(scrub(payload), cls=PayloadEncoder, allow_nan=False, **kwargs)
