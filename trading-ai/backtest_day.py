"""Backtest ensemble predictions for every bar on a chosen day."""

from __future__ import annotations

import json
import sys
from pathlib import Path

import joblib
import numpy as np
import pandas as pd

from data_loader import kite_candles_to_df, merge_auxiliary_features
from ensemble import predict_ensemble
from feature_engineering import LABEL_MAP, build_dataset
from inference import decode_proba, prediction_label, trade_signal_for
from model_schema import align_features, get_model_feature_columns, schema_matches
from paths import INTERVAL_MINUTES, horizon_key, model_path, normalize_interval

ROOT = Path(__file__).resolve().parent


def _close_col(df: pd.DataFrame) -> str:
    return "nifty_close" if "nifty_close" in df.columns else "close"


def _in_nse_session(ts: pd.Timestamp) -> bool:
    if ts.tzinfo is None:
        ts = ts.tz_localize("Asia/Kolkata")
    else:
        ts = ts.tz_convert("Asia/Kolkata")
    minutes = ts.hour * 60 + ts.minute
    open_m = 9 * 60 + 15
    close_m = 15 * 60 + 30
    return open_m <= minutes <= close_m


def _actual_direction_from_return(future_ret) -> int | None:
    if future_ret is None or pd.isna(future_ret):
        return None
    r = float(future_ret)
    if r > 0:
        return 2
    if r < 0:
        return 0
    return 1


def _strict_match(pred_class: int, actual_class: int) -> bool:
    return pred_class == actual_class


def _is_acceptable_flat(pred_class: int, actual_class: int) -> bool:
    return pred_class == 1 and actual_class in (0, 2)


def _backtest_result(pred_class: int, actual_class: int | None, pending: bool = False) -> str:
    if pending:
        return "pending"
    if actual_class is None:
        return "unknown"
    if _strict_match(pred_class, actual_class):
        return "correct"
    if _is_acceptable_flat(pred_class, actual_class):
        return "acceptable"
    return "wrong"


def _directional_hit(pred_class: int, actual_class: int | None) -> bool | None:
    if actual_class is None:
        return None
    if pred_class == 2:
        return actual_class == 2
    if pred_class == 0:
        return actual_class == 0
    return None


def _parse_as_of(payload: dict) -> pd.Timestamp:
    raw = payload.get("asOf")
    if raw:
        as_of = pd.Timestamp(raw)
        if as_of.tzinfo is None:
            return as_of.tz_localize("Asia/Kolkata")
        return as_of.tz_convert("Asia/Kolkata")
    return pd.Timestamp.now(tz="Asia/Kolkata")


def _can_reveal_actual(
    ts: pd.Timestamp,
    live_today: bool,
    as_of: pd.Timestamp,
    interval_min: int,
) -> bool:
    if not live_today:
        return True
    if pd.isna(ts):
        return False
    next_ts = ts + pd.Timedelta(minutes=interval_min)
    return next_ts <= as_of


def main() -> int:
    payload = json.loads(sys.stdin.read())
    target_date = payload.get("targetDate")
    if not target_date:
        print(json.dumps({"error": "targetDate is required (YYYY-MM-DD)"}))
        return 1

    interval = normalize_interval(payload.get("interval"))
    interval_min = INTERVAL_MINUTES[interval]
    live_today = bool(payload.get("liveToday"))
    as_of = _parse_as_of(payload)

    resolved_model = model_path(interval)
    if not resolved_model.exists():
        print(json.dumps({"error": f"Model not trained for {interval}. Run Train model first."}))
        return 1

    bundle = joblib.load(resolved_model)
    if not schema_matches(bundle):
        print(json.dumps({"error": "Model schema outdated. Retrain first."}))
        return 1

    primary_id = payload.get("primaryId", "nifty_fut")
    instruments = payload.get("instruments", [])
    frames: dict = {}
    for item in instruments:
        df = kite_candles_to_df(item.get("candles", []))
        if not df.empty:
            frames[item["id"]] = df

    if primary_id not in frames:
        print(json.dumps({"error": "Primary Nifty future data missing for this date."}))
        return 1

    primary = frames.pop(primary_id)
    merged = merge_auxiliary_features(primary, frames)
    dataset = build_dataset(merged)

    if dataset.empty:
        print(json.dumps({"error": "Not enough data to build features."}))
        return 1

    times = pd.to_datetime(dataset["time"])
    if times.dt.tz is None:
        times_ist = times.dt.tz_localize("Asia/Kolkata", ambiguous="NaT", nonexistent="NaT")
    else:
        times_ist = times.dt.tz_convert("Asia/Kolkata")

    target = pd.Timestamp(target_date).date()
    day_mask = times_ist.dt.date == target
    session_mask = times_ist.map(_in_nse_session)
    subset = dataset.loc[day_mask & session_mask].copy()

    if subset.empty:
        if live_today:
            summary = {
                "date": target_date,
                "historyBars": payload.get("historyBars"),
                "interval": interval,
                "horizon": horizon_key(interval),
                "liveToday": live_today,
                "asOf": as_of.isoformat(),
                "revealedBars": 0,
                "pendingBars": 0,
                "bars": 0,
                "correctCount": 0,
                "wrongCount": 0,
                "acceptableCount": 0,
                "scoredCount": 0,
                "correctPct": 0,
                "wrongPct": 0,
                "acceptablePct": 0,
                "directionAccuracy": 0,
                "predFlatCount": 0,
                "predUpCount": 0,
                "predUpHit": 0,
                "predUpMiss": 0,
                "predUpHitPct": None,
                "predDownCount": 0,
                "predDownHit": 0,
                "predDownMiss": 0,
                "predDownHitPct": None,
                "directionalCount": 0,
                "directionalHit": 0,
                "directionalMiss": 0,
                "directionalHitPct": None,
                "signalCount": 0,
                "signalCorrect": 0,
                "signalWrong": 0,
                "signalCorrectPct": None,
                "signalWrongPct": None,
                "signalAccuracy": None,
                "waitingForSession": True,
            }
            print(json.dumps({"ok": True, "data": {"summary": summary, "bars": []}}))
            return 0
        print(json.dumps({"error": f"No NSE session {interval} bars found for {target_date}."}))
        return 1

    model_columns = get_model_feature_columns(bundle)
    close_key = _close_col(subset)
    bars = []
    correct = 0
    wrong = 0
    acceptable = 0
    signal_trades = 0
    signal_correct = 0
    pred_flat_count = 0
    pred_up_count = 0
    pred_up_hit = 0
    pred_down_count = 0
    pred_down_hit = 0
    revealed_count = 0
    pending_count = 0

    for idx, row in subset.iterrows():
        X = align_features(subset.loc[[idx]], model_columns)
        proba = predict_ensemble(bundle, X)
        pred_class, down, flat, up = decode_proba(bundle, proba)
        signal = trade_signal_for(bundle, proba)

        close_px = float(row[close_key])
        future_ret = row.get("future_return")
        ts = times_ist.loc[idx]
        bar_revealed = _can_reveal_actual(ts, live_today, as_of, interval_min)

        if bar_revealed and pd.notna(future_ret):
            actual_class = _actual_direction_from_return(future_ret)
            next_close = float(close_px * (1 + float(future_ret)))
            future_return_pct = round(float(future_ret) * 100, 4)
            revealed_count += 1
        else:
            actual_class = None
            next_close = None
            future_return_pct = None
            if live_today:
                pending_count += 1

        pending = live_today and not bar_revealed
        result = _backtest_result(pred_class, actual_class, pending=pending)
        strict = result == "correct"
        is_acceptable = result == "acceptable"

        if bar_revealed and pd.notna(future_ret):
            if strict:
                correct += 1
            elif is_acceptable:
                acceptable += 1
            else:
                wrong += 1

            directional_hit = _directional_hit(pred_class, actual_class)
            if pred_class == 2:
                pred_up_count += 1
                if directional_hit:
                    pred_up_hit += 1
            elif pred_class == 0:
                pred_down_count += 1
                if directional_hit:
                    pred_down_hit += 1
            elif pred_class == 1:
                pred_flat_count += 1

            if signal != "NO_TRADE":
                signal_trades += 1
                if actual_class is not None:
                    if signal == "BUY_CALL" and actual_class == 2:
                        signal_correct += 1
                    elif signal == "BUY_PUT" and actual_class == 0:
                        signal_correct += 1
        else:
            directional_hit = None

        bars.append(
            {
                "time": ts.isoformat() if pd.notna(ts) else str(row.get("time", "")),
                "timeLabel": ts.strftime("%H:%M") if pd.notna(ts) else "",
                "close": round(close_px, 2),
                "nextClose": round(next_close, 2) if next_close is not None else None,
                "futureReturnPct": future_return_pct,
                "prediction": prediction_label(bundle, pred_class),
                "probabilities": {
                    "down": round(down, 4),
                    "flat": round(flat, 4),
                    "up": round(up, 4),
                },
                "signal": signal,
                "actual": LABEL_MAP.get(actual_class, "unknown") if actual_class is not None else None,
                "actualClass": actual_class,
                "match": strict,
                "acceptable": is_acceptable,
                "result": result,
                "directionalHit": directional_hit,
                "revealed": bar_revealed and pd.notna(future_ret),
            }
        )

    total = len(bars)
    scored = correct + wrong
    directional_count = pred_up_count + pred_down_count
    directional_hit = pred_up_hit + pred_down_hit
    summary = {
        "date": target_date,
        "historyBars": payload.get("historyBars"),
        "interval": interval,
        "horizon": horizon_key(interval),
        "liveToday": live_today,
        "asOf": as_of.isoformat(),
        "revealedBars": revealed_count,
        "pendingBars": pending_count,
        "bars": total,
        "correctCount": correct,
        "wrongCount": wrong,
        "acceptableCount": acceptable,
        "scoredCount": scored,
        "correctPct": round(correct / scored * 100, 1) if scored else 0,
        "wrongPct": round(wrong / scored * 100, 1) if scored else 0,
        "acceptablePct": round(acceptable / total * 100, 1) if total else 0,
        "directionAccuracy": round(correct / scored, 4) if scored else 0,
        "predFlatCount": pred_flat_count,
        "predUpCount": pred_up_count,
        "predUpHit": pred_up_hit,
        "predUpMiss": pred_up_count - pred_up_hit,
        "predUpHitPct": round(pred_up_hit / pred_up_count * 100, 1) if pred_up_count else None,
        "predDownCount": pred_down_count,
        "predDownHit": pred_down_hit,
        "predDownMiss": pred_down_count - pred_down_hit,
        "predDownHitPct": round(pred_down_hit / pred_down_count * 100, 1) if pred_down_count else None,
        "directionalCount": directional_count,
        "directionalHit": directional_hit,
        "directionalMiss": directional_count - directional_hit,
        "directionalHitPct": round(directional_hit / directional_count * 100, 1) if directional_count else None,
        "signalCount": signal_trades,
        "signalCorrect": signal_correct,
        "signalWrong": signal_trades - signal_correct,
        "signalCorrectPct": round(signal_correct / signal_trades * 100, 1) if signal_trades else None,
        "signalWrongPct": round((signal_trades - signal_correct) / signal_trades * 100, 1) if signal_trades else None,
        "signalAccuracy": round(signal_correct / signal_trades, 4) if signal_trades else None,
    }

    print(json.dumps({"ok": True, "data": {"summary": summary, "bars": bars}}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
