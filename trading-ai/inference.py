"""Unified decode for 3-class (v2) and directional binary (v3) model bundles."""

from __future__ import annotations

import numpy as np

from feature_engineering import LABEL_MAP, SIGNAL_THRESHOLD, trade_signal

V3_SIGNAL_THRESHOLD = 0.55


def is_directional_bundle(bundle) -> bool:
    if not isinstance(bundle, dict):
        return False
    return (
        bundle.get("schemaVersion", 2) >= 3
        or bundle.get("modelType") == "directional_binary_ensemble"
    )


def signal_threshold_for(bundle) -> float:
    if isinstance(bundle, dict) and bundle.get("signalThreshold") is not None:
        return float(bundle["signalThreshold"])
    return V3_SIGNAL_THRESHOLD if is_directional_bundle(bundle) else SIGNAL_THRESHOLD


def decode_proba(bundle, proba_raw) -> tuple[int, float, float, float]:
    """Return pred_class (0=down, 1=flat, 2=up) and down/flat/up probabilities."""
    if is_directional_bundle(bundle):
        p_down = float(proba_raw[0])
        p_up = float(proba_raw[1])
        pred_class = 2 if p_up >= p_down else 0
        return pred_class, p_down, 0.0, p_up
    down, flat, up = float(proba_raw[0]), float(proba_raw[1]), float(proba_raw[2])
    pred_class = int(np.argmax(proba_raw))
    return pred_class, down, flat, up


def trade_signal_for(bundle, proba_raw) -> str:
    threshold = signal_threshold_for(bundle)
    if is_directional_bundle(bundle):
        p_down, p_up = float(proba_raw[0]), float(proba_raw[1])
        if p_up >= threshold:
            return "BUY_CALL"
        if p_down >= threshold:
            return "BUY_PUT"
        return "NO_TRADE"
    return trade_signal(proba_raw, threshold)


def prediction_label(bundle, pred_class: int) -> str:
    if is_directional_bundle(bundle):
        return "up" if pred_class == 2 else "down"
    return LABEL_MAP.get(pred_class, "flat")
