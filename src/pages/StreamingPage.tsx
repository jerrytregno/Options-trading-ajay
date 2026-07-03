import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { Maximize2, Minimize2 } from "lucide-react";
import { DashboardShell } from "@/components/layout/dashboard-shell";
import { CandlestickChart } from "@/components/streaming/CandlestickChart";
import { useKite } from "@/contexts/kite-context";
import {
  mergeLiveQuote,
  parseKiteCandles,
  priceVelocity,
  volumePerSecond,
} from "@/lib/candles";
import {
  buildMovingAverageSeries,
  buildTechnicalSnapshot,
} from "@/lib/technical-indicators";
import type { OptionChainResponse } from "@/types/kite";
import type { GeminiSuggestionResponse, NiftyStreamResponse } from "@/types/streaming";
import { cn, formatNumber, getChangeClass } from "@/lib/utils";

const REFRESH_MS = 1000;

function legToUrl(action: string, strike: number | null) {
  if (!strike || action === "WAIT") return null;
  const leg = action.toLowerCase().replace(/_/g, "-");
  return `/dashboard/trade?strike=${strike}&leg=${leg}`;
}

function MetricCard({
  label,
  value,
  hint,
  valueClass,
}: {
  label: string;
  value: string;
  hint?: string;
  valueClass?: string;
}) {
  return (
    <div className="stream-metric-card">
      <p className="stream-metric-label">{label}</p>
      <p className={cn("stream-metric-value", valueClass)}>{value}</p>
      {hint && <p className="text-muted" style={{ fontSize: "0.75rem" }}>{hint}</p>}
    </div>
  );
}

export default function StreamingPage() {
  const { connected, loginUrl } = useKite();
  const [stream, setStream] = useState<NiftyStreamResponse | null>(null);
  const [chain, setChain] = useState<OptionChainResponse | null>(null);
  const [gemini, setGemini] = useState<GeminiSuggestionResponse | null>(null);
  const [geminiError, setGeminiError] = useState("");
  const [geminiWarning, setGeminiWarning] = useState("");
  const [aiFullscreen, setAiFullscreen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const geminiInflight = useRef(false);

  const candles = useMemo(() => {
    if (!stream) return [];
    const parsed = parseKiteCandles(stream.candles as unknown[]);
    return mergeLiveQuote(parsed, stream.quote.last_price, stream.quote.volume);
  }, [stream]);

  const technicals = useMemo(() => buildTechnicalSnapshot(candles), [candles]);
  const sma9Series = useMemo(() => buildMovingAverageSeries(candles, 9), [candles]);
  const sma20Series = useMemo(() => buildMovingAverageSeries(candles, 20), [candles]);

  const liveMetrics = useMemo(() => {
    const last = candles[candles.length - 1];
    if (!last) {
      return { volumePerSecond: 0, priceVelocity: 0, sessionHigh: 0, sessionLow: 0 };
    }
    return {
      volumePerSecond: volumePerSecond(last),
      priceVelocity: priceVelocity(last),
      sessionHigh: Math.max(...candles.map((c) => c.high)),
      sessionLow: Math.min(...candles.map((c) => c.low)),
    };
  }, [candles]);

  const loadStream = useCallback(async () => {
    if (!connected) return;
    try {
      const res = await fetch("/api/kite/nifty-stream", { credentials: "include" });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Failed to load stream");
      setStream(json.data as NiftyStreamResponse);
      setError("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Stream unavailable");
    }
  }, [connected]);

  const loadChain = useCallback(async () => {
    if (!connected) return;
    try {
      const res = await fetch("/api/kite/option-chain", { credentials: "include" });
      const json = await res.json();
      if (!res.ok) return;
      setChain(json.data as OptionChainResponse);
    } catch {
      setChain(null);
    }
  }, [connected]);

  const loadGemini = useCallback(async () => {
    if (!connected || geminiInflight.current || !stream || candles.length === 0) return;
    geminiInflight.current = true;
    try {
      const atmRow = chain?.chain.find((row) => row.isAtm);
      const res = await fetch("/api/gemini/trade-suggestion", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          spot: stream.quote.last_price,
          change: stream.quote.change,
          changePercent: stream.quote.change_percent,
          rsi: technicals.rsi14,
          trend: technicals.trend,
          emaCross: technicals.emaCross,
          macdHistogram: technicals.macd?.histogram ?? null,
          vwap: technicals.vwap,
          volumePerSecond: liveMetrics.volumePerSecond,
          sessionHigh: liveMetrics.sessionHigh,
          sessionLow: liveMetrics.sessionLow,
          atmStrike: chain?.atmStrike ?? null,
          expiry: chain?.expiry ?? null,
          atmCeLtp: atmRow?.ce?.quote?.last_price ?? null,
          atmPeLtp: atmRow?.pe?.quote?.last_price ?? null,
          lastCandle: candles[candles.length - 1],
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Gemini unavailable");
      const data = json.data as GeminiSuggestionResponse;
      setGemini(data);
      setGeminiError("");
      setGeminiWarning(data.stale ? (data.warning ?? "Showing last AI suggestion") : (data.warning ?? ""));
    } catch (err) {
      const message = err instanceof Error ? err.message : "Gemini unavailable";
      if (gemini) {
        setGeminiWarning(message);
        setGeminiError("");
      } else {
        setGeminiError(message);
      }
    } finally {
      geminiInflight.current = false;
    }
  }, [connected, stream, candles, chain, technicals, liveMetrics, gemini]);

  useEffect(() => {
    if (!connected) return;
    setLoading(true);
    Promise.all([loadStream(), loadChain()]).finally(() => setLoading(false));
  }, [connected, loadStream, loadChain]);

  useEffect(() => {
    if (!connected) return;
    const interval = window.setInterval(() => {
      loadStream();
    }, REFRESH_MS);
    return () => window.clearInterval(interval);
  }, [connected, loadStream]);

  useEffect(() => {
    if (!connected) return;
    const interval = window.setInterval(loadGemini, REFRESH_MS);
    loadGemini();
    return () => window.clearInterval(interval);
  }, [connected, loadGemini]);

  const tradeUrl = gemini?.suggestion
    ? legToUrl(gemini.suggestion.action, gemini.suggestion.strike)
    : null;

  useEffect(() => {
    if (!aiFullscreen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setAiFullscreen(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [aiFullscreen]);

  const renderGeminiPanel = (fullscreen = false) => (
    <>
      <div className={cn("card-header flex-between flex-wrap gap-3", fullscreen && "mb-4")}>
        <div>
          <h3 className="card-title">Gemini AI · 3.5 Flash</h3>
          <p className="card-desc">Real-time Nifty options trade suggestions</p>
        </div>
        <button
          type="button"
          className="btn btn-outline btn-sm"
          onClick={() => setAiFullscreen(!fullscreen)}
          aria-label={fullscreen ? "Exit fullscreen" : "Open AI fullscreen"}
        >
          {fullscreen ? <Minimize2 size={16} /> : <Maximize2 size={16} />}
          {fullscreen ? "Exit fullscreen" : "Fullscreen"}
        </button>
      </div>

      {geminiError && <div className="alert alert-error mb-4">{geminiError}</div>}
      {geminiWarning && !geminiError && (
        <div className="alert alert-warning mb-4">{geminiWarning}</div>
      )}

      {gemini?.suggestion ? (
        <div className="stream-ai-content">
          <div className="flex gap-2 flex-wrap mb-4">
            <span className={cn("badge", gemini.suggestion.bias === "bullish" ? "badge-success" : gemini.suggestion.bias === "bearish" ? "badge-danger" : "badge-default")}>
              {gemini.suggestion.bias}
            </span>
            <span className="badge badge-warning">{gemini.suggestion.confidence} confidence</span>
            <span className="badge badge-default">{gemini.suggestion.action.replace(/_/g, " ")}</span>
            {gemini.cached && <span className="badge badge-default">Cached</span>}
          </div>

          <p className="stream-ai-summary">{gemini.suggestion.summary}</p>

          {gemini.thinking && (
            <div className="stream-ai-section stream-ai-thinking">
              <p className="label">AI Reasoning</p>
              <p className="text-muted stream-ai-thinking-text">{gemini.thinking}</p>
            </div>
          )}

          <div className="stream-ai-section">
            <p className="label">Entry Plan</p>
            <p className="text-muted" style={{ fontSize: fullscreen ? "1rem" : "0.875rem" }}>
              {gemini.suggestion.entryPlan}
            </p>
          </div>
          <div className="stream-ai-section">
            <p className="label">Risk Plan</p>
            <p className="text-muted" style={{ fontSize: fullscreen ? "1rem" : "0.875rem" }}>
              {gemini.suggestion.riskPlan}
            </p>
          </div>
          <div className="stream-ai-section">
            <p className="label">Invalidation</p>
            <p className="text-muted" style={{ fontSize: fullscreen ? "1rem" : "0.875rem" }}>
              {gemini.suggestion.invalidation}
            </p>
          </div>

          {gemini.suggestion.strike && (
            <p className="text-muted mb-4" style={{ fontSize: "0.8125rem" }}>
              Strike {formatNumber(gemini.suggestion.strike, 0)} · {gemini.suggestion.product} · {gemini.suggestion.orderType}
            </p>
          )}

          {tradeUrl && (
            <Link to={tradeUrl} className="btn btn-primary btn-full">
              Open Trade Ticket
            </Link>
          )}

          <p className="text-muted mt-4" style={{ fontSize: "0.6875rem" }}>
            Model: {gemini.model}
            {gemini.updatedAt ? ` · Updated ${new Date(gemini.updatedAt).toLocaleTimeString("en-IN")}` : ""}
            {" · "}Not financial advice
          </p>
        </div>
      ) : (
        <div className="spinner-center" style={{ minHeight: "12rem" }}>
          <div className="spinner spinner-sm" />
          <p className="text-muted mt-3" style={{ fontSize: "0.875rem" }}>Analyzing market…</p>
        </div>
      )}
    </>
  );

  if (aiFullscreen) {
    return (
      <DashboardShell hideSidebar>
        <div className="stream-ai-fullscreen card">
          {renderGeminiPanel(true)}
        </div>
      </DashboardShell>
    );
  }

  return (
    <DashboardShell>
      <div className="flex-between flex-wrap gap-4 mb-6">
        <div className="page-header" style={{ marginBottom: 0 }}>
          <h1>Nifty 50 Streaming</h1>
          <p>Live 1-minute candles, technical metrics, and Gemini trade suggestions every second</p>
        </div>
        {stream && (
          <div className="flex gap-2 flex-wrap items-center">
            <span className="badge badge-success">Live · 1s</span>
            <span className={cn("badge", getChangeClass(stream.quote.change))}>
              {stream.quote.change >= 0 ? "+" : ""}
              {formatNumber(stream.quote.change)} ({formatNumber(stream.quote.change_percent)}%)
            </span>
            {stream.updatedAt && (
              <span className="text-muted" style={{ fontSize: "0.75rem" }}>
                Updated {new Date(stream.updatedAt).toLocaleTimeString("en-IN")}
              </span>
            )}
          </div>
        )}
      </div>

      {!connected ? (
        <div className="card">
          <p className="text-muted">Connect Zerodha to stream Nifty 50 candles and AI suggestions.</p>
          {loginUrl && (
            <a href={loginUrl} className="mt-4" style={{ display: "inline-block" }}>
              <button className="btn btn-primary">Connect Kite</button>
            </a>
          )}
        </div>
      ) : loading && !stream ? (
        <div className="spinner-center" style={{ minHeight: "16rem" }}>
          <div className="spinner spinner-sm" />
        </div>
      ) : (
        <div className="stream-layout">
          <div className="stream-main">
            {error && <div className="alert alert-error mb-4">{error}</div>}

            <div className="card mb-4">
              <div className="card-header flex-between flex-wrap gap-3">
                <div>
                  <h3 className="card-title">Nifty 50 · 1 Min</h3>
                  <p className="card-desc">{stream?.instrument ?? "NSE:NIFTY 50"}</p>
                </div>
                {stream && (
                  <p className={cn("font-semibold", getChangeClass(stream.quote.change))} style={{ fontSize: "1.5rem" }}>
                    {formatNumber(stream.quote.last_price)}
                  </p>
                )}
              </div>
              {candles.length > 0 ? (
                <CandlestickChart candles={candles} sma9={sma9Series} sma20={sma20Series} />
              ) : (
                <p className="text-muted p-4">Waiting for intraday candles…</p>
              )}
            </div>

            <div className="stream-metrics-grid mb-4">
              <MetricCard
                label="Volume / Sec"
                value={liveMetrics.volumePerSecond > 0 ? formatNumber(liveMetrics.volumePerSecond, 0) : "—"}
                hint="Current 1m candle pace"
              />
              <MetricCard
                label="Price Velocity"
                value={`${liveMetrics.priceVelocity >= 0 ? "+" : ""}${formatNumber(liveMetrics.priceVelocity, 3)}/s`}
                hint="Open to close per second"
                valueClass={getChangeClass(liveMetrics.priceVelocity)}
              />
              <MetricCard label="Session High" value={formatNumber(liveMetrics.sessionHigh)} />
              <MetricCard label="Session Low" value={formatNumber(liveMetrics.sessionLow)} />
              <MetricCard
                label="RSI (14)"
                value={technicals.rsi14 != null ? formatNumber(technicals.rsi14, 1) : "—"}
                hint={technicals.rsi14 != null && technicals.rsi14 > 70 ? "Overbought zone" : technicals.rsi14 != null && technicals.rsi14 < 30 ? "Oversold zone" : "Momentum"}
                valueClass={
                  technicals.rsi14 != null && technicals.rsi14 > 70
                    ? "text-down"
                    : technicals.rsi14 != null && technicals.rsi14 < 30
                      ? "text-up"
                      : undefined
                }
              />
              <MetricCard label="SMA 9" value={technicals.sma9 != null ? formatNumber(technicals.sma9) : "—"} />
              <MetricCard label="SMA 20" value={technicals.sma20 != null ? formatNumber(technicals.sma20) : "—"} />
              <MetricCard label="SMA 50" value={technicals.sma50 != null ? formatNumber(technicals.sma50) : "—"} />
              <MetricCard label="EMA 9" value={technicals.ema9 != null ? formatNumber(technicals.ema9) : "—"} />
              <MetricCard label="EMA 21" value={technicals.ema21 != null ? formatNumber(technicals.ema21) : "—"} />
              <MetricCard
                label="VWAP"
                value={technicals.vwap != null ? formatNumber(technicals.vwap) : "—"}
                hint="Intraday volume weighted"
              />
              <MetricCard label="ATR (14)" value={technicals.atr14 != null ? formatNumber(technicals.atr14) : "—"} hint="Volatility" />
              <MetricCard
                label="MACD Hist"
                value={technicals.macd ? formatNumber(technicals.macd.histogram, 3) : "—"}
                valueClass={technicals.macd ? getChangeClass(technicals.macd.histogram) : undefined}
              />
              <MetricCard
                label="Bollinger"
                value={
                  technicals.bollinger
                    ? `${formatNumber(technicals.bollinger.lower)} – ${formatNumber(technicals.bollinger.upper)}`
                    : "—"
                }
                hint="Lower – upper band"
              />
              <MetricCard
                label="Trend"
                value={technicals.trend.toUpperCase()}
                hint={technicals.emaCross !== "none" ? `${technicals.emaCross} cross` : "EMA 9 vs 21"}
                valueClass={technicals.trend === "bullish" ? "text-up" : technicals.trend === "bearish" ? "text-down" : undefined}
              />
            </div>
          </div>

          <aside className="stream-ai-panel card">
            {renderGeminiPanel(false)}
          </aside>
        </div>
      )}
    </DashboardShell>
  );
}
