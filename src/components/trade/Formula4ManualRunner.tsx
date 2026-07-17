import { useCallback, useEffect, useRef, useState } from "react";
import {
  calcPremiumPnl,
  fetchNetPositionQty,
  waitForKiteOrderComplete,
} from "@/lib/auto-trade";
import {
  checkFormula4Exit,
  fetchFormulaOptionChain,
  FORMULA_4_TARGET_PROFIT_INR,
  FORMULA_VARIANTS,
  placeFormulaEntry,
  placeFormulaExit,
  resolveFormulaInstrument,
} from "@/lib/formula-trade";
import { useConfirm } from "@/contexts/confirm-context";
import { getStreamInstrument } from "@/lib/stream-instruments";
import { legLabel, type TradeLeg } from "@/lib/trade-calculations";
import { cn, formatCurrency, formatNumber } from "@/lib/utils";
import type { FormulaLogEntry } from "@/components/trade/FormulaOrchestrator";

const LTP_MS = 500;
const EXIT_CHECK_MS = 250;

type ManualPhase = "ready" | "entering" | "in_position" | "exiting" | "stopped";

interface Formula4ManualRunnerProps {
  streamInstrumentId: string;
  spot: number;
  marketStreaming: boolean;
  connected: boolean;
  onStop?: () => void;
}

export function Formula4ManualRunner({
  streamInstrumentId,
  spot,
  marketStreaming,
  connected,
  onStop,
}: Formula4ManualRunnerProps) {
  const { confirm } = useConfirm();
  const variantRule = FORMULA_VARIANTS[4];
  const instrument = getStreamInstrument(streamInstrumentId);

  const [phase, setPhase] = useState<ManualPhase>("ready");
  const [leg, setLeg] = useState<TradeLeg>("CE_BUY");
  const [ltp, setLtp] = useState(0);
  const [entryPremium, setEntryPremium] = useState(0);
  const [entryOrderId, setEntryOrderId] = useState("");
  const [exitOrderId, setExitOrderId] = useState("");
  const [tradingsymbol, setTradingsymbol] = useState("");
  const [strike, setStrike] = useState(0);
  const [quantity, setQuantity] = useState(0);
  const [logs, setLogs] = useState<FormulaLogEntry[]>([]);
  const [error, setError] = useState("");
  const [stopping, setStopping] = useState(false);
  const [cycles, setCycles] = useState(0);

  const phaseRef = useRef<ManualPhase>("ready");
  const legRef = useRef<TradeLeg>("CE_BUY");
  const tradingsymbolRef = useRef("");
  const quantityRef = useRef(0);
  const entryPremiumRef = useRef(0);
  const ltpRef = useRef(0);
  const enteringRef = useRef(false);
  const exitingRef = useRef(false);
  const exchangeRef = useRef<"NFO" | "BFO">("NFO");

  const setPhaseSync = useCallback((next: ManualPhase) => {
    phaseRef.current = next;
    setPhase(next);
  }, []);

  const pushLog = useCallback((message: string, type: FormulaLogEntry["type"] = "info") => {
    setLogs((prev) => [...prev.slice(-60), { time: new Date().toLocaleTimeString("en-IN"), message, type }]);
  }, []);

  const livePnl =
    phase === "in_position" && entryPremium > 0 && ltp > 0
      ? calcPremiumPnl(leg, entryPremium, ltp, quantity)
      : 0;

  const refreshLtp = useCallback(async () => {
    const symbol = tradingsymbolRef.current;
    if (!symbol) return 0;
    const exchange = exchangeRef.current;
    try {
      const res = await fetch(
        `/api/kite/quotes?instruments=${encodeURIComponent(`${exchange}:${symbol}`)}`,
        { credentials: "include" }
      );
      const json = await res.json();
      if (!res.ok) return ltpRef.current;
      const quote = json.data?.[`${exchange}:${symbol}`] as { last_price?: number } | undefined;
      if (quote?.last_price) {
        setLtp(quote.last_price);
        ltpRef.current = quote.last_price;
        return quote.last_price;
      }
    } catch {
      /* ignore */
    }
    return ltpRef.current;
  }, []);

  const squareOff = useCallback(
    async (reason: string) => {
      if (exitingRef.current || phaseRef.current !== "in_position") return;
      exitingRef.current = true;
      setPhaseSync("exiting");
      pushLog(`${reason} — market exit`, "warning");

      const symbol = tradingsymbolRef.current;
      const qty = quantityRef.current;
      const exchange = exchangeRef.current;

      try {
        await refreshLtp();
        const result = await placeFormulaExit(symbol, legRef.current, qty, exchange);
        pushLog(`Exit order ${result.order_id} submitted`, "info");
        await waitForKiteOrderComplete(result.order_id);
        const openQty = await fetchNetPositionQty(symbol, "MIS");
        if (openQty !== 0) {
          throw new Error(`Position still open (${openQty} qty)`);
        }

        const pnl = calcPremiumPnl(legRef.current, entryPremiumRef.current, ltpRef.current, qty);
        setExitOrderId(result.order_id);
        setCycles((c) => c + 1);
        pushLog(`Exit filled · P&L ${formatCurrency(pnl)}`, pnl >= 0 ? "success" : "error");
        tradingsymbolRef.current = "";
        entryPremiumRef.current = 0;
        setTradingsymbol("");
        setEntryPremium(0);
        setEntryOrderId("");
        exitingRef.current = false;
        setPhaseSync("ready");
      } catch (err) {
        exitingRef.current = false;
        setPhaseSync("in_position");
        const msg = err instanceof Error ? err.message : "Exit failed";
        setError(msg);
        pushLog(`${msg} — will retry`, "error");
      }
    },
    [pushLog, refreshLtp, setPhaseSync]
  );

  const tryExit = useCallback(async () => {
    if (phaseRef.current !== "in_position" || exitingRef.current || entryPremiumRef.current <= 0) return;
    const price = ltpRef.current > 0 ? ltpRef.current : entryPremiumRef.current;
    const pnl = calcPremiumPnl(legRef.current, entryPremiumRef.current, price, quantityRef.current);
    if (!checkFormula4Exit(pnl)) return;
    await squareOff(`+${formatCurrency(FORMULA_4_TARGET_PROFIT_INR)} target (${formatCurrency(pnl)})`);
  }, [squareOff]);

  const enterManual = useCallback(
    async (chosenLeg: TradeLeg) => {
      if (!connected || !marketStreaming || enteringRef.current) return;
      if (phaseRef.current !== "ready") return;
      if (spot <= 0) {
        setError("Spot price not ready — wait for stream");
        return;
      }

      const legLabelText = legLabel(chosenLeg);
      const ok = await confirm({
        title: `${legLabelText} on ${instrument.label}?`,
        body: (
          <>
            <p>
              Place a real <strong>{legLabelText}</strong> on ATM strike · exit at{" "}
              <strong>+{formatCurrency(FORMULA_4_TARGET_PROFIT_INR)}</strong> premium P&L.
            </p>
            <p className="confirm-note">REAL Zerodha MIS market order.</p>
          </>
        ),
        confirmLabel: legLabelText,
        tone: "danger",
      });
      if (!ok) return;

      enteringRef.current = true;
      setPhaseSync("entering");
      setError("");
      legRef.current = chosenLeg;
      setLeg(chosenLeg);
      exchangeRef.current = instrument.chainExchange;

      try {
        const chain = await fetchFormulaOptionChain(instrument.id);
        const resolved = resolveFormulaInstrument(chain, chosenLeg, spot);
        if (!resolved) {
          throw new Error("ATM option not found");
        }

        const quoteKey = `${instrument.chainExchange}:${resolved.tradingsymbol}`;
        const res = await fetch(
          `/api/kite/quotes?instruments=${encodeURIComponent(quoteKey)}`,
          { credentials: "include" }
        );
        const json = await res.json();
        const quote = json.data?.[quoteKey] as { last_price?: number } | undefined;
        const entryLtp = quote?.last_price ?? 0;
        if (entryLtp <= 0) throw new Error("Could not read option LTP");

        const qty = resolved.lotSize;
        quantityRef.current = qty;
        setQuantity(qty);

        pushLog(
          `${legLabelText} · ${instrument.label} · ${resolved.tradingsymbol} @ ${formatNumber(entryLtp)} · 1 lot`,
          "info"
        );

        const result = await placeFormulaEntry(
          resolved.tradingsymbol,
          chosenLeg,
          qty,
          instrument.chainExchange
        );
        await waitForKiteOrderComplete(result.order_id);

        tradingsymbolRef.current = resolved.tradingsymbol;
        entryPremiumRef.current = entryLtp;
        ltpRef.current = entryLtp;
        setTradingsymbol(resolved.tradingsymbol);
        setStrike(resolved.strike);
        setEntryOrderId(result.order_id);
        setEntryPremium(entryLtp);
        setLtp(entryLtp);
        enteringRef.current = false;
        setPhaseSync("in_position");
        pushLog(
          `Entry ${result.order_id} · target +${formatCurrency(FORMULA_4_TARGET_PROFIT_INR)}`,
          "success"
        );
      } catch (err) {
        enteringRef.current = false;
        setPhaseSync("ready");
        const msg = err instanceof Error ? err.message : "Entry failed";
        setError(msg);
        pushLog(msg, "error");
      }
    },
    [confirm, connected, instrument, marketStreaming, pushLog, setPhaseSync, spot]
  );

  useEffect(() => {
    pushLog(
      `${variantRule.displayName} · pick Call or Put · +${formatCurrency(FORMULA_4_TARGET_PROFIT_INR)} auto-exit`,
      "info"
    );
  }, [pushLog, variantRule.displayName]);

  useEffect(() => {
    if (phase !== "in_position") return;
    void refreshLtp();
    const ltpTimer = window.setInterval(() => void refreshLtp(), LTP_MS);
    const exitTimer = window.setInterval(() => void tryExit(), EXIT_CHECK_MS);
    return () => {
      window.clearInterval(ltpTimer);
      window.clearInterval(exitTimer);
    };
  }, [phase, refreshLtp, tryExit]);

  const stopLoop = async () => {
    if (stopping) return;
    if (phaseRef.current === "in_position") {
      const ok = await confirm({
        title: "Stop & exit position?",
        body: (
          <>
            <p>Square off the open position and stop Formula 4.</p>
            <p className="confirm-note">REAL exit on Zerodha.</p>
          </>
        ),
        confirmLabel: "Stop & exit",
        tone: "danger",
      });
      if (!ok) return;
      setStopping(true);
      await squareOff("Stopped by user");
      setPhaseSync("stopped");
      setStopping(false);
      onStop?.();
      return;
    }
    setPhaseSync("stopped");
    pushLog("Formula 4 stopped", "warning");
    onStop?.();
  };

  const canPickLeg = phase === "ready" && connected && marketStreaming && !enteringRef.current;

  return (
    <div className="stream-formula-panel stream-formula-panel--manual">
      <div className="stream-formula-head">
        <div>
          <p className="card-title" style={{ fontSize: "0.9375rem" }}>
            {variantRule.displayName} · {instrument.label}
          </p>
          <p className="card-desc" style={{ marginTop: "0.2rem" }}>
            {phase === "in_position"
              ? `${legLabel(leg)} · ${tradingsymbol || strike}`
              : phase === "ready"
                ? "Choose Call Buy or Put Buy · 1 lot ATM"
                : phase.replace("_", " ")}
            {" · "}
            {cycles} trade{cycles === 1 ? "" : "s"}
          </p>
        </div>
        <span
          className={cn(
            "stream-formula-status-pill",
            phase === "in_position" ? "is-active" : "is-waiting"
          )}
        >
          {phase.replace("_", " ")}
        </span>
      </div>

      {phase === "ready" && (
        <div className="stream-formula-manual-actions">
          <button
            type="button"
            className="stream-formula-manual-btn is-call"
            disabled={!canPickLeg}
            onClick={() => void enterManual("CE_BUY")}
          >
            <span className="stream-formula-manual-btn-title">Call Buy</span>
            <span className="stream-formula-manual-btn-sub">ATM CE · 1 lot</span>
          </button>
          <button
            type="button"
            className="stream-formula-manual-btn is-put"
            disabled={!canPickLeg}
            onClick={() => void enterManual("PE_BUY")}
          >
            <span className="stream-formula-manual-btn-title">Put Buy</span>
            <span className="stream-formula-manual-btn-sub">ATM PE · 1 lot</span>
          </button>
        </div>
      )}

      {phase === "in_position" && (
        <div className="stream-formula-manual-pnl">
          <div className="auto-trade-stat">
            <p className="stream-metric-label">Premium P&L</p>
            <p
              className={cn(
                "stream-metric-value",
                livePnl >= FORMULA_4_TARGET_PROFIT_INR
                  ? "text-up"
                  : livePnl < 0
                    ? "text-down"
                    : undefined
              )}
            >
              {formatCurrency(livePnl)}
            </p>
          </div>
          <div className="auto-trade-stat">
            <p className="stream-metric-label">Target</p>
            <p className="stream-metric-value text-up">+{formatCurrency(FORMULA_4_TARGET_PROFIT_INR)}</p>
          </div>
          <div className="auto-trade-stat">
            <p className="stream-metric-label">To target</p>
            <p className="stream-metric-value">
              {formatCurrency(Math.max(0, FORMULA_4_TARGET_PROFIT_INR - livePnl))}
            </p>
          </div>
        </div>
      )}

      <p className="text-muted mb-3" style={{ fontSize: "0.8125rem" }}>
        Chart: {instrument.label} · Trades: ATM options on {instrument.chainExchange} · Auto exit at +
        {formatCurrency(FORMULA_4_TARGET_PROFIT_INR)} · no RSI scan
      </p>

      {error && <div className="alert alert-error mb-3">{error}</div>}
      {entryOrderId && (
        <p className="text-muted mb-3" style={{ fontSize: "0.8125rem" }}>
          {legLabel(leg)} · {strike} · Entry {entryOrderId}
          {exitOrderId ? ` · Exit ${exitOrderId}` : ""}
        </p>
      )}

      <div className="flex gap-2 flex-wrap mb-3">
        <button type="button" className="btn btn-danger btn-sm" onClick={() => void stopLoop()} disabled={stopping}>
          {stopping ? "Exiting…" : phase === "in_position" ? "Stop & Exit" : "Stop Formula 4"}
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
  );
}
