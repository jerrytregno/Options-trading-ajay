import { useCallback, useEffect, useRef, useState } from "react";
import type { ParsedCandle } from "@/lib/candles";
import { appendSecondCandle } from "@/lib/second-candles";
import { aggregateSecondCandlesToMinutes, mergeMinuteCandles } from "@/lib/minute-candles";
import { buildRsiSeries, buildTechnicalSnapshot } from "@/lib/technical-indicators";
import {
  checkFormulaExit,
  FORMULA_OPTIONS,
  FORMULA_RULES,
  FORMULA_VARIANTS,
  formulaCallEntryLabel,
  formulaPutEntryLabel,
  formulaUsesEma,
  formulaEmaTrendLabel,
  fetchFormulaOptionChain,
  formulaLotsForRisk,
  pickFormulaEntryOption,
  placeFormulaEntry,
  placeFormulaExit,
  premiumProfitPct,
  resolveFormulaInstrument,
  type FormulaOptionId,
  type FormulaPhase,
  type FormulaVariantId,
  isPastFormulaHardExit,
  isInFormulaHardExitWindow,
} from "@/lib/formula-trade";
import { fetchNetPositionQty, waitForKiteOrderComplete } from "@/lib/auto-trade";
import { STREAM_INSTRUMENTS, type StreamInstrument } from "@/lib/stream-instruments";
import { useConfirm } from "@/contexts/confirm-context";
import { legLabel } from "@/lib/trade-calculations";
import type { OptionChainResponse } from "@/types/kite";
import type { NiftySessionResponse } from "@/types/streaming";
import { cn, formatCurrency, formatNumber } from "@/lib/utils";

const CHECK_MS = 1000;
const LTP_MS = 2000;
const SESSION_MS = 60_000;
const CHAIN_MS = 30_000;

export interface FormulaLogEntry {
  time: string;
  message: string;
  type?: "info" | "success" | "warning" | "error";
}

interface InstrumentFeed {
  secondCandles: ParsedCandle[];
  lastVolume: number;
  sessionCandles: ParsedCandle[];
  chain: OptionChainResponse | null;
}

interface InstrumentSnapshot {
  spot: number;
  recentRsi: number[];
  vwap: number | null;
  ema20: number | null;
  ema50: number | null;
  rsi14: number | null;
  minuteCandleCount: number;
}

function buildInstrumentSnapshot(feed: InstrumentFeed): InstrumentSnapshot {
  const streamMinutes = aggregateSecondCandlesToMinutes(feed.secondCandles);
  const minutes = mergeMinuteCandles(feed.sessionCandles, streamMinutes);
  const technicals = buildTechnicalSnapshot(minutes);
  const rsiSeries = buildRsiSeries(minutes, FORMULA_RULES.rsiPeriod);
  const last = feed.secondCandles[feed.secondCandles.length - 1];
  return {
    spot: last?.close ?? 0,
    recentRsi: rsiSeries.slice(-5).map((p) => p.value),
    vwap: technicals.vwap,
    ema20: technicals.ema20,
    ema50: technicals.ema50,
    rsi14: technicals.rsi14,
    minuteCandleCount: minutes.length,
  };
}

function entryContextFromSnapshot(snap: InstrumentSnapshot) {
  return {
    recentRsi: snap.recentRsi,
    spot: snap.spot,
    vwap: snap.vwap,
    ema20: snap.ema20,
    ema50: snap.ema50,
  };
}

interface FormulaOrchestratorProps {
  formulaVariant: FormulaVariantId;
  marketStreaming: boolean;
  connected: boolean;
  onStop?: () => void;
  onWatchUpdate?: (status: Record<string, string>) => void;
}

export function FormulaOrchestrator({
  formulaVariant,
  marketStreaming,
  connected,
  onStop,
  onWatchUpdate,
}: FormulaOrchestratorProps) {
  const { confirm } = useConfirm();
  const variantRule = FORMULA_VARIANTS[formulaVariant];

  const [phase, setPhase] = useState<FormulaPhase>("waiting");
  const [activeInstrument, setActiveInstrument] = useState<StreamInstrument | null>(null);
  const [activeOption, setActiveOption] = useState<FormulaOptionId>(1);
  const [ltp, setLtp] = useState(0);
  const [entryPremium, setEntryPremium] = useState(0);
  const [entryOrderId, setEntryOrderId] = useState("");
  const [exitOrderId, setExitOrderId] = useState("");
  const [tradingsymbol, setTradingsymbol] = useState("");
  const [strike, setStrike] = useState(0);
  const [consecutiveLosses, setConsecutiveLosses] = useState(0);
  const [cooldownTarget, setCooldownTarget] = useState(0);
  const [logs, setLogs] = useState<FormulaLogEntry[]>([]);
  const [error, setError] = useState("");
  const [stopping, setStopping] = useState(false);
  const [cycles, setCycles] = useState(0);
  const [watchStatus, setWatchStatus] = useState<Record<string, string>>({});
  const [cooldownMinuteCount, setCooldownMinuteCount] = useState(0);

  const runningRef = useRef(true);
  const phaseRef = useRef<FormulaPhase>("waiting");
  const feedsRef = useRef<Map<string, InstrumentFeed>>(new Map());
  const enteringRef = useRef(false);
  const exitingRef = useRef(false);
  const activeInstRef = useRef<StreamInstrument | null>(null);
  const activeOptionRef = useRef<FormulaOptionId>(1);
  const legRef = useRef(FORMULA_OPTIONS[1].leg);
  const optionExchangeRef = useRef<"NFO" | "BFO">("NFO");
  const tradingsymbolRef = useRef("");
  const quantityRef = useRef(75);
  const entryPremiumRef = useRef(0);
  const entryTimeMsRef = useRef(0);
  const ltpRef = useRef(0);
  const capitalRef = useRef(0);
  const consecutiveLossesRef = useRef(0);
  const cooldownTargetRef = useRef(0);
  const cooldownInstrumentIdRef = useRef<string | null>(null);

  const rule = FORMULA_OPTIONS[activeOption];
  const profitPct = premiumProfitPct(entryPremium, ltp);
  const inEodExitWindow = isInFormulaHardExitWindow();

  const setPhaseSync = useCallback((next: FormulaPhase) => {
    phaseRef.current = next;
    setPhase(next);
  }, []);

  const pushLog = useCallback((message: string, type: FormulaLogEntry["type"] = "info") => {
    setLogs((prev) => [
      ...prev.slice(-80),
      { time: new Date().toLocaleTimeString("en-IN"), message, type },
    ]);
  }, []);

  const publishWatchStatus = useCallback(
    (status: Record<string, string>) => {
      setWatchStatus(status);
      onWatchUpdate?.(status);
    },
    [onWatchUpdate]
  );

  const ensureFeed = useCallback((id: string): InstrumentFeed => {
    let feed = feedsRef.current.get(id);
    if (!feed) {
      feed = { secondCandles: [], lastVolume: 0, sessionCandles: [], chain: null };
      feedsRef.current.set(id, feed);
    }
    return feed;
  }, []);

  const loadSessions = useCallback(async () => {
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
          const data = json.data as NiftySessionResponse;
          ensureFeed(inst.id).sessionCandles = data.candles ?? [];
        } catch {
          /* keep prior session */
        }
      })
    );
  }, [connected, ensureFeed]);

  const loadChains = useCallback(async () => {
    if (!connected) return;
    await Promise.all(
      STREAM_INSTRUMENTS.map(async (inst) => {
        const chain = await fetchFormulaOptionChain(inst.id);
        if (chain) ensureFeed(inst.id).chain = chain;
      })
    );
  }, [connected, ensureFeed]);

  const pollQuotes = useCallback(async () => {
    if (!connected) return;
    if (!marketStreaming) {
      publishWatchStatus(
        Object.fromEntries(STREAM_INSTRUMENTS.map((i) => [i.id, "stream off"]))
      );
      return;
    }
    const keys = STREAM_INSTRUMENTS.map((i) => i.kiteKey).join(",");
    try {
      const res = await fetch(
        `/api/kite/quotes?instruments=${encodeURIComponent(keys)}`,
        { credentials: "include" }
      );
      const json = await res.json();
      if (!res.ok) {
        const msg = typeof json.error === "string" ? json.error : "Quote fetch failed";
        publishWatchStatus(
          Object.fromEntries(STREAM_INSTRUMENTS.map((i) => [i.id, "quote error"]))
        );
        setError(msg);
        return;
      }

      const status: Record<string, string> = {};
      const entriesBlocked = isPastFormulaHardExit();
      for (const inst of STREAM_INSTRUMENTS) {
        const quote = json.data?.[inst.kiteKey] as
          | { last_price?: number; volume?: number }
          | undefined;
        if (!quote?.last_price) {
          status[inst.id] = "no quote";
          continue;
        }
        const feed = ensureFeed(inst.id);
        feed.secondCandles = appendSecondCandle(
          feed.secondCandles,
          quote.last_price,
          quote.volume ?? 0,
          feed.lastVolume
        );
        feed.lastVolume = quote.volume ?? 0;
        const snap = buildInstrumentSnapshot(feed);
        const rsiLabel = snap.rsi14 != null ? formatNumber(snap.rsi14, 1) : "—";

        if (phaseRef.current === "waiting" && snap.recentRsi.length > 0 && !entriesBlocked) {
          const ctx = entryContextFromSnapshot(snap);
          const signal = pickFormulaEntryOption(ctx, formulaVariant);
          const emaHint =
            formulaUsesEma(formulaVariant) && snap.ema20 != null && snap.ema50 != null
              ? ` · EMA ${formulaEmaTrendLabel(ctx)}`
              : "";
          if (signal != null) {
            status[inst.id] = `SIGNAL · ${FORMULA_OPTIONS[signal].name} · RSI ${rsiLabel}${emaHint}`;
          } else {
            status[inst.id] = `RSI ${rsiLabel}${emaHint} · watching`;
          }
        } else if (entriesBlocked) {
          status[inst.id] = `RSI ${rsiLabel} · scan only (past 3:15)`;
        } else if (phaseRef.current === "in_position" && activeInstRef.current?.id === inst.id) {
          status[inst.id] = `RSI ${rsiLabel} · in trade`;
        } else if (phaseRef.current !== "waiting") {
          status[inst.id] = `RSI ${rsiLabel} · paused`;
        } else {
          status[inst.id] = `RSI ${rsiLabel} · warming up`;
        }

        if (phaseRef.current === "cooldown" && cooldownInstrumentIdRef.current === inst.id) {
          setCooldownMinuteCount(snap.minuteCandleCount);
        }
      }
      publishWatchStatus(status);
    } catch {
      publishWatchStatus(
        Object.fromEntries(STREAM_INSTRUMENTS.map((i) => [i.id, "quote error"]))
      );
    }
  }, [connected, marketStreaming, ensureFeed, formulaVariant, publishWatchStatus]);

  useEffect(() => {
    publishWatchStatus(
      Object.fromEntries(STREAM_INSTRUMENTS.map((i) => [i.id, "starting…"]))
    );
    if (!connected) return;
    void loadSessions();
    void loadChains();
    const sessionTimer = window.setInterval(() => void loadSessions(), SESSION_MS);
    const chainTimer = window.setInterval(() => void loadChains(), CHAIN_MS);
    const quoteTimer = window.setInterval(() => void pollQuotes(), CHECK_MS);
    void pollQuotes();
    return () => {
      window.clearInterval(sessionTimer);
      window.clearInterval(chainTimer);
      window.clearInterval(quoteTimer);
    };
  }, [connected, loadSessions, loadChains, pollQuotes, publishWatchStatus]);

  useEffect(() => {
    void (async () => {
      try {
        const res = await fetch("/api/kite/margins", { credentials: "include" });
        const json = await res.json();
        if (res.ok && json.data?.available) {
          capitalRef.current = json.data.available;
        }
      } catch {
        /* default lot sizing */
      }
    })();
  }, []);

  const beginWaiting = useCallback(() => {
    setActiveInstrument(null);
    activeInstRef.current = null;
    cooldownInstrumentIdRef.current = null;
    setEntryOrderId("");
    setExitOrderId("");
    setEntryPremium(0);
    setTradingsymbol("");
    entryPremiumRef.current = 0;
    entryTimeMsRef.current = 0;
    tradingsymbolRef.current = "";
    setPhaseSync("waiting");
    if (isPastFormulaHardExit()) {
      pushLog(
        "Past 3:15 PM IST — live scan on all symbols, no new entries until tomorrow",
        "warning"
      );
    } else {
      pushLog(
        `Scanning ${STREAM_INSTRUMENTS.map((i) => i.label).join(", ")} · first signal wins · one trade at a time`,
        "info"
      );
    }
  }, [pushLog, setPhaseSync]);

  const startCooldown = useCallback(
    (instrumentId: string, minuteCount: number) => {
      const target = minuteCount + FORMULA_RULES.cooldownCandles;
      cooldownTargetRef.current = target;
      cooldownInstrumentIdRef.current = instrumentId;
      setCooldownTarget(target);
      setCooldownMinuteCount(minuteCount);
      setPhaseSync("cooldown");
      pushLog(
        `Cooldown ${FORMULA_RULES.cooldownCandles} × 1m bars · then resume all scanners`,
        "info"
      );
    },
    [pushLog, setPhaseSync]
  );

  const haltAfterLosses = useCallback(() => {
    setPhase("stopped");
    pushLog(`${FORMULA_RULES.maxConsecutiveLosses} consecutive losses — formula halted`, "error");
    runningRef.current = false;
    onStop?.();
  }, [pushLog, onStop]);

  const refreshLtp = useCallback(async () => {
    const symbol = tradingsymbolRef.current;
    const exchange = optionExchangeRef.current;
    if (!symbol) return 0;
    try {
      const res = await fetch(
        `/api/kite/quotes?instruments=${encodeURIComponent(`${exchange}:${symbol}`)}`,
        { credentials: "include" }
      );
      const json = await res.json();
      if (!res.ok) return ltpRef.current;
      const quote = json.data?.[`${exchange}:${symbol}`] as { last_price?: number } | undefined;
      if (quote?.last_price) {
        ltpRef.current = quote.last_price;
        setLtp(quote.last_price);
        return quote.last_price;
      }
    } catch {
      /* ignore */
    }
    return ltpRef.current;
  }, []);

  const squareOff = useCallback(
    async (reason: string) => {
      if (phaseRef.current !== "in_position" || exitingRef.current) return;
      const symbol = tradingsymbolRef.current;
      const qty = quantityRef.current;
      const leg = legRef.current;
      const exchange = optionExchangeRef.current;
      if (!symbol || qty <= 0) {
        pushLog("Exit blocked — missing tradingsymbol or quantity", "error");
        return;
      }

      exitingRef.current = true;
      setPhaseSync("exiting");
      pushLog(`${reason} — placing Zerodha exit (${activeInstRef.current?.label ?? "—"})`, "warning");

      try {
        const liveLtp = await refreshLtp();
        const result = await placeFormulaExit(symbol, leg, qty, exchange);
        pushLog(`Exit order submitted · ${result.order_id}`, "info");
        await waitForKiteOrderComplete(result.order_id);
        const openQty = await fetchNetPositionQty(symbol, "MIS");
        if (openQty !== 0) {
          throw new Error(`Position still open on Zerodha (${openQty} qty remaining)`);
        }

        setExitOrderId(result.order_id);
        const pnl = (liveLtp - entryPremiumRef.current) * qty;
        pushLog(
          `Exit filled · ${result.order_id} · P&L ${formatCurrency(pnl)} · ${formatNumber(premiumProfitPct(entryPremiumRef.current, liveLtp), 1)}%`,
          pnl >= 0 ? "success" : "error"
        );

        setCycles((c) => c + 1);
        let losses = consecutiveLossesRef.current;
        if (pnl < 0) {
          losses += 1;
          setConsecutiveLosses(losses);
          consecutiveLossesRef.current = losses;
          pushLog(`Loss streak: ${losses}/${FORMULA_RULES.maxConsecutiveLosses}`, "warning");
        } else {
          setConsecutiveLosses(0);
          consecutiveLossesRef.current = 0;
        }

        if (losses >= FORMULA_RULES.maxConsecutiveLosses) {
          exitingRef.current = false;
          haltAfterLosses();
          return;
        }

        const instId = activeInstRef.current?.id ?? "nifty50";
        const feed = feedsRef.current.get(instId);
        const snap = feed ? buildInstrumentSnapshot(feed) : { minuteCandleCount: 0, spot: 0, recentRsi: [], vwap: null, ema20: null, ema50: null, rsi14: null };
        exitingRef.current = false;
        startCooldown(instId, snap.minuteCandleCount);
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Exit failed";
        exitingRef.current = false;
        setPhaseSync("in_position");
        setError(msg);
        pushLog(`${msg} — will retry exit`, "error");
      }
    },
    [pushLog, startCooldown, haltAfterLosses, refreshLtp, setPhaseSync]
  );

  const tryEntryAll = useCallback(async () => {
    if (phaseRef.current !== "waiting" || !runningRef.current || enteringRef.current) return;
    if (isPastFormulaHardExit()) return;

    for (const inst of STREAM_INSTRUMENTS) {
      if (phaseRef.current !== "waiting") return;
      const feed = feedsRef.current.get(inst.id);
      if (!feed || feed.secondCandles.length === 0) continue;

      const snap = buildInstrumentSnapshot(feed);
      if (snap.recentRsi.length === 0 || snap.spot <= 0) continue;

      const option = pickFormulaEntryOption(entryContextFromSnapshot(snap), formulaVariant);
      if (option == null) continue;

      enteringRef.current = true;
      setPhaseSync("entering");
      activeInstRef.current = inst;
      setActiveInstrument(inst);
      activeOptionRef.current = option;
      setActiveOption(option);
      legRef.current = FORMULA_OPTIONS[option].leg;
      optionExchangeRef.current = inst.chainExchange;

      const liveChain = (await fetchFormulaOptionChain(inst.id)) ?? feed.chain;
      if (liveChain) feed.chain = liveChain;
      const resolved = resolveFormulaInstrument(liveChain, FORMULA_OPTIONS[option].leg, snap.spot);
      if (!resolved) {
        enteringRef.current = false;
        setPhaseSync("waiting");
        activeInstRef.current = null;
        setActiveInstrument(null);
        pushLog(`${inst.label} — ATM option not found`, "warning");
        continue;
      }

      pushLog(
        `[${inst.label}] ${FORMULA_OPTIONS[option].name} @ ${formatNumber(resolved.strike)} · RSI ${formatNumber(snap.recentRsi[snap.recentRsi.length - 1], 1)}${
          formulaUsesEma(formulaVariant) && snap.ema20 != null && snap.ema50 != null
            ? ` · EMA20 ${formatNumber(snap.ema20)} · EMA50 ${formatNumber(snap.ema50)}`
            : ""
        }`,
        "success"
      );
      pushLog(`Other scanners paused — trade active on ${inst.label}`, "info");

      try {
        const quoteKey = `${inst.chainExchange}:${resolved.tradingsymbol}`;
        const res = await fetch(
          `/api/kite/quotes?instruments=${encodeURIComponent(quoteKey)}`,
          { credentials: "include" }
        );
        const json = await res.json();
        const quote = json.data?.[quoteKey] as { last_price?: number } | undefined;
        const entryLtp = quote?.last_price ?? 0;

        const lots = formulaLotsForRisk(capitalRef.current, entryLtp, resolved.lotSize);
        const qty = lots * resolved.lotSize;
        quantityRef.current = qty;

        const result = await placeFormulaEntry(
          resolved.tradingsymbol,
          FORMULA_OPTIONS[option].leg,
          qty,
          inst.chainExchange
        );

        tradingsymbolRef.current = resolved.tradingsymbol;
        entryPremiumRef.current = entryLtp;
        entryTimeMsRef.current = Date.now();
        ltpRef.current = entryLtp;
        setTradingsymbol(resolved.tradingsymbol);
        setStrike(resolved.strike);
        setEntryOrderId(result.order_id);
        setEntryPremium(entryLtp);
        setLtp(entryLtp);
        enteringRef.current = false;
        setPhaseSync("in_position");
        pushLog(`Entry ${result.order_id} · ${lots} lot(s) @ ${formatNumber(entryLtp)}`, "success");
      } catch (err) {
        enteringRef.current = false;
        setPhaseSync("waiting");
        activeInstRef.current = null;
        setActiveInstrument(null);
        pushLog(err instanceof Error ? err.message : "Entry failed", "error");
      }
      return;
    }
  }, [formulaVariant, pushLog, setPhaseSync]);

  const tryExit = useCallback(async () => {
    if (phaseRef.current !== "in_position" || exitingRef.current || entryPremiumRef.current <= 0) return;
    const liveLtp = ltpRef.current > 0 ? ltpRef.current : entryPremiumRef.current;
    const profit = premiumProfitPct(entryPremiumRef.current, liveLtp);
    const exitCheck = checkFormulaExit(profit, entryTimeMsRef.current);
    if (!exitCheck.exit) return;
    await squareOff(exitCheck.reason);
  }, [squareOff]);

  const startedRef = useRef(false);
  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;
    pushLog(
      `${variantRule.name} (${variantRule.shortLabel}) · monitoring ${STREAM_INSTRUMENTS.length} underlyings`,
      "info"
    );
    beginWaiting();
  }, [beginWaiting, pushLog, variantRule.name, variantRule.shortLabel]);

  useEffect(() => {
    if (phase !== "cooldown") return;
    if (cooldownMinuteCount >= cooldownTargetRef.current) {
      beginWaiting();
    }
  }, [cooldownMinuteCount, phase, beginWaiting]);

  useEffect(() => {
    if (!runningRef.current || phase !== "waiting") return;
    const timer = window.setInterval(() => void tryEntryAll(), CHECK_MS);
    void tryEntryAll();
    return () => window.clearInterval(timer);
  }, [phase, tryEntryAll]);

  useEffect(() => {
    if (!runningRef.current || phase !== "in_position") return;
    refreshLtp();
    const timer = window.setInterval(refreshLtp, LTP_MS);
    return () => window.clearInterval(timer);
  }, [phase, refreshLtp, tradingsymbol]);

  useEffect(() => {
    if (!runningRef.current || phase !== "in_position") return;
    const timer = window.setInterval(() => void tryExit(), CHECK_MS);
    void tryExit();
    return () => window.clearInterval(timer);
  }, [phase, tryExit]);

  const stopLoop = async () => {
    if (stopping) return;
    if (phaseRef.current === "in_position") {
      const ok = await confirm({
        title: "Stop & exit position?",
        body: (
          <>
            <p>Stop formula trading and square off the open position.</p>
            <p className="confirm-note">This places a REAL exit on Zerodha.</p>
          </>
        ),
        confirmLabel: "Stop & exit",
        tone: "danger",
      });
      if (!ok) return;
      setStopping(true);
      runningRef.current = false;
      await squareOff("Stopped by user");
      setPhase("stopped");
      setStopping(false);
      onStop?.();
      return;
    }
    runningRef.current = false;
    setPhase("stopped");
    pushLog("Formula trading stopped", "warning");
    onStop?.();
  };

  const cooldownLeft = Math.max(0, cooldownTarget - cooldownMinuteCount);

  return (
    <div className="stream-formula-panel">
      <div className="stream-formula-head">
        <div>
          <p className="card-title" style={{ fontSize: "0.9375rem" }}>
            {variantRule.displayName} · Multi-symbol engine
          </p>
          <p className="card-desc" style={{ marginTop: "0.2rem" }}>
            {phase === "in_position" && activeInstrument
              ? `Trading ${activeInstrument.label} · ${rule.name}`
              : phase === "waiting"
                ? `Scanning ${STREAM_INSTRUMENTS.length} markets · first signal wins`
                : phase.replace("_", " ")}
            {" · "}
            {cycles} cycle{cycles === 1 ? "" : "s"} · L {consecutiveLosses}/{FORMULA_RULES.maxConsecutiveLosses}
          </p>
        </div>
        <span
          className={cn(
            "stream-formula-status-pill",
            phase === "in_position" ? "is-active" : "is-waiting"
          )}
        >
          {phase === "cooldown" ? `cooldown · ${cooldownLeft}m bars` : phase.replace("_", " ")}
        </span>
      </div>

      <div className="stream-formula-chips">
        {STREAM_INSTRUMENTS.map((inst) => (
          <span
            key={inst.id}
            className={cn(
              "stream-formula-chip",
              activeInstrument?.id === inst.id && phase === "in_position" && "is-trade"
            )}
          >
            {inst.label}
            {watchStatus[inst.id] ? ` · ${watchStatus[inst.id]}` : ""}
          </span>
        ))}
      </div>

      <div className="stream-formula-body">
        <div className="formula-trade-rules mb-3">
          <p className="text-muted" style={{ fontSize: "0.8125rem", margin: 0 }}>
            Call {formulaCallEntryLabel(formulaVariant)} · Put {formulaPutEntryLabel(formulaVariant)} · ATM · one trade globally
          </p>
        </div>

        {phase === "in_position" && (
          <div className="auto-trade-stats mb-3">
            <div className="auto-trade-stat">
              <p className="stream-metric-label">Premium P&L</p>
              <p
                className={cn(
                  "stream-metric-value",
                  profitPct <= -FORMULA_RULES.stopLossPct
                    ? "text-down"
                    : profitPct >=
                        (inEodExitWindow
                          ? FORMULA_RULES.hardExitMinProfitPct
                          : FORMULA_RULES.takeProfitMinPct)
                      ? "text-up"
                      : undefined
                )}
              >
                {formatNumber(profitPct, 2)}%
              </p>
            </div>
          </div>
        )}

        {error && <div className="alert alert-error mb-3">{error}</div>}
        {entryOrderId && (
          <p className="text-muted mb-3" style={{ fontSize: "0.8125rem" }}>
            {activeInstrument?.label} · {legLabel(rule.leg)} · {strike} · Entry {entryOrderId}
            {exitOrderId ? ` · Exit ${exitOrderId}` : ""}
          </p>
        )}

        <div className="flex gap-2 flex-wrap mb-3">
          <button type="button" className="btn btn-danger btn-sm" onClick={() => void stopLoop()} disabled={stopping}>
            {stopping ? "Exiting…" : phase === "in_position" ? "Stop & Exit" : "Stop Formula"}
          </button>
          <span className="badge badge-warning" style={{ alignSelf: "center" }}>
            Live Zerodha orders
          </span>
        </div>

        {logs.length > 0 && (
          <div className="stream-formula-log">
            {logs.map((entry, index) => (
              <p
                key={`${entry.time}-${index}`}
                className={cn("stream-formula-log-line", entry.type && `log-${entry.type}`)}
              >
                <span className="text-muted">{entry.time}</span> {entry.message}
              </p>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
