import { useCallback, useEffect, useRef, useState } from "react";
import {
  AI_AUTO_TARGET_PROFIT_INR,
  AI_LOOP_POLL_MS,
  calcPremiumPnl,
  defaultProduct,
  exitTransactionType,
  placeKiteOrder,
  shouldExitForProfitInr,
  shouldExitPosition,
  type AutoTradeLogEntry,
  type AutoTradePhase,
  type AutoTradePlan,
} from "@/lib/auto-trade";
import type { StreamingGeminiPayload } from "@/lib/streaming-snapshot";
import { useConfirm } from "@/contexts/confirm-context";
import { buildProtectedMarketOrder } from "@/lib/kite-orders";
import { legLabel, parseTradeLeg, productForExchange, type TradeLeg } from "@/lib/trade-calculations";
import type { EntryTimingApiResponse } from "@/types/auto-trade";
import { cn, formatCurrency, formatNumber } from "@/lib/utils";

const LTP_REFRESH_MS = 2000;
const EXIT_CHECK_MS = 1000;

interface AutoTradeRunnerProps {
  plan: AutoTradePlan;
  leg: TradeLeg;
  strike: number;
  tradingsymbol: string;
  lotSize: number;
  lots: number;
  spotPrice: number;
  autoStart?: boolean;
  loop?: boolean;
  targetProfitInr?: number;
  getStreamingSnapshot?: () => StreamingGeminiPayload | null;
  onCancel?: () => void;
}

export function AutoTradeRunner({
  plan,
  leg,
  strike,
  tradingsymbol,
  lotSize,
  lots,
  spotPrice,
  autoStart = false,
  loop = false,
  targetProfitInr = AI_AUTO_TARGET_PROFIT_INR,
  getStreamingSnapshot,
  onCancel,
}: AutoTradeRunnerProps) {
  const { confirm } = useConfirm();
  const [phase, setPhase] = useState<AutoTradePhase>("idle");
  const [ltp, setLtp] = useState(0);
  const [entryPremium, setEntryPremium] = useState(0);
  const [entryOrderId, setEntryOrderId] = useState("");
  const [exitOrderId, setExitOrderId] = useState("");
  const [lastSignal, setLastSignal] = useState("");
  const [logs, setLogs] = useState<AutoTradeLogEntry[]>([]);
  const [error, setError] = useState("");
  const [stopping, setStopping] = useState(false);
  const runningRef = useRef(false);
  const phaseRef = useRef<AutoTradePhase>("idle");
  const ltpRef = useRef(0);
  const spotPriceRef = useRef(spotPrice);

  const quantity = lots * lotSize;
  const { transactionType } = parseTradeLeg(leg);
  const product = productForExchange(defaultProduct(plan), "NFO");

  const pushLog = useCallback((message: string, type: AutoTradeLogEntry["type"] = "info") => {
    setLogs((prev) => [
      ...prev.slice(-40),
      { time: new Date().toLocaleTimeString("en-IN"), message, type },
    ]);
  }, []);

  useEffect(() => {
    phaseRef.current = phase;
  }, [phase]);

  useEffect(() => {
    spotPriceRef.current = spotPrice;
  }, [spotPrice]);

  useEffect(() => {
    ltpRef.current = ltp;
  }, [ltp]);

  const refreshLtp = useCallback(async () => {
    try {
      const res = await fetch(
        `/api/kite/quotes?instruments=${encodeURIComponent(`NFO:${tradingsymbol}`)}`,
        { credentials: "include" }
      );
      const json = await res.json();
      if (!res.ok) return;
      const quote = json.data?.[`NFO:${tradingsymbol}`] as { last_price?: number } | undefined;
      if (quote?.last_price) setLtp(quote.last_price);
    } catch {
      /* ignore transient quote errors */
    }
  }, [tradingsymbol]);

  const checkEntry = useCallback(async () => {
    if (phaseRef.current !== "waiting") return;
    try {
      const res = await fetch("/api/gemini/entry-timing", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          plannedAction: plan.action,
          strike,
          leg,
          product: plan.product,
          entryPlan: plan.entryPlan,
          riskPlan: plan.riskPlan,
          invalidation: plan.invalidation,
          summary: plan.summary,
          spot: spotPriceRef.current,
          optionLtp: ltpRef.current,
          targetPremium: plan.targetPremium,
          stopPremium: plan.stopPremium,
          streamingSnapshot: getStreamingSnapshot?.() ?? undefined,
          exitTargetProfitInr: loop ? targetProfitInr : undefined,
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Entry check failed");
      const data = json.data as EntryTimingApiResponse;
      const cachedNote = data.cached ? " (cached)" : "";
      setLastSignal(`${data.signal}: ${data.reason}${cachedNote}`);
      pushLog(
        `AI → ${data.signal}: ${data.reason}${cachedNote}`,
        data.signal === "ENTER" ? "success" : "info"
      );

      if (data.signal === "ABORT") {
        if (loop && runningRef.current) {
          pushLog("Setup skipped — waiting for next AI entry", "warning");
          setPhase("waiting");
          return;
        }
        setPhase("cancelled");
        pushLog("Trade aborted by AI — invalidation met", "warning");
        runningRef.current = false;
        return;
      }

      if (data.signal === "ENTER" && phaseRef.current === "waiting") {
        setPhase("entering");
        pushLog("Placing entry order…", "info");
        const liveLtp = ltpRef.current;
        const limit = data.limitPrice && data.limitPrice > 0 ? data.limitPrice : liveLtp;
        const orderType = data.limitPrice && data.limitPrice > 0 ? "LIMIT" : "MARKET";
        const baseFields = {
          tradingsymbol,
          exchange: "NFO",
          transaction_type: transactionType,
          order_type: orderType,
          product,
          quantity,
          validity: "DAY",
          variety: "regular",
        };
        const payload =
          orderType === "LIMIT"
            ? { ...baseFields, price: limit }
            : buildProtectedMarketOrder(baseFields);

        const result = await placeKiteOrder(payload);
        setEntryOrderId(result.order_id);
        setEntryPremium(limit > 0 ? limit : liveLtp);
        setPhase("in_position");
        pushLog(
          `Entry filled · Order ${result.order_id} @ ${formatNumber(limit > 0 ? limit : liveLtp)}`,
          "success"
        );
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Entry check failed";
      pushLog(msg, "error");
    }
  }, [plan, strike, leg, tradingsymbol, transactionType, product, quantity, pushLog, getStreamingSnapshot]);

  const squareOff = useCallback(
    async (reason: string) => {
      if (phaseRef.current !== "in_position") return;
      setPhase("exiting");
      pushLog(`${reason} — squaring off`, "warning");
      try {
        await refreshLtp();
        const liveLtp = ltpRef.current;
        const exitSide = exitTransactionType(leg);
        const result = await placeKiteOrder(
          buildProtectedMarketOrder({
            tradingsymbol,
            exchange: "NFO",
            transaction_type: exitSide,
            product,
            quantity,
          })
        );
        setExitOrderId(result.order_id);
        const pnl = calcPremiumPnl(leg, entryPremium, liveLtp > 0 ? liveLtp : ltp, quantity);
        if (loop && runningRef.current) {
          setPhase("waiting");
          setEntryPremium(0);
          setEntryOrderId("");
          pushLog(
            `Exit order ${result.order_id} · P&L ${formatCurrency(pnl)} · waiting for next trade`,
            pnl >= 0 ? "success" : "error"
          );
          return;
        }
        setPhase("completed");
        pushLog(
          `Exit order ${result.order_id} · P&L ${formatCurrency(pnl)}`,
          pnl >= 0 ? "success" : "error"
        );
        runningRef.current = false;
      } catch (err) {
        setPhase("error");
        const msg = err instanceof Error ? err.message : "Exit failed";
        setError(msg);
        pushLog(msg, "error");
        runningRef.current = false;
      }
    },
    [leg, entryPremium, ltp, tradingsymbol, product, quantity, pushLog, refreshLtp, loop]
  );

  const checkExit = useCallback(async () => {
    if (phaseRef.current !== "in_position" || ltp <= 0 || entryPremium <= 0) return;
    if (loop) {
      const pnl = calcPremiumPnl(leg, entryPremium, ltp, quantity);
      if (shouldExitForProfitInr(pnl, targetProfitInr)) {
        await squareOff(`Target ${formatCurrency(targetProfitInr)} reached (${formatCurrency(pnl)})`);
      }
      return;
    }
    const exitCheck = shouldExitPosition(leg, entryPremium, ltp, plan.targetPremium, plan.stopPremium);
    if (!exitCheck.exit) return;
    await squareOff(exitCheck.reason);
  }, [leg, entryPremium, ltp, plan.targetPremium, plan.stopPremium, squareOff, loop, targetProfitInr, quantity]);

  const start = useCallback(async (skipConfirm = false) => {
    if (plan.action === "WAIT") {
      setError("AI suggested WAIT — no auto-trade for this setup");
      return;
    }
    if (!skipConfirm) {
      const ok = await confirm({
        title: "Start AI auto-trade?",
        body: (
          <>
            <p>
              {legLabel(leg)} @ strike {formatNumber(strike)}
            </p>
            <p>This will place REAL orders on Zerodha when AI signals ENTER, and exit at target/stop.</p>
            <p className="confirm-note">REAL Zerodha orders — real money.</p>
          </>
        ),
        confirmLabel: "Start auto-trade",
        tone: "danger",
      });
      if (!ok) return;
    }
    setError("");
    setLogs([]);
    runningRef.current = true;
    setPhase("waiting");
    pushLog("Auto-trade started — waiting for AI entry signal", "info");
    void (async () => {
      await refreshLtp();
      checkEntry();
    })();
  }, [plan.action, leg, strike, pushLog, refreshLtp, checkEntry, confirm]);

  const stop = async () => {
    if (stopping || phase === "exiting") return;

    if (phaseRef.current === "in_position") {
      const ok = await confirm({
        title: "Stop & exit position?",
        body: (
          <>
            <p>
              Stop auto-trade and square off {legLabel(leg)} @ strike {formatNumber(strike)}.
            </p>
            <p className="confirm-note">This will place a REAL exit order on Zerodha.</p>
          </>
        ),
        confirmLabel: "Stop & exit",
        tone: "danger",
      });
      if (!ok) return;
      setStopping(true);
      runningRef.current = false;
      await squareOff("Stopped by user");
      setStopping(false);
      onCancel?.();
      return;
    }

    runningRef.current = false;
    setPhase("cancelled");
    pushLog("Auto-trade cancelled by user", "warning");
    onCancel?.();
  };

  const autoStartedRef = useRef(false);
  useEffect(() => {
    if (!autoStart || autoStartedRef.current || phase !== "idle") return;
    autoStartedRef.current = true;
    start(true);
  }, [autoStart, phase, start]);

  useEffect(() => {
    if (!runningRef.current || phase === "idle" || phase === "completed" || phase === "cancelled" || phase === "error") {
      return;
    }
    refreshLtp();
    const ltpTimer = window.setInterval(refreshLtp, LTP_REFRESH_MS);
    return () => window.clearInterval(ltpTimer);
  }, [phase, refreshLtp]);

  useEffect(() => {
    if (phase !== "waiting") return;
    checkEntry();
    const timer = window.setInterval(checkEntry, AI_LOOP_POLL_MS);
    return () => window.clearInterval(timer);
  }, [phase, checkEntry]);

  useEffect(() => {
    if (phase !== "in_position") return;
    const timer = window.setInterval(checkExit, EXIT_CHECK_MS);
    checkExit();
    return () => window.clearInterval(timer);
  }, [phase, checkExit, ltp]);

  const pnl =
    phase === "in_position" && entryPremium > 0 && ltp > 0
      ? calcPremiumPnl(leg, entryPremium, ltp, quantity)
      : 0;

  return (
    <div className="card auto-trade-panel mb-6">
      <div className="card-header flex-between flex-wrap gap-3">
        <div>
          <h3 className="card-title">AI Auto Trade</h3>
          <p className="card-desc">
            {legLabel(leg)} · Strike {formatNumber(strike, 0)} · {tradingsymbol}
          </p>
        </div>
        <span
          className={cn(
            "badge",
            phase === "in_position" ? "badge-success" : phase === "waiting" ? "badge-warning" : "badge-default"
          )}
        >
          {phase.replace("_", " ")}
        </span>
      </div>

      <p className="text-muted mb-4" style={{ fontSize: "0.875rem" }}>{plan.summary}</p>

      <div className="auto-trade-stats mb-4">
        <div className="auto-trade-stat">
          <p className="stream-metric-label">Option LTP</p>
          <p className="stream-metric-value">{ltp > 0 ? formatNumber(ltp) : "—"}</p>
        </div>
        <div className="auto-trade-stat">
          <p className="stream-metric-label">Target</p>
          <p className="stream-metric-value text-up">
            {plan.targetPremium != null ? formatNumber(plan.targetPremium) : "—"}
          </p>
        </div>
        <div className="auto-trade-stat">
          <p className="stream-metric-label">Stop</p>
          <p className="stream-metric-value text-down">
            {plan.stopPremium != null ? formatNumber(plan.stopPremium) : "—"}
          </p>
        </div>
        {phase === "in_position" && (
          <div className="auto-trade-stat">
            <p className="stream-metric-label">Live P&L</p>
            <p className={cn("stream-metric-value", pnl >= 0 ? "text-up" : "text-down")}>
              {formatCurrency(pnl)}
            </p>
          </div>
        )}
      </div>

      {lastSignal && phase === "waiting" && (
        <div className="alert alert-warning mb-4" style={{ fontSize: "0.875rem" }}>{lastSignal}</div>
      )}
      {error && <div className="alert alert-error mb-4">{error}</div>}
      {entryOrderId && (
        <p className="text-muted mb-3" style={{ fontSize: "0.8125rem" }}>
          Entry order: {entryOrderId}
          {exitOrderId ? ` · Exit: ${exitOrderId}` : ""}
        </p>
      )}

      <div className="flex gap-2 flex-wrap mb-4">
        {phase === "idle" && !autoStart && (
          <button type="button" className="btn btn-primary" onClick={() => start()}>
            Start AI Auto Trade
          </button>
        )}
        {(phase === "waiting" || phase === "in_position") && (
          <button
            type="button"
            className="btn btn-danger"
            onClick={() => void stop()}
            disabled={stopping}
          >
            {stopping ? "Exiting…" : phase === "in_position" ? "Stop & Exit" : "Stop Auto Trade"}
          </button>
        )}
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
