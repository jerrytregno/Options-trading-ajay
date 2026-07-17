"""Load multi-instrument OHLCV exported from the Node/Kite API."""

from __future__ import annotations

import json
from pathlib import Path

import pandas as pd

DATA_DIR = Path(__file__).resolve().parent / "data"


def kite_candles_to_df(candles: list) -> pd.DataFrame:
    rows = []
    for item in candles:
        if not isinstance(item, (list, tuple)) or len(item) < 6:
            continue
        time, open_, high, low, close, volume = item[:6]
        rows.append(
            {
                "time": pd.to_datetime(time),
                "open": float(open_),
                "high": float(high),
                "low": float(low),
                "close": float(close),
                "volume": float(volume or 0),
            }
        )
    if not rows:
        return pd.DataFrame(columns=["time", "open", "high", "low", "close", "volume"])
    df = pd.DataFrame(rows).sort_values("time").drop_duplicates("time")
    return df.reset_index(drop=True)


def load_instruments(path: Path | None = None) -> dict[str, pd.DataFrame]:
    path = path or DATA_DIR / "raw_instruments.json"
    payload = json.loads(path.read_text())
    primary_id = payload.get("primaryId", "nifty_fut")
    instruments = payload.get("instruments", [])

    frames: dict[str, pd.DataFrame] = {}
    for item in instruments:
        inst_id = item["id"]
        df = kite_candles_to_df(item.get("candles", []))
        if df.empty:
            continue
        frames[inst_id] = df

    if primary_id not in frames:
        raise ValueError(f"Primary instrument '{primary_id}' has no candle data")

    return frames


def merge_auxiliary_features(primary: pd.DataFrame, aux: dict[str, pd.DataFrame]) -> pd.DataFrame:
    merged = primary.copy()
    merged = merged.rename(
        columns={
            c: f"nifty_{c}" if c != "time" else "time"
            for c in merged.columns
        }
    )

    for inst_id, df in aux.items():
        if df.empty:
            continue
        aux_df = df[["time", "close", "volume", "high", "low"]].copy()
        aux_df = aux_df.rename(
            columns={
                "close": f"{inst_id}_close",
                "volume": f"{inst_id}_volume",
                "high": f"{inst_id}_high",
                "low": f"{inst_id}_low",
            }
        )
        merged = pd.merge_asof(
            merged.sort_values("time"),
            aux_df.sort_values("time"),
            on="time",
            direction="backward",
        )

    return merged.sort_values("time").reset_index(drop=True)
