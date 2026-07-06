import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { Activity, Brain, LineChart, Maximize2, Minimize2, Sparkles } from "lucide-react";
import { DashboardShell } from "@/components/layout/dashboard-shell";
import { StreamingChart } from "@/components/streaming/StreamingChart";
import { FormulaOrchestrator } from "@/components/trade/FormulaOrchestrator";
import { useConfirm } from "@/contexts/confirm-context";
import { useKite } from "@/contexts/kite-context";
import { buildAutoTradePlan, saveAutoTradePlan } from "@/lib/auto-trade";
import type { ParsedCandle } from "@/lib/candles";
import { appendSecondCandle } from "@/lib/second-candles";
import {
  buildRsiSeries,
  buildTechnicalSnapshot,
  calculateFibonacciRetracement,
} from "@/lib/technical-indicators";
import { aggregateSecondCandlesToMinutes, mergeMinuteCandles } from "@/lib/minute-candles";
import { compactRecent1s } from "@/lib/session-context";
import {
  DEFAULT_STREAM_INSTRUMENT_ID,
  getStreamInstrument,
  STREAM_INSTRUMENTS,
} from "@/lib/stream-instruments";
import type { OptionChainResponse } from "@/types/kite";
import type { GeminiSuggestionResponse, NiftySessionResponse, NiftyStreamResponse } from "@/types/streaming";
import { cn, formatNumber, getChangeClass } from "@/lib/utils";
import { formatIndianDateTime } from "@/lib/market-time";
import {
  FORMULA_VARIANTS,
  formulaCallEntryLabel,
  formulaPutEntryLabel,
  isPastFormulaHardExit,
  type FormulaVariantId,
} from "@/lib/formula-trade";

const REFRESH_MS = 1000;
const SESSION_REFRESH_MS = 60000;
const STREAMING_AI_KEY = "optionflow_streaming_ai";
const STREAMING_LIVE_KEY = "optionflow_streaming_live";
const STREAMING_FORMULA_VARIANT_KEY = "optionflow_formula_variant";
const STREAMING_INSTRUMENT_KEY = "optionflow_stream_instrument";
const CHART_HEIGHT = 480;
const CHART_HEIGHT_FULLSCREEN = 560;

function FormulaTradingConfirmBody({ variant }: { variant: FormulaVariantId }) {
  const variantRule = FORMULA_VARIANTS[variant];

  return (
    <>
      <p className="confirm-note mb-3">
        {variantRule.name} · {variantRule.shortLabel}
        {isPastFormulaHardExit() && (
          <>
            {" "}
            · <strong>Past 3:15 PM</strong> — scan + RSI only, no new entries today
          </>
        )}
      </p>
      <div className="confirm-section">
        <p className="confirm-section-title">Entry</p>
        <ul className="confirm-list">
          <li>Scans Nifty 50, Sensex, Dixon, HDFC Bank · ATM CE/PE</li>
          <li>Call: {formulaCallEntryLabel(variant)}</li>
          <li>Put: {formulaPutEntryLabel(variant)}</li>
          <li>One open trade globally · first signal wins</li>
        </ul>
      </div>
      <div className="confirm-section">
        <p className="confirm-section-title">Exit</p>
        <ul className="confirm-list">
          <li>Take profit +8–12% · stop loss −15% · no time stop</li>
          <li>3:15–3:29 PM: exit at ≥0.5% profit · force exit 3:29 PM</li>
        </ul>
      </div>
      <div className="confirm-section">
        <p className="confirm-section-title">Risk & loop</p>
        <ul className="confirm-list">
          <li>1% capital per trade · stop after 2 losses</li>
          <li>One open position at a time · 5 × 1-minute bar cooldown between trades</li>
          <li>Next valid Call or Put after each exit (no forced alternation)</li>
        </ul>
      </div>
      <p className="confirm-note">REAL Zerodha orders — no Gemini.</p>
    </>
  );
}

function legToUrl(action: string, strike: number | null, auto = false) {
  if (!strike || action === "WAIT") return null;
  const leg = action.toLowerCase().replace(/_/g, "-");
  return `/dashboard/trade?strike=${strike}&leg=${leg}${auto ? "&auto=1" : ""}`;
}

function optionLtpForAction(
  chain: OptionChainResponse | null,
  action: string,
  strike: number | null
): number {
  if (!chain || !strike) return 0;
  const row = chain.chain.find((r) => r.strike === strike);
  if (!row) return 0;
  if (action.startsWith("CE")) return row.ce?.quote?.last_price ?? 0;
  if (action.startsWith("PE")) return row.pe?.quote?.last_price ?? 0;
  return 0;
}

function parseSymbolScan(line?: string) {
  if (!line) return { rsi: null as string | null, hint: "", signal: false };
  const signal = line.includes("SIGNAL");
  const rsiMatch = line.match(/RSI ([\d.]+|—)/);
  const rsi = rsiMatch?.[1] ?? null;
  let hint = "";
  if (signal) hint = "Signal";
  else if (line.includes("watching")) hint = "Watching";
  else if (line.includes("scan only")) hint = "Scan only";
  else if (line.includes("paused")) hint = "Paused";
  else if (line.includes("stream off")) hint = "Stream off";
  else if (line.includes("starting")) hint = "Starting…";
  else if (line.includes("warming")) hint = "Warming up";
  else if (line.includes("no quote")) hint = "No quote";
  else hint = line.split("·").pop()?.trim() ?? "";
  return { rsi, hint, signal };
}

function MetricCell({
  label,
  value,
  valueClass,
}: {
  label: string;
  value: string;
  valueClass?: string;
}) {
  return (
    <div className="stream-metric-cell">
      <p className="stream-metric-label">{label}</p>
      <p className={cn("stream-metric-value", valueClass)}>{value}</p>
    </div>
  );
}

export default function StreamingPage() {
  const { connected, loginUrl } = useKite();
  const { confirm } = useConfirm();
  const navigate = useNavigate();
  const [stream, setStream] = useState<NiftyStreamResponse | null>(null);
  const [secondCandles, setSecondCandles] = useState<ParsedCandle[]>([]);
  const [chain, setChain] = useState<OptionChainResponse | null>(null);
  const [gemini, setGemini] = useState<GeminiSuggestionResponse | null>(null);
  const [geminiError, setGeminiError] = useState("");
  const [geminiWarning, setGeminiWarning] = useState("");
  const [sessionData, setSessionData] = useState<NiftySessionResponse | null>(null);
  const [pageFullscreen, setPageFullscreen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [formulaTrading, setFormulaTrading] = useState(false);
  const [formulaWatchStatus, setFormulaWatchStatus] = useState<Record<string, string>>({});
  const [formulaVariant, setFormulaVariant] = useState<FormulaVariantId>(() => {
    try {
      return sessionStorage.getItem(STREAMING_FORMULA_VARIANT_KEY) === "2" ? 2 : 1;
    } catch {
      return 1;
    }
  });
  const [aiStreaming, setAiStreaming] = useState(() => {
    try {
      return sessionStorage.getItem(STREAMING_AI_KEY) !== "off";
    } catch {
      return true;
    }
  });
  const [marketStreaming, setMarketStreaming] = useState(() => {
    try {
      return sessionStorage.getItem(STREAMING_LIVE_KEY) !== "off";
    } catch {
      return true;
    }
  });
  const [streamInstrumentId, setStreamInstrumentId] = useState(() => {
    try {
      const saved = sessionStorage.getItem(STREAMING_INSTRUMENT_KEY);
      return saved && getStreamInstrument(saved) ? saved : DEFAULT_STREAM_INSTRUMENT_ID;
    } catch {
      return DEFAULT_STREAM_INSTRUMENT_ID;
    }
  });
  const selectedInstrument = useMemo(
    () => getStreamInstrument(streamInstrumentId),
    [streamInstrumentId]
  );
  const geminiInflight = useRef(false);
  const lastQuoteVolumeRef = useRef(0);
  const sessionContextRef = useRef<NiftySessionResponse["session"]>(null);
  const recent1sRef = useRef<string[]>([]);
  const secondCandlesRef = useRef<ParsedCandle[]>([]);

  const streamMinuteCandles = useMemo(
    () => aggregateSecondCandlesToMinutes(secondCandles),
    [secondCandles]
  );
  const minuteCandles = useMemo(
    () => mergeMinuteCandles(sessionData?.candles ?? [], streamMinuteCandles),
    [sessionData?.candles, streamMinuteCandles]
  );
  const technicals = useMemo(() => buildTechnicalSnapshot(minuteCandles), [minuteCandles]);
  const rsiSeries = useMemo(() => buildRsiSeries(minuteCandles, 14), [minuteCandles]);

  const liveMetrics = useMemo(() => {
    const last = minuteCandles[minuteCandles.length - 1];
    if (!last) {
      return { volumePerMinute: 0, priceMove: 0, sessionHigh: 0, sessionLow: 0 };
    }
    return {
      volumePerMinute: last.volume,
      priceMove: last.close - last.open,
      sessionHigh: Math.max(...minuteCandles.map((c) => c.high)),
      sessionLow: Math.min(...minuteCandles.map((c) => c.low)),
    };
  }, [minuteCandles]);

  const sessionFibLevels = useMemo(() => {
    if (liveMetrics.sessionHigh <= liveMetrics.sessionLow) return [];
    return calculateFibonacciRetracement(liveMetrics.sessionHigh, liveMetrics.sessionLow);
  }, [liveMetrics.sessionHigh, liveMetrics.sessionLow]);

  useEffect(() => {
    secondCandlesRef.current = secondCandles;
    recent1sRef.current = compactRecent1s(secondCandles);
  }, [secondCandles]);

  useEffect(() => {
    sessionContextRef.current = sessionData?.session ?? null;
  }, [sessionData]);

  const loadStream = useCallback(async () => {
    if (!connected || !marketStreaming) return;
    const instrument = selectedInstrument.kiteKey;
    try {
      const res = await fetch(
        `/api/kite/quote-stream?instrument=${encodeURIComponent(instrument)}`,
        { credentials: "include" }
      );
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Failed to load stream");
      setStream(json.data as NiftyStreamResponse);
      setError("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Stream unavailable");
    }
  }, [connected, marketStreaming, selectedInstrument.kiteKey]);

  const loadSession = useCallback(async () => {
    if (!connected) return;
    const instrument = selectedInstrument.kiteKey;
    try {
      const res = await fetch(
        `/api/kite/instrument-session?instrument=${encodeURIComponent(instrument)}`,
        { credentials: "include" }
      );
      const json = await res.json();
      if (!res.ok) return;
      setSessionData(json.data as NiftySessionResponse);
    } catch {
      /* keep last session snapshot */
    }
  }, [connected, selectedInstrument.kiteKey]);

  useEffect(() => {
    if (!marketStreaming || !stream?.quote.last_price) return;
    const vol = stream.quote.volume ?? 0;
    setSecondCandles((prev) =>
      appendSecondCandle(prev, stream.quote.last_price, vol, lastQuoteVolumeRef.current)
    );
    lastQuoteVolumeRef.current = vol;
  }, [stream, marketStreaming]);

  useEffect(() => {
    if (!connected) {
      setSecondCandles([]);
      lastQuoteVolumeRef.current = 0;
    }
  }, [connected]);

  const loadChain = useCallback(async () => {
    if (!connected) return;
    try {
      const res = await fetch(
        `/api/kite/option-chain?underlying=${encodeURIComponent(streamInstrumentId)}`,
        { credentials: "include" }
      );
      const json = await res.json();
      if (!res.ok) return;
      setChain(json.data as OptionChainResponse);
    } catch {
      setChain(null);
    }
  }, [connected, streamInstrumentId]);

  const loadGemini = useCallback(async () => {
    if (
      !connected ||
      !marketStreaming ||
      !aiStreaming ||
      geminiInflight.current ||
      !stream ||
      secondCandlesRef.current.length === 0
    ) {
      return;
    }
    geminiInflight.current = true;
    try {
      const atmRow = chain?.chain.find((row) => row.isAtm);
      const res = await fetch("/api/gemini/trade-suggestion", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          underlyingId: streamInstrumentId,
          instrumentLabel: selectedInstrument.label,
          chainSymbol: selectedInstrument.chainSymbol,
          chainExchange: selectedInstrument.chainExchange,
          spot: stream.quote.last_price,
          change: stream.quote.change,
          changePercent: stream.quote.change_percent,
          rsi: technicals.rsi14,
          trend: technicals.trend,
          emaCross: technicals.emaCross,
          macdHistogram: technicals.macd?.histogram ?? null,
          vwap: technicals.vwap,
          volumePerSecond: liveMetrics.volumePerMinute,
          sessionHigh: liveMetrics.sessionHigh,
          sessionLow: liveMetrics.sessionLow,
          fibLevels: sessionFibLevels.map((f) => ({ label: f.label, price: f.price })),
          atmStrike: chain?.atmStrike ?? null,
          expiry: chain?.expiry ?? null,
          atmCeLtp: atmRow?.ce?.quote?.last_price ?? null,
          atmPeLtp: atmRow?.pe?.quote?.last_price ?? null,
          sessionContext: sessionContextRef.current,
          recent1s: recent1sRef.current,
          lastCandle: secondCandlesRef.current[secondCandlesRef.current.length - 1] ?? null,
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
  }, [connected, marketStreaming, aiStreaming, streamInstrumentId, selectedInstrument, stream, chain, technicals, liveMetrics, sessionFibLevels, gemini]);

  const selectStreamInstrument = (id: string) => {
    if (id === streamInstrumentId) return;
    setStreamInstrumentId(id);
    setSecondCandles([]);
    lastQuoteVolumeRef.current = 0;
    setStream(null);
    setSessionData(null);
    setGemini(null);
    setGeminiError("");
    setGeminiWarning("");
    try {
      sessionStorage.setItem(STREAMING_INSTRUMENT_KEY, id);
    } catch {
      /* ignore */
    }
  };

  useEffect(() => {
    if (!connected || !marketStreaming || !aiStreaming) return;
    const interval = window.setInterval(loadGemini, REFRESH_MS);
    loadGemini();
    return () => window.clearInterval(interval);
  }, [connected, marketStreaming, aiStreaming, streamInstrumentId, loadGemini]);

  useEffect(() => {
    if (!connected || !marketStreaming) return;
    void loadChain();
  }, [connected, marketStreaming, streamInstrumentId, loadChain]);

  const toggleMarketStreaming = () => {
    setMarketStreaming((prev) => {
      const next = !prev;
      try {
        sessionStorage.setItem(STREAMING_LIVE_KEY, next ? "on" : "off");
      } catch {
        /* ignore */
      }
      if (!next) {
        setFormulaTrading(false);
      }
      return next;
    });
  };

  const toggleAiStreaming = () => {
    setAiStreaming((prev) => {
      const next = !prev;
      try {
        sessionStorage.setItem(STREAMING_AI_KEY, next ? "on" : "off");
      } catch {
        /* ignore */
      }
      return next;
    });
  };

  useEffect(() => {
    if (!connected || !marketStreaming) return;
    setLoading(true);
    Promise.all([loadStream(), loadChain(), loadSession()]).finally(() => setLoading(false));
  }, [connected, marketStreaming, loadStream, loadChain, loadSession]);

  useEffect(() => {
    if (!connected || !marketStreaming) return;
    const interval = window.setInterval(loadSession, SESSION_REFRESH_MS);
    return () => window.clearInterval(interval);
  }, [connected, marketStreaming, loadSession]);

  useEffect(() => {
    if (!connected || !marketStreaming) return;
    const interval = window.setInterval(loadStream, REFRESH_MS);
    return () => window.clearInterval(interval);
  }, [connected, marketStreaming, loadStream]);

  useEffect(() => {
    if (!pageFullscreen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setPageFullscreen(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [pageFullscreen]);

  const handleStartFormulaTrading = async () => {
    if (!connected || !marketStreaming) return;
    const ok = await confirm({
      title: `Start ${FORMULA_VARIANTS[formulaVariant].name}?`,
      body: <FormulaTradingConfirmBody variant={formulaVariant} />,
      confirmLabel: "Start trading",
      tone: "danger",
    });
    if (!ok) return;
    setFormulaWatchStatus(
      Object.fromEntries(STREAM_INSTRUMENTS.map((i) => [i.id, "starting…"]))
    );
    setFormulaTrading(true);
  };

  const handleStopFormula = () => {
    setFormulaTrading(false);
    setFormulaWatchStatus({});
  };

  const selectFormulaVariant = (variant: FormulaVariantId) => {
    if (formulaTrading) return;
    setFormulaVariant(variant);
    try {
      sessionStorage.setItem(STREAMING_FORMULA_VARIANT_KEY, String(variant));
    } catch {
      /* ignore */
    }
  };

  const tradeUrl = gemini?.suggestion
    ? legToUrl(gemini.suggestion.action, gemini.suggestion.strike)
    : null;
  const autoTradeUrl = gemini?.suggestion
    ? legToUrl(gemini.suggestion.action, gemini.suggestion.strike, true)
    : null;

  const handleStartAutoTrade = async () => {
    if (!gemini?.suggestion || !autoTradeUrl) return;
    const { action, strike } = gemini.suggestion;
    if (action === "WAIT" || !strike) return;
    const optionLtp = optionLtpForAction(chain, action, strike);
    const ok = await confirm({
      title: "Start AI auto-trade?",
      body: (
        <>
          <p>
            {action.replace(/_/g, " ")} @ strike {formatNumber(strike)}
            {optionLtp > 0 ? ` · LTP ${formatNumber(optionLtp)}` : ""}
          </p>
          <p>
            AI will wait for the right entry, place a REAL Zerodha order, and exit at target/stop.
          </p>
          <p className="confirm-note">REAL Zerodha orders — real money.</p>
        </>
      ),
      confirmLabel: "Start auto-trade",
      tone: "danger",
    });
    if (!ok) return;
    saveAutoTradePlan(buildAutoTradePlan(gemini.suggestion, optionLtp));
    navigate(autoTradeUrl);
  };

  const renderGeminiPanel = () => (
    <div className="stream-ai-panel-inner">
      <div className="stream-ai-head">
        <div className="stream-ai-brand">
          <div className="stream-ai-icon-wrap">
            <Brain size={18} />
          </div>
          <div>
            <p className="stream-ai-title">Gemini AI</p>
            <p className="stream-ai-subtitle">{selectedInstrument.label} options · 3.5 Flash</p>
          </div>
        </div>
        <label className="stream-ai-toggle" title={aiStreaming ? "Pause AI" : "Resume AI"}>
          <span className="stream-ai-toggle-label">{aiStreaming ? "On" : "Off"}</span>
          <input
            type="checkbox"
            checked={aiStreaming}
            onChange={toggleAiStreaming}
            disabled={!marketStreaming}
            aria-label="Toggle Gemini AI"
          />
          <span className="stream-ai-toggle-track" aria-hidden />
        </label>
      </div>

      {!marketStreaming && (
        <div className="stream-ai-notice stream-ai-notice-warning">
          Stream is paused. Turn on live data to refresh AI context.
        </div>
      )}

      {!aiStreaming && (
        <div className="stream-ai-notice stream-ai-notice-warning">
          AI paused — no API calls. Toggle <strong>On</strong> to resume.
        </div>
      )}

      {geminiError && aiStreaming && (
        <div className="stream-ai-notice stream-ai-notice-error">{geminiError}</div>
      )}
      {geminiWarning && !geminiError && aiStreaming && (
        <div className="stream-ai-notice stream-ai-notice-warning">{geminiWarning}</div>
      )}

      {!aiStreaming && gemini?.suggestion ? (
        <div className="stream-ai-content">
          <span className="stream-ai-tag">Last suggestion</span>
          <p className="stream-ai-summary">{gemini.suggestion.summary}</p>
          <p className="text-muted" style={{ fontSize: "0.8125rem" }}>
            {gemini.suggestion.action.replace(/_/g, " ")}
            {gemini.suggestion.strike ? ` · ${formatNumber(gemini.suggestion.strike, 0)}` : ""}
          </p>
        </div>
      ) : gemini?.suggestion ? (
        <div className="stream-ai-content">
          <div className="stream-ai-tags">
            <span
              className={cn(
                "stream-ai-tag",
                gemini.suggestion.bias === "bullish" && "stream-ai-tag-bull",
                gemini.suggestion.bias === "bearish" && "stream-ai-tag-bear"
              )}
            >
              {gemini.suggestion.bias}
            </span>
            <span className="stream-ai-tag">{gemini.suggestion.confidence}</span>
            <span className="stream-ai-tag">{gemini.suggestion.action.replace(/_/g, " ")}</span>
            {gemini.cached && <span className="stream-ai-tag">Cached</span>}
          </div>

          <p className="stream-ai-summary">{gemini.suggestion.summary}</p>

          {gemini.thinking && (
            <div className="stream-ai-block">
              <p className="stream-ai-block-title">Reasoning</p>
              <p className="text-muted stream-ai-thinking-text">{gemini.thinking}</p>
            </div>
          )}

          <div className="stream-ai-block">
            <p className="stream-ai-block-title">Entry</p>
            <p className="text-muted" style={{ fontSize: "0.8125rem" }}>{gemini.suggestion.entryPlan}</p>
          </div>
          <div className="stream-ai-block">
            <p className="stream-ai-block-title">Risk</p>
            <p className="text-muted" style={{ fontSize: "0.8125rem" }}>{gemini.suggestion.riskPlan}</p>
          </div>

          {autoTradeUrl && gemini.suggestion.action !== "WAIT" && (
            <button type="button" className="btn btn-primary btn-full" onClick={handleStartAutoTrade}>
              Start AI Auto Trade
            </button>
          )}
          {tradeUrl && (
            <Link to={tradeUrl} className="btn btn-secondary btn-full mt-2">
              Manual Trade Ticket
            </Link>
          )}

          <p className="text-muted mt-3" style={{ fontSize: "0.6875rem" }}>
            {gemini.model}
            {gemini.updatedAt ? ` · ${formatIndianDateTime(new Date(gemini.updatedAt))}` : ""}
          </p>
        </div>
      ) : aiStreaming ? (
        <div className="stream-ai-empty">
          <Sparkles size={28} className="stream-chart-empty-icon" />
          <p>Analyzing {selectedInstrument.label}…</p>
        </div>
      ) : (
        <div className="stream-ai-empty">
          <Brain size={28} className="stream-chart-empty-icon" />
          <p>Enable AI for live {selectedInstrument.label} trade suggestions.</p>
        </div>
      )}
    </div>
  );

  const renderSymbolStrip = () => (
    <section className="stream-symbols-section">
      <div className="stream-symbols-heading">
        <p className="stream-symbols-title">
          {formulaTrading ? "Live formula scan · all symbols" : "Markets"}
        </p>
        {formulaTrading && (
          <span className="stream-live-pill">
            <span className="stream-live-dot" />
            {FORMULA_VARIANTS[formulaVariant].name} active
          </span>
        )}
      </div>
      <div className="stream-symbols-grid">
        {STREAM_INSTRUMENTS.map((item) => {
          const scan = parseSymbolScan(formulaWatchStatus[item.id]);
          const rsiNum = scan.rsi ? Number(scan.rsi) : null;
          return (
            <button
              key={item.id}
              type="button"
              className={cn(
                "stream-symbol-card",
                streamInstrumentId === item.id && "is-active",
                formulaTrading && scan.signal && "has-signal"
              )}
              onClick={() => selectStreamInstrument(item.id)}
            >
              <span className="stream-symbol-name">{item.label}</span>
              {formulaTrading ? (
                <>
                  {scan.signal && <span className="stream-symbol-badge">Signal</span>}
                  {scan.rsi && (
                    <span
                      className={cn(
                        "stream-symbol-rsi",
                        rsiNum != null && rsiNum > 70 && "is-hot",
                        rsiNum != null && rsiNum < 30 && "is-cold"
                      )}
                    >
                      RSI <span className="stream-symbol-rsi-value">{scan.rsi}</span>
                      {scan.hint && <span className="stream-symbol-meta"> · {scan.hint}</span>}
                    </span>
                  )}
                  {!scan.rsi && scan.hint && (
                    <span className="stream-symbol-meta">{scan.hint}</span>
                  )}
                </>
              ) : (
                <span className="stream-symbol-meta">{item.chainExchange} · tap to chart</span>
              )}
            </button>
          );
        })}
      </div>
    </section>
  );

  const renderHeader = () => (
    <header className="stream-hero">
      <div className="stream-hero-text">
        <h1>Market Streaming</h1>
        <p>Real-time 1-second charts · multi-symbol formula · AI on every market</p>
      </div>
      {connected && (
        <div className="stream-toolbar">
          <div className="stream-toolbar-group">
            <span className={cn("stream-live-pill", !marketStreaming && "is-paused")}>
              <span className="stream-live-dot" />
              {marketStreaming ? "Live · 1s" : "Paused"}
            </span>
            {stream && (
              <span className={cn("stream-price-chip", getChangeClass(stream.quote.change))}>
                {formatNumber(stream.quote.last_price)}
                {" · "}
                {stream.quote.change >= 0 ? "+" : ""}
                {formatNumber(stream.quote.change_percent)}%
              </span>
            )}
            <label className="stream-ai-toggle" title="Toggle live quotes">
              <span className="stream-ai-toggle-label">Stream</span>
              <input
                type="checkbox"
                checked={marketStreaming}
                onChange={toggleMarketStreaming}
                aria-label="Toggle market streaming"
              />
              <span className="stream-ai-toggle-track" aria-hidden />
            </label>
            <label className="stream-ai-toggle stream-ai-toggle-accent" title="Gemini AI assistant">
              <span className="stream-ai-toggle-label">AI</span>
              <input
                type="checkbox"
                checked={aiStreaming}
                onChange={toggleAiStreaming}
                disabled={!marketStreaming}
                aria-label="Toggle Gemini AI"
              />
              <span className="stream-ai-toggle-track" aria-hidden />
            </label>
          </div>

          <div className="stream-toolbar-divider" aria-hidden />

          <div className="stream-toolbar-group">
            <span className="stream-toolbar-label">Formula</span>
            <div className="stream-segment">
              {([1, 2] as const).map((id) => (
                <button
                  key={id}
                  type="button"
                  className={cn("stream-segment-btn", formulaVariant === id && "is-active")}
                  onClick={() => selectFormulaVariant(id)}
                  disabled={formulaTrading}
                  title={FORMULA_VARIANTS[id].shortLabel}
                >
                  {FORMULA_VARIANTS[id].name}
                </button>
              ))}
            </div>
            <button
              type="button"
              className={cn("stream-btn-formula", formulaTrading && "is-running")}
              onClick={handleStartFormulaTrading}
              disabled={formulaTrading || !marketStreaming}
            >
              {formulaTrading ? "Running…" : `Start ${FORMULA_VARIANTS[formulaVariant].name}`}
            </button>
          </div>

          <div className="stream-toolbar-divider" aria-hidden />

          <button
            type="button"
            className="stream-btn-icon"
            onClick={() => setPageFullscreen(!pageFullscreen)}
            title={pageFullscreen ? "Exit fullscreen" : "Fullscreen"}
          >
            {pageFullscreen ? <Minimize2 size={16} /> : <Maximize2 size={16} />}
          </button>
        </div>
      )}
    </header>
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
          {error && <div className="alert alert-error">{error}</div>}

          {renderSymbolStrip()}

          {formulaTrading && (
            <FormulaOrchestrator
              formulaVariant={formulaVariant}
              marketStreaming={marketStreaming}
              connected={connected}
              onStop={handleStopFormula}
              onWatchUpdate={setFormulaWatchStatus}
            />
          )}

          <article className="stream-chart-card">
            <div className="stream-chart-head">
              <div className="stream-chart-head-left">
                <p className="stream-chart-symbol">{selectedInstrument.label}</p>
                <p className="stream-chart-sub">
                  <LineChart size={13} style={{ display: "inline", verticalAlign: "-2px", marginRight: 4 }} />
                  1-second candles · {secondCandles.length} buffered
                  {stream?.updatedAt && marketStreaming && (
                    <> · {formatIndianDateTime(new Date(stream.updatedAt))}</>
                  )}
                </p>
              </div>
              {stream && (
                <div className="stream-chart-price-block">
                  <p className={cn("stream-chart-price", getChangeClass(stream.quote.change))}>
                    {formatNumber(stream.quote.last_price)}
                  </p>
                  <p className={cn("stream-chart-change", getChangeClass(stream.quote.change))}>
                    {stream.quote.change >= 0 ? "+" : ""}
                    {formatNumber(stream.quote.change)} ({formatNumber(stream.quote.change_percent)}%)
                  </p>
                </div>
              )}
            </div>

            <div className="stream-chart-body">
              {secondCandles.length > 0 ? (
                <StreamingChart
                  candles={secondCandles}
                  rsiSeries={rsiSeries}
                  symbol={selectedInstrument.label}
                  height={pageFullscreen ? CHART_HEIGHT_FULLSCREEN : CHART_HEIGHT}
                />
              ) : (
                <div className="stream-chart-empty">
                  <Activity size={32} className="stream-chart-empty-icon" />
                  <p>Building candles from live quotes…</p>
                  {!marketStreaming && (
                    <button type="button" className="btn btn-secondary btn-sm" onClick={toggleMarketStreaming}>
                      Turn stream on
                    </button>
                  )}
                </div>
              )}
            </div>

            <div className="stream-metrics-ribbon">
              <MetricCell label="Vol / Min" value={formatNumber(liveMetrics.volumePerMinute, 0)} />
              <MetricCell
                label="Move / Min"
                value={`${liveMetrics.priceMove >= 0 ? "+" : ""}${formatNumber(liveMetrics.priceMove, 2)}`}
                valueClass={getChangeClass(liveMetrics.priceMove)}
              />
              <MetricCell label="High" value={formatNumber(liveMetrics.sessionHigh)} />
              <MetricCell label="Low" value={formatNumber(liveMetrics.sessionLow)} />
              <MetricCell
                label="RSI 1m"
                value={technicals.rsi14 != null ? formatNumber(technicals.rsi14, 1) : "—"}
                valueClass={
                  technicals.rsi14 != null && technicals.rsi14 > 70
                    ? "text-down"
                    : technicals.rsi14 != null && technicals.rsi14 < 30
                      ? "text-up"
                      : undefined
                }
              />
              <MetricCell label="SMA 9" value={technicals.sma9 != null ? formatNumber(technicals.sma9) : "—"} />
              <MetricCell label="EMA 9" value={technicals.ema9 != null ? formatNumber(technicals.ema9) : "—"} />
              <MetricCell label="VWAP" value={technicals.vwap != null ? formatNumber(technicals.vwap) : "—"} />
            </div>
          </article>
        </div>

        <aside className="stream-ai-panel">{renderGeminiPanel()}</aside>
      </div>
    );
  };

  if (pageFullscreen) {
    return (
      <DashboardShell hideSidebar>
        <div className="stream-page stream-page-fullscreen">
          {renderHeader()}
          {renderStreamContent()}
        </div>
      </DashboardShell>
    );
  }

  return (
    <DashboardShell>
      <div className="stream-page">
        {renderHeader()}
        {renderStreamContent()}
      </div>
    </DashboardShell>
  );
}
