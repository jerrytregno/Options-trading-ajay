import { useCallback, useEffect, useRef, useState } from "react";
import {
  AI_AUTO_TARGET_PROFIT_INR,
  AI_LOOP_POLL_MS,
  isAiLoopEntryAction,
  isNakedSellAction,
  calcPremiumPnl,
  exitTransactionType,
  fetchNetPositionQty,
  fetchKiteNetPosition,
  placeKiteOrder,
  resolveEntryAfterOrderAttempt,
  shouldExitForProfitInr,
  waitForKiteEntryFill,
  waitForKiteExitFill,
  type AutoTradeLogEntry,
} from "@/lib/auto-trade";
import {
  rsiForcedLeg,
} from "@/lib/gemini-trade-rules";
import {
  buildBracketEntryOrder,
  buildLimitExitOrder,
  buildProtectedMarketOrder,
  profitTargetPointsFromInr,
  profitTargetPremiumPrice,
} from "@/lib/kite-orders";
import { fetchFormulaOptionChain, resolveFormulaInstrument } from "@/lib/formula-trade";
import type { StreamingGeminiPayload } from "@/lib/streaming-snapshot";
import { legLabel, parseTradeLeg, productForExchange, type TradeLeg } from "@/lib/trade-calculations";
import type { EntryTimingApiResponse } from "@/types/auto-trade";
import type { GeminiSuggestionResponse, GeminiTradeSuggestion } from "@/types/streaming";
import { cn, formatCurrency, formatNumber } from "@/lib/utils";
import { Bot, Radar, Crosshair, TrendingUp, LogOut, Square, Activity, Target } from "lucide-react";

const LTP_MS = 1000;
const EXIT_CHECK_MS = 250;
const POSITION_SYNC_MS = 2000;

type AiPhase = "scanning" | "waiting_entry" | "entering" | "in_position" | "exiting";

export type GeminiAutoTradePhase = AiPhase;

interface GeminiAutoTraderProps {
  connected: boolean;
  marketStreaming: boolean;
  aiStreaming: boolean;
  underlyingId: string;
  getSnapshot: () => StreamingGeminiPayload | null;
  onStop?: () => void;
  onGeminiPause?: () => void;
  onGeminiResume?: () => void;
  onPhaseChange?: (phase: AiPhase) => void;
}

function actionToLeg(action: GeminiTradeSuggestion["action"]): TradeLeg | null {
  if (isAiLoopEntryAction(action)) return action;
  return null;
}

export function GeminiAutoTrader({
  connected,
  marketStreaming,
  aiStreaming,
  underlyingId,
  getSnapshot,
  onStop,
  onGeminiPause,
  onGeminiResume,
  onPhaseChange,
}: GeminiAutoTraderProps) {
  const [phase, setPhase] = useState<AiPhase>("scanning");
  const [plan, setPlan] = useState<GeminiTradeSuggestion | null>(null);
  const [leg, setLeg] = useState<TradeLeg>("CE_BUY");
  const [strike, setStrike] = useState(0);
  const [tradingsymbol, setTradingsymbol] = useState("");
  const [lotSize, setLotSize] = useState(75);
  const [lots] = useState(1);
  const [ltp, setLtp] = useState(0);
  const [entryPremium, setEntryPremium] = useState(0);
  const [targetExitPremium, setTargetExitPremium] = useState(0);
  const [brokerTargetExit, setBrokerTargetExit] = useState(false);
  const [entryOrderId, setEntryOrderId] = useState("");
  const [exitOrderId, setExitOrderId] = useState("");
  const [lastSignal, setLastSignal] = useState("");
  const [cycles, setCycles] = useState(0);
  const [logs, setLogs] = useState<AutoTradeLogEntry[]>([]);
  const [stopping, setStopping] = useState(false);

  const runningRef = useRef(true);
  const phaseRef = useRef<AiPhase>("scanning");
  const planRef = useRef<GeminiTradeSuggestion | null>(null);
  const legRef = useRef<TradeLeg>("CE_BUY");
  const tradingsymbolRef = useRef("");
  const quantityRef = useRef(75);
  const entryPremiumRef = useRef(0);
  const ltpRef = useRef(0);
  const enteringRef = useRef(false);
  const exitingRef = useRef(false);
  const entryOrderIdRef = useRef("");
  const positionSyncedRef = useRef(false);
  const lastEntryErrorRef = useRef("");
  const pendingExitOrderIdRef = useRef("");
  const brokerTargetExitRef = useRef(false);
  const targetExitPremiumRef = useRef(0);
  const scanForSetupRef = useRef<() => Promise<void>>(async () => {});
  const loopStartLoggedAtRef = useRef(0);

  const quantity = lots * lotSize;
  const product = productForExchange("MIS", "NFO");

  const setPhaseSync = useCallback((next: AiPhase) => {
    phaseRef.current = next;
    setPhase(next);
  }, []);

  const pushLog = useCallback((message: string, type: AutoTradeLogEntry["type"] = "info") => {
    setLogs((prev) => [...prev.slice(-80), { time: new Date().toLocaleTimeString("en-IN"), message, type }]);
  }, []);

  useEffect(() => {
    ltpRef.current = ltp;
  }, [ltp]);

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
        setLtp(quote.last_price);
        ltpRef.current = quote.last_price;
        return quote.last_price;
      }
    } catch {
      /* ignore */
    }
    return ltpRef.current;
  }, []);

  const fetchSuggestion = useCallback(async (): Promise<GeminiTradeSuggestion | null> => {
    const snapshot = getSnapshot();
    if (!snapshot) return null;
    const res = await fetch("/api/gemini/trade-suggestion", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify(snapshot),
    });
    const json = await res.json();
    if (!res.ok) throw new Error(json.error ?? "Options AI suggestion failed");
    const data = json.data as GeminiSuggestionResponse;
    pushLog(`AI setup: ${data.suggestion.action.replace(/_/g, " ")} — ${data.suggestion.summary}`, "info");
    return data.suggestion;
  }, [getSnapshot, pushLog]);

  const scanForSetup = useCallback(async () => {
    if (!runningRef.current || phaseRef.current !== "scanning" || !aiStreaming) return;
    try {
      const suggestion = await fetchSuggestion();
      if (!runningRef.current || phaseRef.current !== "scanning") return;
      if (!suggestion || suggestion.action === "WAIT" || !isAiLoopEntryAction(suggestion.action)) {
        setLastSignal(suggestion?.summary ?? "Waiting for AI setup…");
        return;
      }
      if (isNakedSellAction(suggestion.action)) {
        pushLog("Naked sell blocked — AI loop only buys CE/PE, then sells to exit", "warning");
        setLastSignal("Waiting for Call Buy or Put Buy setup…");
        return;
      }
      const snapshot = getSnapshot();
      const rsi = snapshot?.liveNow.rsi14 ?? snapshot?.technicals.rsi14;
      const forcedLeg = rsiForcedLeg(rsi);
      if (forcedLeg && suggestion.action !== forcedLeg) {
        pushLog(
          `RSI ${formatNumber(rsi ?? 0, 1)} — expected ${legLabel(forcedLeg)}, got ${legLabel(suggestion.action as TradeLeg)} · rescanning`,
          "warning"
        );
        setLastSignal(`RSI ${formatNumber(rsi ?? 0, 1)} — waiting for ${legLabel(forcedLeg)}…`);
        return;
      }
      const nextLeg = actionToLeg(suggestion.action);
      if (!nextLeg) return;

      const chain = await fetchFormulaOptionChain(underlyingId);
      const resolved = resolveFormulaInstrument(chain, nextLeg, snapshot?.spot);
      if (!resolved) {
        pushLog("ATM option not found — rescanning", "warning");
        return;
      }

      planRef.current = suggestion;
      setPlan(suggestion);
      legRef.current = nextLeg;
      setLeg(nextLeg);
      setStrike(resolved.strike);
      tradingsymbolRef.current = resolved.tradingsymbol;
      setTradingsymbol(resolved.tradingsymbol);
      setLotSize(resolved.lotSize);
      quantityRef.current = lots * resolved.lotSize;
      setPhaseSync("waiting_entry");
      pushLog(
        `Watching entry · ${legLabel(nextLeg)} @ ${formatNumber(resolved.strike)} · auto exit +${formatCurrency(AI_AUTO_TARGET_PROFIT_INR)}`,
        "success"
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Scan failed";
      pushLog(msg, "error");
    }
  }, [aiStreaming, fetchSuggestion, getSnapshot, lots, pushLog, setPhaseSync, underlyingId]);

  scanForSetupRef.current = scanForSetup;

  const abandonSetupAndRescan = useCallback(
    (reason: string, type: AutoTradeLogEntry["type"] = "warning") => {
      planRef.current = null;
      setPlan(null);
      setEntryOrderId("");
      enteringRef.current = false;
      setPhaseSync("scanning");
      pushLog(reason, type);
      pushLog("Loop continues — scanning for next trade", "info");
      queueMicrotask(() => void scanForSetupRef.current());
    },
    [pushLog, setPhaseSync]
  );

  useEffect(() => {
    entryOrderIdRef.current = entryOrderId;
  }, [entryOrderId]);

  const adoptOpenPosition = useCallback(
    async (orderId: string | null, note: string, kiteAvgPrice?: number) => {
      if (positionSyncedRef.current && phaseRef.current === "in_position") return;
      positionSyncedRef.current = true;

      const fillLtp =
        kiteAvgPrice && kiteAvgPrice > 0
          ? kiteAvgPrice
          : (await refreshLtp()) || ltpRef.current;
      entryPremiumRef.current = fillLtp;
      setEntryPremium(fillLtp);
      if (orderId) {
        entryOrderIdRef.current = orderId;
        setEntryOrderId(orderId);
      }
      if (brokerTargetExitRef.current) {
        const targetPx = profitTargetPremiumPrice(fillLtp, quantityRef.current, AI_AUTO_TARGET_PROFIT_INR);
        targetExitPremiumRef.current = targetPx;
        setTargetExitPremium(targetPx);
      }
      enteringRef.current = false;
      lastEntryErrorRef.current = "";
      setPhaseSync("in_position");
      pushLog(`${note} · @ ${formatNumber(fillLtp)}`, "success");
      pushLog(
        brokerTargetExitRef.current
          ? `Zerodha target exit @ ${formatNumber(targetExitPremiumRef.current)} (+${formatCurrency(AI_AUTO_TARGET_PROFIT_INR)}) — no app sell needed`
          : `Options AI paused — monitoring P&L`,
        "info"
      );
      onGeminiPause?.();
    },
    [onGeminiPause, pushLog, refreshLtp, setPhaseSync]
  );

  const syncZerodhaPosition = useCallback(async (): Promise<boolean> => {
    const symbol = tradingsymbolRef.current;
    if (!symbol || !runningRef.current) return false;
    const phase = phaseRef.current;
    if (phase !== "waiting_entry" && phase !== "entering") return false;

    try {
      const pos = await fetchKiteNetPosition(symbol, product);
      if (!pos || pos.quantity <= 0) return false;

      quantityRef.current = pos.quantity;
      if (pos.last_price > 0) {
        setLtp(pos.last_price);
        ltpRef.current = pos.last_price;
      }
      await adoptOpenPosition(
        entryOrderIdRef.current || null,
        `Zerodha position detected · ${pos.quantity} qty`,
        pos.average_price > 0 ? pos.average_price : pos.last_price
      );
      return true;
    } catch {
      return false;
    }
  }, [adoptOpenPosition, product]);

  const handleEntryFailure = useCallback(
    async (err: unknown, placedOrderId: string | null) => {
      enteringRef.current = false;
      const fallback = err instanceof Error ? err.message : "Entry failed";

      try {
        if (await syncZerodhaPosition()) return;

        const resolution = await resolveEntryAfterOrderAttempt(
          placedOrderId,
          tradingsymbolRef.current,
          product,
          quantityRef.current
        );

        if (resolution.outcome === "filled") {
          await adoptOpenPosition(placedOrderId, resolution.message);
          return;
        }

        if (resolution.outcome === "pending") {
          if (await syncZerodhaPosition()) return;
          enteringRef.current = false;
          setPhaseSync("waiting_entry");
          pushLog(`${resolution.message} — watching Zerodha for fill`, "warning");
          return;
        }

        if (await syncZerodhaPosition()) return;

        const zerodhaMsg = resolution.message || fallback;
        pushLog(zerodhaMsg, "error");
        if (/insufficient|margin|fund|balance/i.test(zerodhaMsg)) {
          abandonSetupAndRescan("Buy rejected (insufficient margin) — scanning for next trade");
        } else {
          abandonSetupAndRescan(`Entry failed (${zerodhaMsg}) — scanning for next trade`);
        }
      } catch (verifyErr) {
        const verifyMsg = verifyErr instanceof Error ? verifyErr.message : fallback;
        pushLog(verifyMsg, "error");
        abandonSetupAndRescan("Could not verify entry on Zerodha — scanning for next trade");
      }
    },
    [abandonSetupAndRescan, adoptOpenPosition, product, pushLog, setPhaseSync, syncZerodhaPosition]
  );

  const checkEntry = useCallback(async () => {
    if (!runningRef.current || phaseRef.current !== "waiting_entry" || enteringRef.current) return;
    if (await syncZerodhaPosition()) return;
    if (!aiStreaming) return;
    const snapshot = getSnapshot();
    const currentPlan = planRef.current;
    if (!snapshot || !currentPlan) return;

    let placedOrderId: string | null = null;

    try {
      const res = await fetch("/api/gemini/entry-timing", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          plannedAction: currentPlan.action,
          strike: currentPlan.strike,
          leg: legRef.current,
          product: currentPlan.product,
          entryPlan: currentPlan.entryPlan,
          riskPlan: currentPlan.riskPlan,
          invalidation: currentPlan.invalidation,
          summary: currentPlan.summary,
          spot: snapshot.spot,
          optionLtp: ltpRef.current,
          quantity: quantityRef.current,
          streamingSnapshot: snapshot,
          exitTargetProfitInr: AI_AUTO_TARGET_PROFIT_INR,
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Entry check failed");
      const data = json.data as EntryTimingApiResponse;
      setLastSignal(`${data.signal}: ${data.reason}`);
      pushLog(
        `AI → ${data.signal}: ${data.reason}`,
        data.signal === "ENTER" ? "success" : "info"
      );

      if (data.signal === "ABORT") {
        pushLog("Setup skipped — scanning for next trade", "warning");
        setPhaseSync("scanning");
        planRef.current = null;
        setPlan(null);
        return;
      }

      if (data.signal !== "ENTER" || phaseRef.current !== "waiting_entry") return;

      if (!isAiLoopEntryAction(legRef.current)) {
        pushLog("Entry blocked — AI loop only allows Call Buy or Put Buy", "error");
        setPhaseSync("scanning");
        planRef.current = null;
        setPlan(null);
        return;
      }

      enteringRef.current = true;
      setPhaseSync("entering");
      pushLog("Placing entry order…", "info");

      try {
        await refreshLtp();
        const { transactionType } = parseTradeLeg(legRef.current);
        const orderType = data.limitPrice && data.limitPrice > 0 ? "LIMIT" : "MARKET";
        const baseFields = {
          tradingsymbol: tradingsymbolRef.current,
          exchange: "NFO",
          transaction_type: transactionType,
          order_type: orderType,
          product,
          quantity: quantityRef.current,
          validity: "DAY",
        };
        const entryFields =
          orderType === "LIMIT" ? { ...baseFields, price: data.limitPrice! } : baseFields;

        const squareoffPts = profitTargetPointsFromInr(quantityRef.current, AI_AUTO_TARGET_PROFIT_INR);
        let bracketPlaced = false;

        try {
          const bracketPayload = buildBracketEntryOrder(
            entryFields,
            quantityRef.current,
            AI_AUTO_TARGET_PROFIT_INR
          );
          const result = await placeKiteOrder(bracketPayload);
          placedOrderId = result.order_id;
          bracketPlaced = true;
          brokerTargetExitRef.current = true;
          setBrokerTargetExit(true);
          pushLog(
            `Bracket entry · Zerodha auto-exit +${formatCurrency(AI_AUTO_TARGET_PROFIT_INR)} (${formatNumber(squareoffPts)} pts)`,
            "success"
          );
        } catch (bracketErr) {
          const bracketMsg = bracketErr instanceof Error ? bracketErr.message : "Bracket order failed";
          pushLog(`${bracketMsg} — entry + limit target on Zerodha`, "warning");
          const payload =
            orderType === "LIMIT" ? entryFields : buildProtectedMarketOrder(baseFields);
          const result = await placeKiteOrder(payload);
          placedOrderId = result.order_id;
        }

        entryOrderIdRef.current = placedOrderId;
        setEntryOrderId(placedOrderId);
        pushLog(`Entry order ${placedOrderId} submitted — waiting for fill…`, "info");
        await waitForKiteEntryFill(
          placedOrderId,
          tradingsymbolRef.current,
          product,
          quantityRef.current
        );

        if (!bracketPlaced) {
          const fillPx = (await refreshLtp()) || ltpRef.current;
          const targetPx = profitTargetPremiumPrice(
            fillPx,
            quantityRef.current,
            AI_AUTO_TARGET_PROFIT_INR
          );
          const exitSide = exitTransactionType(legRef.current);
          const exitResult = await placeKiteOrder(
            buildLimitExitOrder(
              {
                tradingsymbol: tradingsymbolRef.current,
                exchange: "NFO",
                transaction_type: exitSide,
                product,
                quantity: quantityRef.current,
              },
              targetPx
            )
          );
          brokerTargetExitRef.current = true;
          setBrokerTargetExit(true);
          targetExitPremiumRef.current = targetPx;
          setTargetExitPremium(targetPx);
          pushLog(
            `Target limit sell ${exitResult.order_id} @ ${formatNumber(targetPx)} on Zerodha (+${formatCurrency(AI_AUTO_TARGET_PROFIT_INR)})`,
            "success"
          );
        }

        await adoptOpenPosition(placedOrderId, `Entry filled · ${placedOrderId}`);
      } catch (orderErr) {
        await handleEntryFailure(orderErr, placedOrderId);
      }
    } catch (err) {
      enteringRef.current = false;
      setPhaseSync("waiting_entry");
      const msg = err instanceof Error ? err.message : "Entry check failed";
      if (lastEntryErrorRef.current !== msg) {
        lastEntryErrorRef.current = msg;
        pushLog(msg, "error");
        pushLog(`Loop still running — AI will retry on next check (~${AI_LOOP_POLL_MS / 1000}s)`, "info");
      }
    }
  }, [aiStreaming, getSnapshot, handleEntryFailure, product, pushLog, refreshLtp, setPhaseSync, adoptOpenPosition, syncZerodhaPosition]);

  useEffect(() => {
    if (phase !== "waiting_entry" && phase !== "entering") return;
    if (!tradingsymbol) return;
    positionSyncedRef.current = false;
    void syncZerodhaPosition();
    const timer = window.setInterval(() => void syncZerodhaPosition(), POSITION_SYNC_MS);
    return () => window.clearInterval(timer);
  }, [phase, tradingsymbol, syncZerodhaPosition]);

  const finishTradeCycle = useCallback(
    (liveLtp: number, _closedExitOrderId: string, logPrefix: string) => {
      const pnl = calcPremiumPnl(
        legRef.current,
        entryPremiumRef.current,
        liveLtp > 0 ? liveLtp : ltpRef.current,
        quantityRef.current
      );
      setCycles((c) => c + 1);
      pushLog(`${logPrefix} · P&L ${formatCurrency(pnl)} · scanning next trade`, pnl >= 0 ? "success" : "error");
      pendingExitOrderIdRef.current = "";
      setEntryOrderId("");
      entryOrderIdRef.current = "";
      setExitOrderId("");
      setEntryPremium(0);
      entryPremiumRef.current = 0;
      positionSyncedRef.current = false;
      brokerTargetExitRef.current = false;
      setBrokerTargetExit(false);
      targetExitPremiumRef.current = 0;
      setTargetExitPremium(0);
      planRef.current = null;
      setPlan(null);
      exitingRef.current = false;
      setPhaseSync("scanning");
      pushLog("Options AI resumed — scanning for next trade", "info");
      onGeminiResume?.();
      queueMicrotask(() => void scanForSetupRef.current());
    },
    [onGeminiResume, pushLog, setPhaseSync]
  );

  const squareOff = useCallback(
    async (reason: string) => {
      if (exitingRef.current || phaseRef.current !== "in_position") return;
      exitingRef.current = true;
      setPhaseSync("exiting");
      pushLog(`${reason}`, "warning");
      try {
        const symbol = tradingsymbolRef.current;

        let openQty = await fetchNetPositionQty(symbol, product);
        if (openQty === 0) {
          const liveLtp = await refreshLtp();
          finishTradeCycle(liveLtp, pendingExitOrderIdRef.current, "Exit complete (position already flat on Zerodha)");
          return;
        }

        let exitOrderId = pendingExitOrderIdRef.current;
        if (!exitOrderId) {
          pushLog("Instant market sell (no AI) — profit target hit", "info");
          const exitSide = exitTransactionType(legRef.current);
          const result = await placeKiteOrder(
            buildProtectedMarketOrder({
              tradingsymbol: symbol,
              exchange: "NFO",
              transaction_type: exitSide,
              product,
              quantity: quantityRef.current,
            })
          );
          exitOrderId = result.order_id;
          pendingExitOrderIdRef.current = exitOrderId;
          setExitOrderId(exitOrderId);
          pushLog(`Exit order ${exitOrderId} submitted — waiting for fill…`, "info");
        } else {
          pushLog(`Confirming pending exit order ${exitOrderId}…`, "info");
        }

        const liveLtpPromise = refreshLtp();

        try {
          await waitForKiteExitFill(exitOrderId, symbol, product);
        } catch (waitErr) {
          openQty = await fetchNetPositionQty(symbol, product);
          if (openQty !== 0) throw waitErr;
          pushLog("Exit filled on Zerodha — position flat", "success");
        }

        openQty = await fetchNetPositionQty(symbol, product);
        if (openQty !== 0) {
          throw new Error(`Position still open (${openQty} qty)`);
        }

        const liveLtp = await liveLtpPromise;
        finishTradeCycle(liveLtp, exitOrderId, "Exit filled");
      } catch (err) {
        const openQty = await fetchNetPositionQty(tradingsymbolRef.current, product);
        if (openQty === 0) {
          finishTradeCycle(ltpRef.current, pendingExitOrderIdRef.current, "Exit complete (position flat on Zerodha)");
          return;
        }
        exitingRef.current = false;
        setPhaseSync("in_position");
        const msg = err instanceof Error ? err.message : "Exit failed";
        pushLog(`${msg} — will retry exit (no duplicate order until flat)`, "error");
      }
    },
    [finishTradeCycle, product, pushLog, refreshLtp, setPhaseSync]
  );

  const triggerInstantExit = useCallback(
    (pnl: number) => {
      void squareOff(
        `+${formatCurrency(AI_AUTO_TARGET_PROFIT_INR)} target (${formatCurrency(pnl)}) — instant sell`
      );
    },
    [squareOff]
  );

  const watchBrokerExit = useCallback(async () => {
    if (!brokerTargetExitRef.current || phaseRef.current !== "in_position" || exitingRef.current) {
      return;
    }
    try {
      const openQty = await fetchNetPositionQty(tradingsymbolRef.current, product);
      if (openQty !== 0) return;
      const liveLtp = await refreshLtp();
      finishTradeCycle(liveLtp, "", "Zerodha target exit — position flat");
    } catch {
      /* retry on next tick */
    }
  }, [finishTradeCycle, product, refreshLtp]);

  const checkExit = useCallback(() => {
    if (phaseRef.current !== "in_position" || entryPremiumRef.current <= 0 || exitingRef.current) return;

    if (brokerTargetExitRef.current) {
      void watchBrokerExit();
      return;
    }

    if (pendingExitOrderIdRef.current) {
      void squareOff("Confirming exit fill");
      return;
    }

    const cachedPnl = calcPremiumPnl(
      legRef.current,
      entryPremiumRef.current,
      ltpRef.current,
      quantityRef.current
    );
    if (shouldExitForProfitInr(cachedPnl)) {
      triggerInstantExit(cachedPnl);
      return;
    }

    void refreshLtp().then((price) => {
      if (phaseRef.current !== "in_position" || entryPremiumRef.current <= 0 || exitingRef.current) return;
      if (pendingExitOrderIdRef.current) return;
      const pnl = calcPremiumPnl(legRef.current, entryPremiumRef.current, price, quantityRef.current);
      if (shouldExitForProfitInr(pnl)) {
        triggerInstantExit(pnl);
      }
    });
  }, [refreshLtp, squareOff, triggerInstantExit, watchBrokerExit]);

  const stop = useCallback(async () => {
    if (stopping) return;
    if (phaseRef.current === "in_position") {
      setStopping(true);
      runningRef.current = false;
      await squareOff("Stopped by user");
      setStopping(false);
      onStop?.();
      return;
    }
    runningRef.current = false;
    pushLog("AI trading stopped by user", "warning");
    onStop?.();
  }, [onStop, pushLog, squareOff, stopping]);

  useEffect(() => {
    onPhaseChange?.(phase);
  }, [phase, onPhaseChange]);

  useEffect(() => {
    if (!connected || !marketStreaming) {
      runningRef.current = false;
      return;
    }
    runningRef.current = true;
    const now = Date.now();
    if (now - loopStartLoggedAtRef.current < 3000) return;
    loopStartLoggedAtRef.current = now;
    pushLog(`AI loop started · Gemini for entry only · +${formatCurrency(AI_AUTO_TARGET_PROFIT_INR)} target sent to Zerodha at entry`, "info");
  }, [connected, marketStreaming, pushLog]);

  useEffect(() => {
    if (!runningRef.current || phase !== "scanning" || !aiStreaming) return;
    void scanForSetup();
    const timer = window.setInterval(() => void scanForSetup(), AI_LOOP_POLL_MS);
    return () => window.clearInterval(timer);
  }, [phase, aiStreaming, scanForSetup]);

  useEffect(() => {
    if (phase !== "waiting_entry") return;
    void refreshLtp();
    if (!aiStreaming) return;
    void checkEntry();
    const timer = window.setInterval(() => void checkEntry(), AI_LOOP_POLL_MS);
    return () => window.clearInterval(timer);
  }, [phase, aiStreaming, checkEntry, refreshLtp]);

  useEffect(() => {
    if (phase !== "in_position") return;
    void refreshLtp();
    checkExit();
    const ltpTimer = window.setInterval(() => void refreshLtp(), LTP_MS);
    const exitTimer = window.setInterval(checkExit, EXIT_CHECK_MS);
    return () => {
      window.clearInterval(ltpTimer);
      window.clearInterval(exitTimer);
    };
  }, [phase, checkExit, refreshLtp]);

  const livePnl =
    phase === "in_position" && entryPremium > 0 && ltp > 0
      ? calcPremiumPnl(leg, entryPremium, ltp, quantity)
      : 0;

  const isCall = leg.startsWith("CE");
  const phaseMeta: Record<AiPhase, { label: string; tone: string }> = {
    scanning: { label: "Scanning market", tone: "scan" },
    waiting_entry: { label: "Waiting for entry", tone: "wait" },
    entering: { label: "Placing entry", tone: "enter" },
    in_position: { label: "In position", tone: "live" },
    exiting: { label: "Exiting", tone: "exit" },
  };
  const phaseRank: Record<AiPhase, number> = {
    scanning: 0,
    waiting_entry: 1,
    entering: 1,
    in_position: 2,
    exiting: 3,
  };
  const currentRank = phaseRank[phase];
  const steps = [
    { key: "scan", label: "Scan", icon: Radar },
    { key: "entry", label: "Entry", icon: Crosshair },
    { key: "position", label: "Position", icon: TrendingUp },
    { key: "exit", label: "Exit", icon: LogOut },
  ];
  const progressPct = Math.max(
    0,
    Math.min(100, (livePnl / AI_AUTO_TARGET_PROFIT_INR) * 100)
  );
  const targetHit = livePnl >= AI_AUTO_TARGET_PROFIT_INR;
  const tradeLive = phase === "in_position" || phase === "exiting";
  const pnlTone = targetHit ? "is-up" : livePnl < 0 ? "is-down" : "is-flat";
  const ringCircumference = 326.7;
  const ringOffset = ringCircumference - (progressPct / 100) * ringCircumference;
  const remainingToTarget = Math.max(0, AI_AUTO_TARGET_PROFIT_INR - livePnl);
  const targetPremiumDisplay =
    targetExitPremium > 0
      ? targetExitPremium
      : entryPremium > 0
        ? profitTargetPremiumPrice(entryPremium, quantity, AI_AUTO_TARGET_PROFIT_INR)
        : 0;

  if (tradeLive) {
    return (
      <div className={cn("gat", "gat--live-trade", `gat--${phaseMeta[phase].tone}`)}>
        <div className={cn("gat-live-card", pnlTone)}>
          <div className="gat-live-top">
            <div className="gat-live-header">
              <span className="gat-live-pulse" aria-hidden />
              <span className="gat-live-status">
                {phase === "exiting" ? "Exiting position" : "Live trade"}
              </span>
              <span className={cn("gat-leg-badge", isCall ? "is-call" : "is-put")}>{legLabel(leg)}</span>
              {brokerTargetExit && phase !== "exiting" && (
                <span className="gat-live-broker-badge">Target on Zerodha</span>
              )}
            </div>
            <p className="gat-live-symbol">{tradingsymbol || `${formatNumber(strike)} strike`}</p>
          </div>

          <div className="gat-live-body">
            <div className="gat-live-hero">
              <div className="gat-live-ring-wrap">
                <svg className="gat-live-ring" viewBox="0 0 120 120" aria-hidden>
                  <circle className="gat-live-ring-track" cx="60" cy="60" r="52" />
                  <circle
                    className={cn("gat-live-ring-progress", pnlTone, targetHit && "is-hit")}
                    cx="60"
                    cy="60"
                    r="52"
                    strokeDasharray={ringCircumference}
                    strokeDashoffset={ringOffset}
                  />
                </svg>
                <div className="gat-live-ring-center">
                  <span className="gat-live-pnl-label">Premium P&amp;L</span>
                  <p className={cn("gat-live-pnl-value", pnlTone)}>{formatCurrency(livePnl)}</p>
                  <span className="gat-live-pnl-sub">
                    {targetHit
                      ? "Target reached — Zerodha should exit"
                      : livePnl < 0
                        ? `${formatCurrency(Math.abs(livePnl))} in loss · ${formatCurrency(remainingToTarget)} to +${formatCurrency(AI_AUTO_TARGET_PROFIT_INR)} target`
                        : `${formatCurrency(remainingToTarget)} to +${formatCurrency(AI_AUTO_TARGET_PROFIT_INR)} target`}
                  </span>
                </div>
              </div>
            </div>

            <div className="gat-live-details">
              <div className="gat-live-stats">
                <div className="gat-live-stat">
                  <span className="gat-live-stat-label">Entry premium</span>
                  <span className="gat-live-stat-value">{formatNumber(entryPremium)}</span>
                </div>
                <div className="gat-live-stat">
                  <span className="gat-live-stat-label">LTP</span>
                  <span className="gat-live-stat-value">{formatNumber(ltp)}</span>
                </div>
                <div className="gat-live-stat">
                  <span className="gat-live-stat-label">Quantity</span>
                  <span className="gat-live-stat-value">{quantity}</span>
                </div>
                <div className="gat-live-stat gat-live-stat--target">
                  <span className="gat-live-stat-label">
                    <Target size={12} /> Profit target
                  </span>
                  <span className="gat-live-stat-value text-up">+{formatCurrency(AI_AUTO_TARGET_PROFIT_INR)}</span>
                  {targetPremiumDisplay > 0 && (
                    <span className="gat-live-stat-hint">Exit @ {formatNumber(targetPremiumDisplay)}</span>
                  )}
                </div>
              </div>
              {brokerTargetExit && (
                <p className="gat-live-broker-note">
                  Profit target is set on Zerodha at entry — the app will not place a sell order at target (avoids IP blocks).
                  Use Stop below only if you want to exit early.
                </p>
              )}
            </div>
          </div>
        </div>

        <button
          type="button"
          className="gat-stop is-danger gat-stop--focus"
          onClick={() => void stop()}
          disabled={stopping}
        >
          <Square size={14} />
          {stopping || phase === "exiting" ? "Exiting…" : "Stop & exit early"}
        </button>
      </div>
    );
  }

  return (
    <div className={cn("gat", `gat--${phaseMeta[phase].tone}`)}>
      <header className="gat-head">
        <div className="gat-brand">
          <span className="gat-brand-icon">
            <Bot size={18} />
          </span>
          <div>
            <p className="gat-brand-title">AI Loop Trading</p>
            <p className="gat-brand-sub">
              Auto entry · +{formatCurrency(AI_AUTO_TARGET_PROFIT_INR)} target on Zerodha
            </p>
          </div>
        </div>
        <span className={cn("gat-phase", `gat-phase--${phaseMeta[phase].tone}`)}>
          <span className="gat-phase-dot" />
          {phaseMeta[phase].label}
        </span>
      </header>

      <div className="gat-steps">
        {steps.map((step, idx) => {
          const Icon = step.icon;
          const state = idx < currentRank ? "done" : idx === currentRank ? "active" : "todo";
          return (
            <div key={step.key} className={cn("gat-step", `is-${state}`)}>
              <span className="gat-step-ico">
                <Icon size={15} />
              </span>
              <span className="gat-step-label">{step.label}</span>
            </div>
          );
        })}
      </div>

      <div className="gat-stat-row">
        <div className="gat-stat">
          <p className="gat-stat-label">Trades done</p>
          <p className="gat-stat-value">{cycles}</p>
        </div>
        <div className="gat-stat">
          <p className="gat-stat-label">Exit target</p>
          <p className="gat-stat-value text-up">{formatCurrency(AI_AUTO_TARGET_PROFIT_INR)}</p>
        </div>
        <div className="gat-stat">
          <p className="gat-stat-label">Mode</p>
          <p className="gat-stat-value">Live</p>
        </div>
      </div>

      {plan && phase !== "scanning" && (
        <div className="gat-plan">
          <span className={cn("gat-leg-badge", isCall ? "is-call" : "is-put")}>{legLabel(leg)}</span>
          <span className="gat-plan-strike">{formatNumber(strike)}</span>
          <span className="gat-plan-symbol">{tradingsymbol}</span>
          {plan.summary && <span className="gat-plan-summary">{plan.summary}</span>}
        </div>
      )}

      {lastSignal && (
        <div className={cn("gat-signal", `gat-signal--${phaseMeta[phase].tone}`)}>{lastSignal}</div>
      )}

      {(entryOrderId || exitOrderId) && (
        <p className="gat-orders">
          {entryOrderId ? `Entry #${entryOrderId}` : ""}
          {exitOrderId ? ` · Exit #${exitOrderId}` : ""}
        </p>
      )}

      <button
        type="button"
        className="gat-stop"
        onClick={() => void stop()}
        disabled={stopping}
      >
        <Square size={14} />
        {stopping ? "Stopping…" : "Stop AI trading"}
      </button>

      {logs.length > 0 && (
        <div className="gat-log">
          <div className="gat-log-head">
            <Activity size={13} />
            Activity
          </div>
          <div className="gat-log-body">
            {logs
              .slice()
              .reverse()
              .map((entry, index) => (
                <p
                  key={`${entry.time}-${index}`}
                  className={cn("gat-log-line", entry.type && `log-${entry.type}`)}
                >
                  <span className="gat-log-time">{entry.time}</span> {entry.message}
                </p>
              ))}
          </div>
        </div>
      )}
    </div>
  );
}
