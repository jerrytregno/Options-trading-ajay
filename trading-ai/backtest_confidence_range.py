"""Backtest high-confidence directional calls over the last N trading days."""

from __future__ import annotations

import json
import sys
from pathlib import Path

import joblib
import pandas as pd

from data_loader import kite_candles_to_df, merge_auxiliary_features
from ensemble import predict_ensemble
from feature_engineering import LABEL_MAP, build_dataset
from inference import decode_proba, is_directional_bundle
from model_schema import align_features, get_model_feature_columns, schema_matches
from paths import model_path, normalize_interval, raw_path

ROOT = Path(__file__).resolve().parent
BACKTEST_MIN_HISTORY_BARS = 21


def _ist_date(ts) -> str:
    t = pd.Timestamp(ts)
    if t.tzinfo is None:
        t = t.tz_localize("Asia/Kolkata")
    else:
        t = t.tz_convert("Asia/Kolkata")
    return t.strftime("%Y-%m-%d")


def _in_nse_session(ts: pd.Timestamp) -> bool:
    if ts.tzinfo is None:
        ts = ts.tz_localize("Asia/Kolkata")
    else:
        ts = ts.tz_convert("Asia/Kolkata")
    minutes = ts.hour * 60 + ts.minute
    return 9 * 60 + 15 <= minutes <= 15 * 60 + 30


def _actual_label(future_ret) -> str | None:
    if future_ret is None or pd.isna(future_ret):
        return None
    r = float(future_ret)
    if r > 0:
        return "up"
    if r < 0:
        return "down"
    return "flat"


def _filter_candles(candles: list, target_date: str) -> tuple[list, int, int]:
    kept: list = []
    history = 0
    target = 0
    for candle in candles:
        if not isinstance(candle, list) or candle[0] is None:
            continue
        day = _ist_date(candle[0])
        if day < target_date:
            kept.append(candle)
            history += 1
        elif day == target_date:
            kept.append(candle)
            target += 1
    return kept, history, target


def _confident_direction(probs: dict, threshold: float) -> str | None:
    down, flat, up = probs["down"], probs["flat"], probs["up"]
    if up >= threshold and up > down and up - flat >= 0:
        return "up"
    if down >= threshold and down > up and down - flat >= 0:
        return "down"
    return None


def _trading_dates(raw_payload: dict, primary_id: str) -> list[str]:
    primary = next(i for i in raw_payload["instruments"] if i["id"] == primary_id)
    dates = sorted({_ist_date(c[0]) for c in primary.get("candles", []) if c})
    return dates


def backtest_day(
    bundle,
    model_columns,
    raw_payload: dict,
    target_date: str,
    threshold: float,
) -> dict:
    primary_id = raw_payload.get("primaryId", "nifty_fut")
    instruments = []
    for item in raw_payload["instruments"]:
        sliced, history, target_bars = _filter_candles(item.get("candles", []), target_date)
        instruments.append({**item, "candles": sliced, "barCount": len(sliced)})
        if item["id"] == primary_id and (target_bars == 0 or history < BACKTEST_MIN_HISTORY_BARS):
            return {"skipped": True, "reason": "insufficient_bars", "history": history, "targetBars": target_bars}

    frames: dict = {}
    for item in instruments:
        df = kite_candles_to_df(item.get("candles", []))
        if not df.empty:
            frames[item["id"]] = df

    if primary_id not in frames:
        return {"skipped": True, "reason": "missing_primary"}

    primary = frames.pop(primary_id)
    merged = merge_auxiliary_features(primary, frames)
    dataset = build_dataset(merged)
    if dataset.empty:
        return {"skipped": True, "reason": "empty_dataset"}

    times = pd.to_datetime(dataset["time"])
    if times.dt.tz is None:
        times_ist = times.dt.tz_localize("Asia/Kolkata", ambiguous="NaT", nonexistent="NaT")
    else:
        times_ist = times.dt.tz_convert("Asia/Kolkata")

    target = pd.Timestamp(target_date).date()
    subset = dataset.loc[(times_ist.dt.date == target) & times_ist.map(_in_nse_session)].copy()
    if subset.empty:
        return {"skipped": True, "reason": "no_session_bars"}

    hits = misses = calls = 0
    up_calls = up_hits = down_calls = down_hits = 0

    for idx, row in subset.iterrows():
        if pd.isna(row.get("future_return")):
            continue
        X = align_features(subset.loc[[idx]], model_columns)
        proba = predict_ensemble(bundle, X)
        _, down, flat, up = decode_proba(bundle, proba)
        probs = {"down": down, "flat": flat, "up": up}
        direction = _confident_direction(probs, threshold)
        if not direction:
            continue

        actual = _actual_label(row.get("future_return"))
        if not actual or actual == "flat":
            continue

        calls += 1
        matched = actual == direction
        if matched:
            hits += 1
        else:
            misses += 1

        if direction == "up":
            up_calls += 1
            if matched:
                up_hits += 1
        else:
            down_calls += 1
            if matched:
                down_hits += 1

    return {
        "skipped": False,
        "date": target_date,
        "calls": calls,
        "hits": hits,
        "misses": misses,
        "hitPct": round(hits / calls * 100, 1) if calls else None,
        "upCalls": up_calls,
        "upHits": up_hits,
        "downCalls": down_calls,
        "downHits": down_hits,
    }


def main() -> int:
    interval = normalize_interval(sys.argv[1] if len(sys.argv) > 1 else "minute")
    days = int(sys.argv[2]) if len(sys.argv) > 2 else 30
    threshold = float(sys.argv[3]) if len(sys.argv) > 3 else 0.85

    raw_file = raw_path(interval)
    if not raw_file.exists():
        print(json.dumps({"error": f"No training data for {interval}"}))
        return 1

    resolved = model_path(interval)
    if not resolved.exists():
        print(json.dumps({"error": f"No model for {interval}. Train first."}))
        return 1

    bundle = joblib.load(resolved)
    if not schema_matches(bundle):
        print(json.dumps({"error": "Model schema outdated. Retrain first."}))
        return 1

    raw_payload = json.loads(raw_file.read_text())
    primary_id = raw_payload.get("primaryId", "nifty_fut")
    all_dates = _trading_dates(raw_payload, primary_id)
    if not all_dates:
        print(json.dumps({"error": "No trading dates in dataset"}))
        return 1

    target_dates = all_dates[-days:]
    model_columns = get_model_feature_columns(bundle)

    day_results = []
    total_hits = total_misses = total_calls = 0
    total_up_calls = total_up_hits = total_down_calls = total_down_hits = 0
    skipped = []

    for date in target_dates:
        result = backtest_day(bundle, model_columns, raw_payload, date, threshold)
        if result.get("skipped"):
            skipped.append({"date": date, **result})
            continue
        day_results.append(result)
        total_calls += result["calls"]
        total_hits += result["hits"]
        total_misses += result["misses"]
        total_up_calls += result["upCalls"]
        total_up_hits += result["upHits"]
        total_down_calls += result["downCalls"]
        total_down_hits += result["downHits"]

    summary = {
        "interval": interval,
        "threshold": threshold,
        "flatMargin": 0,
        "modelType": bundle.get("modelType"),
        "schemaVersion": bundle.get("schemaVersion"),
        "directionalBinary": is_directional_bundle(bundle),
        "requestedDays": days,
        "tradingDaysAvailable": len(all_dates),
        "dateRange": {"from": target_dates[0], "to": target_dates[-1]} if target_dates else None,
        "daysTested": len(day_results),
        "daysSkipped": len(skipped),
        "totalCalls": total_calls,
        "totalHits": total_hits,
        "totalMisses": total_misses,
        "hitPct": round(total_hits / total_calls * 100, 2) if total_calls else None,
        "upCalls": total_up_calls,
        "upHits": total_up_hits,
        "upHitPct": round(total_up_hits / total_up_calls * 100, 2) if total_up_calls else None,
        "downCalls": total_down_calls,
        "downHits": total_down_hits,
        "downHitPct": round(total_down_hits / total_down_calls * 100, 2) if total_down_calls else None,
        "avgCallsPerDay": round(total_calls / len(day_results), 1) if day_results else 0,
        "daysWithCalls": sum(1 for d in day_results if d["calls"] > 0),
    }

    print(json.dumps({"ok": True, "summary": summary, "days": day_results, "skipped": skipped}, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
