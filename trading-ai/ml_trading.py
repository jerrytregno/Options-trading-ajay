"""ML Trading — hourly NIFTY pattern library build + match (JSON stdin/stdout)."""

from __future__ import annotations

import json
import sys
from datetime import datetime, timezone

from hourly_pattern_lib import (
    build_day_patterns,
    load_library,
    match_all_patterns,
    save_library,
)
from ml_trading_paths import LIBRARY_PATH, RAW_CANDLES_PATH


def _emit(payload: dict) -> None:
    print(json.dumps(payload, default=str))


def main() -> int:
    try:
        raw = sys.stdin.read()
        payload = json.loads(raw) if raw.strip() else {}
        action = str(payload.get("action", "match")).lower()
        candles = payload.get("candles", [])
        top_k = int(payload.get("topK", 8))
        current_date = payload.get("currentDate")

        if action == "build":
            patterns = build_day_patterns(candles)
            save_library(LIBRARY_PATH, patterns)
            _emit(
                {
                    "ok": True,
                    "action": "build",
                    "patternCount": len(patterns),
                    "firstDate": patterns[0].date if patterns else None,
                    "lastDate": patterns[-1].date if patterns else None,
                    "libraryPath": str(LIBRARY_PATH),
                }
            )
            return 0

        if action == "match":
            if candles:
                patterns = build_day_patterns(candles)
            else:
                patterns = load_library(LIBRARY_PATH)
            result = match_all_patterns(patterns, current_date=current_date, top_k=top_k)
            _emit({"ok": True, "action": "match", "data": result})
            return 0

        if action == "status":
            patterns = load_library(LIBRARY_PATH)
            raw_exists = RAW_CANDLES_PATH.exists()
            _emit(
                {
                    "ok": True,
                    "action": "status",
                    "patternCount": len(patterns),
                    "firstDate": patterns[0].date if patterns else None,
                    "lastDate": patterns[-1].date if patterns else None,
                    "rawCached": raw_exists,
                    "libraryBuilt": len(patterns) > 0,
                }
            )
            return 0

        _emit({"ok": False, "error": f"Unknown action '{action}'"})
        return 1
    except Exception as exc:  # noqa: BLE001
        _emit({"ok": False, "error": str(exc), "at": datetime.now(timezone.utc).isoformat()})
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
