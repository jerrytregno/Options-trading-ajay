"""XGBoost + LightGBM + CatBoost ensemble with logistic meta-model."""

from __future__ import annotations

from typing import Any

import numpy as np
from catboost import CatBoostClassifier
from lightgbm import LGBMClassifier
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import accuracy_score
from sklearn.utils.class_weight import compute_class_weight
from xgboost import XGBClassifier

ENSEMBLE_WEIGHTS = {"xgb": 0.4, "lgbm": 0.35, "cat": 0.25}


def compute_sample_weights(y) -> np.ndarray:
    classes = np.unique(y)
    weights = compute_class_weight("balanced", classes=classes, y=y)
    weight_map = dict(zip(classes, weights))
    return np.array([weight_map[int(yi)] for yi in y])


def _base_models(num_class: int = 3) -> dict[str, Any]:
    return {
        "xgb": XGBClassifier(
            n_estimators=400,
            max_depth=4,
            learning_rate=0.05,
            subsample=0.8,
            colsample_bytree=0.8,
            objective="multi:softprob",
            num_class=num_class,
            random_state=42,
            n_jobs=-1,
        ),
        "lgbm": LGBMClassifier(
            n_estimators=400,
            max_depth=4,
            learning_rate=0.05,
            subsample=0.8,
            colsample_bytree=0.8,
            objective="multiclass",
            num_class=num_class,
            random_state=42,
            verbose=-1,
        ),
        "cat": CatBoostClassifier(
            iterations=400,
            depth=4,
            learning_rate=0.05,
            loss_function="MultiClass" if num_class > 2 else "Logloss",
            random_seed=42,
            verbose=0,
        ),
    }


def train_ensemble(
    X_train,
    y_train,
    X_val,
    y_val,
    num_class: int = 3,
    sample_weight=None,
):
    models = _base_models(num_class)
    for model in models.values():
        if sample_weight is not None:
            model.fit(X_train, y_train, sample_weight=sample_weight)
        else:
            model.fit(X_train, y_train)

    stack_val = _stack_probas(models, X_val)
    multi = "multinomial" if num_class > 2 else "auto"
    meta = LogisticRegression(max_iter=2000, multi_class=multi)
    meta.fit(stack_val, y_val)

    val_preds = meta.predict(stack_val)
    val_acc = float(accuracy_score(y_val, val_preds))

    return {"models": models, "meta": meta, "valAccuracy": val_acc}


def _stack_probas(models: dict[str, Any], X) -> np.ndarray:
    parts = [models["xgb"].predict_proba(X), models["lgbm"].predict_proba(X), models["cat"].predict_proba(X)]
    return np.hstack(parts)


def predict_ensemble(bundle: dict[str, Any], X) -> np.ndarray:
    models = bundle["models"]
    meta = bundle["meta"]
    stack = _stack_probas(models, X)
    try:
        return meta.predict_proba(stack)[0]
    except Exception:
        p_xgb = models["xgb"].predict_proba(X)[0]
        p_lgb = models["lgbm"].predict_proba(X)[0]
        p_cat = models["cat"].predict_proba(X)[0]
        return (
            ENSEMBLE_WEIGHTS["xgb"] * p_xgb
            + ENSEMBLE_WEIGHTS["lgbm"] * p_lgb
            + ENSEMBLE_WEIGHTS["cat"] * p_cat
        )


def walk_forward_scores(X, y, n_splits: int = 3, num_class: int = 3, sample_weight=None) -> list[float]:
    from sklearn.model_selection import TimeSeriesSplit

    tscv = TimeSeriesSplit(n_splits=n_splits)
    scores: list[float] = []
    for train_idx, test_idx in tscv.split(X):
        if len(train_idx) < 100 or len(test_idx) < 30:
            continue
        split = int(len(train_idx) * 0.85)
        tr = train_idx[:split]
        va = train_idx[split:]
        te = test_idx
        sw_train = sample_weight[tr] if sample_weight is not None else None
        bundle = train_ensemble(
            X.iloc[tr],
            y.iloc[tr],
            X.iloc[va],
            y.iloc[va],
            num_class=num_class,
            sample_weight=sw_train,
        )
        preds = [int(np.argmax(predict_ensemble(bundle, X.iloc[[i]]))) for i in te]
        scores.append(float(accuracy_score(y.iloc[te], preds)))
    return scores
