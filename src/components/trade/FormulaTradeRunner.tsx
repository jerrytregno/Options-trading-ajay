import { useCallback, useEffect, useRef, useState } from "react";
import {
  checkFormulaExit,
  FORMULA_OPTIONS,
  FORMULA_RULES,
  FORMULA_VARIANTS,
  formulaCallEntryLabel,
  formulaPutEntryLabel,
  formulaUsesVwap,
  fetchFormulaOptionChain,
  formulaLotsForRisk,
  pickFormulaEntryOption,
  type FormulaEntryContext,
  type FormulaOptionId,
  type FormulaPhase,
  type FormulaVariantId,
  isPastFormulaHardExit,
  isInFormulaHardExitWindow,
  placeFormulaEntry,
  placeFormulaExit,
  premiumProfitPct,
  resolveFormulaInstrument,
} from "@/lib/formula-trade";
import { fetchNetPositionQty, waitForKiteOrderComplete } from "@/lib/auto-trade";
import { useConfirm } from "@/contexts/confirm-context";
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
  formulaVariant: FormulaVariantId;
  rsi14: number | null;
  recentRsi: number[];
  spotPrice: number;
  vwap: number | null;
  candleCount: number;
  onStop?: () => void;
}

export function FormulaTradeRunner({
  chain,
  formulaVariant,
  rsi14,
  recentRsi,
  spotPrice,
  vwap,
  candleCount,
  onStop,
}: FormulaTradeRunnerProps) {
  const { confirm } = useConfirm();
  const [phase, setPhase] = useState<FormulaPhase>("waiting");
  const [activeOption, setActiveOption] = useState<FormulaOptionId>(1);
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
  const exitingRef = useRef(false);

  const setPhaseSync = useCallback((next: FormulaPhase) => {
    phaseRef.current = next;
    setPhase(next);
  }, []);
  const variantRule = FORMULA_VARIANTS[formulaVariant];
  const usesVwap = formulaUsesVwap(formulaVariant);
  const rule = FORMULA_OPTIONS[activeOption];
  const profitPct = premiumProfitPct(entryPremium, ltp);
  const inEodExitWindow = isInFormulaHardExitWindow();

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
      ema20: null,
      ema50: null,
    };
  }, []);

  const beginWaiting = useCallback(() => {
    if (isPastFormulaHardExit()) {
      setPhaseSync("stopped");
      pushLog("Past 3:15 PM IST — no new entries (EOD exit window)", "warning");
      runningRef.current = false;
      onStop?.();
      return;
    }
    setEntryOrderId("");
    setExitOrderId("");
    setEntryPremium(0);
    setEntryTimeMs(0);
    setLtp(0);
    setTradingsymbol("");
    entryPremiumRef.current = 0;
    entryTimeMsRef.current = 0;
    ltpRef.current = 0;
    tradingsymbolRef.current = "";
    setPhaseSync("waiting");
    pushLog("Waiting for Call or Put signal (one trade at a time)", "info");
  }, [pushLog, onStop, setPhaseSync]);

  const startCooldown = useCallback(() => {
    const target = candleCountRef.current + FORMULA_RULES.cooldownCandles;
    cooldownTargetRef.current = target;
    setCooldownTarget(target);
    setPhaseSync("cooldown");
    pushLog(
      `Cooldown ${FORMULA_RULES.cooldownCandles} × 1m bars · then next valid Call or Put`,
      "info"
    );
  }, [pushLog, setPhaseSync]);

  const haltAfterLosses = useCallback(() => {
    setPhase("stopped");
    pushLog(`${FORMULA_RULES.maxConsecutiveLosses} consecutive losses — formula halted`, "error");
    runningRef.current = false;
    onStop?.();
  }, [pushLog, onStop]);

  const refreshLtp = useCallback(async () => {
    const symbol = tradingsymbolRef.current;
    if (!symbol) return 0;
    try {
      const res = await fetch(
        `/api/kite/quotes?instruments=${encodeURIComponent(`NFO:${symbol}`)}`,
        { credentials: "include" }
      );
      const json = await res.json();
      if (!res.ok) return ltpRef.current;
      const quote = json.data?.[`NFO:${symbol}`] as { last_price?: number } | undefined;
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
      if (!symbol || qty <= 0) {
        pushLog("Exit blocked — missing tradingsymbol or quantity", "error");
        return;
      }

      exitingRef.current = true;
      setPhaseSync("exiting");
      pushLog(`${reason} — placing Zerodha exit`, "warning");

      try {
        const liveLtp = await refreshLtp();
        const result = await placeFormulaExit(symbol, leg, qty);
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

        exitingRef.current = false;
        startCooldown();
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Exit failed";
        exitingRef.current = false;
        setPhaseSync("in_position");
        setError(msg);
        pushLog(`${msg} — will retry exit on next check`, "error");
      }
    },
    [pushLog, startCooldown, haltAfterLosses, refreshLtp, setPhaseSync]
  );

  const tryEntry = useCallback(async () => {
    if (phaseRef.current !== "waiting" || !runningRef.current) return;
    if (isPastFormulaHardExit()) return;

    const ctx = entryContext();
    const option = pickFormulaEntryOption(ctx, formulaVariant);
    if (option == null) return;

    setActiveOption(option);
    activeOptionRef.current = option;
    legRef.current = FORMULA_OPTIONS[option].leg;

    const liveChain = (await fetchFormulaOptionChain("nifty50")) ?? chain;
    const spot = spotRef.current;
    const instrument = resolveFormulaInstrument(liveChain, FORMULA_OPTIONS[option].leg, spot);
    if (!instrument) {
      pushLog("ATM option not found — waiting for chain", "warning");
      return;
    }

    setPhase("entering");
    phaseRef.current = "entering";
    pushLog(
      `${FORMULA_OPTIONS[option].name} @ ${formatNumber(instrument.strike)} · RSI ${recentRsiRef.current.slice(-FORMULA_RULES.rsiConfirmCandles).map((r) => formatNumber(r, 1)).join(", ")}${usesVwap ? ` · spot ${formatNumber(ctx.spot)} vs VWAP ${ctx.vwap != null ? formatNumber(ctx.vwap) : "—"}` : ""}`,
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
      tradingsymbolRef.current = instrument.tradingsymbol;
      entryPremiumRef.current = entryLtp;
      entryTimeMsRef.current = now;
      quantityRef.current = qty;
      setTradingsymbol(instrument.tradingsymbol);
      setStrike(instrument.strike);
      setEntryOrderId(result.order_id);
      setEntryPremium(entryLtp);
      setEntryTimeMs(now);
      ltpRef.current = entryLtp;
      setLtp(entryLtp);
      setPhaseSync("in_position");
      pushLog(
        `Entry ${result.order_id} · ${lots} lot(s) @ ${formatNumber(entryLtp)} · 1% risk sizing`,
        "success"
      );
    } catch (err) {
      setPhaseSync("waiting");
      pushLog(err instanceof Error ? err.message : "Entry failed", "error");
    }
  }, [chain, entryContext, pushLog, usesVwap, setPhaseSync]);

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
    pushLog(`Formula loop · ${variantRule.name} (${variantRule.shortLabel}) · one trade at a time`, "info");
    beginWaiting();
  }, [beginWaiting, pushLog, variantRule.name, variantRule.shortLabel]);

  useEffect(() => {
    if (phase !== "cooldown") return;
    if (candleCountRef.current >= cooldownTargetRef.current) {
      beginWaiting();
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

  const cooldownLeft = Math.max(0, cooldownTarget - candleCount);

  return (
    <div className="card formula-trade-panel mb-4">
      <div className="card-header flex-between flex-wrap gap-3">
        <div>
          <h3 className="card-title">Formula Trading</h3>
          <p className="card-desc">
            {variantRule.name} · {variantRule.shortLabel} · 1m signals · 1s execution
            {" · "}
            {phase === "in_position" || phase === "entering" || phase === "exiting"
              ? rule.name
              : "Next: Call or Put (first valid signal)"}
            {" · "}
            {cycles} cycle{cycles === 1 ? "" : "s"} · losses {consecutiveLosses}/
            {FORMULA_RULES.maxConsecutiveLosses}
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
          {phase === "cooldown" ? `cooldown (${cooldownLeft}m bars)` : phase.replace("_", " ")}
        </span>
      </div>

      <div className="formula-trade-rules mb-4">
        <p className="text-muted" style={{ fontSize: "0.8125rem", margin: 0 }}>
          <strong>Strike:</strong> Always ATM · CE or PE from live spot
        </p>
        <p className="text-muted" style={{ fontSize: "0.8125rem", margin: "0.35rem 0 0" }}>
          <strong>Call:</strong> {formulaCallEntryLabel(formulaVariant)}
        </p>
        <p className="text-muted" style={{ fontSize: "0.8125rem", margin: "0.35rem 0 0" }}>
          <strong>Put:</strong> {formulaPutEntryLabel(formulaVariant)}
        </p>
        <p className="text-muted" style={{ fontSize: "0.8125rem", margin: "0.35rem 0 0" }}>
          <strong>Exit:</strong> TP +8–12% · SL −15% · 3:15–3:29 exit ≥0.5% · force 3:29 PM
        </p>
        <p className="text-muted" style={{ fontSize: "0.8125rem", margin: "0.35rem 0 0" }}>
          <strong>Loop:</strong> Next valid Call or Put · one open position only
        </p>
        <p className="text-muted" style={{ fontSize: "0.8125rem", margin: "0.35rem 0 0" }}>
          <strong>Risk:</strong> 1% capital/trade · stop after 2 losses · 5 × 1m bar cooldown
        </p>
      </div>

      <div className="auto-trade-stats mb-4">
        <div className="auto-trade-stat">
          <p className="stream-metric-label">RSI (14 · 1m)</p>
          <p className="stream-metric-value">{rsi14 != null ? formatNumber(rsi14, 1) : "—"}</p>
        </div>
        <div className="auto-trade-stat">
          <p className="stream-metric-label">Spot{usesVwap ? " vs VWAP (1m)" : ""}</p>
          <p className="stream-metric-value" style={{ fontSize: "0.875rem" }}>
            {spotPrice > 0 ? formatNumber(spotPrice) : "—"}
            {usesVwap && vwap != null ? ` / ${formatNumber(vwap)}` : ""}
          </p>
        </div>
        {phase === "in_position" && (
          <>
            <div className="auto-trade-stat">
              <p className="stream-metric-label">Premium P&L</p>
              <p
                className={cn(
                  "stream-metric-value",
                  profitPct >= (inEodExitWindow ? FORMULA_RULES.hardExitMinProfitPct : FORMULA_RULES.takeProfitMinPct)
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
              <p className="stream-metric-label">Exit target</p>
              <p className="stream-metric-value" style={{ fontSize: "0.875rem" }}>
                {inEodExitWindow
                  ? `≥${FORMULA_RULES.hardExitMinProfitPct}% until 3:29`
                  : `TP ≥${FORMULA_RULES.takeProfitMinPct}%`}
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
