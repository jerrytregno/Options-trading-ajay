"""Per-interval model and data paths."""

from __future__ import annotations

import os
from pathlib import Path

ROOT = Path(__file__).resolve().parent
DATA_DIR = ROOT / "data"
MODEL_DIR = ROOT / "model"

ALLOWED_INTERVALS = ("minute", "3minute", "5minute", "15minute")

INTERVAL_MINUTES = {
    "minute": 1,
    "3minute": 3,
    "5minute": 5,
    "15minute": 15,
}


def normalize_interval(interval: str | None) -> str:
    value = (interval or os.environ.get("PREDICTION_INTERVAL") or "minute").strip()
    if value not in ALLOWED_INTERVALS:
        raise ValueError(f"Unsupported interval '{value}'. Use: {', '.join(ALLOWED_INTERVALS)}")
    return value


def horizon_key(interval: str) -> str:
    return f"next_{normalize_interval(interval)}_candle"


def interval_data_dir(interval: str) -> Path:
    return DATA_DIR / normalize_interval(interval)


def raw_path(interval: str) -> Path:
    return interval_data_dir(interval) / "raw_instruments.json"


def interval_model_dir(interval: str) -> Path:
    return MODEL_DIR / normalize_interval(interval)


def model_path(interval: str) -> Path:
    normalized = normalize_interval(interval)
    current = interval_model_dir(normalized) / "ensemble_nifty.pkl"
    if current.exists():
        return current
    if normalized == "minute":
        legacy = MODEL_DIR / "ensemble_nifty.pkl"
        if legacy.exists():
            return legacy
    return current


def legacy_model_path(interval: str) -> Path:
    normalized = normalize_interval(interval)
    if normalized == "minute":
        return MODEL_DIR / "xgb_nifty.pkl"
    return interval_model_dir(normalized) / "xgb_nifty.pkl"


def metrics_path(interval: str) -> Path:
    normalized = normalize_interval(interval)
    current = interval_model_dir(normalized) / "metrics.json"
    if current.exists():
        return current
    if normalized == "minute":
        legacy = MODEL_DIR / "metrics.json"
        if legacy.exists():
            return legacy
    return current


def features_csv_path(interval: str) -> Path:
    return interval_data_dir(interval) / "nifty_features.csv"


def min_training_bars(interval: str) -> int:
    minutes = INTERVAL_MINUTES[normalize_interval(interval)]
    return max(100, 300 // minutes)


def model_exists(interval: str) -> bool:
    normalized = normalize_interval(interval)
    if model_path(normalized).exists():
        return True
    if legacy_model_path(normalized).exists():
        return True
    return False
