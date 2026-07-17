"""Train directional Up/Down ensemble for a chosen interval."""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path

import joblib
import numpy as np
import pandas as pd
from sklearn.metrics import accuracy_score, classification_report

from data_loader import merge_auxiliary_features
from ensemble import compute_sample_weights, predict_ensemble, train_ensemble, walk_forward_scores
from feature_engineering import (
    DIRECTIONAL_LABEL_MAP,
    FEATURE_COLUMNS,
    RETURN_THRESHOLD,
    V3_SIGNAL_THRESHOLD,
    build_directional_dataset,
)
from paths import (
    features_csv_path,
    horizon_key,
    interval_data_dir,
    interval_model_dir,
    min_training_bars,
    model_path,
    metrics_path,
    normalize_interval,
    raw_path,
)

ROOT = Path(__file__).resolve().parent


def _directional_accuracy(y_true, y_pred) -> float:
    if len(y_true) == 0:
        return 0.0
    return float(accuracy_score(y_true, y_pred))


def main() -> int:
    interval = normalize_interval(os.environ.get("PREDICTION_INTERVAL"))
    raw_file = raw_path(interval)
    if not raw_file.exists():
        print(json.dumps({"error": f"No training data for {interval}. Export candles first."}))
        return 1

    payload = json.loads(raw_file.read_text())
    if payload.get("interval") and payload.get("interval") != interval:
        print(json.dumps({"error": f"Dataset interval mismatch ({payload.get('interval')} vs {interval})."}))
        return 1

    interval_data_dir(interval).mkdir(parents=True, exist_ok=True)
    interval_model_dir(interval).mkdir(parents=True, exist_ok=True)

    from data_loader import kite_candles_to_df

    primary_id = payload.get("primaryId", "nifty_fut")
    frames: dict[str, pd.DataFrame] = {}
    for item in payload.get("instruments", []):
        df = kite_candles_to_df(item.get("candles", []))
        if not df.empty:
            frames[item["id"]] = df

    if primary_id not in frames:
        print(json.dumps({"error": f"Primary instrument '{primary_id}' has no candle data"}))
        return 1

    primary = frames.pop(primary_id)
    merged = merge_auxiliary_features(primary, frames)
    full_dataset = build_directional_dataset(merged)

    min_bars = min_training_bars(interval)
    min_directional = max(80, int(min_bars * 0.35))
    if len(full_dataset) < min_directional:
        print(
            json.dumps(
                {
                    "error": (
                        f"Not enough directional rows ({len(full_dataset)}). "
                        f"Need ≥{min_directional} bars with ≥{RETURN_THRESHOLD * 100:.2f}% move. "
                        "Retrain with 60 days of history."
                    )
                }
            )
        )
        return 1

    features_csv_path(interval).write_text(full_dataset.to_csv(index=False))

    X = full_dataset[FEATURE_COLUMNS]
    y = full_dataset["target"]
    sample_weight = compute_sample_weights(y)

    split = int(len(full_dataset) * 0.8)
    meta_split = int(split * 0.85)
    X_train, X_meta, X_test = X.iloc[:meta_split], X.iloc[meta_split:split], X.iloc[split:]
    y_train, y_meta, y_test = y.iloc[:meta_split], y.iloc[meta_split:split], y.iloc[split:]
    sw_train = sample_weight[:meta_split]

    bundle = train_ensemble(
        X_train,
        y_train,
        X_meta,
        y_meta,
        num_class=2,
        sample_weight=sw_train,
    )
    bundle["featureColumns"] = list(FEATURE_COLUMNS)
    bundle["schemaVersion"] = 3
    bundle["modelType"] = "directional_binary_ensemble"
    bundle["interval"] = interval
    bundle["labelThreshold"] = RETURN_THRESHOLD
    bundle["signalThreshold"] = V3_SIGNAL_THRESHOLD

    wf_scores = walk_forward_scores(X, y, num_class=2, sample_weight=sample_weight)

    holdout_preds = [int(np.argmax(predict_ensemble(bundle, X_test.iloc[[i]]))) for i in range(len(X_test))]
    holdout_accuracy = _directional_accuracy(y_test, holdout_preds)
    report = classification_report(
        y_test,
        holdout_preds,
        target_names=["down", "up"],
        output_dict=True,
        zero_division=0,
    )

    importances = {
        FEATURE_COLUMNS[i]: float(v)
        for i, v in enumerate(bundle["models"]["xgb"].feature_importances_)
    }

    resolved_model_path = model_path(interval)
    resolved_model_path.parent.mkdir(parents=True, exist_ok=True)
    joblib.dump(bundle, resolved_model_path)

    legacy = ROOT / "model" / "xgb_nifty.pkl"
    if interval == "minute" and legacy.exists():
        legacy.unlink()

    metrics = {
        "schemaVersion": 3,
        "modelType": "directional_binary_ensemble",
        "interval": interval,
        "horizon": horizon_key(interval),
        "labelThreshold": RETURN_THRESHOLD,
        "signalThreshold": V3_SIGNAL_THRESHOLD,
        "rows": len(full_dataset),
        "trainRows": len(X_train),
        "directionalRows": len(full_dataset),
        "holdoutAccuracy": round(holdout_accuracy, 4),
        "directionalHoldoutAccuracy": round(holdout_accuracy, 4),
        "metaValAccuracy": round(bundle["valAccuracy"], 4),
        "walkForwardAccuracy": round(float(np.mean(wf_scores)), 4) if wf_scores else None,
        "directionalWalkForwardAccuracy": round(float(np.mean(wf_scores)), 4) if wf_scores else None,
        "walkForwardFolds": wf_scores,
        "classificationReport": report,
        "labelMap": DIRECTIONAL_LABEL_MAP,
        "features": FEATURE_COLUMNS,
        "featureImportance": dict(sorted(importances.items(), key=lambda x: x[1], reverse=True)),
        "modelPath": str(resolved_model_path),
    }
    metrics_path(interval).write_text(json.dumps(metrics, indent=2))
    print(json.dumps({"ok": True, "metrics": metrics}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
