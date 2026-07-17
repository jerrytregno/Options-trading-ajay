"""Paths for ML Trading hourly NIFTY pattern library."""

from __future__ import annotations

from pathlib import Path

ROOT = Path(__file__).resolve().parent
DATA_DIR = ROOT / "data" / "ml-trading"
RAW_CANDLES_PATH = DATA_DIR / "hourly_nifty_candles.json"
LIBRARY_PATH = DATA_DIR / "pattern_library.json"
META_PATH = DATA_DIR / "meta.json"

ML_TRADING_INTERVAL = "60minute"
ML_TRADING_DAYS = 365
NIFTY_INSTRUMENT = "NSE:NIFTY 50"
