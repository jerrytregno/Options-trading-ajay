import { useCallback, useEffect, useRef, useState } from "react";
import {
  checkFormulaEntry,
  checkFormulaExit,
  flipFormulaOption,
  FORMULA_OPTIONS,
  FORMULA_RULES,
  formulaLotsForRisk,
  getStoredFormulaOption,
  type FormulaEntryContext,
  type FormulaOptionId,
  type FormulaPhase,
  isPastFormulaHardExit,
  placeFormulaEntry,
  placeFormulaExit,
  premiumProfitPct,
  resolveFormulaInstrument,
  storeNextFormulaOption,
} from "@/lib/formula-trade";
import { legLabel } from "@/lib/trade-calculations";
import type { OptionChainResponse } from "@/types/kite";
import { cn, formatCurrency, formatNumber } from "@/lib/utils";

const CHECK_MS = 1000;
const LTP_MS = 2000;

export interface FormulaLogEntry {
  time: string;
  message: string;
  type?: "info" | "success" | "warning" | "error";
}

interface FormulaTradeRunnerProps {
  chain: OptionChainResponse | null;
  rsi14: number | null;
  recentRsi: number[];
  spotPrice: number;
  vwap: number | null;
  candleCount: number;
  onStop?: () => void;
}

export function FormulaTradeRunner({
  chain,
  rsi14,
  recentRsi,
  spotPrice,
  vwap,
  candleCount,
  onStop,
}: FormulaTradeRunnerProps) {
  const [phase, setPhase] = useState<FormulaPhase>("waiting");
  const [activeOption, setActiveOption] = useState<FormulaOptionId>(() => getStoredFormulaOption());
  const [ltp, setLtp] = useState(0);
  const [entryPremium, setEntryPremium] = useState(0);
  const [entryTimeMs, setEntryTimeMs] = useState(0);
  const [entryOrderId, setEntryOrderId] = useState("");
  const [exitOrderId, setExitOrderId] = useState("");
  const [tradingsymbol, setTradingsymbol] = useState("");
  const [strike, setStrike] = useState(0);
  const [tradeLots, setTradeLots] = useState(1);
  const [capital, setCapital] = useState(0);
  const [consecutiveLosses, setConsecutiveLosses] = useState(0);
  const [cooldownTarget, setCooldownTarget] = useState(0);
  const [logs, setLogs] = useState<FormulaLogEntry[]>([]);
  const [error, setError] = useState("");
  const [stopping, setStopping] = useState(false);
  const [cycles, setCycles] = useState(0);

  const runningRef = useRef(true);
  const phaseRef = useRef<FormulaPhase>("waiting");
  const activeOptionRef = useRef(activeOption);
  const rsiRef = useRef(rsi14);
  const recentRsiRef = useRef(recentRsi);
  const spotRef = useRef(spotPrice);
  const vwapRef = useRef(vwap);
  const candleCountRef = useRef(candleCount);
  const ltpRef = useRef(0);
  const entryPremiumRef = useRef(0);
  const entryTimeMsRef = useRef(0);
  const tradingsymbolRef = useRef("");
  const legRef = useRef(FORMULA_OPTIONS[1].leg);
  const quantityRef = useRef(75);
  const capitalRef = useRef(0);
  const consecutiveLossesRef = useRef(0);
  const cooldownTargetRef = useRef(0);

  const rule = FORMULA_OPTIONS[activeOption];
  const profitPct = premiumProfitPct(entryPremium, ltp);
  const minutesInTrade =
    entryTimeMs > 0 ? Math.floor((Date.now() - entryTimeMs) / 60000) : 0;

  const pushLog = useCallback((message: string, type: FormulaLogEntry["type"] = "info") => {
    setLogs((prev) => [
      ...prev.slice(-50),
      { time: new Date().toLocaleTimeString("en-IN"), message, type },
    ]);
  }, []);

  useEffect(() => {
    phaseRef.current = phase;
  }, [phase]);
  useEffect(() => {
    activeOptionRef.current = activeOption;
    legRef.current = FORMULA_OPTIONS[activeOption].leg;
  }, [activeOption]);
  useEffect(() => {
    rsiRef.current = rsi14;
  }, [rsi14]);
  useEffect(() => {
    recentRsiRef.current = recentRsi;
  }, [recentRsi]);
  useEffect(() => {
    spotRef.current = spotPrice;
  }, [spotPrice]);
  useEffect(() => {
    vwapRef.current = vwap;
  }, [vwap]);
  useEffect(() => {
    candleCountRef.current = candleCount;
  }, [candleCount]);
  useEffect(() => {
    ltpRef.current = ltp;
  }, [ltp]);
  useEffect(() => {
    entryPremiumRef.current = entryPremium;
  }, [entryPremium]);
  useEffect(() => {
    entryTimeMsRef.current = entryTimeMs;
  }, [entryTimeMs]);
  useEffect(() => {
    tradingsymbolRef.current = tradingsymbol;
  }, [tradingsymbol]);
  useEffect(() => {
    capitalRef.current = capital;
  }, [capital]);
  useEffect(() => {
    consecutiveLossesRef.current = consecutiveLosses;
  }, [consecutiveLosses]);
  useEffect(() => {
    cooldownTargetRef.current = cooldownTarget;
  }, [cooldownTarget]);

  useEffect(() => {
    void (async () => {
      try {
        const res = await fetch("/api/kite/margins", { credentials: "include" });
        const json = await res.json();
        if (res.ok && json.data?.available) {
          setCapital(json.data.available);
          capitalRef.current = json.data.available;
        }
      } catch {
        /* use default lot sizing */
      }
    })();
  }, []);

  const entryContext = useCallback((): FormulaEntryContext => {
    return {
      recentRsi: recentRsiRef.current,
      spot: spotRef.current,
      vwap: vwapRef.current,
    };
  }, []);

  const beginWaiting = useCallback(
    (option: FormulaOptionId) => {
      if (isPastFormulaHardExit()) {
        setPhase("stopped");
        pushLog("Past 3:15 PM IST — no new entries", "warning");
        runningRef.current = false;
        onStop?.();
        return;
      }
      setActiveOption(option);
      setEntryOrderId("");
      setExitOrderId("");
      setEntryPremium(0);
      setEntryTimeMs(0);
      setLtp(0);
      setTradingsymbol("");
      setPhase("waiting");
      pushLog(
        `${FORMULA_OPTIONS[option].name} — waiting for ${FORMULA_OPTIONS[option].entryLabel}`,
        "info"
      );
    },
    [pushLog, onStop]
  );

  const startCooldown = useCallback(
    (nextOption: FormulaOptionId) => {
      const target = candleCountRef.current + FORMULA_RULES.cooldownCandles;
      cooldownTargetRef.current = target;
      setCooldownTarget(target);
      setActiveOption(nextOption);
      setPhase("cooldown");
      pushLog(
        `Cooldown ${FORMULA_RULES.cooldownCandles} candles · next ${FORMULA_OPTIONS[nextOption].name}`,
        "info"
      );
    },
    [pushLog]
  );

  const haltAfterLosses = useCallback(() => {
    setPhase("stopped");
    pushLog(`${FORMULA_RULES.maxConsecutiveLosses} consecutive losses — formula halted`, "error");
    runningRef.current = false;
    onStop?.();
  }, [pushLog, onStop]);

  const refreshLtp = useCallback(async () => {
    const symbol = tradingsymbolRef.current;
    if (!symbol) return;
    try {
      const res = await fetch(
        `/api/kite/quotes?instruments=${encodeURIComponent(`NFO:${symbol}`)}`,
        { credentials: "include" }
      );
      const json = await res.json();
      if (!res.ok) return;
      const quote = json.data?.[`NFO:${symbol}`] as { last_price?: number } | undefined;
      if (quote?.last_price) setLtp(quote.last_price);
    } catch {
      /* ignore */
    }
  }, []);

  const squareOff = useCallback(
    async (reason: string) => {
      if (phaseRef.current !== "in_position") return;
      setPhase("exiting");
      pushLog(`${reason} — squaring off`, "warning");
      try {
        await refreshLtp();
        const result = await placeFormulaExit(
          tradingsymbolRef.current,
          legRef.current,
          quantityRef.current
        );
        setExitOrderId(result.order_id);
        const pnl =
          (ltpRef.current - entryPremiumRef.current) * quantityRef.current;
        pushLog(
          `Exit ${result.order_id} · P&L ${formatCurrency(pnl)} · ${formatNumber(premiumProfitPct(entryPremiumRef.current, ltpRef.current), 1)}%`,
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
          haltAfterLosses();
          return;
        }

        const next = flipFormulaOption(activeOptionRef.current);
        storeNextFormulaOption(next);
        startCooldown(next);
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Exit failed";
        setPhase("stopped");
        setError(msg);
        pushLog(msg, "error");
        runningRef.current = false;
        onStop?.();
      }
    },
    [pushLog, startCooldown, haltAfterLosses, onStop, refreshLtp]
  );

  const tryEntry = useCallback(async () => {
    if (phaseRef.current !== "waiting" || !runningRef.current) return;
    if (isPastFormulaHardExit()) return;

    const option = activeOptionRef.current;
    if (!checkFormulaEntry(option, entryContext())) return;

    const instrument = resolveFormulaInstrument(chain, FORMULA_OPTIONS[option].leg);
    if (!instrument) {
      pushLog("ATM option not found — waiting for chain", "warning");
      return;
    }

    setPhase("entering");
    const ctx = entryContext();
    pushLog(
      `${FORMULA_OPTIONS[option].name} signal · RSI ${recentRsiRef.current.slice(-2).map((r) => formatNumber(r, 1)).join(", ")} · spot ${formatNumber(ctx.spot)} vs VWAP ${ctx.vwap != null ? formatNumber(ctx.vwap) : "—"}`,
      "success"
    );

    try {
      let entryLtp = 0;
      const res = await fetch(
        `/api/kite/quotes?instruments=${encodeURIComponent(`NFO:${instrument.tradingsymbol}`)}`,
        { credentials: "include" }
      );
      const json = await res.json();
      const quote = json.data?.[`NFO:${instrument.tradingsymbol}`] as { last_price?: number } | undefined;
      entryLtp = quote?.last_price ?? 0;

      const lots = formulaLotsForRisk(
        capitalRef.current,
        entryLtp,
        instrument.lotSize
      );
      const qty = lots * instrument.lotSize;
      quantityRef.current = qty;
      setTradeLots(lots);

      const result = await placeFormulaEntry(instrument.tradingsymbol, FORMULA_OPTIONS[option].leg, qty);

      const now = Date.now();
      setTradingsymbol(instrument.tradingsymbol);
      setStrike(instrument.strike);
      setEntryOrderId(result.order_id);
      setEntryPremium(entryLtp);
      setEntryTimeMs(now);
      entryTimeMsRef.current = now;
      setLtp(entryLtp);
      setPhase("in_position");
      pushLog(
        `Entry ${result.order_id} · ${lots} lot(s) @ ${formatNumber(entryLtp)} · 1% risk sizing`,
        "success"
      );
    } catch (err) {
      setPhase("waiting");
      pushLog(err instanceof Error ? err.message : "Entry failed", "error");
    }
  }, [chain, entryContext, pushLog]);

  const tryExit = useCallback(async () => {
    if (phaseRef.current !== "in_position" || entryPremiumRef.current <= 0) return;
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
    const opt = getStoredFormulaOption();
    pushLog(
      `Formula loop · ${FORMULA_OPTIONS[opt].name} first · alternates 1 ↔ 2`,
      "info"
    );
    beginWaiting(opt);
  }, [beginWaiting, pushLog]);

  useEffect(() => {
    if (phase !== "cooldown") return;
    if (candleCountRef.current >= cooldownTargetRef.current) {
      beginWaiting(activeOptionRef.current);
    }
  }, [candleCount, phase, beginWaiting]);

  useEffect(() => {
    if (!runningRef.current || phase !== "in_position") return;
    refreshLtp();
    const timer = window.setInterval(refreshLtp, LTP_MS);
    return () => window.clearInterval(timer);
  }, [phase, refreshLtp, tradingsymbol]);

  useEffect(() => {
    if (!runningRef.current || phase !== "waiting") return;
    const timer = window.setInterval(() => void tryEntry(), CHECK_MS);
    tryEntry();
    return () => window.clearInterval(timer);
  }, [phase, tryEntry, rsi14, recentRsi, spotPrice, vwap]);

  useEffect(() => {
    if (!runningRef.current || phase !== "in_position") return;
    const timer = window.setInterval(() => void tryExit(), CHECK_MS);
    tryExit();
    return () => window.clearInterval(timer);
  }, [phase, tryExit, ltp]);

  const stopLoop = async () => {
    if (stopping) return;
    if (phaseRef.current === "in_position") {
      if (
        !window.confirm(
          "Stop formula trading and square off the open position?\n\nThis places a REAL exit on Zerodha."
        )
      ) {
        return;
      }
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

  const cooldownLeft = Math.max(0, cooldownTarget - candleCount);

  return (
    <div className="card formula-trade-panel mb-4">
      <div className="card-header flex-between flex-wrap gap-3">
        <div>
          <h3 className="card-title">Formula Trading</h3>
          <p className="card-desc">
            {rule.name} · Loop 1 ↔ 2 · {cycles} cycle{cycles === 1 ? "" : "s"} · losses{" "}
            {consecutiveLosses}/{FORMULA_RULES.maxConsecutiveLosses}
          </p>
        </div>
        <span
          className={cn(
            "badge",
            phase === "in_position"
              ? "badge-success"
              : phase === "waiting" || phase === "cooldown"
                ? "badge-warning"
                : "badge-default"
          )}
        >
          {phase === "cooldown" ? `cooldown (${cooldownLeft})` : phase.replace("_", " ")}
        </span>
      </div>

      <div className="formula-trade-rules mb-4">
        <p className="text-muted" style={{ fontSize: "0.8125rem", margin: 0 }}>
          <strong>Call:</strong> RSI &lt; 15 for 2 candles + spot &gt; VWAP
        </p>
        <p className="text-muted" style={{ fontSize: "0.8125rem", margin: "0.35rem 0 0" }}>
          <strong>Put:</strong> RSI &gt; 75 for 2 candles + spot &lt; VWAP
        </p>
        <p className="text-muted" style={{ fontSize: "0.8125rem", margin: "0.35rem 0 0" }}>
          <strong>Exit:</strong> TP +8–12% · SL −15% · 20 min · hard 3:15 PM
        </p>
        <p className="text-muted" style={{ fontSize: "0.8125rem", margin: "0.35rem 0 0" }}>
          <strong>Risk:</strong> 1% capital/trade · stop after 2 losses · 5-candle cooldown
        </p>
      </div>

      <div className="auto-trade-stats mb-4">
        <div className="auto-trade-stat">
          <p className="stream-metric-label">RSI (14)</p>
          <p className="stream-metric-value">{rsi14 != null ? formatNumber(rsi14, 1) : "—"}</p>
        </div>
        <div className="auto-trade-stat">
          <p className="stream-metric-label">Spot vs VWAP</p>
          <p className="stream-metric-value" style={{ fontSize: "0.875rem" }}>
            {spotPrice > 0 ? formatNumber(spotPrice) : "—"}
            {vwap != null ? ` / ${formatNumber(vwap)}` : ""}
          </p>
        </div>
        {phase === "in_position" && (
          <>
            <div className="auto-trade-stat">
              <p className="stream-metric-label">Premium P&L</p>
              <p
                className={cn(
                  "stream-metric-value",
                  profitPct >= FORMULA_RULES.takeProfitMinPct
                    ? "text-up"
                    : profitPct <= -FORMULA_RULES.stopLossPct
                      ? "text-down"
                      : undefined
                )}
              >
                {formatNumber(profitPct, 2)}%
              </p>
            </div>
            <div className="auto-trade-stat">
              <p className="stream-metric-label">Time in trade</p>
              <p className="stream-metric-value">
                {minutesInTrade}/{FORMULA_RULES.timeStopMinutes}m
              </p>
            </div>
          </>
        )}
        {capital > 0 && (
          <div className="auto-trade-stat">
            <p className="stream-metric-label">Capital · lots</p>
            <p className="stream-metric-value" style={{ fontSize: "0.875rem" }}>
              {formatCurrency(capital)} · {tradeLots} lot{tradeLots === 1 ? "" : "s"}
            </p>
          </div>
        )}
      </div>

      {error && <div className="alert alert-error mb-4">{error}</div>}
      {entryOrderId && (
        <p className="text-muted mb-3" style={{ fontSize: "0.8125rem" }}>
          {tradingsymbol && `${legLabel(rule.leg)} · ${strike} · `}
          Entry: {entryOrderId}
          {exitOrderId ? ` · Exit: ${exitOrderId}` : ""}
        </p>
      )}

      <div className="flex gap-2 flex-wrap mb-4">
        <button
          type="button"
          className="btn btn-danger"
          onClick={() => void stopLoop()}
          disabled={stopping}
        >
          {stopping ? "Exiting…" : phase === "in_position" ? "Stop & Exit" : "Stop Formula"}
        </button>
        <span className="badge badge-warning" style={{ alignSelf: "center" }}>
          Live orders — real money
        </span>
      </div>

      {logs.length > 0 && (
        <div className="auto-trade-log">
          {logs.map((entry, index) => (
            <p key={`${entry.time}-${index}`} className={cn("auto-trade-log-line", entry.type && `log-${entry.type}`)}>
              <span className="text-muted">{entry.time}</span> {entry.message}
            </p>
          ))}
        </div>
      )}
    </div>
  );
}
