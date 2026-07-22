"""Build daily hourly NIFTY patterns and match against historical shapes."""

from __future__ import annotations

import json
from dataclasses import asdict, dataclass
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any

import numpy as np
import pandas as pd

from data_loader import kite_candles_to_df


@dataclass
class HourSlot:
    time: str
    hour_label: str
    open: float
    high: float
    low: float
    close: float
    high_pct: float
    low_pct: float
    close_pct: float


@dataclass
class DayPattern:
    date: str
    day_open: float
    day_close: float
    day_high: float
    day_low: float
    day_return_pct: float
    outcome: str
    bar_count: int
    slots: list[HourSlot]
    vector: list[float]


def _to_ist_date(ts: pd.Timestamp) -> str:
    if ts.tzinfo is None:
        ts = ts.tz_localize("UTC")
    return ts.tz_convert("Asia/Kolkata").strftime("%Y-%m-%d")


def _hour_label(ts: pd.Timestamp) -> str:
    if ts.tzinfo is None:
        ts = ts.tz_localize("UTC")
    local = ts.tz_convert("Asia/Kolkata")
    return local.strftime("%H:%M")


def _outcome_from_return(ret_pct: float, threshold: float = 0.05) -> str:
    if ret_pct >= threshold:
        return "bullish"
    if ret_pct <= -threshold:
        return "bearish"
    return "neutral"


def _slot_vector(slots: list[HourSlot], up_to: int | None = None) -> np.ndarray:
    end = len(slots) if up_to is None else min(up_to, len(slots))
    if end <= 0:
        return np.array([], dtype=float)
    parts: list[float] = []
    for slot in slots[:end]:
        parts.extend([slot.high_pct, slot.low_pct, slot.close_pct])
    return np.asarray(parts, dtype=float)


def _cosine_similarity(a: np.ndarray, b: np.ndarray) -> float:
    if a.size == 0 or b.size == 0 or a.shape != b.shape:
        return 0.0
    na = np.linalg.norm(a)
    nb = np.linalg.norm(b)
    if na == 0 or nb == 0:
        return 1.0 if np.allclose(a, b) else 0.0
    return float(np.dot(a, b) / (na * nb))


def _similarity_score(a: np.ndarray, b: np.ndarray) -> float:
    """Cosine on aligned prefix; falls back to distance-based score so we always rank closest."""
    if a.size == 0 or b.size == 0:
        return 0.0
    n = min(a.size, b.size)
    aligned_a = a[:n]
    aligned_b = b[:n]
    cos = _cosine_similarity(aligned_a, aligned_b)
    if cos > 0:
        return cos
    diff = aligned_a - aligned_b
    dist = float(np.linalg.norm(diff))
    scale = float(np.linalg.norm(aligned_a) + np.linalg.norm(aligned_b)) or 1.0
    return max(0.0001, 1.0 / (1.0 + dist / scale))


def build_day_patterns(candles: list) -> list[DayPattern]:
    df = kite_candles_to_df(candles)
    if df.empty:
        return []

    df = df.copy()
    df["session_date"] = df["time"].apply(_to_ist_date)
    patterns: list[DayPattern] = []

    for session_date, group in df.groupby("session_date", sort=True):
        day = group.sort_values("time")
        if len(day) < 2:
            continue

        day_open = float(day.iloc[0]["open"])
        if day_open <= 0:
            continue

        day_close = float(day.iloc[-1]["close"])
        day_high = float(day["high"].max())
        day_low = float(day["low"].min())
        day_return_pct = (day_close - day_open) / day_open * 100.0

        slots: list[HourSlot] = []
        for _, row in day.iterrows():
            slots.append(
                HourSlot(
                    time=str(row["time"]),
                    hour_label=_hour_label(pd.Timestamp(row["time"])),
                    open=float(row["open"]),
                    high=float(row["high"]),
                    low=float(row["low"]),
                    close=float(row["close"]),
                    high_pct=(float(row["high"]) - day_open) / day_open * 100.0,
                    low_pct=(float(row["low"]) - day_open) / day_open * 100.0,
                    close_pct=(float(row["close"]) - day_open) / day_open * 100.0,
                )
            )

        vector = _slot_vector(slots).tolist()
        patterns.append(
            DayPattern(
                date=str(session_date),
                day_open=round(day_open, 2),
                day_close=round(day_close, 2),
                day_high=round(day_high, 2),
                day_low=round(day_low, 2),
                day_return_pct=round(day_return_pct, 3),
                outcome=_outcome_from_return(day_return_pct),
                bar_count=len(slots),
                slots=slots,
                vector=vector,
            )
        )

    return patterns


def serialize_library(patterns: list[DayPattern]) -> dict[str, Any]:
    return {
        "version": 1,
        "patternCount": len(patterns),
        "patterns": [asdict(p) for p in patterns],
    }


def deserialize_library(payload: dict[str, Any]) -> list[DayPattern]:
    patterns: list[DayPattern] = []
    for raw in payload.get("patterns", []):
        slots = [HourSlot(**slot) for slot in raw.get("slots", [])]
        patterns.append(
            DayPattern(
                date=str(raw["date"]),
                day_open=float(raw["day_open"]),
                day_close=float(raw["day_close"]),
                day_high=float(raw["day_high"]),
                day_low=float(raw["day_low"]),
                day_return_pct=float(raw["day_return_pct"]),
                outcome=str(raw["outcome"]),
                bar_count=int(raw["bar_count"]),
                slots=slots,
                vector=[float(v) for v in raw.get("vector", [])],
            )
        )
    return patterns


def save_library(path: Path, patterns: list[DayPattern]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(serialize_library(patterns), indent=2))


def load_library(path: Path) -> list[DayPattern]:
    if not path.exists():
        return []
    payload = json.loads(path.read_text())
    return deserialize_library(payload)


def _week_id(date_str: str) -> str:
    ts = pd.Timestamp(f"{date_str}T12:00:00", tz="Asia/Kolkata")
    iso = ts.isocalendar()
    return f"{iso.year}-W{iso.week:02d}"


def _weekday_index(date_str: str) -> int:
    ts = pd.Timestamp(f"{date_str}T12:00:00", tz="Asia/Kolkata")
    return int(ts.weekday())


def _patterns_for_week(patterns: list[DayPattern], week_id: str) -> list[DayPattern]:
    return sorted([p for p in patterns if _week_id(p.date) == week_id], key=lambda p: p.date)


def _reference_session_hours(patterns: list[DayPattern]) -> list[str]:
    if not patterns:
        return []
    best = max(patterns, key=lambda p: p.bar_count)
    return [slot.hour_label for slot in best.slots]


def _session_bar_count(patterns: list[DayPattern]) -> int:
    return len(_reference_session_hours(patterns))


def _synthesize_day_pattern(
    today: DayPattern,
    hour_predictions: list[dict[str, Any]],
    session_hours: list[str],
    session_bars: int,
) -> DayPattern:
    """Build a full-session day pattern using actual bars + predicted hours."""
    day_open = today.day_open
    slots: list[HourSlot] = []

    for index in range(session_bars):
        if index < len(today.slots):
            slots.append(today.slots[index])
            continue

        pred = hour_predictions[index] if index < len(hour_predictions) else {}
        hour_label = (
            str(pred.get("hourLabel"))
            if pred.get("hourLabel")
            else (session_hours[index] if index < len(session_hours) else f"slot-{index}")
        )
        open_px = float(pred.get("predOpen") or pred.get("open") or (slots[-1].close if slots else day_open))
        high_px = float(pred.get("predHigh") or open_px)
        low_px = float(pred.get("predLow") or open_px)
        close_px = float(pred.get("predClose") or open_px)
        slots.append(
            HourSlot(
                time=f"{today.date}T{hour_label}:00+05:30",
                hour_label=hour_label,
                open=open_px,
                high=high_px,
                low=low_px,
                close=close_px,
                high_pct=(high_px - day_open) / day_open * 100.0 if day_open > 0 else 0.0,
                low_pct=(low_px - day_open) / day_open * 100.0 if day_open > 0 else 0.0,
                close_pct=(close_px - day_open) / day_open * 100.0 if day_open > 0 else 0.0,
            )
        )

    if not slots:
        return today

    day_close = float(slots[-1].close)
    day_high = max(s.high for s in slots)
    day_low = min(s.low for s in slots)
    day_return_pct = (day_close - day_open) / day_open * 100.0 if day_open > 0 else 0.0

    return DayPattern(
        date=today.date,
        day_open=round(day_open, 2),
        day_close=round(day_close, 2),
        day_high=round(day_high, 2),
        day_low=round(day_low, 2),
        day_return_pct=round(day_return_pct, 3),
        outcome=_outcome_from_return(day_return_pct),
        bar_count=len(slots),
        slots=slots,
        vector=_slot_vector(slots).tolist(),
    )


def _build_week_partial_vector(
    week_days: list[DayPattern],
    last_day_bars: int | None = None,
) -> tuple[np.ndarray, float]:
    if not week_days:
        return np.array([], dtype=float), 0.0

    week_open = week_days[0].day_open
    if week_open <= 0:
        return np.array([], dtype=float), 0.0

    parts: list[float] = []
    for index, day in enumerate(week_days):
        is_last = index == len(week_days) - 1
        limit = len(day.slots) if not is_last else (last_day_bars or len(day.slots))
        for slot in day.slots[:limit]:
            parts.extend(
                [
                    (slot.high - week_open) / week_open * 100.0,
                    (slot.low - week_open) / week_open * 100.0,
                    (slot.close - week_open) / week_open * 100.0,
                ]
            )
    return np.asarray(parts, dtype=float), week_open


def _hour_bias(open_px: float, close_px: float, threshold: float = 0.02) -> str:
    if open_px <= 0:
        return "neutral"
    move_pct = (close_px - open_px) / open_px * 100.0
    return _outcome_from_return(move_pct, threshold)


def _predict_full_day_hours(
    today_pattern: DayPattern,
    week_matches: list[dict[str, Any]],
    session_hours: list[str],
) -> list[dict[str, Any]]:
    actual_count = today_pattern.bar_count
    day_open = today_pattern.day_open
    last_actual_close = today_pattern.slots[actual_count - 1].close if actual_count else day_open
    predictions: list[dict[str, Any]] = []

    for hour_index, hour_label in enumerate(session_hours):
        if hour_index < actual_count and hour_index < len(today_pattern.slots):
            slot = today_pattern.slots[hour_index]
            predictions.append(
                {
                    "hourLabel": hour_label,
                    "hourIndex": hour_index,
                    "status": "actual",
                    "open": round(slot.open, 2),
                    "high": round(slot.high, 2),
                    "low": round(slot.low, 2),
                    "close": round(slot.close, 2),
                    "predOpen": round(slot.open, 2),
                    "predHigh": round(slot.high, 2),
                    "predLow": round(slot.low, 2),
                    "predClose": round(slot.close, 2),
                    "hourBias": _hour_bias(slot.open, slot.close),
                    "confidence": 1.0,
                }
            )
            last_actual_close = slot.close
            continue

        weighted_open = 0.0
        weighted_high = 0.0
        weighted_low = 0.0
        weighted_close = 0.0
        weight_sum = 0.0
        bullish_w = 0.0
        bearish_w = 0.0

        for match in week_matches:
            analog_slots = match.get("todayAnalogFullDaySlots") or []
            if hour_index >= len(analog_slots):
                continue
            slot = analog_slots[hour_index]
            weight = float(match.get("similarity", 0))
            if weight <= 0:
                continue
            open_px = float(slot.get("open", slot.get("close", 0)))
            high_px = float(slot.get("high", 0))
            low_px = float(slot.get("low", 0))
            close_px = float(slot.get("close", 0))
            weighted_open += open_px * weight
            weighted_high += high_px * weight
            weighted_low += low_px * weight
            weighted_close += close_px * weight
            weight_sum += weight
            bias = _hour_bias(open_px, close_px)
            if bias == "bullish":
                bullish_w += weight
            elif bias == "bearish":
                bearish_w += weight

        if weight_sum <= 0:
            pred_open = last_actual_close
            predictions.append(
                {
                    "hourLabel": hour_label,
                    "hourIndex": hour_index,
                    "status": "pending",
                    "open": None,
                    "high": None,
                    "low": None,
                    "close": None,
                    "predOpen": round(pred_open, 2),
                    "predHigh": None,
                    "predLow": None,
                    "predClose": None,
                    "hourBias": "neutral",
                    "confidence": 0.0,
                }
            )
            continue

        pred_open = weighted_open / weight_sum
        pred_high = weighted_high / weight_sum
        pred_low = weighted_low / weight_sum
        pred_close = weighted_close / weight_sum
        if hour_index == actual_count:
            pred_open = last_actual_close
        bias = _hour_bias(pred_open, pred_close)
        confidence = max(bullish_w, bearish_w, weight_sum - bullish_w - bearish_w) / weight_sum

        predictions.append(
            {
                "hourLabel": hour_label,
                "hourIndex": hour_index,
                "status": "predicted",
                "open": None,
                "high": None,
                "low": None,
                "close": None,
                "predOpen": round(pred_open, 2),
                "predHigh": round(pred_high, 2),
                "predLow": round(pred_low, 2),
                "predClose": round(pred_close, 2),
                "hourBias": bias,
                "confidence": round(confidence, 4),
            }
        )
        last_actual_close = pred_close

    return predictions


def _fallback_week_matches_from_weekday(
    sorted_patterns: list[DayPattern],
    today: str,
    today_pattern: DayPattern,
    today_weekday: int,
    compare_bars: int,
    top_k: int,
) -> list[dict[str, Any]]:
    """Closest historical same-weekday days when strict week alignment finds nothing."""
    candidates: list[dict[str, Any]] = []

    for candidate in sorted_patterns:
        if candidate.date == today:
            continue
        if _weekday_index(candidate.date) != today_weekday:
            continue
        n = min(compare_bars, candidate.bar_count, len(today_pattern.slots))
        if n < 1:
            continue
        hist = _slot_vector(candidate.slots, n)
        q = _slot_vector(today_pattern.slots, n)
        similarity = _similarity_score(q, hist)
        candidates.append(
            {
                "weekId": _week_id(candidate.date),
                "similarity": round(similarity, 4),
                "weekStart": _patterns_for_week(sorted_patterns, _week_id(candidate.date))[0].date
                if _patterns_for_week(sorted_patterns, _week_id(candidate.date))
                else candidate.date,
                "weekDaysMatched": [candidate.date],
                "todayAnalogDate": candidate.date,
                "todayAnalogOutcome": candidate.outcome,
                "todayAnalogDayReturnPct": candidate.day_return_pct,
                "todayAnalogFullDaySlots": [asdict(s) for s in candidate.slots],
                "closestFallback": True,
            }
        )

    candidates.sort(key=lambda item: item["similarity"], reverse=True)
    return candidates[:top_k]


def _collect_week_match_candidates(
    sorted_patterns: list[DayPattern],
    current_week_id: str,
    current_week_days: list[DayPattern],
    today: str,
    today_weekday: int,
    compare_bars: int,
) -> list[dict[str, Any]]:
    query, _ = _build_week_partial_vector(current_week_days, compare_bars)
    if query.size == 0:
        return []

    week_ids = sorted({_week_id(p.date) for p in sorted_patterns if _week_id(p.date) != current_week_id})
    week_matches: list[dict[str, Any]] = []

    for week_id in week_ids:
        hist_days = _patterns_for_week(sorted_patterns, week_id)
        analog_day = next((d for d in hist_days if _weekday_index(d.date) == today_weekday), None)
        if analog_day is None:
            continue

        hist_through = [d for d in hist_days if d.date <= analog_day.date]
        if not hist_through:
            continue

        slice_len = min(len(current_week_days), len(hist_through))
        if slice_len < 1:
            continue

        curr_slice = current_week_days[-slice_len:]
        hist_slice = hist_through[-slice_len:]
        hist_vector, _ = _build_week_partial_vector(hist_slice, compare_bars)
        curr_vector, _ = _build_week_partial_vector(curr_slice, compare_bars)
        similarity = _similarity_score(curr_vector, hist_vector)

        week_matches.append(
            {
                "weekId": week_id,
                "similarity": round(similarity, 4),
                "weekStart": hist_days[0].date,
                "weekDaysMatched": [d.date for d in hist_slice],
                "todayAnalogDate": analog_day.date,
                "todayAnalogOutcome": analog_day.outcome,
                "todayAnalogDayReturnPct": analog_day.day_return_pct,
                "todayAnalogFullDaySlots": [asdict(s) for s in analog_day.slots],
                "closestFallback": False,
            }
        )

    week_matches.sort(key=lambda item: item["similarity"], reverse=True)
    return week_matches


def match_week_and_predict_today(
    patterns: list[DayPattern],
    current_date: str | None = None,
    top_k: int = 8,
) -> dict[str, Any]:
    if not patterns:
        raise ValueError("Pattern library is empty — sync hourly data first")

    sorted_patterns = sorted(patterns, key=lambda p: p.date)
    today = current_date or sorted_patterns[-1].date
    today_pattern = next((p for p in sorted_patterns if p.date == today), sorted_patterns[-1])
    session_hours = _reference_session_hours(sorted_patterns)
    session_bars = len(session_hours)
    compare_bars = today_pattern.bar_count
    if compare_bars < 1:
        raise ValueError("Not enough hourly candles for today to build a pattern")

    current_week_id = _week_id(today)
    current_week_days = _patterns_for_week(sorted_patterns, current_week_id)
    current_week_days = [d for d in current_week_days if d.date <= today]
    if not current_week_days:
        current_week_days = [today_pattern]

    today_weekday = _weekday_index(today)

    # Week-to-date uses actual bars today; prior days in the week use full session.
    query, week_open = _build_week_partial_vector(current_week_days, compare_bars)
    if query.size == 0:
        raise ValueError("Could not build current week pattern")

    week_matches = _collect_week_match_candidates(
        sorted_patterns,
        current_week_id,
        current_week_days,
        today,
        today_weekday,
        compare_bars,
    )
    used_closest_fallback = False
    if not week_matches:
        week_matches = _fallback_week_matches_from_weekday(
            sorted_patterns,
            today,
            today_pattern,
            today_weekday,
            compare_bars,
            top_k * 3,
        )
        used_closest_fallback = bool(week_matches)

    top_week_matches = week_matches[:top_k]
    if not top_week_matches:
        raise ValueError("No historical data available to find a closest week pattern")

    best_similarity = top_week_matches[0]["similarity"]
    used_closest_fallback = (
        used_closest_fallback
        or any(m.get("closestFallback") for m in top_week_matches)
        or best_similarity < 0.35
    )

    session_hours = _reference_session_hours(sorted_patterns)
    hour_predictions = _predict_full_day_hours(today_pattern, top_week_matches, session_hours)

    weights = np.array([max(m["similarity"], 0.0001) for m in top_week_matches], dtype=float)
    weight_sum = float(weights.sum()) or 1.0
    bullish_w = sum(m["similarity"] for m in top_week_matches if m["todayAnalogOutcome"] == "bullish")
    bearish_w = sum(m["similarity"] for m in top_week_matches if m["todayAnalogOutcome"] == "bearish")
    neutral_w = sum(m["similarity"] for m in top_week_matches if m["todayAnalogOutcome"] == "neutral")
    avg_day_return = (
        sum(m["todayAnalogDayReturnPct"] * m["similarity"] for m in top_week_matches) / weight_sum
    )

    if bullish_w >= bearish_w and bullish_w >= neutral_w:
        prediction = "bullish"
    elif bearish_w >= bullish_w and bearish_w >= neutral_w:
        prediction = "bearish"
    else:
        prediction = "neutral"

    predicted_slots = [p for p in hour_predictions if p["status"] == "predicted"]
    if predicted_slots:
        pred_day_close = predicted_slots[-1]["predClose"]
        expected_rest = (
            (pred_day_close - today_pattern.slots[compare_bars - 1].close)
            / today_pattern.slots[compare_bars - 1].close
            * 100.0
            if pred_day_close and compare_bars
            else 0.0
        )
    else:
        expected_rest = 0.0

    return {
        "matchMode": "week",
        "currentWeekId": current_week_id,
        "weekOpen": round(week_open, 2),
        "weekDaysIncluded": [d.date for d in current_week_days],
        "weekPatternBars": int(query.size / 3),
        "currentDate": today_pattern.date,
        "compareBars": compare_bars,
        "compareThrough": today_pattern.slots[compare_bars - 1].hour_label,
        "weekMatches": top_week_matches,
        "hourPredictions": hour_predictions,
        "prediction": prediction,
        "confidence": round(max(bullish_w, bearish_w, neutral_w) / weight_sum, 4),
        "probabilities": {
            "bullish": round(bullish_w / weight_sum, 4),
            "bearish": round(bearish_w / weight_sum, 4),
            "neutral": round(neutral_w / weight_sum, 4),
        },
        "expectedDayReturnPct": round(avg_day_return, 3),
        "expectedRestOfDayReturnPct": round(expected_rest, 3),
        "libraryDays": len(patterns),
        "usedClosestMatch": used_closest_fallback,
        "bestSimilarity": round(best_similarity, 4),
    }


def match_all_patterns(
    patterns: list[DayPattern],
    current_date: str | None = None,
    top_k: int = 8,
) -> dict[str, Any]:
    """Week-based match + full-day hour predictions, with day-level matches for reference."""
    session_hours = _reference_session_hours(patterns)
    session_bars = len(session_hours)
    if session_bars < 1:
        raise ValueError("Could not determine full-session hourly bar count")

    week = match_week_and_predict_today(patterns, current_date=current_date, top_k=top_k)
    sorted_patterns = sorted(patterns, key=lambda p: p.date)
    today = current_date or sorted_patterns[-1].date
    raw_today = next((p for p in sorted_patterns if p.date == today), sorted_patterns[-1])

    synthesized_today = _synthesize_day_pattern(
        raw_today,
        week.get("hourPredictions") or [],
        session_hours,
        session_bars,
    )

    try:
        day = match_current_day(
            patterns,
            current_date=current_date,
            top_k=top_k,
            match_pattern=synthesized_today,
            raw_today=raw_today,
            session_bars=session_bars,
            session_hours=session_hours,
        )
    except ValueError:
        day = match_current_day(
            patterns,
            current_date=current_date,
            top_k=top_k,
            match_pattern=raw_today,
            raw_today=raw_today,
            session_bars=min(session_bars, raw_today.bar_count),
            session_hours=session_hours,
        )

    return {
        **day,
        **week,
        "compareBars": session_bars,
        "compareThrough": session_hours[session_bars - 1],
        "sessionBars": session_bars,
        "actualBarsToday": raw_today.bar_count,
        "dayMatches": day.get("matches", []),
        "matches": day.get("matches", []),
        "matchMode": "week",
        "usedClosestMatch": bool(week.get("usedClosestMatch") or day.get("usedClosestMatch")),
        "bestSimilarity": max(
            float(week.get("bestSimilarity") or 0),
            float(day.get("bestSimilarity") or 0),
        ),
    }


def match_current_day(
    patterns: list[DayPattern],
    current_date: str | None = None,
    top_k: int = 8,
    match_pattern: DayPattern | None = None,
    raw_today: DayPattern | None = None,
    session_bars: int | None = None,
    session_hours: list[str] | None = None,
) -> dict[str, Any]:
    if not patterns:
        raise ValueError("Pattern library is empty — sync hourly data first")

    sorted_patterns = sorted(patterns, key=lambda p: p.date)
    today = current_date or sorted_patterns[-1].date
    raw_today = raw_today or next((p for p in sorted_patterns if p.date == today), sorted_patterns[-1])
    today_pattern = match_pattern or raw_today

    session_hours = session_hours or _reference_session_hours(patterns)
    session_bars = session_bars or len(session_hours)
    if session_bars < 1:
        raise ValueError("Could not determine full-session hourly bar count")

    compare_bars = min(session_bars, len(today_pattern.slots))
    if compare_bars < 1:
        raise ValueError("Today pattern does not have enough hourly bars for matching")

    matches: list[dict[str, Any]] = []

    for candidate in sorted_patterns:
        if candidate.date == today_pattern.date:
            continue
        n = min(session_bars, candidate.bar_count, len(today_pattern.slots))
        if n < 1:
            continue
        hist = _slot_vector(candidate.slots, n)
        q = _slot_vector(today_pattern.slots, n)
        similarity = _similarity_score(q, hist)

        anchor_idx = min(session_bars, candidate.bar_count) - 1
        anchor_close = candidate.slots[anchor_idx].close
        rest_return_pct = (
            (candidate.day_close - anchor_close) / anchor_close * 100.0 if anchor_close > 0 else 0.0
        )
        matched_bars = min(session_bars, candidate.bar_count)

        matches.append(
            {
                "date": candidate.date,
                "similarity": round(similarity, 4),
                "outcome": candidate.outcome,
                "dayReturnPct": candidate.day_return_pct,
                "restOfDayReturnPct": round(rest_return_pct, 3),
                "dayOpen": candidate.day_open,
                "dayClose": candidate.day_close,
                "dayHigh": candidate.day_high,
                "dayLow": candidate.day_low,
                "matchedBars": matched_bars,
                "matchedThrough": candidate.slots[matched_bars - 1].hour_label,
                "fullDayBarCount": candidate.bar_count,
                "matchedSlots": [asdict(s) for s in candidate.slots[:matched_bars]],
                "fullDaySlots": [asdict(s) for s in candidate.slots],
                "closestFallback": candidate.bar_count < session_bars,
            }
        )

    matches.sort(key=lambda item: item["similarity"], reverse=True)
    top_matches = matches[:top_k]

    if not top_matches:
        # Closest same-weekday days with at least partial session data
        today_wd = _weekday_index(today_pattern.date)
        for candidate in sorted_patterns:
            if candidate.date == today_pattern.date:
                continue
            if _weekday_index(candidate.date) != today_wd:
                continue
            n = min(session_bars, candidate.bar_count, len(today_pattern.slots))
            if n < 1:
                continue
            sim = _similarity_score(
                _slot_vector(today_pattern.slots, n),
                _slot_vector(candidate.slots, n),
            )
            matches.append(
                {
                    "date": candidate.date,
                    "similarity": round(sim, 4),
                    "outcome": candidate.outcome,
                    "dayReturnPct": candidate.day_return_pct,
                    "restOfDayReturnPct": 0.0,
                    "dayOpen": candidate.day_open,
                    "dayClose": candidate.day_close,
                    "dayHigh": candidate.day_high,
                    "dayLow": candidate.day_low,
                    "matchedBars": min(session_bars, candidate.bar_count),
                    "matchedThrough": candidate.slots[min(session_bars, candidate.bar_count) - 1].hour_label,
                    "fullDayBarCount": candidate.bar_count,
                    "matchedSlots": [asdict(s) for s in candidate.slots[:session_bars]],
                    "fullDaySlots": [asdict(s) for s in candidate.slots],
                    "closestFallback": True,
                }
            )
        matches.sort(key=lambda item: item["similarity"], reverse=True)
        top_matches = matches[:top_k]

    if not top_matches:
        raise ValueError("No historical days available to find a closest pattern")

    used_closest = any(m.get("closestFallback") for m in top_matches) or top_matches[0]["similarity"] < 0.35

    weights = np.array([max(m["similarity"], 0.0001) for m in top_matches], dtype=float)
    weight_sum = float(weights.sum()) or 1.0

    bullish_w = sum(m["similarity"] for m in top_matches if m["outcome"] == "bullish")
    bearish_w = sum(m["similarity"] for m in top_matches if m["outcome"] == "bearish")
    neutral_w = sum(m["similarity"] for m in top_matches if m["outcome"] == "neutral")

    avg_day_return = sum(m["dayReturnPct"] * m["similarity"] for m in top_matches) / weight_sum
    avg_rest_return = sum(m["restOfDayReturnPct"] * m["similarity"] for m in top_matches) / weight_sum

    if bullish_w >= bearish_w and bullish_w >= neutral_w:
        prediction = "bullish"
    elif bearish_w >= bullish_w and bearish_w >= neutral_w:
        prediction = "bearish"
    else:
        prediction = "neutral"

    confidence = max(bullish_w, bearish_w, neutral_w) / weight_sum

    compare_through = today_pattern.slots[compare_bars - 1].hour_label if compare_bars else session_hours[-1]

    return {
        "currentDate": today_pattern.date,
        "compareBars": compare_bars,
        "compareThrough": compare_through,
        "sessionBars": session_bars,
        "actualBarsToday": raw_today.bar_count,
        "currentPattern": {
            "dayOpen": today_pattern.day_open,
            "dayClose": today_pattern.day_close,
            "dayHigh": today_pattern.day_high,
            "dayLow": today_pattern.day_low,
            "dayReturnPct": today_pattern.day_return_pct,
            "dayCloseSoFar": raw_today.slots[raw_today.bar_count - 1].close if raw_today.bar_count else today_pattern.day_close,
            "dayHighSoFar": max(s.high for s in raw_today.slots) if raw_today.slots else today_pattern.day_high,
            "dayLowSoFar": min(s.low for s in raw_today.slots) if raw_today.slots else today_pattern.day_low,
            "matchedBars": compare_bars,
            "fullDayBarCount": len(today_pattern.slots),
            "matchedSlots": [asdict(s) for s in today_pattern.slots[:compare_bars]],
            "fullDaySlots": [asdict(s) for s in today_pattern.slots],
            "actualSlots": [asdict(s) for s in raw_today.slots],
            "vectorLength": int(_slot_vector(today_pattern.slots, compare_bars).size),
        },
        "prediction": prediction,
        "confidence": round(confidence, 4),
        "probabilities": {
            "bullish": round(bullish_w / weight_sum, 4),
            "bearish": round(bearish_w / weight_sum, 4),
            "neutral": round(neutral_w / weight_sum, 4),
        },
        "expectedDayReturnPct": round(avg_day_return, 3),
        "expectedRestOfDayReturnPct": round(avg_rest_return, 3),
        "matches": top_matches,
        "libraryDays": len(patterns),
        "usedClosestMatch": used_closest,
        "bestSimilarity": round(top_matches[0]["similarity"], 4),
    }


def _truncate_day_pattern(day: DayPattern, bars: int) -> DayPattern:
    count = min(max(bars, 1), len(day.slots))
    slots = day.slots[:count]
    day_open = day.day_open
    day_close = float(slots[-1].close)
    day_high = max(s.high for s in slots)
    day_low = min(s.low for s in slots)
    day_return_pct = (day_close - day_open) / day_open * 100.0 if day_open > 0 else 0.0
    return DayPattern(
        date=day.date,
        day_open=round(day_open, 2),
        day_close=round(day_close, 2),
        day_high=round(day_high, 2),
        day_low=round(day_low, 2),
        day_return_pct=round(day_return_pct, 3),
        outcome=_outcome_from_return(day_return_pct),
        bar_count=len(slots),
        slots=slots,
        vector=_slot_vector(slots).tolist(),
    )


def _build_backtest_comparison(
    hour_predictions: list[dict[str, Any]],
    target_full: DayPattern,
) -> list[dict[str, Any]]:
    actual_by_label = {slot.hour_label: slot for slot in target_full.slots}
    rows: list[dict[str, Any]] = []

    for pred in hour_predictions:
        label = str(pred.get("hourLabel", ""))
        actual = actual_by_label.get(label)
        if actual is None:
            continue

        pred_close = pred.get("predClose")
        actual_bias = _hour_bias(actual.open, actual.close)
        close_error_pct: float | None = None
        if pred.get("status") == "predicted" and pred_close is not None and actual.open > 0:
            close_error_pct = round((float(pred_close) - actual.close) / actual.open * 100.0, 3)

        rows.append(
            {
                "hourLabel": label,
                "hourIndex": pred.get("hourIndex"),
                "status": pred.get("status"),
                "predOpen": pred.get("predOpen"),
                "predHigh": pred.get("predHigh"),
                "predLow": pred.get("predLow"),
                "predClose": pred_close,
                "actualOpen": round(actual.open, 2),
                "actualHigh": round(actual.high, 2),
                "actualLow": round(actual.low, 2),
                "actualClose": round(actual.close, 2),
                "closeErrorPct": close_error_pct,
                "predBias": pred.get("hourBias"),
                "actualBias": actual_bias,
                "biasCorrect": pred.get("hourBias") == actual_bias if pred.get("status") == "predicted" else None,
                "confidence": pred.get("confidence"),
            }
        )

    return rows


def _backtest_single_from_patterns(
    all_patterns: list[DayPattern],
    target_date: str,
    top_k: int = 8,
    simulation_bars: int = 1,
    include_full_match: bool = True,
) -> dict[str, Any]:
    target_dt = datetime.strptime(target_date, "%Y-%m-%d")
    start_date = (target_dt - timedelta(days=365)).strftime("%Y-%m-%d")

    library = [p for p in all_patterns if start_date <= p.date < target_date]
    target_full = next((p for p in all_patterns if p.date == target_date), None)

    if target_full is None:
        raise ValueError(f"No hourly session data for {target_date}")
    if len(library) < 20:
        raise ValueError(f"Not enough history in 1-year window ({len(library)} days)")

    sim_bars = min(max(simulation_bars, 1), target_full.bar_count)
    partial_target = _truncate_day_pattern(target_full, sim_bars)
    patterns_for_match = library + [partial_target]

    match_result = match_all_patterns(patterns_for_match, current_date=target_date, top_k=top_k)
    comparison = _build_backtest_comparison(match_result.get("hourPredictions") or [], target_full)

    predicted_outcome = str(match_result.get("prediction", "neutral"))
    actual_outcome = target_full.outcome
    direction_correct = predicted_outcome == actual_outcome

    predicted_hours = [row for row in comparison if row.get("status") == "predicted"]
    hour_close_errors = [
        abs(float(row["closeErrorPct"]))
        for row in predicted_hours
        if row.get("closeErrorPct") is not None
    ]
    hour_bias_correct = sum(1 for row in predicted_hours if row.get("biasCorrect") is True)
    predicted_day_return = float(match_result.get("expectedDayReturnPct") or 0)
    actual_day_return = float(target_full.day_return_pct)
    day_return_error = abs(predicted_day_return - actual_day_return)

    last_pred_close = predicted_hours[-1]["predClose"] if predicted_hours else partial_target.day_close
    close_error_pct = (
        round((float(last_pred_close) - target_full.day_close) / target_full.day_open * 100.0, 3)
        if target_full.day_open > 0 and last_pred_close is not None
        else None
    )

    backtest_meta = {
        "targetDate": target_date,
        "libraryStart": start_date,
        "libraryEnd": library[-1].date,
        "libraryDays": len(library),
        "candleWindowDays": 365,
        "simulationBars": sim_bars,
        "simulationThrough": partial_target.slots[-1].hour_label if partial_target.slots else None,
        "actual": {
            "dayOpen": target_full.day_open,
            "dayClose": target_full.day_close,
            "dayHigh": target_full.day_high,
            "dayLow": target_full.day_low,
            "dayReturnPct": target_full.day_return_pct,
            "outcome": actual_outcome,
            "barCount": target_full.bar_count,
            "slots": [asdict(s) for s in target_full.slots],
        },
        "comparison": comparison,
        "accuracy": {
            "directionCorrect": direction_correct,
            "predictedOutcome": predicted_outcome,
            "actualOutcome": actual_outcome,
            "predictedDayReturnPct": round(predicted_day_return, 3),
            "actualDayReturnPct": round(actual_day_return, 3),
            "dayReturnErrorPct": round(day_return_error, 3),
            "predictedClose": round(float(last_pred_close), 2) if last_pred_close is not None else None,
            "actualClose": target_full.day_close,
            "closeErrorPct": close_error_pct,
            "hourCloseMaePct": round(sum(hour_close_errors) / len(hour_close_errors), 3)
            if hour_close_errors
            else None,
            "predictedHourCount": len(predicted_hours),
            "hourBiasAccuracyPct": round(hour_bias_correct / len(predicted_hours) * 100.0, 1)
            if predicted_hours
            else None,
        },
    }

    if not include_full_match:
        return backtest_meta

    return {**match_result, "backtest": backtest_meta}


def backtest_ml_trading(
    candles: list,
    target_date: str,
    top_k: int = 8,
    simulation_bars: int = 1,
) -> dict[str, Any]:
    """Walk-forward backtest: 1-year library strictly before target date, predict from first bar."""
    all_patterns = build_day_patterns(candles)
    if not all_patterns:
        raise ValueError("No hourly patterns could be built from candles")
    return _backtest_single_from_patterns(all_patterns, target_date, top_k, simulation_bars, True)


def backtest_ml_trading_batch(
    candles: list,
    days: int = 30,
    top_k: int = 8,
    simulation_bars: int = 1,
) -> dict[str, Any]:
    """Backtest the last N trading sessions; report direction hit-rate."""
    all_patterns = build_day_patterns(candles)
    if not all_patterns:
        raise ValueError("No hourly patterns could be built from candles")

    sorted_dates = sorted({p.date for p in all_patterns})
    if len(sorted_dates) < days:
        raise ValueError(f"Need at least {days} trading days in candle data (have {len(sorted_dates)})")

    target_dates = sorted_dates[-days:]
    day_rows: list[dict[str, Any]] = []
    skipped: list[dict[str, Any]] = []

    for target_date in target_dates:
        try:
            meta = _backtest_single_from_patterns(
                all_patterns,
                target_date,
                top_k=top_k,
                simulation_bars=simulation_bars,
                include_full_match=False,
            )
            acc = meta["accuracy"]
            actual_slots = (meta.get("actual") or {}).get("slots") or []
            day_rows.append(
                {
                    "date": target_date,
                    "directionCorrect": acc["directionCorrect"],
                    "predictedOutcome": acc["predictedOutcome"],
                    "actualOutcome": acc["actualOutcome"],
                    "predictedDayReturnPct": acc["predictedDayReturnPct"],
                    "actualDayReturnPct": acc["actualDayReturnPct"],
                    "dayReturnErrorPct": acc["dayReturnErrorPct"],
                    "confidence": None,
                    "actualSlots": actual_slots,
                }
            )
        except ValueError as exc:
            skipped.append({"date": target_date, "error": str(exc)})

    tested = len(day_rows)
    correct = sum(1 for row in day_rows if row["directionCorrect"])
    wrong = tested - correct

    def count_outcome(key: str, value: str) -> dict[str, int]:
        subset = [row for row in day_rows if row[key] == value]
        return {
            "count": len(subset),
            "correct": sum(1 for row in subset if row["directionCorrect"]),
        }

    avg_day_error = (
        round(sum(float(row["dayReturnErrorPct"]) for row in day_rows) / tested, 3) if tested else None
    )

    return {
        "daysRequested": days,
        "daysTested": tested,
        "daysSkipped": len(skipped),
        "daysCorrect": correct,
        "daysWrong": wrong,
        "directionAccuracyPct": round(correct / tested * 100.0, 1) if tested else 0.0,
        "avgDayReturnErrorPct": avg_day_error,
        "dateRange": {
            "first": target_dates[0] if target_dates else None,
            "last": target_dates[-1] if target_dates else None,
        },
        "byPredictedOutcome": {
            "bullish": count_outcome("predictedOutcome", "bullish"),
            "bearish": count_outcome("predictedOutcome", "bearish"),
            "neutral": count_outcome("predictedOutcome", "neutral"),
        },
        "byActualOutcome": {
            "bullish": count_outcome("actualOutcome", "bullish"),
            "bearish": count_outcome("actualOutcome", "bearish"),
            "neutral": count_outcome("actualOutcome", "neutral"),
        },
        "days": day_rows,
        "skipped": skipped,
    }
