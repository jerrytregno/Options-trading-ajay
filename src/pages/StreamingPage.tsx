import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { Maximize2, Minimize2 } from "lucide-react";
import { DashboardShell } from "@/components/layout/dashboard-shell";
import { StreamingChart } from "@/components/streaming/StreamingChart";
import { useKite } from "@/contexts/kite-context";
import type { ParsedCandle } from "@/lib/candles";
import { appendSecondCandle } from "@/lib/second-candles";
import {
  buildRsiSeries,
  buildTechnicalSnapshot,
  calculateFibonacciRetracement,
} from "@/lib/technical-indicators";
import type { OptionChainResponse } from "@/types/kite";
import type { GeminiSuggestionResponse, NiftyStreamResponse } from "@/types/streaming";
import { cn, formatNumber, getChangeClass } from "@/lib/utils";
import { formatIndianDateTime } from "@/lib/market-time";

const REFRESH_MS = 1000;
const CHART_HEIGHT = 480;
const CHART_HEIGHT_FULLSCREEN = 560;

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
  const [secondCandles, setSecondCandles] = useState<ParsedCandle[]>([]);
  const [chain, setChain] = useState<OptionChainResponse | null>(null);
  const [gemini, setGemini] = useState<GeminiSuggestionResponse | null>(null);
  const [geminiError, setGeminiError] = useState("");
  const [geminiWarning, setGeminiWarning] = useState("");
  const [pageFullscreen, setPageFullscreen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const geminiInflight = useRef(false);
  const lastQuoteVolumeRef = useRef(0);

  const technicals = useMemo(() => buildTechnicalSnapshot(secondCandles), [secondCandles]);
  const rsiSeries = useMemo(() => buildRsiSeries(secondCandles, 14), [secondCandles]);
  const fibLevels = useMemo(() => {
    if (secondCandles.length === 0) return [];
    const high = Math.max(...secondCandles.map((c) => c.high));
    const low = Math.min(...secondCandles.map((c) => c.low));
    return calculateFibonacciRetracement(high, low);
  }, [secondCandles]);

  const liveMetrics = useMemo(() => {
    const last = secondCandles[secondCandles.length - 1];
    if (!last) {
      return { volumePerSecond: 0, priceVelocity: 0, sessionHigh: 0, sessionLow: 0 };
    }
    return {
      volumePerSecond: last.volume,
      priceVelocity: last.close - last.open,
      sessionHigh: Math.max(...secondCandles.map((c) => c.high)),
      sessionLow: Math.min(...secondCandles.map((c) => c.low)),
    };
  }, [secondCandles]);

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

  useEffect(() => {
    if (!stream?.quote.last_price) return;
    const vol = stream.quote.volume ?? 0;
    setSecondCandles((prev) =>
      appendSecondCandle(prev, stream.quote.last_price, vol, lastQuoteVolumeRef.current)
    );
    lastQuoteVolumeRef.current = vol;
  }, [stream]);

  useEffect(() => {
    if (!connected) {
      setSecondCandles([]);
      lastQuoteVolumeRef.current = 0;
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
    if (!connected || geminiInflight.current || !stream || secondCandles.length === 0) return;
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
          fibLevels: fibLevels.map((f) => ({ label: f.label, price: f.price })),
          atmStrike: chain?.atmStrike ?? null,
          expiry: chain?.expiry ?? null,
          atmCeLtp: atmRow?.ce?.quote?.last_price ?? null,
          atmPeLtp: atmRow?.pe?.quote?.last_price ?? null,
          lastCandle: secondCandles[secondCandles.length - 1],
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
  }, [connected, stream, secondCandles, chain, technicals, liveMetrics, fibLevels, gemini]);

  useEffect(() => {
    if (!connected) return;
    setLoading(true);
    Promise.all([loadStream(), loadChain()]).finally(() => setLoading(false));
  }, [connected, loadStream, loadChain]);

  useEffect(() => {
    if (!connected) return;
    const interval = window.setInterval(loadStream, REFRESH_MS);
    return () => window.clearInterval(interval);
  }, [connected, loadStream]);

  useEffect(() => {
    if (!connected) return;
    const interval = window.setInterval(loadGemini, REFRESH_MS);
    loadGemini();
    return () => window.clearInterval(interval);
  }, [connected, loadGemini]);

  useEffect(() => {
    if (!pageFullscreen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setPageFullscreen(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [pageFullscreen]);

  const tradeUrl = gemini?.suggestion
    ? legToUrl(gemini.suggestion.action, gemini.suggestion.strike)
    : null;

  const renderGeminiPanel = () => (
    <>
      <div className="card-header">
        <h3 className="card-title">Gemini AI · 3.5 Flash</h3>
        <p className="card-desc">Real-time Nifty options trade suggestions</p>
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
            <p className="text-muted" style={{ fontSize: "0.875rem" }}>{gemini.suggestion.entryPlan}</p>
          </div>
          <div className="stream-ai-section">
            <p className="label">Risk Plan</p>
            <p className="text-muted" style={{ fontSize: "0.875rem" }}>{gemini.suggestion.riskPlan}</p>
          </div>
          <div className="stream-ai-section">
            <p className="label">Invalidation</p>
            <p className="text-muted" style={{ fontSize: "0.875rem" }}>{gemini.suggestion.invalidation}</p>
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
            {gemini.updatedAt ? ` · Updated ${formatIndianDateTime(new Date(gemini.updatedAt))}` : ""}
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

  const renderHeader = () => (
    <div className="flex-between flex-wrap gap-4 mb-6">
      <div className="page-header" style={{ marginBottom: 0 }}>
        <h1>Nifty 50 Streaming</h1>
        <p>Live 1-second candles with Fib, RSI, volume, and Gemini AI every second</p>
      </div>
      <div className="flex gap-2 flex-wrap items-center">
        {stream && (
          <>
            <span className="badge badge-success">Live · 1s</span>
            <span className={cn("badge", getChangeClass(stream.quote.change))}>
              {stream.quote.change >= 0 ? "+" : ""}
              {formatNumber(stream.quote.change)} ({formatNumber(stream.quote.change_percent)}%)
            </span>
            {stream.updatedAt && (
              <span className="text-muted" style={{ fontSize: "0.75rem" }}>
                Updated {formatIndianDateTime(new Date(stream.updatedAt))}
              </span>
            )}
          </>
        )}
        {connected && (
          <button
            type="button"
            className="btn btn-outline btn-sm"
            onClick={() => setPageFullscreen(!pageFullscreen)}
          >
            {pageFullscreen ? <Minimize2 size={16} /> : <Maximize2 size={16} />}
            {pageFullscreen ? "Exit fullscreen" : "Fullscreen"}
          </button>
        )}
      </div>
    </div>
  );

  const renderStreamContent = () => {
    if (!connected) {
      return (
        <div className="card">
          <p className="text-muted">Connect Zerodha to stream Nifty 50 candles and AI suggestions.</p>
          {loginUrl && (
            <a href={loginUrl} className="mt-4" style={{ display: "inline-block" }}>
              <button className="btn btn-primary">Connect Kite</button>
            </a>
          )}
        </div>
      );
    }

    if (loading && !stream) {
      return (
        <div className="spinner-center" style={{ minHeight: "16rem" }}>
          <div className="spinner spinner-sm" />
        </div>
      );
    }

    return (
      <div className="stream-layout">
        <div className="stream-main">
          {error && <div className="alert alert-error mb-4">{error}</div>}

          <div className="card mb-4">
            <div className="card-header flex-between flex-wrap gap-3">
              <div>
                <h3 className="card-title">Nifty 50 · 1 Sec</h3>
                <p className="card-desc">
                  {stream?.instrument ?? "NSE:NIFTY 50"} · {secondCandles.length} candles buffered
                </p>
              </div>
              {stream && (
                <p className={cn("font-semibold", getChangeClass(stream.quote.change))} style={{ fontSize: "1.5rem" }}>
                  {formatNumber(stream.quote.last_price)}
                </p>
              )}
            </div>
            {secondCandles.length > 0 ? (
              <StreamingChart
                candles={secondCandles}
                fibLevels={fibLevels}
                rsiSeries={rsiSeries}
                height={pageFullscreen ? CHART_HEIGHT_FULLSCREEN : CHART_HEIGHT}
              />
            ) : (
              <p className="text-muted p-4">Building 1-second candles from live quotes…</p>
            )}
          </div>

          <div className="stream-metrics-grid mb-4">
            <MetricCard label="Volume / Sec" value={formatNumber(liveMetrics.volumePerSecond, 0)} hint="Current 1s bar" />
            <MetricCard
              label="Price Move / Sec"
              value={`${liveMetrics.priceVelocity >= 0 ? "+" : ""}${formatNumber(liveMetrics.priceVelocity, 2)}`}
              valueClass={getChangeClass(liveMetrics.priceVelocity)}
            />
            <MetricCard label="Range High" value={formatNumber(liveMetrics.sessionHigh)} />
            <MetricCard label="Range Low" value={formatNumber(liveMetrics.sessionLow)} />
            <MetricCard
              label="RSI (14)"
              value={technicals.rsi14 != null ? formatNumber(technicals.rsi14, 1) : "—"}
              hint={technicals.rsi14 != null && technicals.rsi14 > 70 ? "Overbought" : technicals.rsi14 != null && technicals.rsi14 < 30 ? "Oversold" : "On chart"}
              valueClass={
                technicals.rsi14 != null && technicals.rsi14 > 70
                  ? "text-down"
                  : technicals.rsi14 != null && technicals.rsi14 < 30
                    ? "text-up"
                    : undefined
              }
            />
            <MetricCard
              label="Fib 50%"
              value={
                fibLevels.find((f) => f.ratio === 0.5)
                  ? formatNumber(fibLevels.find((f) => f.ratio === 0.5)!.price)
                  : "—"
              }
              hint="Mid retracement"
            />
            <MetricCard label="SMA 9" value={technicals.sma9 != null ? formatNumber(technicals.sma9) : "—"} />
            <MetricCard label="EMA 9" value={technicals.ema9 != null ? formatNumber(technicals.ema9) : "—"} />
            <MetricCard label="VWAP" value={technicals.vwap != null ? formatNumber(technicals.vwap) : "—"} />
            <MetricCard
              label="Trend"
              value={technicals.trend.toUpperCase()}
              valueClass={technicals.trend === "bullish" ? "text-up" : technicals.trend === "bearish" ? "text-down" : undefined}
            />
          </div>
        </div>

        <aside className="stream-ai-panel card">{renderGeminiPanel()}</aside>
      </div>
    );
  };

  if (pageFullscreen) {
    return (
      <DashboardShell hideSidebar>
        <div className="stream-page-fullscreen">
          {renderHeader()}
          {renderStreamContent()}
        </div>
      </DashboardShell>
    );
  }

  return (
    <DashboardShell>
      {renderHeader()}
      {renderStreamContent()}
    </DashboardShell>
  );
}
