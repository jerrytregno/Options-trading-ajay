"""Align feature matrix to the columns a saved model was trained on."""

from __future__ import annotations

import pandas as pd

from feature_engineering import FEATURE_COLUMNS

SCHEMA_VERSION = 3


def get_model_feature_columns(bundle) -> list[str]:
    if isinstance(bundle, dict):
        saved = bundle.get("featureColumns")
        if saved:
            return list(saved)
        models = bundle.get("models") or {}
        xgb = models.get("xgb")
        if xgb is not None and hasattr(xgb, "feature_names_in_"):
            return list(xgb.feature_names_in_)
    if hasattr(bundle, "feature_names_in_"):
        return list(bundle.feature_names_in_)
    return FEATURE_COLUMNS


def schema_matches(bundle) -> bool:
    if not isinstance(bundle, dict):
        return False
    version = bundle.get("schemaVersion")
    if version not in (2, 3):
        return False
    return get_model_feature_columns(bundle) == FEATURE_COLUMNS


def align_features(row: pd.DataFrame, columns: list[str]) -> pd.DataFrame:
    aligned = pd.DataFrame(index=row.index)
    for col in columns:
        if col in row.columns:
            aligned[col] = row[col]
        else:
            aligned[col] = 0.0
    return aligned[columns]
