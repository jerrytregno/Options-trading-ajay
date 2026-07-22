"""Single-pass threshold sweep for directional prediction intervals."""

from __future__ import annotations

import json
import sys

import joblib
import pandas as pd

from backtest_confidence_range import (
    BACKTEST_MIN_HISTORY_BARS,
    _confident_direction,
    _filter_candles,
    _in_nse_session,
    _ist_date,
)
from data_loader import kite_candles_to_df, merge_auxiliary_features
from ensemble import predict_ensemble
from feature_engineering import build_dataset
from inference import decode_proba
from model_schema import align_features, get_model_feature_columns, schema_matches
from paths import model_path, normalize_interval, raw_path

THRESHOLDS = [0.52, 0.55, 0.58, 0.60, 0.62, 0.65, 0.68, 0.70, 0.75, 0.80]
TARGET_HIT = 70.0
MIN_CALLS = 20


def main() -> int:
    interval = normalize_interval(sys.argv[1] if len(sys.argv) > 1 else "5minute")
    days = int(sys.argv[2]) if len(sys.argv) > 2 else 30

    raw_file = raw_path(interval)
    resolved = model_path(interval)
    if not raw_file.exists() or not resolved.exists():
        print(json.dumps({"error": f"Missing data or model for {interval}"}))
        return 1

    bundle = joblib.load(resolved)
    if not schema_matches(bundle):
        print(json.dumps({"error": "Model schema outdated"}))
        return 1

    raw_payload = json.loads(raw_file.read_text())
    primary_id = raw_payload.get("primaryId", "nifty_fut")
    primary = next(i for i in raw_payload["instruments"] if i["id"] == primary_id)
    all_dates = sorted({_ist_date(c[0]) for c in primary.get("candles", []) if c})
    target_dates = all_dates[-days:]
    model_columns = get_model_feature_columns(bundle)

    predictions: list[dict] = []
    for target_date in target_dates:
        instruments = []
        for item in raw_payload["instruments"]:
            sliced, history, target_bars = _filter_candles(item.get("candles", []), target_date)
            instruments.append({**item, "candles": sliced})
            if item["id"] == primary_id and (
                target_bars == 0 or history < BACKTEST_MIN_HISTORY_BARS
            ):
                instruments = []
                break
        if not instruments:
            continue

        frames: dict = {}
        for item in instruments:
            df = kite_candles_to_df(item.get("candles", []))
            if not df.empty:
                frames[item["id"]] = df
        if primary_id not in frames:
            continue

        primary_df = frames.pop(primary_id)
        merged = merge_auxiliary_features(primary_df, frames)
        dataset = build_dataset(merged)
        if dataset.empty:
            continue

        times = pd.to_datetime(dataset["time"])
        if times.dt.tz is None:
            times_ist = times.dt.tz_localize("Asia/Kolkata", ambiguous="NaT", nonexistent="NaT")
        else:
            times_ist = times.dt.tz_convert("Asia/Kolkata")

        target = pd.Timestamp(target_date).date()
        subset = dataset.loc[(times_ist.dt.date == target) & times_ist.map(_in_nse_session)].copy()
        for idx, row in subset.iterrows():
            if pd.isna(row.get("future_return")):
                continue
            X = align_features(subset.loc[[idx]], model_columns)
            proba = predict_ensemble(bundle, X)
            _, down, flat, up = decode_proba(bundle, proba)
            fr = float(row["future_return"])
            if fr > 0:
                actual = "up"
            elif fr < 0:
                actual = "down"
            else:
                actual = "flat"
            predictions.append(
                {
                    "date": target_date,
                    "time": str(row.get("time", "")),
                    "down": down,
                    "flat": flat,
                    "up": up,
                    "maxSide": max(down, up),
                    "actual": actual,
                }
            )

    sweep = []
    for threshold in THRESHOLDS:
        hits = misses = calls = 0
        for row in predictions:
            direction = _confident_direction(
                {"down": row["down"], "flat": row["flat"], "up": row["up"]},
                threshold,
            )
            if not direction or row["actual"] == "flat":
                continue
            calls += 1
            if row["actual"] == direction:
                hits += 1
            else:
                misses += 1
        hit_pct = round(hits / calls * 100, 2) if calls else None
        sweep.append(
            {
                "threshold": threshold,
                "thresholdPct": round(threshold * 100, 1),
                "calls": calls,
                "hits": hits,
                "misses": misses,
                "hitPct": hit_pct,
                "avgCallsPerDay": round(calls / max(1, len(target_dates)), 1),
            }
        )

    recommended = next(
        (
            row
            for row in sweep
            if row["calls"] >= MIN_CALLS and row["hitPct"] is not None and row["hitPct"] >= TARGET_HIT
        ),
        None,
    )
    if recommended is None:
        recommended = max(
            (row for row in sweep if row["calls"] >= MIN_CALLS),
            key=lambda r: (r["hitPct"] or 0, -r["threshold"]),
            default=sweep[0] if sweep else None,
        )

    max_probs = [r["maxSide"] for r in predictions]
    prob_stats = {
        "bars": len(predictions),
        "maxSideMedian": round(float(pd.Series(max_probs).median()), 4),
        "maxSideP90": round(float(pd.Series(max_probs).quantile(0.9)), 4),
        "maxSideMax": round(float(max(max_probs)), 4) if max_probs else 0,
        "pctAtOrAbove60": round(100 * sum(1 for v in max_probs if v >= 0.60) / max(1, len(max_probs)), 1),
        "pctAtOrAbove65": round(100 * sum(1 for v in max_probs if v >= 0.65) / max(1, len(max_probs)), 1),
        "pctAtOrAbove70": round(100 * sum(1 for v in max_probs if v >= 0.70) / max(1, len(max_probs)), 1),
        "pctAtOrAbove75": round(100 * sum(1 for v in max_probs if v >= 0.75) / max(1, len(max_probs)), 1),
    }

    print(
        json.dumps(
            {
                "ok": True,
                "interval": interval,
                "days": len(target_dates),
                "dateRange": {"from": target_dates[0], "to": target_dates[-1]} if target_dates else None,
                "probStats": prob_stats,
                "sweep": sweep,
                "recommended": recommended,
                "targetHitPct": TARGET_HIT,
                "minCalls": MIN_CALLS,
            },
            indent=2,
        )
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
