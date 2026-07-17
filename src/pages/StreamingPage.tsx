import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Activity, LineChart, Maximize2, Minimize2 } from "lucide-react";
import { DashboardShell } from "@/components/layout/dashboard-shell";
import { StreamingChart } from "@/components/streaming/StreamingChart";
import { FormulaOrchestrator } from "@/components/trade/FormulaOrchestrator";
import { Formula4ManualRunner } from "@/components/trade/Formula4ManualRunner";
import { useConfirm } from "@/contexts/confirm-context";
import { useKite } from "@/contexts/kite-context";
import type { ParsedCandle } from "@/lib/candles";
import { appendSecondCandle } from "@/lib/second-candles";
import {
  buildRsiSeries,
  buildTechnicalSnapshot,
} from "@/lib/technical-indicators";
import { aggregateSecondCandlesToMinutes, mergeMinuteCandles } from "@/lib/minute-candles";
import { emptyInstrumentRecord, quotesToStreamsByInstrument } from "@/lib/market-stream-utils";
import { enrichQuoteMetrics, type RawKiteQuote } from "@/lib/quote-depth";
import {
  DEFAULT_STREAM_INSTRUMENT_ID,
  getStreamInstrument,
  isStreamInstrumentId,
  STREAM_INSTRUMENTS,
} from "@/lib/stream-instruments";
import type { NiftySessionResponse, NiftyStreamResponse } from "@/types/streaming";
import { cn, formatCurrency, formatNumber, getChangeClass } from "@/lib/utils";
import { formatIndianDateTime } from "@/lib/market-time";
import {
  FORMULA_RULES,
  FORMULA_VARIANTS,
  formulaCallEntryLabel,
  formulaDisplayName,
  formulaCallEmaFilters,
  formulaPutEmaFilters,
  formulaIsManual,
  formulaPutEntryLabel,
  formulaUsesEma,
  formulaUsesVwap,
  isPastFormulaHardExit,
  type FormulaVariantId,
  FORMULA_4_TARGET_PROFIT_INR,
} from "@/lib/formula-trade";

const REFRESH_MS = 1000;
const SESSION_REFRESH_MS = 60000;
const STREAMING_LIVE_KEY = "optionflow_streaming_live";
const STREAMING_FORMULA_VARIANT_KEY = "optionflow_formula_variant";
const STREAMING_INSTRUMENT_KEY = "optionflow_stream_instrument";
const CHART_HEIGHT = 480;
const CHART_HEIGHT_FULLSCREEN = 560;

function parseStoredFormulaVariant(): FormulaVariantId {
  try {
    const saved = sessionStorage.getItem(STREAMING_FORMULA_VARIANT_KEY);
    if (saved === "2") return 2;
    if (saved === "3") return 3;
    if (saved === "4") return 4;
  } catch {
    /* ignore */
  }
  return 1;
}

function FormulaTradingConfirmBody({ variant }: { variant: FormulaVariantId }) {
  const variantRule = FORMULA_VARIANTS[variant];

  if (formulaIsManual(variant)) {
    return (
      <>
        <p className="confirm-note mb-3">
          {variantRule.displayName} · {variantRule.shortLabel}
        </p>
        <div className="confirm-section">
          <p className="confirm-section-title">Entry</p>
          <ul className="confirm-list">
            <li>You pick <strong>Call Buy</strong> or <strong>Put Buy</strong> manually</li>
            <li>Uses the chart symbol ({STREAM_INSTRUMENTS.map((i) => i.label).join(", ")}) · ATM · 1 lot</li>
            <li>One open trade at a time</li>
          </ul>
        </div>
        <div className="confirm-section">
          <p className="confirm-section-title">Exit</p>
          <ul className="confirm-list">
            <li>Auto market sell at <strong>+{formatCurrency(FORMULA_4_TARGET_PROFIT_INR)}</strong> premium P&L</li>
            <li>No RSI / VWAP / EMA rules</li>
          </ul>
        </div>
        <p className="confirm-note">REAL Zerodha orders — no Options AI.</p>
      </>
    );
  }

  return (
    <>
      <p className="confirm-note mb-3">
        {variantRule.displayName} · {variantRule.shortLabel}
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
          <li>Scans {STREAM_INSTRUMENTS.map((i) => i.label).join(", ")} · ATM CE/PE</li>
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
      <p className="confirm-note">REAL Zerodha orders — no Options AI.</p>
    </>
  );
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
  title,
}: {
  label: string;
  value: string;
  valueClass?: string;
  title?: string;
}) {
  return (
    <div className="stream-metric-cell" title={title}>
      <p className="stream-metric-label">{label}</p>
      <p className={cn("stream-metric-value", valueClass)}>{value}</p>
    </div>
  );
}

type EmaFilterPass = boolean | null;

function EmaFilterBadge({
  label,
  pass,
  size = "md",
}: {
  label: string;
  pass: EmaFilterPass;
  size?: "sm" | "md";
}) {
  if (pass == null) {
    return <span className={cn("stream-ema-compare", "is-neutral", size === "sm" && "is-sm")}>—</span>;
  }
  return (
    <span
      className={cn(
        "stream-ema-compare",
        pass ? "is-up" : "is-down",
        size === "sm" && "is-sm"
      )}
    >
      {label}
    </span>
  );
}

function EmaFormulaFiltersPanel({
  spot,
  ema20,
  ema50,
  compact = false,
}: {
  spot: number;
  ema20: number | null;
  ema50: number | null;
  compact?: boolean;
}) {
  const ctx = { spot, ema20, ema50 };
  const call = formulaCallEmaFilters(ctx);
  const put = formulaPutEmaFilters(ctx);
  const size = compact ? "sm" : "md";

  return (
    <div className={cn("stream-ema-filters", compact && "is-compact")}>
      <div className="stream-ema-filter-row">
        <span className="stream-ema-filter-side is-call">Call</span>
        <EmaFilterBadge label="Spot > EMA 20" pass={call.spotAboveEma20} size={size} />
        <EmaFilterBadge label="EMA 20 > EMA 50" pass={call.ema20AboveEma50} size={size} />
      </div>
      <div className="stream-ema-filter-row">
        <span className="stream-ema-filter-side is-put">Put</span>
        <EmaFilterBadge label="Spot < EMA 20" pass={put.spotBelowEma20} size={size} />
        <EmaFilterBadge label="EMA 20 < EMA 50" pass={put.ema20BelowEma50} size={size} />
      </div>
    </div>
  );
}

export default function StreamingPage() {
  const { connected, loginUrl } = useKite();
  const { confirm } = useConfirm();
  const [stream, setStream] = useState<NiftyStreamResponse | null>(null);
  const [candlesByInstrument, setCandlesByInstrument] = useState<Record<string, ParsedCandle[]>>(() =>
    emptyInstrumentRecord([])
  );
  const [streamsByInstrument, setStreamsByInstrument] = useState<Record<string, NiftyStreamResponse>>({});
  const [sessionsByInstrument, setSessionsByInstrument] = useState<
    Record<string, NiftySessionResponse>
  >({});
  const [pageFullscreen, setPageFullscreen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [formulaTrading, setFormulaTrading] = useState(false);
  const [formulaWatchStatus, setFormulaWatchStatus] = useState<Record<string, string>>({});
  const [formulaVariant, setFormulaVariant] = useState<FormulaVariantId>(() => parseStoredFormulaVariant());
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
      return saved && isStreamInstrumentId(saved) ? saved : DEFAULT_STREAM_INSTRUMENT_ID;
    } catch {
      return DEFAULT_STREAM_INSTRUMENT_ID;
    }
  });
  const selectedInstrument = useMemo(
    () => getStreamInstrument(streamInstrumentId),
    [streamInstrumentId]
  );
  const lastVolumeByInstrumentRef = useRef<Record<string, number>>(emptyInstrumentRecord(0));
  const lastActivityVolumeRef = useRef(0);
  const activityKiteKeyRef = useRef<string | null>(null);
  const [activitySource, setActivitySource] = useState<string | null>(null);
  const [activityMetrics, setActivityMetrics] = useState<ReturnType<typeof enrichQuoteMetrics> | null>(
    null
  );

  const secondCandles = candlesByInstrument[streamInstrumentId] ?? [];
  const sessionData = sessionsByInstrument[streamInstrumentId] ?? null;

  useEffect(() => {
    setStream(streamsByInstrument[streamInstrumentId] ?? null);
  }, [streamInstrumentId, streamsByInstrument]);

  useEffect(() => {
    if (!connected || !selectedInstrument.activityUnderlying) {
      activityKiteKeyRef.current = null;
      setActivitySource(null);
      setActivityMetrics(null);
      lastActivityVolumeRef.current = 0;
      return;
    }
    void (async () => {
      try {
        const res = await fetch(
          `/api/kite/nearest-future?underlying=${encodeURIComponent(selectedInstrument.activityUnderlying!)}`,
          { credentials: "include" }
        );
        const json = await res.json();
        if (!res.ok) return;
        const data = json.data as { kiteKey: string; tradingsymbol: string };
        activityKiteKeyRef.current = data.kiteKey;
        setActivitySource(data.tradingsymbol);
        lastActivityVolumeRef.current = 0;
      } catch {
        /* ignore */
      }
    })();
  }, [connected, selectedInstrument]);

  const streamStatusByInstrument = useMemo(() => {
    const status: Record<string, string> = {};
    for (const inst of STREAM_INSTRUMENTS) {
      if (!marketStreaming) {
        status[inst.id] = "stream off";
        continue;
      }
      const candles = candlesByInstrument[inst.id] ?? [];
      if (candles.length === 0) {
        status[inst.id] = "starting…";
        continue;
      }
      const streamMinutes = aggregateSecondCandlesToMinutes(candles);
      const minutes = mergeMinuteCandles(sessionsByInstrument[inst.id]?.candles ?? [], streamMinutes);
      const tech = buildTechnicalSnapshot(minutes);
      const rsiLabel = tech.rsi14 != null ? formatNumber(tech.rsi14, 1) : "—";
      status[inst.id] = `RSI ${rsiLabel} · ${candles.length} × 1s`;
    }
    return status;
  }, [candlesByInstrument, sessionsByInstrument, marketStreaming]);

  const technicalsByInstrument = useMemo(() => {
    const out: Record<
      string,
      {
        rsi14: number | null;
        vwap: number | null;
        ema20: number | null;
        ema50: number | null;
        spot: number;
      }
    > = {};
    for (const inst of STREAM_INSTRUMENTS) {
      const candles = candlesByInstrument[inst.id] ?? [];
      const streamMinutes = aggregateSecondCandlesToMinutes(candles);
      const minutes = mergeMinuteCandles(sessionsByInstrument[inst.id]?.candles ?? [], streamMinutes);
      const tech = buildTechnicalSnapshot(minutes);
      const spot =
        candles[candles.length - 1]?.close ??
        streamsByInstrument[inst.id]?.quote.last_price ??
        0;
      out[inst.id] = {
        rsi14: tech.rsi14,
        vwap: tech.vwap,
        ema20: tech.ema20,
        ema50: tech.ema50,
        spot,
      };
    }
    return out;
  }, [candlesByInstrument, sessionsByInstrument, streamsByInstrument]);

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
  const chartSpot = stream?.quote.last_price ?? minuteCandles[minuteCandles.length - 1]?.close ?? 0;

  const liveMetrics = useMemo(() => {
    const lastSecond = secondCandles[secondCandles.length - 1];
    const last = minuteCandles[minuteCandles.length - 1];
    const book = stream?.quote;
    const activity = activityMetrics?.orderBook;
    const useFutureActivity = Boolean(activitySource && activityMetrics);
    const base = useFutureActivity
      ? {
          volumePerSecond: activityMetrics!.volumePerSecond,
          cumulativeVolume: activityMetrics!.cumulativeVolume,
          buyBookOrders: activity!.buyOrders,
          sellBookOrders: activity!.sellOrders,
          totalBookOrders: activity!.totalOrders,
          buyBookQuantity: activity!.buyQuantity,
          sellBookQuantity: activity!.sellQuantity,
        }
      : {
          volumePerSecond: lastSecond?.volume ?? book?.volumePerSecond ?? 0,
          cumulativeVolume: book?.cumulativeVolume ?? book?.volume ?? 0,
          buyBookOrders: book?.buyOrders ?? 0,
          sellBookOrders: book?.sellOrders ?? 0,
          totalBookOrders: book?.totalBookOrders ?? 0,
          buyBookQuantity: book?.buyBookQuantity ?? 0,
          sellBookQuantity: book?.sellBookQuantity ?? 0,
        };
    if (!last) {
      return {
        ...base,
        volumePerMinute: 0,
        priceMove: 0,
        sessionHigh: 0,
        sessionLow: 0,
      };
    }
    return {
      ...base,
      volumePerMinute: last.volume,
      priceMove: last.close - last.open,
      sessionHigh: Math.max(...minuteCandles.map((c) => c.high)),
      sessionLow: Math.min(...minuteCandles.map((c) => c.low)),
    };
  }, [minuteCandles, secondCandles, stream?.quote, activityMetrics, activitySource]);

  const loadAllSessions = useCallback(async () => {
    if (!connected) return;
    await Promise.all(
      STREAM_INSTRUMENTS.map(async (inst) => {
        try {
          const res = await fetch(
            `/api/kite/instrument-session?instrument=${encodeURIComponent(inst.kiteKey)}`,
            { credentials: "include" }
          );
          const json = await res.json();
          if (!res.ok) return;
          setSessionsByInstrument((prev) => ({
            ...prev,
            [inst.id]: json.data as NiftySessionResponse,
          }));
        } catch {
          /* keep prior session */
        }
      })
    );
  }, [connected]);

  const pollAllMarkets = useCallback(async () => {
    if (!connected || !marketStreaming) return;
    const quoteKeys = [
      ...STREAM_INSTRUMENTS.map((item) => item.kiteKey),
      ...(activityKiteKeyRef.current ? [activityKiteKeyRef.current] : []),
    ];
    const keys = [...new Set(quoteKeys)].join(",");
    try {
      const res = await fetch(
        `/api/kite/quotes?instruments=${encodeURIComponent(keys)}`,
        { credentials: "include" }
      );
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Failed to load quotes");

      const prevVolumes = { ...lastVolumeByInstrumentRef.current };
      const prevActivityVol = lastActivityVolumeRef.current;
      const activityKey = activityKiteKeyRef.current;
      const activityQuote = activityKey
        ? (json.data?.[activityKey] as RawKiteQuote | undefined)
        : undefined;

      if (activityQuote) {
        setActivityMetrics(enrichQuoteMetrics(activityQuote, prevActivityVol));
        lastActivityVolumeRef.current = activityQuote.volume ?? 0;
      }

      setCandlesByInstrument((prev) => {
        const next = { ...prev };
        for (const inst of STREAM_INSTRUMENTS) {
          const quote = json.data?.[inst.kiteKey] as RawKiteQuote | undefined;
          if (!quote?.last_price) continue;
          const spotVol = quote.volume ?? 0;
          const useFutureVol = Boolean(inst.activityUnderlying && spotVol <= 0 && activityQuote);
          const candleVol = useFutureVol ? (activityQuote!.volume ?? 0) : spotVol;
          const candlePrevVol = useFutureVol
            ? prevActivityVol
            : (lastVolumeByInstrumentRef.current[inst.id] ?? 0);
          next[inst.id] = appendSecondCandle(
            prev[inst.id] ?? [],
            quote.last_price,
            candleVol,
            candlePrevVol
          );
          if (!useFutureVol) {
            lastVolumeByInstrumentRef.current[inst.id] = spotVol;
          }
        }
        return next;
      });

      setStreamsByInstrument((prev) => ({
        ...prev,
        ...quotesToStreamsByInstrument(json.data ?? {}, prevVolumes),
      }));
      setError("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Stream unavailable");
    }
  }, [connected, marketStreaming]);

  const selectStreamInstrument = (id: string) => {
    if (id === streamInstrumentId) return;
    setStreamInstrumentId(id);
    try {
      sessionStorage.setItem(STREAMING_INSTRUMENT_KEY, id);
    } catch {
      /* ignore */
    }
  };

  useEffect(() => {
    if (!connected) {
      setCandlesByInstrument(emptyInstrumentRecord([]));
      setStreamsByInstrument({});
      setSessionsByInstrument({});
      lastVolumeByInstrumentRef.current = emptyInstrumentRecord(0);
      lastActivityVolumeRef.current = 0;
      activityKiteKeyRef.current = null;
      setActivitySource(null);
      setActivityMetrics(null);
      setStream(null);
    }
  }, [connected]);

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

  useEffect(() => {
    if (!connected || !marketStreaming) return;
    setLoading(true);
    Promise.all([pollAllMarkets(), loadAllSessions()]).finally(() => setLoading(false));
  }, [connected, marketStreaming, pollAllMarkets, loadAllSessions]);

  useEffect(() => {
    if (!connected || !marketStreaming) return;
    const interval = window.setInterval(loadAllSessions, SESSION_REFRESH_MS);
    return () => window.clearInterval(interval);
  }, [connected, marketStreaming, loadAllSessions]);

  useEffect(() => {
    if (!connected || !marketStreaming) return;
    const interval = window.setInterval(pollAllMarkets, REFRESH_MS);
    void pollAllMarkets();
    return () => window.clearInterval(interval);
  }, [connected, marketStreaming, pollAllMarkets]);

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
      title: `Start ${formulaDisplayName(formulaVariant)}?`,
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

  const renderSymbolStrip = () => (
    <section className="stream-symbols-section">
      <div className="stream-symbols-heading">
        <p className="stream-symbols-title">
          {formulaTrading
            ? formulaIsManual(formulaVariant)
              ? `${formulaDisplayName(formulaVariant)} · pick Call or Put`
              : "Live formula scan · all symbols"
            : marketStreaming
              ? "All markets streaming · tap to chart"
              : "Markets"}
        </p>
        {(formulaTrading || marketStreaming) && (
          <span className="stream-live-pill">
            <span className="stream-live-dot" />
            {formulaTrading ? `${formulaDisplayName(formulaVariant)} active` : `${STREAM_INSTRUMENTS.length} × live`}
          </span>
        )}
      </div>
      <div className="stream-symbols-grid">
        {STREAM_INSTRUMENTS.map((item) => {
          const statusLine = formulaTrading
            ? formulaWatchStatus[item.id]
            : streamStatusByInstrument[item.id];
          const scan = parseSymbolScan(statusLine);
          const rsiNum = scan.rsi ? Number(scan.rsi) : null;
          const instTech = technicalsByInstrument[item.id];
          const showLiveMeta = formulaTrading || marketStreaming;
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
              {showLiveMeta ? (
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
                  {formulaUsesEma(formulaVariant) && instTech && (
                    <EmaFormulaFiltersPanel
                      spot={instTech.spot}
                      ema20={instTech.ema20}
                      ema50={instTech.ema50}
                      compact
                    />
                  )}
                  {formulaUsesVwap(formulaVariant) && instTech?.vwap != null && instTech.spot > 0 && (
                    <span className="stream-symbol-meta">
                      Spot {instTech.spot > instTech.vwap ? ">" : "<"} VWAP {formatNumber(instTech.vwap)}
                    </span>
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
        <p>Real-time 1-second charts · multi-symbol formula trading</p>
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
            {marketStreaming && stream && (
              <>
                <span className="stream-activity-chip" title="Volume traded in the last second">
                  Vol/s {formatNumber(liveMetrics.volumePerSecond, 0)}
                </span>
                <span className="stream-activity-chip is-book" title="Open orders in the book (buy + sell)">
                  Book {formatNumber(liveMetrics.totalBookOrders, 0)}
                </span>
              </>
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
          </div>

          <div className="stream-toolbar-divider" aria-hidden />

          <div className="stream-toolbar-group">
            <span className="stream-toolbar-label">Formula</span>
            <div className="stream-segment">
              {([1, 2, 3, 4] as const).map((id) => {
                const variant = FORMULA_VARIANTS[id];
                return (
                  <button
                    key={variant.id}
                    type="button"
                    className={cn("stream-segment-btn", formulaVariant === variant.id && "is-active")}
                    onClick={() => selectFormulaVariant(variant.id)}
                    disabled={formulaTrading}
                    title={variant.shortLabel}
                  >
                    <span className="stream-segment-name">{variant.name}</span>
                    <span className="stream-segment-risk">({variant.riskTag})</span>
                  </button>
                );
              })}
            </div>
            <button
              type="button"
              className={cn("stream-btn-formula", formulaTrading && "is-running")}
              onClick={handleStartFormulaTrading}
              disabled={formulaTrading || !marketStreaming}
            >
              {formulaTrading ? "Running…" : `Start ${formulaDisplayName(formulaVariant)}`}
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
          <p className="text-muted">Connect Zerodha to stream live charts and run formula trading.</p>
          {loginUrl && (
            <a href={loginUrl} className="mt-4" style={{ display: "inline-block" }}>
              <button className="btn btn-primary">Connect Kite</button>
            </a>
          )}
        </div>
      );
    }

    if (loading && secondCandles.length === 0 && !stream) {
      return (
        <div className="spinner-center" style={{ minHeight: "16rem" }}>
          <div className="spinner spinner-sm" />
        </div>
      );
    }

    return (
      <div className="stream-layout stream-layout-single">
        <div className="stream-main">
          {error && <div className="alert alert-error">{error}</div>}

          {renderSymbolStrip()}

          {formulaTrading &&
            (formulaIsManual(formulaVariant) ? (
              <Formula4ManualRunner
                streamInstrumentId={streamInstrumentId}
                spot={chartSpot}
                marketStreaming={marketStreaming}
                connected={connected}
                onStop={handleStopFormula}
              />
            ) : (
              <FormulaOrchestrator
                formulaVariant={formulaVariant}
                marketStreaming={marketStreaming}
                connected={connected}
                onStop={handleStopFormula}
                onWatchUpdate={setFormulaWatchStatus}
              />
            ))}

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

            {marketStreaming && (
              <section className="stream-activity-panel" aria-label="Live volume and order book">
                <div className="stream-activity-head">
                  <Activity size={15} aria-hidden />
                  <span className="stream-activity-title">Live activity</span>
                  <span className="stream-activity-hint">
                    {activitySource
                      ? `Volume & book from ${activitySource} · spot chart = index`
                      : "Kite quote · 1s refresh"}
                  </span>
                </div>
                <div className="stream-activity-grid">
                  <div className="stream-activity-stat is-highlight">
                    <span className="stream-activity-label">Volume / sec</span>
                    <span className="stream-activity-value">{formatNumber(liveMetrics.volumePerSecond, 0)}</span>
                    <span className="stream-activity-sub">
                      Δ from session volume · 1m bar {formatNumber(liveMetrics.volumePerMinute, 0)}
                    </span>
                  </div>
                  <div className="stream-activity-stat">
                    <span className="stream-activity-label">Session volume</span>
                    <span className="stream-activity-value">{formatNumber(liveMetrics.cumulativeVolume, 0)}</span>
                    <span className="stream-activity-sub">Cumulative today</span>
                  </div>
                  <div className="stream-activity-stat is-buy">
                    <span className="stream-activity-label">Buy book</span>
                    <span className="stream-activity-value">{formatNumber(liveMetrics.buyBookOrders, 0)} orders</span>
                    <span className="stream-activity-sub">
                      Qty {formatNumber(liveMetrics.buyBookQuantity, 0)}
                    </span>
                  </div>
                  <div className="stream-activity-stat is-sell">
                    <span className="stream-activity-label">Sell book</span>
                    <span className="stream-activity-value">{formatNumber(liveMetrics.sellBookOrders, 0)} orders</span>
                    <span className="stream-activity-sub">
                      Qty {formatNumber(liveMetrics.sellBookQuantity, 0)}
                    </span>
                  </div>
                  <div className="stream-activity-stat">
                    <span className="stream-activity-label">Total book orders</span>
                    <span className="stream-activity-value">{formatNumber(liveMetrics.totalBookOrders, 0)}</span>
                    <span className="stream-activity-sub">
                      {activitySource
                        ? `Nearest Nifty future · top 5 book levels`
                        : liveMetrics.totalBookOrders === 0
                          ? "No depth on this symbol"
                          : "Top 5 levels each side"}
                    </span>
                  </div>
                </div>
              </section>
            )}

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

            {formulaUsesEma(formulaVariant) && (
              <div className="stream-ema-compare-bar">
                <span className="stream-ema-compare-bar-label">Formula 3 EMA filters</span>
                <EmaFormulaFiltersPanel spot={chartSpot} ema20={technicals.ema20} ema50={technicals.ema50} />
              </div>
            )}

            <div className="stream-metrics-ribbon">
              <MetricCell label="Vol / Sec" value={formatNumber(liveMetrics.volumePerSecond, 0)} />
              <MetricCell label="Vol / Min" value={formatNumber(liveMetrics.volumePerMinute, 0)} />
              <MetricCell
                label="Book orders"
                value={formatNumber(liveMetrics.totalBookOrders, 0)}
                title={`Buy ${formatNumber(liveMetrics.buyBookOrders, 0)} · Sell ${formatNumber(liveMetrics.sellBookOrders, 0)}`}
              />
              <MetricCell
                label="Buy book qty"
                value={formatNumber(liveMetrics.buyBookQuantity, 0)}
              />
              <MetricCell
                label="Sell book qty"
                value={formatNumber(liveMetrics.sellBookQuantity, 0)}
              />
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
              {formulaUsesEma(formulaVariant) && (
                <>
                  <MetricCell
                    label={`EMA ${FORMULA_RULES.emaFastPeriod}`}
                    value={technicals.ema20 != null ? formatNumber(technicals.ema20) : "—"}
                  />
                  <MetricCell
                    label={`EMA ${FORMULA_RULES.emaSlowPeriod}`}
                    value={technicals.ema50 != null ? formatNumber(technicals.ema50) : "—"}
                  />
                  {(() => {
                    const call = formulaCallEmaFilters({
                      spot: chartSpot,
                      ema20: technicals.ema20,
                      ema50: technicals.ema50,
                    });
                    const put = formulaPutEmaFilters({
                      spot: chartSpot,
                      ema20: technicals.ema20,
                      ema50: technicals.ema50,
                    });
                    return (
                      <>
                        <MetricCell
                          label="Call · Spot > EMA 20"
                          value={call.spotAboveEma20 == null ? "—" : call.spotAboveEma20 ? "Pass" : "Fail"}
                          valueClass={call.spotAboveEma20 == null ? undefined : call.spotAboveEma20 ? "text-up" : "text-down"}
                        />
                        <MetricCell
                          label="Call · EMA 20 > EMA 50"
                          value={call.ema20AboveEma50 == null ? "—" : call.ema20AboveEma50 ? "Pass" : "Fail"}
                          valueClass={call.ema20AboveEma50 == null ? undefined : call.ema20AboveEma50 ? "text-up" : "text-down"}
                        />
                        <MetricCell
                          label="Put · Spot < EMA 20"
                          value={put.spotBelowEma20 == null ? "—" : put.spotBelowEma20 ? "Pass" : "Fail"}
                          valueClass={put.spotBelowEma20 == null ? undefined : put.spotBelowEma20 ? "text-up" : "text-down"}
                        />
                        <MetricCell
                          label="Put · EMA 20 < EMA 50"
                          value={put.ema20BelowEma50 == null ? "—" : put.ema20BelowEma50 ? "Pass" : "Fail"}
                          valueClass={put.ema20BelowEma50 == null ? undefined : put.ema20BelowEma50 ? "text-up" : "text-down"}
                        />
                      </>
                    );
                  })()}
                </>
              )}
              {formulaUsesVwap(formulaVariant) && (
                <>
                  <MetricCell label="VWAP" value={technicals.vwap != null ? formatNumber(technicals.vwap) : "—"} />
                  <MetricCell
                    label="Spot vs VWAP"
                    value={
                      chartSpot > 0 && technicals.vwap != null
                        ? `${chartSpot > technicals.vwap ? ">" : "<"} ${formatNumber(technicals.vwap)}`
                        : "—"
                    }
                    valueClass={
                      chartSpot > 0 && technicals.vwap != null
                        ? chartSpot > technicals.vwap
                          ? "text-up"
                          : "text-down"
                        : undefined
                    }
                  />
                </>
              )}
              {!formulaUsesEma(formulaVariant) && !formulaUsesVwap(formulaVariant) && (
                <MetricCell
                  label="Filter"
                  value={FORMULA_VARIANTS[formulaVariant].shortLabel}
                />
              )}
            </div>
          </article>
        </div>
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
