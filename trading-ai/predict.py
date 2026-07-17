"""Live next-candle prediction for a chosen interval."""

from __future__ import annotations

import json
import sys
from pathlib import Path

import joblib
import numpy as np
import pandas as pd

from data_loader import kite_candles_to_df, merge_auxiliary_features
from ensemble import predict_ensemble
from feature_engineering import FEATURE_COLUMNS, build_dataset
from inference import decode_proba, prediction_label, signal_threshold_for, trade_signal_for
from model_schema import SCHEMA_VERSION, align_features, get_model_feature_columns, schema_matches
from paths import (
    INTERVAL_MINUTES,
    horizon_key,
    legacy_model_path,
    model_path,
    normalize_interval,
)

ROOT = Path(__file__).resolve().parent


def resolve_model_path(interval: str) -> Path:
    current = model_path(interval)
    if current.exists():
        return current
    legacy = legacy_model_path(interval)
    if legacy.exists():
        return legacy
    raise FileNotFoundError(f"No trained model found for {interval}")


def _is_forming_bar(time_val, interval: str) -> bool:
    """True when the bar timestamp is the current (still open) interval bucket in IST."""
    from datetime import datetime
    from zoneinfo import ZoneInfo

    step = INTERVAL_MINUTES[normalize_interval(interval)]
    ist = ZoneInfo("Asia/Kolkata")
    now = datetime.now(ist)
    t = pd.Timestamp(time_val)
    if t.tz is None:
        t = t.tz_localize("Asia/Kolkata")
    else:
        t = t.tz_convert("Asia/Kolkata")

    now_bucket = now.replace(second=0, microsecond=0)
    if step > 1:
        now_bucket = now_bucket.replace(minute=(now_bucket.minute // step) * step)

    bar_bucket = t.replace(second=0, microsecond=0)
    if step > 1:
        bar_bucket = bar_bucket.replace(minute=(bar_bucket.minute // step) * step)

    return bar_bucket >= now_bucket


def pick_live_row(dataset, interval: str):
    """Predict from the last *closed* candle — skip the forming bar when present."""
    if dataset.empty:
        raise ValueError("Not enough history to compute features")
    if len(dataset) >= 2 and _is_forming_bar(dataset.iloc[-1]["time"], interval):
        return dataset.iloc[[-2]]
    return dataset.tail(1)


def build_live_row(payload: dict):
    interval = normalize_interval(payload.get("interval"))
    primary_id = payload.get("primaryId", "nifty_fut")
    snapshot = payload.get("liveSnapshot")
    instruments = payload.get("instruments", [])
    frames: dict = {}

    for item in instruments:
        df = kite_candles_to_df(item.get("candles", []))
        if not df.empty:
            frames[item["id"]] = df

    if primary_id not in frames:
        raise ValueError(f"Primary instrument '{primary_id}' missing")

    primary = frames.pop(primary_id)
    merged = merge_auxiliary_features(primary, frames)
    dataset = build_dataset(merged, snapshot)
    if dataset.empty:
        raise ValueError("Not enough history to compute features")
    return pick_live_row(dataset, interval)


def main() -> int:
    payload = json.loads(sys.stdin.read())
    interval = normalize_interval(payload.get("interval"))

    try:
        resolved = resolve_model_path(interval)
    except FileNotFoundError as exc:
        print(json.dumps({"error": str(exc)}))
        return 1

    latest = build_live_row(payload)
    bundle = joblib.load(resolved)

    if not schema_matches(bundle):
        print(
            json.dumps(
                {
                    "error": (
                        f"Saved model uses an outdated feature schema. "
                        f"Click Train model to retrain (schema v{SCHEMA_VERSION}, "
                        f"{len(FEATURE_COLUMNS)} features)."
                    )
                }
            )
        )
        return 1

    model_columns = get_model_feature_columns(bundle)
    X = align_features(latest, model_columns)

    if isinstance(bundle, dict) and "models" in bundle:
        proba = predict_ensemble(bundle, X)
    else:
        proba = bundle.predict_proba(X)[0]

    pred_class, down, flat, up = decode_proba(bundle, proba)
    signal = trade_signal_for(bundle, proba)
    threshold = signal_threshold_for(bundle)

    result = {
        "interval": interval,
        "prediction": prediction_label(bundle, pred_class),
        "class": pred_class,
        "probabilities": {
            "down": round(down, 4),
            "flat": round(flat, 4),
            "up": round(up, 4),
            "bearish": round(down, 4),
            "neutral": round(flat, 4),
            "bullish": round(up, 4),
        },
        "probGreen": round(up, 4),
        "signal": signal,
        "threshold": threshold,
        "horizon": horizon_key(interval),
        "features": {
            col: round(float(latest.iloc[0][col]), 6)
            for col in FEATURE_COLUMNS
            if col in latest.columns and not np.isnan(latest.iloc[0][col])
        },
        "liveSnapshot": payload.get("liveSnapshot"),
        "asOf": str(latest.iloc[0].get("time", "")),
    }
    print(json.dumps({"ok": True, "data": result}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
