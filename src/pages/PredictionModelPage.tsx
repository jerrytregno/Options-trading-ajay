import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Activity,
  AlertTriangle,
  Brain,
  CalendarCheck,
  Eye,
  Play,
  RefreshCw,
  Target,
  TrendingDown,
  TrendingUp,
  Minus,
} from "lucide-react";
import { DashboardShell } from "@/components/layout/dashboard-shell";
import { PredictionAtmLivePanel } from "@/components/prediction/PredictionAtmLivePanel";
import { PredictionNiftyStreamChart } from "@/components/streaming/PredictionNiftyStreamChart";
import { PredictionAutoTrader } from "@/components/trade/PredictionAutoTrader";
import { useKite } from "@/contexts/kite-context";
import type {
  PredictionBacktestResult,
  PredictionLiveResult,
  PredictionStatus,
} from "@/types/prediction";
import {
  autoRefreshMs,
  formatLivePredictionWindow,
  getTodayIstDate,
  getTomorrowIstDate,
  horizonLabel,
  isLiveBacktestDate,
  isTodayIstDate,
  isTomorrowIstDate,
  PREDICTION_INTERVALS,
  PREDICTION_INTERVAL_LABELS,
  type PredictionInterval,
} from "@/lib/prediction-intervals";
import {
  computeConfidenceStats,
  BACKTEST_CONFIDENCE_THRESHOLD,
  DISPLAY_CONFIDENCE_THRESHOLD,
  displaySignalForPrediction,
  formatPointsPnl,
  getBacktestDisplayPrediction,
  getDisplayPrediction,
  tradePointsPnl,
} from "@/lib/prediction-confidence";
import { cn, formatNumber } from "@/lib/utils";
import { fetchNiftySpotPrice } from "@/lib/prediction-auto-trade";
import "@/styles/prediction-page.css";
import "@/styles/prediction-auto-trade.css";

export default function PredictionModelPage() {
  const { connected, loginUrl } = useKite();
  const [interval, setInterval] = useState<PredictionInterval>("minute");
  const [status, setStatus] = useState<PredictionStatus | null>(null);
  const [live, setLive] = useState<PredictionLiveResult | null>(null);
  const [loadingStatus, setLoadingStatus] = useState(true);
  const [training, setTraining] = useState(false);
  const [predicting, setPredicting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [trainDays, setTrainDays] = useState(60);
  const [autoRefresh, setAutoRefresh] = useState(false);
  const [backtestDate, setBacktestDate] = useState("");
  const [backtesting, setBacktesting] = useState(false);
  const [backtest, setBacktest] = useState<PredictionBacktestResult | null>(null);
  const [revealed, setRevealed] = useState(false);
  const [niftySpot, setNiftySpot] = useState<number | null>(null);
  const dashboardRef = useRef<HTMLDivElement>(null);

  const minBacktestDate = status?.trainingDateRange?.min ?? (() => {
    const d = new Date();
    d.setDate(d.getDate() - trainDays);
    return d.toISOString().slice(0, 10);
  })();
  const maxBacktestDate = getTomorrowIstDate();
  const isBacktestLive = isLiveBacktestDate(backtestDate);
  const isBacktestToday = isTodayIstDate(backtestDate);
  const isBacktestTomorrow = isTomorrowIstDate(backtestDate);
  const showActualColumns = revealed || backtest?.summary.liveToday === true;

  const revealStats = useMemo(() => {
    if (!backtest || (!revealed && !backtest.summary.liveToday)) return null;
    const stats = computeConfidenceStats(
      backtest.bars,
      BACKTEST_CONFIDENCE_THRESHOLD,
      0,
      { onlyRevealed: true },
    );
    const predFlatCount = backtest.bars.filter(
      (b) => getBacktestDisplayPrediction(b.probabilities) === "flat",
    ).length;
    const totalOptionPnl = backtest.bars.reduce(
      (sum, bar) =>
        sum + (bar.option?.tradeEntered ? (bar.option?.pnlRupees ?? 0) : 0),
      0,
    );
    const optionTrades = backtest.bars.filter((b) => b.option?.tradeEntered).length;
    const totalBrokerage = backtest.bars.reduce(
      (sum, bar) =>
        sum + (bar.option?.tradeEntered ? (bar.option?.brokerageRupees ?? 0) : 0),
      0,
    );

    return {
      total: backtest.summary.bars,
      predFlatCount,
      predUpCount: stats.predUpCount,
      predUpHit: stats.predUpHit,
      predUpMiss: stats.predUpMiss,
      predUpHitPct: stats.predUpHitPct,
      predDownCount: stats.predDownCount,
      predDownHit: stats.predDownHit,
      predDownMiss: stats.predDownMiss,
      predDownHitPct: stats.predDownHitPct,
      directionalCount: stats.count,
      directionalHit: stats.hit,
      directionalMiss: stats.miss,
      directionalHitPct: stats.hitPct,
      totalOptionPnl,
      totalBrokerage,
      optionTrades,
    };
  }, [backtest, revealed]);

  const tradePlan = backtest?.summary.tradePlan;
  const optionEnrichmentError = backtest?.summary.optionEnrichmentError;
  const useOptionPnl = isBacktestToday && Boolean(tradePlan);

  const refreshBacktestLive = useCallback(async () => {
    if (!connected || !backtestDate || !status?.schemaCurrent) return;
    try {
      const res = await fetch(
        `/api/prediction/backtest?date=${encodeURIComponent(backtestDate)}&interval=${encodeURIComponent(interval)}`,
        { credentials: "include" },
      );
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Backtest failed");
      const data = json.data as PredictionBacktestResult;
      setBacktest(data);
      if (isLiveBacktestDate(backtestDate)) setRevealed(true);
    } catch {
      // keep prior backtest visible during live refresh
    }
  }, [connected, backtestDate, status?.schemaCurrent, interval]);

  const loadStatus = useCallback(async (selectedInterval: PredictionInterval = interval) => {
    setLoadingStatus(true);
    try {
      const res = await fetch(
        `/api/prediction/status?interval=${encodeURIComponent(selectedInterval)}`,
        { credentials: "include" },
      );
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Failed to load status");
      setStatus(json.data as PredictionStatus);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load status");
    } finally {
      setLoadingStatus(false);
    }
  }, [interval]);

  const runLive = useCallback(async () => {
    if (!connected || !status?.modelTrained) return;
    if (!status.schemaCurrent) return;
    setPredicting(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/prediction/live?interval=${encodeURIComponent(interval)}`,
        { credentials: "include" },
      );
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Prediction failed");
      setLive(json.data as PredictionLiveResult);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Prediction failed");
    } finally {
      setPredicting(false);
    }
  }, [connected, status?.modelTrained, status?.schemaCurrent, interval]);

  const runBacktest = async (options?: { silent?: boolean; keepReveal?: boolean }) => {
    if (!connected || !backtestDate || !status?.schemaCurrent) return;
    const silent = options?.silent ?? false;
    if (!silent) {
      setBacktesting(true);
      setError(null);
      setRevealed(false);
      setBacktest(null);
    }
    try {
      const res = await fetch(
        `/api/prediction/backtest?date=${encodeURIComponent(backtestDate)}&interval=${encodeURIComponent(interval)}`,
        { credentials: "include" },
      );
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Backtest failed");
      const data = json.data as PredictionBacktestResult;
      setBacktest(data);
      if (isLiveBacktestDate(backtestDate) || options?.keepReveal) {
        setRevealed(true);
      }
    } catch (e) {
      if (!silent) {
        setError(e instanceof Error ? e.message : "Backtest failed");
      }
    } finally {
      if (!silent) setBacktesting(false);
    }
  };

  const runTrain = async () => {
    if (!connected) return;
    setTraining(true);
    setError(null);
    try {
      const res = await fetch("/api/prediction/train", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ interval, days: trainDays }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Training failed");
      await loadStatus(interval);
      await runLive();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Training failed");
    } finally {
      setTraining(false);
    }
  };

  const switchInterval = (next: PredictionInterval) => {
    if (next === interval) return;
    setInterval(next);
    setLive(null);
    setBacktest(null);
    setRevealed(false);
    setError(null);
  };

  useEffect(() => {
    if (!connected) {
      setNiftySpot(null);
      return;
    }
    let cancelled = false;
    const tick = async () => {
      const spot = await fetchNiftySpotPrice();
      if (!cancelled && spot != null) setNiftySpot(spot);
    };
    void tick();
    const id = window.setInterval(() => void tick(), 2000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [connected]);

  useEffect(() => {
    void loadStatus(interval);
  }, [interval, loadStatus]);

  useEffect(() => {
    if (!backtestDate && maxBacktestDate) {
      setBacktestDate(maxBacktestDate);
    }
  }, [backtestDate, maxBacktestDate]);

  useEffect(() => {
    if (!autoRefresh || !status?.schemaCurrent || !status?.modelTrained || !connected) return;
    void runLive();
    const id = window.setInterval(() => void runLive(), autoRefreshMs(interval));
    return () => window.clearInterval(id);
  }, [autoRefresh, status?.schemaCurrent, status?.modelTrained, connected, runLive, interval]);

  useEffect(() => {
    if (!backtest || !isBacktestLive || !connected || !status?.schemaCurrent) return;
    const id = window.setInterval(() => {
      void refreshBacktestLive();
    }, autoRefreshMs(interval));
    return () => window.clearInterval(id);
  }, [backtest, isBacktestLive, connected, status?.schemaCurrent, interval, refreshBacktestLive]);

  const metrics = status?.metrics;
  const probs = live?.probabilities;
  const intervalLabel = horizonLabel(interval);
  const liveDisplayPred = probs ? getDisplayPrediction(probs) : null;
  const livePredictionWindow =
    live?.asOf != null ? formatLivePredictionWindow(live.asOf, interval) : null;

  return (
    <DashboardShell>
      <div className="prediction-page" ref={dashboardRef}>
        <header className="page-header prediction-header">
          <div>
            <h1 className="page-title">
              <Brain size={22} />
              Prediction Model
            </h1>
            <p className="page-subtitle">
              Next {intervalLabel} candle · Up/Down directional model · predicts meaningful moves (≥0.05%)
            </p>
          </div>
          <div className="prediction-header-actions">
            {connected && (
              <div className="prediction-spot-pill" title="NSE Nifty 50 index">
                <span className="prediction-spot-label">Nifty 50</span>
                <span className="prediction-spot-value">
                  {niftySpot != null ? formatNumber(niftySpot, 2) : "—"}
                </span>
              </div>
            )}
            <label className="prediction-auto-toggle">
              <input
                type="checkbox"
                checked={autoRefresh}
                onChange={(e) => setAutoRefresh(e.target.checked)}
                disabled={!status?.modelTrained}
              />
              Auto refresh ({intervalLabel})
            </label>
            <button
              className="btn btn-secondary btn-sm"
              onClick={() => void loadStatus(interval)}
              disabled={loadingStatus}
            >
              <RefreshCw size={14} className={loadingStatus ? "spin" : ""} />
              Status
            </button>
          </div>
        </header>

        <div className="prediction-interval-tabs" role="tablist" aria-label="Candle interval">
          {PREDICTION_INTERVALS.map((item) => (
            <button
              key={item}
              type="button"
              role="tab"
              aria-selected={interval === item}
              className={cn("prediction-interval-tab", interval === item && "active")}
              onClick={() => switchInterval(item)}
            >
              {PREDICTION_INTERVAL_LABELS[item]}
            </button>
          ))}
        </div>

        {!connected && (
          <div className="card prediction-banner">
            <AlertTriangle size={18} />
            <div>
              <p className="font-medium">Connect Zerodha Kite to train and predict</p>
              {loginUrl && (
                <a href={loginUrl} className="btn btn-primary btn-sm" style={{ marginTop: "0.5rem" }}>
                  Connect Kite
                </a>
              )}
            </div>
          </div>
        )}

        {error && (
          <div className="card prediction-error">
            <AlertTriangle size={16} />
            {error}
          </div>
        )}

        <div className="prediction-grid">
          <section className="card prediction-panel">
            <h2 className="prediction-panel-title">Model status</h2>
            {loadingStatus ? (
              <p className="text-muted">Loading…</p>
            ) : status ? (
              <dl className="prediction-dl">
                <div>
                  <dt>Python</dt>
                  <dd className={status.pythonAvailable ? "text-success" : "text-danger"}>
                    {status.pythonAvailable ? status.pythonVersion : "Not installed"}
                  </dd>
                </div>
                <div>
                  <dt>ML stack</dt>
                  <dd className={status.xgboostAvailable ? "text-success" : "text-danger"}>
                    {status.xgboostAvailable ? "XGB + LGBM + CatBoost" : "Install requirements.txt + libomp"}
                  </dd>
                </div>
                <div>
                  <dt>Schema</dt>
                  <dd className={status.schemaCurrent ? "text-success" : "text-warning"}>
                    {status.schemaCurrent
                      ? `v${status.metrics?.schemaVersion ?? 3} · ${intervalLabel} Up/Down`
                      : "Outdated — retrain required"}
                  </dd>
                </div>
                <div>
                  <dt>Interval</dt>
                  <dd>{intervalLabel} candles</dd>
                </div>
                <div>
                  <dt>Model</dt>
                  <dd className={status.schemaCurrent ? "text-success" : "text-warning"}>
                    {status.schemaCurrent
                      ? "Directional model trained"
                      : status.modelTrained
                        ? "Needs retrain"
                        : "Not trained"}
                  </dd>
                </div>
                {metrics?.metaValAccuracy != null && (
                  <div>
                    <dt>Meta-model val accuracy</dt>
                    <dd>{formatNumber(metrics.metaValAccuracy * 100, 1)}%</dd>
                  </div>
                )}
                {metrics?.holdoutAccuracy != null && (
                  <div>
                    <dt>Holdout accuracy</dt>
                    <dd>{formatNumber(metrics.holdoutAccuracy * 100, 1)}%</dd>
                  </div>
                )}
                {metrics?.walkForwardAccuracy != null && (
                  <div>
                    <dt>Walk-forward accuracy</dt>
                    <dd>{formatNumber(metrics.walkForwardAccuracy * 100, 1)}%</dd>
                  </div>
                )}
                {metrics?.rows != null && (
                  <div>
                    <dt>Training rows</dt>
                    <dd>{metrics.rows.toLocaleString()}</dd>
                  </div>
                )}
              </dl>
            ) : null}
            <p className="text-muted prediction-note">{status?.note}</p>

            <div className="prediction-train-block">
              <label className="prediction-label">
                Training days
                <input
                  type="number"
                  min={30}
                  max={180}
                  value={trainDays}
                  onChange={(e) => setTrainDays(Number(e.target.value))}
                  className="input prediction-input"
                />
              </label>
              <button
                className="btn btn-primary btn-full"
                onClick={() => void runTrain()}
                disabled={!connected || training || !status?.pythonAvailable || !status?.xgboostAvailable}
              >
                <Play size={16} />
                {training ? "Training…" : `Train ${intervalLabel} model`}
              </button>
            </div>
          </section>

          <section className="card prediction-panel prediction-signal-panel">
            <h2 className="prediction-panel-title">
              <Target size={18} />
              Live signal
            </h2>
            {!status?.schemaCurrent ? (
              <p className="text-muted">
                Your saved model uses the old feature set. Click <strong>Train model</strong> once to
                upgrade — takes ~1–2 min with Kite connected.
              </p>
            ) : !status?.modelTrained ? (
              <p className="text-muted">Train the model first to see live predictions.</p>
            ) : (
              <>
                <button
                  className="btn btn-secondary btn-sm"
                  onClick={() => void runLive()}
                  disabled={!connected || predicting || !status?.schemaCurrent}
                  style={{ marginBottom: "1rem" }}
                >
                  <Activity size={14} />
                  {predicting ? "Predicting…" : "Run prediction"}
                </button>

                {live && probs && liveDisplayPred && (
                  <>
                    <div
                      className={cn(
                        "prediction-signal-badge",
                        liveDisplayPred === "up" && "bullish",
                        liveDisplayPred === "down" && "bearish",
                        liveDisplayPred === "flat" && "neutral",
                      )}
                    >
                      {liveDisplayPred === "up" && <TrendingUp size={20} />}
                      {liveDisplayPred === "down" && <TrendingDown size={20} />}
                      {liveDisplayPred === "flat" && <Minus size={20} />}
                      <span>{displaySignalForPrediction(liveDisplayPred)}</span>
                      <small>
                        {livePredictionWindow?.summary ?? `Next ${intervalLabel} candle`} · P(up){" "}
                        {formatNumber((probs.up ?? 0) * 100, 1)}% · P(down){" "}
                        {formatNumber((probs.down ?? 0) * 100, 1)}% · trade if ≥
                        {formatNumber(DISPLAY_CONFIDENCE_THRESHOLD * 100, 0)}%
                      </small>
                    </div>

                    <div className="prediction-probs">
                      {(
                        [
                          ["down", probs.down ?? probs.bearish ?? 0, TrendingDown],
                          ["flat", probs.flat ?? probs.neutral ?? 0, Minus],
                          ["up", probs.up ?? probs.bullish ?? 0, TrendingUp],
                        ] as const
                      ).map(([label, value, Icon]) => (
                        <div key={label} className={`prediction-prob prediction-prob-${label === "down" ? "bearish" : label === "up" ? "bullish" : "neutral"}`}>
                          <div className="prediction-prob-head">
                            <Icon size={14} />
                            <span>{label}</span>
                            <strong>{formatNumber(value * 100, 1)}%</strong>
                          </div>
                          <div className="prediction-prob-bar">
                            <div style={{ width: `${value * 100}%` }} />
                          </div>
                        </div>
                      ))}
                    </div>

                    {live.asOf && (
                      <p className="text-muted prediction-asof">
                        Features as of {live.asOf}
                        {livePredictionWindow?.toLabel
                          ? ` · target candle ~${livePredictionWindow.toLabel} IST`
                          : ""}
                      </p>
                    )}
                  </>
                )}
              </>
            )}
          </section>

          <PredictionAtmLivePanel
            connected={connected}
            modelReady={Boolean(status?.schemaCurrent && status?.modelTrained)}
            interval={interval}
            live={live}
            targetCandleLabel={livePredictionWindow?.toLabel ?? null}
          />
        </div>

        <PredictionAutoTrader
          connected={connected}
          modelReady={Boolean(status?.schemaCurrent && status?.modelTrained && interval === "minute")}
          interval={interval}
          liveSnapshot={interval === "minute" ? live : null}
          dashboardRef={dashboardRef}
        />
        {interval !== "minute" && (
          <p className="text-muted prediction-note" style={{ marginTop: "-0.5rem", marginBottom: "1rem" }}>
            Automated trading uses the <strong>1 min</strong> model only — switch to the 1 min tab to enable.
          </p>
        )}

        <PredictionNiftyStreamChart connected={connected} loginUrl={loginUrl} />

        <section className="card prediction-panel prediction-backtest-panel">
          <h2 className="prediction-panel-title">
            <CalendarCheck size={18} />
            Check model (historical day)
          </h2>
          <p className="text-muted prediction-note">
            Pick any date from your saved training candles
            {status?.trainingDateRange
              ? ` (${status.trainingDateRange.min} to ${status.trainingDateRange.max})`
              : ""}
            . All bars <strong>before</strong> that date are used as context; predictions run for every{" "}
            {intervalLabel} bar on the chosen day.{" "}
            {isBacktestLive ? (
              <>
                <strong>Today</strong> and <strong>Tomorrow</strong> auto-reveal each minute as the
                next candle closes (refreshes every {intervalLabel}). Pick tomorrow before the
                session to queue live predictions.{" "}
                <strong>Today</strong> also loads live ATM option premiums from Zerodha for P/L in ₹
                (premium change × lot size × lots — not index points).
              </>
            ) : (
              <>
                Press <strong>Reveal</strong> to compare past dates. Past dates show{" "}
                <strong>P/L pts</strong> (Nifty index move only). Choose <strong>Today</strong> with
                Zerodha connected for real ATM option P/L in ₹.
              </>
            )}{" "}
            <strong>Flat</strong> is prediction-only; actual shows <strong>Up</strong> or{" "}
            <strong>Down</strong>. Check model stats use{" "}
            <strong>≥{formatNumber(BACKTEST_CONFIDENCE_THRESHOLD * 100, 0)}%</strong>; automated trading
            enters at <strong>≥{formatNumber(DISPLAY_CONFIDENCE_THRESHOLD * 100, 0)}%</strong>.
          </p>
          <div className="prediction-backtest-controls">
            <label className="prediction-label">
              Date
              <input
                type="date"
                className="input prediction-input"
                min={minBacktestDate}
                max={maxBacktestDate}
                value={backtestDate}
                onChange={(e) => {
                  setBacktestDate(e.target.value);
                  setBacktest(null);
                  setRevealed(false);
                }}
              />
            </label>
            <div className="prediction-backtest-date-quick">
              <button
                type="button"
                className={cn("btn btn-sm", isBacktestToday ? "btn-primary" : "btn-secondary")}
                onClick={() => {
                  setBacktestDate(getTodayIstDate());
                  setBacktest(null);
                  setRevealed(false);
                }}
              >
                Today
              </button>
              <button
                type="button"
                className={cn("btn btn-sm", isBacktestTomorrow ? "btn-primary" : "btn-secondary")}
                onClick={() => {
                  setBacktestDate(getTomorrowIstDate());
                  setBacktest(null);
                  setRevealed(false);
                }}
              >
                Tomorrow
              </button>
            </div>
            <button
              className="btn btn-secondary"
              onClick={() => void runBacktest()}
              disabled={!connected || backtesting || !backtestDate || !status?.schemaCurrent}
            >
              <CalendarCheck size={16} />
              {backtesting ? "Checking…" : "Check model"}
            </button>
            {backtest && !isBacktestLive && (
              <button
                className="btn btn-primary"
                onClick={() => setRevealed(true)}
                disabled={revealed}
              >
                <Eye size={16} />
                {revealed ? "Revealed" : "Reveal actual prices"}
              </button>
            )}
            {backtest && isBacktestLive && (
              <span className="prediction-live-badge">
                <RefreshCw size={14} className="spin" />
                Live — {isBacktestTomorrow ? "Tomorrow" : "Today"} · updating every {intervalLabel}
              </span>
            )}
          </div>

          {isBacktestToday && backtest && !tradePlan && optionEnrichmentError && (
            <p className="prediction-trade-plan-error text-down">
              Zerodha option pricing unavailable: {optionEnrichmentError}
            </p>
          )}

          {tradePlan && (
            <div className="prediction-trade-plan">
              <h3 className="prediction-trade-plan-title">ATM option plan (Zerodha — today)</h3>
              <p className="prediction-trade-plan-note">
                {tradePlan.spotPrice != null && (
                  <>Nifty {formatNumber(tradePlan.spotPrice, 2)} · </>
                )}
                Balance ₹{formatNumber(tradePlan.availableBalance, 0)} · lot size{" "}
                {tradePlan.lotSize} · expiry {tradePlan.expiry} · sizing uses{" "}
                {tradePlan.riskPerTradePct}% risk @ {tradePlan.stopLossPct ?? 15}% stop · hold until +
                {formatNumber(tradePlan.targetProfitInr ?? 200, 0)} net (scan 1m premiums) · ₹50/trade
                charges
              </p>
              <div className="prediction-trade-plan-grid">
                <div className="prediction-trade-plan-card">
                  <span className="prediction-trade-plan-label">ATM Call</span>
                  <span className="prediction-trade-plan-value">
                    {tradePlan.atmStrike} · ₹{formatNumber(tradePlan.atmCallPremium ?? 0, 2)}
                  </span>
                  <span className="text-muted">
                    {tradePlan.suggestedLotsCall ?? 1} lot(s) · cost ₹
                    {formatNumber(tradePlan.costPerLotCall ?? 0, 0)}/lot
                  </span>
                  <span className="text-muted">{tradePlan.atmCallSymbol ?? "—"}</span>
                </div>
                <div className="prediction-trade-plan-card">
                  <span className="prediction-trade-plan-label">ATM Put</span>
                  <span className="prediction-trade-plan-value">
                    {tradePlan.atmStrike} · ₹{formatNumber(tradePlan.atmPutPremium ?? 0, 2)}
                  </span>
                  <span className="text-muted">
                    {tradePlan.suggestedLotsPut ?? 1} lot(s) · cost ₹
                    {formatNumber(tradePlan.costPerLotPut ?? 0, 0)}/lot
                  </span>
                  <span className="text-muted">{tradePlan.atmPutSymbol ?? "—"}</span>
                </div>
              </div>
              {revealStats && revealStats.optionTrades > 0 && (
                <p className="prediction-trade-plan-total">
                  Session option P/L (entered trades only, net of ₹50/trade):{" "}
                  <span className={revealStats.totalOptionPnl >= 0 ? "text-up" : "text-down"}>
                    {revealStats.totalOptionPnl >= 0 ? "+" : ""}₹
                    {formatNumber(revealStats.totalOptionPnl, 0)}
                  </span>{" "}
                  across {revealStats.optionTrades} trades
                  {revealStats.totalBrokerage > 0 && (
                    <>
                      {" "}
                      · ₹{formatNumber(revealStats.totalBrokerage, 0)} Zerodha charges deducted
                    </>
                  )}
                </p>
              )}
            </div>
          )}

          {revealStats && (
            <div className="prediction-backtest-results">
              <div className="prediction-backtest-directional">
                <h3 className="prediction-backtest-directional-title">
                  Up / Down predictions (≥{formatNumber(BACKTEST_CONFIDENCE_THRESHOLD * 100, 0)}% confidence)
                </h3>
                <p className="prediction-backtest-directional-note">
                  {revealStats.predFlatCount} bars shown as Flat (neither Up nor Down reached{" "}
                  {formatNumber(BACKTEST_CONFIDENCE_THRESHOLD * 100, 0)}%.
                  Hit/loss counts only strict ≥{formatNumber(BACKTEST_CONFIDENCE_THRESHOLD * 100, 0)}% calls.
                </p>

                {revealStats.directionalCount > 0 ? (
                    <>
                      <div className="prediction-backtest-directional-totals">
                        <div className="prediction-backtest-stat prediction-backtest-stat-correct">
                          <span className="prediction-backtest-stat-label">Hit</span>
                          <span className="prediction-backtest-stat-value">{revealStats.directionalHit}</span>
                          <span className="prediction-backtest-stat-pct">
                            {formatNumber(revealStats.directionalHitPct ?? 0, 1)}%
                          </span>
                        </div>
                        <div className="prediction-backtest-stat prediction-backtest-stat-wrong">
                          <span className="prediction-backtest-stat-label">Loss</span>
                          <span className="prediction-backtest-stat-value">{revealStats.directionalMiss}</span>
                          <span className="prediction-backtest-stat-pct">
                            {formatNumber(
                              100 - (revealStats.directionalHitPct ?? 0),
                              1,
                            )}
                            %
                          </span>
                        </div>
                      </div>
                      <div className="prediction-backtest-compare-bar prediction-backtest-directional-bar" aria-hidden>
                        <div
                          className="prediction-backtest-compare-fill prediction-backtest-compare-fill-correct"
                          style={{ width: `${revealStats.directionalHitPct ?? 0}%` }}
                        />
                        <div
                          className="prediction-backtest-compare-fill prediction-backtest-compare-fill-wrong"
                          style={{
                            width: `${100 - (revealStats.directionalHitPct ?? 0)}%`,
                          }}
                        />
                      </div>
                      <p className="prediction-backtest-directional-total">
                        {revealStats.directionalHit} hit vs {revealStats.directionalMiss} loss out of{" "}
                        {revealStats.directionalCount} directional calls (
                        {formatNumber(revealStats.directionalHitPct ?? 0, 1)}% hit rate)
                      </p>
                      <div className="prediction-backtest-directional-grid">
                        <div className="prediction-backtest-directional-card prediction-backtest-directional-up">
                          <span className="prediction-backtest-directional-label">Predicted Up</span>
                          <span className="prediction-backtest-directional-count">
                            {revealStats.predUpCount} times
                          </span>
                          <span className="text-up">
                            {revealStats.predUpHit} hit (
                            {formatNumber(revealStats.predUpHitPct ?? 0, 1)}%)
                          </span>
                          <span className="text-down">{revealStats.predUpMiss} missed</span>
                        </div>
                        <div className="prediction-backtest-directional-card prediction-backtest-directional-down">
                          <span className="prediction-backtest-directional-label">Predicted Down</span>
                          <span className="prediction-backtest-directional-count">
                            {revealStats.predDownCount} times
                          </span>
                          <span className="text-up">
                            {revealStats.predDownHit} hit (
                            {formatNumber(revealStats.predDownHitPct ?? 0, 1)}%)
                          </span>
                          <span className="text-down">{revealStats.predDownMiss} missed</span>
                        </div>
                      </div>
                    </>
                  ) : (
                    <p className="prediction-confidence-empty">
                      No ≥{formatNumber(BACKTEST_CONFIDENCE_THRESHOLD * 100, 0)}% Up or Down calls on this day — all bars shown as Flat in the table.
                    </p>
                  )}
              </div>
            </div>
          )}

          {backtest && !showActualColumns && (
            <div className="prediction-backtest-summary">
              <span>
                {backtest.summary.bars} bars on {backtest.summary.date}
                {backtest.summary.historyBars != null
                  ? ` · ${backtest.summary.historyBars.toLocaleString()} context bars before`
                  : ""}{" "}
                — press Reveal to compare
              </span>
            </div>
          )}

          {backtest && showActualColumns && backtest.summary.liveToday && (
            <div className="prediction-backtest-summary">
              <span>
                {backtest.summary.bars === 0 && backtest.summary.waitingForSession
                  ? `Waiting for ${backtest.summary.date} session (9:15 AM IST) — auto-refreshing`
                  : `${backtest.summary.revealedBars ?? 0} of ${backtest.summary.bars} minutes revealed${
                      backtest.summary.pendingBars
                        ? ` · ${backtest.summary.pendingBars} waiting for next candle`
                        : ""
                    }`}
              </span>
            </div>
          )}

          {backtest && (
            <div className="prediction-backtest-table-wrap">
              <table className="prediction-backtest-table">
                <thead>
                  <tr>
                    <th>Time</th>
                    <th>Close</th>
                    <th>Pred</th>
                    <th>Signal</th>
                    {showActualColumns && (
                      <>
                        <th>Next close</th>
                        <th>Actual</th>
                        <th>Move</th>
                        {useOptionPnl ? (
                          <>
                            <th>Entry ₹</th>
                            <th>Target ₹</th>
                            <th>Exit ₹</th>
                            <th>Exit @</th>
                            <th>Hold</th>
                            <th>Lots</th>
                            <th>Trade P/L</th>
                          </>
                        ) : (
                          <th title="Nifty index points — not option ₹. Use Today for Zerodha option P/L.">
                            P/L pts
                          </th>
                        )}
                        <th>✓</th>
                      </>
                    )}
                  </tr>
                </thead>
                <tbody>
                  {backtest.bars.map((bar) => {
                    const displayPred = getBacktestDisplayPrediction(bar.probabilities);
                    const isDirectional = displayPred === "up" || displayPred === "down";
                    const directionalHit =
                      showActualColumns &&
                      bar.revealed &&
                      isDirectional &&
                      bar.actual === displayPred;

                    const pnl =
                      !useOptionPnl && showActualColumns && bar.revealed
                        ? tradePointsPnl(displayPred, bar.close, bar.nextClose)
                        : null;
                    const opt = bar.option;

                    return (
                    <tr
                      key={bar.time}
                      className={cn(
                        showActualColumns && bar.revealed && isDirectional && directionalHit && "row-match",
                        showActualColumns &&
                          bar.revealed &&
                          isDirectional &&
                          !directionalHit &&
                          bar.actual &&
                          "row-miss",
                      )}
                    >
                      <td>{bar.timeLabel}</td>
                      <td>{formatNumber(bar.close, 2)}</td>
                      <td className={`pred-${displayPred}`}>{displayPred.toUpperCase()}</td>
                      <td>{displaySignalForPrediction(displayPred)}</td>
                      {showActualColumns && (
                        <>
                          <td>
                            {bar.revealed && bar.nextClose != null
                              ? formatNumber(bar.nextClose, 2)
                              : "—"}
                          </td>
                          <td className={`pred-${bar.actual ?? ""}`}>
                            {bar.revealed && bar.actual ? bar.actual.toUpperCase() : "—"}
                          </td>
                          <td>
                            {bar.revealed && bar.futureReturnPct != null
                              ? `${bar.futureReturnPct >= 0 ? "+" : ""}${formatNumber(bar.futureReturnPct, 3)}%`
                              : "—"}
                          </td>
                          {useOptionPnl ? (
                            <>
                              <td>
                                {opt?.tradeEntered && opt.entryPremium != null
                                  ? `₹${formatNumber(opt.entryPremium, 2)}`
                                  : opt?.skipped
                                    ? "—"
                                    : isDirectional
                                      ? "…"
                                      : "—"}
                              </td>
                              <td>
                                {opt?.tradeEntered && opt.targetExitPremium != null
                                  ? `₹${formatNumber(opt.targetExitPremium, 2)}`
                                  : "—"}
                              </td>
                              <td>
                                {opt?.tradeEntered && opt.exitPremium != null
                                  ? `₹${formatNumber(opt.exitPremium, 2)}`
                                  : "—"}
                              </td>
                              <td>
                                {opt?.tradeEntered && opt.exitTimeLabel
                                  ? opt.exitTimeLabel
                                  : "—"}
                              </td>
                              <td>
                                {opt?.tradeEntered && opt.holdMinutes != null
                                  ? `${opt.holdMinutes}m`
                                  : "—"}
                              </td>
                              <td>{opt?.tradeEntered ? opt.lots : "—"}</td>
                              <td
                                className={
                                  opt?.tradeEntered && opt.pnlRupees != null
                                    ? opt.pnlRupees >= 0
                                      ? "text-up"
                                      : "text-down"
                                    : undefined
                                }
                              >
                                {opt?.skipped
                                  ? "skip"
                                  : opt?.tradeEntered && opt.pnlRupees != null
                                    ? `${opt.pnlRupees >= 0 ? "+" : ""}₹${formatNumber(opt.pnlRupees, 0)}${
                                        opt.exitReason === "open"
                                          ? " · open"
                                          : opt.exitReason === "target"
                                            ? " · tgt"
                                            : opt.exitReason === "stop"
                                              ? " · SL"
                                              : opt.exitReason === "eod"
                                                ? " · EOD"
                                                : ""
                                      }`
                                    : isDirectional && !bar.revealed
                                      ? "…"
                                      : "—"}
                              </td>
                            </>
                          ) : (
                            <td
                              className={
                                pnl != null ? (pnl >= 0 ? "text-up" : "text-down") : undefined
                              }
                            >
                              {!bar.revealed
                                ? isDirectional
                                  ? "…"
                                  : "—"
                                : pnl != null
                                  ? formatPointsPnl(pnl)
                                  : "—"}
                            </td>
                          )}
                          <td>
                            {!bar.revealed
                              ? "…"
                              : !isDirectional
                                ? "—"
                                : directionalHit
                                  ? "✓"
                                  : "✗"}
                          </td>
                        </>
                      )}
                    </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </section>

        <div className="prediction-grid prediction-grid-2">
          <section className="card prediction-panel">
            <h2 className="prediction-panel-title">Feature universe</h2>
            <ul className="prediction-feature-list">
              {status?.instruments.map((item) => (
                <li key={item.id}>
                  <strong>{item.label}</strong>
                  {item.kiteKey && <span className="text-muted">{item.kiteKey}</span>}
                </li>
              ))}
            </ul>
            <p className="text-muted prediction-note">
              7 layers: Nifty fut microstructure · weighted heavyweights (HDFC/ICICI/Reliance/Infy/TCS) ·
              Bank Nifty · options flow (PCR, OI, max pain) · order book OBI · time-of-day · VIX regime ·
              Gemini numeric sentiment. Label = next {intervalLabel} candle (+/−0.02%). Train on history; live predict
              enriches with depth + option chain + Gemini. Each interval keeps its own trained model.
            </p>
          </section>

          {metrics?.featureImportance && (
            <section className="card prediction-panel">
              <h2 className="prediction-panel-title">Feature importance</h2>
              <ul className="prediction-importance-list">
                {Object.entries(metrics.featureImportance)
                  .slice(0, 10)
                  .map(([name, score]) => (
                    <li key={name}>
                      <span>{name}</span>
                      <div className="prediction-importance-bar">
                        <div
                          style={{
                            width: `${(score / Math.max(...Object.values(metrics.featureImportance!))) * 100}%`,
                          }}
                        />
                      </div>
                    </li>
                  ))}
              </ul>
            </section>
          )}
        </div>

        <div className="card prediction-disclaimer">
          <AlertTriangle size={16} />
          <p>
            This is a research starter — not financial advice. Validate with walk-forward testing before
            live trading. Past accuracy does not guarantee future edge; options carry significant risk.
          </p>
        </div>
      </div>
    </DashboardShell>
  );
}
