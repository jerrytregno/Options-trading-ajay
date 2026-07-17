"""1-minute next-candle feature engineering (microstructure + flow + time)."""

from __future__ import annotations

import numpy as np
import pandas as pd
import ta

# Target: next candle direction
FORWARD_BARS = 1
# Minimum move to label Up/Down (0.05%). Smaller moves are treated as Flat in training filters.
RETURN_THRESHOLD = 0.0005

LABEL_MAP = {0: "down", 1: "flat", 2: "up"}
DIRECTIONAL_LABEL_MAP = {0: "down", 1: "up"}
SIGNAL_THRESHOLD = 0.75
V3_SIGNAL_THRESHOLD = 0.55

LIVE_SNAPSHOT_DEFAULTS = {
    "atm_pcr": 1.0,
    "atm_call_oi_change": 0.0,
    "atm_put_oi_change": 0.0,
    "oi_delta": 0.0,
    "iv_change": 0.0,
    "max_pain_distance": 0.0,
    "bid_volume": 0.0,
    "ask_volume": 0.0,
    "bid_ask_ratio": 1.0,
    "obi": 0.0,
    "gemini_sentiment": 0.5,
    "gemini_impact": 0.0,
    "gemini_banking": 0.0,
    "gemini_it": 0.0,
    "gemini_energy": 0.0,
}

FEATURE_COLUMNS = [
    # Layer 1 — Nifty futures
    "return_1m",
    "return_2m",
    "return_3m",
    "return_5m",
    "ema9",
    "ema21",
    "vwap_distance",
    "atr_14",
    "rsi_7",
    # Layer 2 — market leaders
    "heavyweight_score",
    # Layer 3 — Bank Nifty
    "banknifty_return_1m",
    "banknifty_return_3m",
    "banknifty_vwap_distance",
    "banknifty_volume_ratio",
    # Layer 4 — options flow (live-enriched)
    "atm_pcr",
    "atm_call_oi_change",
    "atm_put_oi_change",
    "oi_delta",
    "iv_change",
    "max_pain_distance",
    # Layer 5 — order flow (live-enriched)
    "bid_volume",
    "ask_volume",
    "bid_ask_ratio",
    "obi",
    # Layer 6 — time
    "minute_of_day",
    "is_opening_hour",
    "is_closing_hour",
    "day_of_week",
    # Layer 7 — volatility regime
    "india_vix",
    "vix_change",
    "realized_volatility_5m",
    # Layer 8 — Gemini numeric features
    "gemini_sentiment",
    "gemini_impact",
    "gemini_banking",
    "gemini_it",
    "gemini_energy",
]


def _close_col(df: pd.DataFrame, prefix: str) -> str:
    named = f"{prefix}_close"
    return named if named in df.columns else "close"


def _vwap_distance(high: pd.Series, low: pd.Series, close: pd.Series, volume: pd.Series) -> pd.Series:
    typical = (high + low + close) / 3
    cum_vol = volume.cumsum().replace(0, np.nan)
    vwap = (typical * volume).cumsum() / cum_vol
    return (close - vwap) / close.replace(0, np.nan)


def _ist_time_parts(times: pd.Series) -> pd.DataFrame:
    ts = pd.to_datetime(times)
    if ts.dt.tz is None:
        ts = ts.dt.tz_localize("Asia/Kolkata", ambiguous="NaT", nonexistent="NaT")
    else:
        ts = ts.dt.tz_convert("Asia/Kolkata")
    hour = ts.dt.hour.fillna(10).astype(int)
    minute = ts.dt.minute.fillna(0).astype(int)
    minute_of_day = hour * 60 + minute
    return pd.DataFrame(
        {
            "minute_of_day": minute_of_day,
            "is_opening_hour": (((hour == 9) & (minute >= 15)) | ((hour == 10) & (minute < 15))).astype(float),
            "is_closing_hour": ((hour == 15) & (minute >= 0)).astype(float),
            "day_of_week": ts.dt.dayofweek.fillna(2).astype(float),
        },
        index=times.index,
    )


def apply_live_snapshot(df: pd.DataFrame, snapshot: dict | None) -> pd.DataFrame:
    out = df.copy()
    snap = {**LIVE_SNAPSHOT_DEFAULTS, **(snapshot or {})}
    for key, value in snap.items():
        if key in FEATURE_COLUMNS:
            out[key] = float(value) if value is not None else LIVE_SNAPSHOT_DEFAULTS.get(key, 0.0)
    return out


def create_features(df: pd.DataFrame, snapshot: dict | None = None) -> pd.DataFrame:
    out = df.copy()
    close = out[_close_col(out, "nifty")]
    high = out["nifty_high"] if "nifty_high" in out.columns else out["high"]
    low = out["nifty_low"] if "nifty_low" in out.columns else out["low"]
    volume = out["nifty_volume"] if "nifty_volume" in out.columns else out["volume"]

    out["return_1m"] = close.pct_change(1)
    out["return_2m"] = close.pct_change(2)
    out["return_3m"] = close.pct_change(3)
    out["return_5m"] = close.pct_change(5)

    out["ema9"] = ta.trend.EMAIndicator(close, 9).ema_indicator()
    out["ema21"] = ta.trend.EMAIndicator(close, 21).ema_indicator()
    out["vwap_distance"] = _vwap_distance(high, low, close, volume)
    out["atr_14"] = ta.volatility.AverageTrueRange(high, low, close, 14).average_true_range()
    out["rsi_7"] = ta.momentum.RSIIndicator(close, 7).rsi()

    out["realized_volatility_5m"] = out["return_1m"].rolling(5).std()

    # Layer 2 — weighted leader score (1m returns)
    weights = {
        "hdfc": 0.35,
        "icici": 0.25,
        "reliance": 0.25,
        "infy": 0.10,
        "tcs": 0.05,
    }
    score = pd.Series(0.0, index=out.index)
    for inst, weight in weights.items():
        col = f"{inst}_close"
        if col in out.columns:
            score = score + weight * out[col].pct_change(1).fillna(0)
    out["heavyweight_score"] = score

    # Layer 3 — Bank Nifty
    if "banknifty_close" in out.columns:
        bn_close = out["banknifty_close"]
        bn_high = out.get("banknifty_high", bn_close)
        bn_low = out.get("banknifty_low", bn_close)
        bn_vol = out.get("banknifty_volume", pd.Series(0, index=out.index))
        out["banknifty_return_1m"] = bn_close.pct_change(1)
        out["banknifty_return_3m"] = bn_close.pct_change(3)
        out["banknifty_vwap_distance"] = _vwap_distance(bn_high, bn_low, bn_close, bn_vol)
        bn_vol_mean = bn_vol.rolling(20).mean().replace(0, np.nan)
        out["banknifty_volume_ratio"] = bn_vol / bn_vol_mean
    else:
        out["banknifty_return_1m"] = np.nan
        out["banknifty_return_3m"] = np.nan
        out["banknifty_vwap_distance"] = np.nan
        out["banknifty_volume_ratio"] = np.nan

    # Layer 7 — VIX
    if "vix_close" in out.columns:
        out["india_vix"] = out["vix_close"]
        out["vix_change"] = out["vix_close"].pct_change(1)
    else:
        out["india_vix"] = np.nan
        out["vix_change"] = np.nan

    # Layer 6 — time (IST)
    if "time" in out.columns:
        time_feats = _ist_time_parts(out["time"])
        out = pd.concat([out, time_feats], axis=1)

    # Layers 4, 5, 8 — defaults for training; overwritten at live predict
    out = apply_live_snapshot(out, snapshot)

    return out


def create_labels(df: pd.DataFrame) -> pd.DataFrame:
    out = df.copy()
    close = out[_close_col(out, "nifty")]
    future_return = close.shift(-FORWARD_BARS).sub(close).div(close.replace(0, np.nan))

    out["future_return"] = future_return
    out["target"] = np.where(
        future_return > RETURN_THRESHOLD,
        2,
        np.where(future_return < -RETURN_THRESHOLD, 0, 1),
    )
    return out


def build_dataset(merged: pd.DataFrame, snapshot: dict | None = None) -> pd.DataFrame:
    featured = create_features(merged, snapshot)
    labeled = create_labels(featured)
    dataset = labeled.dropna(subset=["target"]).copy()

    for col in FEATURE_COLUMNS:
        if col not in dataset.columns:
            dataset[col] = LIVE_SNAPSHOT_DEFAULTS.get(col, 0.0)
        dataset[col] = dataset[col].fillna(LIVE_SNAPSHOT_DEFAULTS.get(col, 0.0))

    dataset = dataset.dropna(subset=FEATURE_COLUMNS)
    dataset["target"] = dataset["target"].astype(int)
    return dataset


def build_directional_dataset(merged: pd.DataFrame, snapshot: dict | None = None) -> pd.DataFrame:
    """Up vs Down only — trains on bars with a meaningful move (excludes Flat labels)."""
    dataset = build_dataset(merged, snapshot)
    moved = dataset[dataset["target"] != 1].copy()
    moved["target"] = moved["target"].map({0: 0, 2: 1}).astype(int)
    return moved


def trade_signal(proba: np.ndarray, threshold: float = SIGNAL_THRESHOLD) -> str:
    down, flat, up = float(proba[0]), float(proba[1]), float(proba[2])
    if up > threshold:
        return "BUY_CALL"
    if down > threshold:
        return "BUY_PUT"
    return "NO_TRADE"
