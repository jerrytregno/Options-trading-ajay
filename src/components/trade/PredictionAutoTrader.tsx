import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import {
  exitTransactionType,
  fetchKiteNetPosition,
  fetchKiteOpenPositions,
  fetchKiteOrder,
  fetchNetPositionQty,
  placeKiteOrder,
  readOrderFill,
  waitForKiteEntryFill,
  waitForKiteExitFill,
  type AutoTradeLogEntry,
  type KiteNetPositionSnapshot,
} from "@/lib/auto-trade";
import { fetchFormulaOptionChain, resolveFormulaInstrument } from "@/lib/formula-trade";
import { buildProtectedMarketOrder } from "@/lib/kite-orders";
import { getIndianMarketContext } from "@/lib/market-time";
import {
  calcBotCycleGrossPnl,
  calcBotDisplayGrossPnlFromZerodha,
  canEnterPredictionTrade,
  fetchOptionLtp,
  fetchOptionQuote,
  fetchPredictionLive,
  grossPnlForNetTarget,
  isActionableNextMinuteSignal,
  legFromOptionSymbol,
  msUntilNextAutoTradePoll,
  netPremiumPnl,
  nextMinuteWatchLabel,
  pickPositionToManage,
  autoConfidenceThreshold,
  PREDICTION_AUTO_POSITION_VERIFY_MS,
  PREDICTION_AUTO_QUOTE_MS,
  PREDICTION_AUTO_STOP_LOSS_NET_INR,
  PREDICTION_AUTO_TARGET_NET_INR,
  PREDICTION_POSITION_SYNC_MS,
  getPredictionAutoExitTrigger,
  predictionConfidenceLabel,
  zerodhaPositionGrossPnl,
  type PredictionAutoExitTrigger,
  strikeFromOptionSymbol,
  type PredictionAutoPhase,
  type PredictionTradeStatus,
} from "@/lib/prediction-auto-trade";
import { legLabel, parseTradeLeg, type TradeLeg } from "@/lib/trade-calculations";
import { horizonLabel, type PredictionInterval } from "@/lib/prediction-intervals";
import type { PredictionLiveResult } from "@/types/prediction";
import { cn, formatCurrency, formatNumber, getChangeClass } from "@/lib/utils";
import {
  Bot,
  Maximize2,
  Minimize2,
  Play,
  Square,
  Target,
  TrendingDown,
  TrendingUp,
} from "lucide-react";
import "@/styles/prediction-auto-trade.css";

const AUTO_TRADE_EXIT_LABEL: Record<PredictionAutoExitTrigger, (net: number) => string> = {
  target: (net) =>
    `+${formatCurrency(PREDICTION_AUTO_TARGET_NET_INR)} net target (${formatCurrency(net)})`,
  stop_loss: (net) =>
    `−${formatCurrency(PREDICTION_AUTO_STOP_LOSS_NET_INR)} net stop (${formatCurrency(net)})`,
};

interface PredictionAutoTraderProps {
  connected: boolean;
  modelReady: boolean;
  interval: PredictionInterval;
  liveSnapshot?: PredictionLiveResult | null;
  dashboardRef: RefObject<HTMLElement | null>;
}

export function PredictionAutoTrader({
  connected,
  modelReady,
  interval,
  liveSnapshot = null,
  dashboardRef,
}: PredictionAutoTraderProps) {
  const [running, setRunning] = useState(false);
  const [phase, setPhase] = useState<PredictionAutoPhase>("idle");
  const [tradeStatus, setTradeStatus] = useState<PredictionTradeStatus>("Closed");
  const [leg, setLeg] = useState<TradeLeg>("CE_BUY");
  const [strike, setStrike] = useState(0);
  const [tradingsymbol, setTradingsymbol] = useState("");
  const [quantity, setQuantity] = useState(0);
  const [entryPremium, setEntryPremium] = useState(0);
  const [ltp, setLtp] = useState(0);
  const [lastLive, setLastLive] = useState<PredictionLiveResult | null>(null);
  const [lastClosedPnl, setLastClosedPnl] = useState<number | null>(null);
  const [watchNote, setWatchNote] = useState("");
  const [cycles, setCycles] = useState(0);
  const [logs, setLogs] = useState<AutoTradeLogEntry[]>([]);
  const [kitePositions, setKitePositions] = useState<KiteNetPositionSnapshot[]>([]);
  const [pendingEntryOrderId, setPendingEntryOrderId] = useState("");
  const [positionsLoading, setPositionsLoading] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const [stopping, setStopping] = useState(false);

  const runningRef = useRef(false);
  const phaseRef = useRef<PredictionAutoPhase>("idle");
  const legRef = useRef<TradeLeg>("CE_BUY");
  const tradingsymbolRef = useRef("");
  const quantityRef = useRef(0);
  const entryPremiumRef = useRef(0);
  const ltpRef = useRef(0);
  const enteringRef = useRef(false);
  const exitingRef = useRef(false);
  const positionBaselineQtyRef = useRef(0);
  const positionPnlAtEntryRef = useRef(0);
  const pendingEntryOrderIdRef = useRef("");
  const positionSyncedRef = useRef(false);
  const consumedSignalsRef = useRef<Set<string>>(new Set());
  const lastSkipLogRef = useRef("");
  const managingExistingRef = useRef(false);
  const processSnapshotRef = useRef<
    ((live: PredictionLiveResult) => Promise<void>) | null
  >(null);
  const lastLiveRef = useRef<PredictionLiveResult | null>(null);
  const quoteInflightRef = useRef(false);
  const liveGrossPnlRef = useRef(0);
  const cycleExitGrossRef = useRef(0);

  const product = "MIS";

  const pushLog = useCallback((message: string, type: AutoTradeLogEntry["type"] = "info") => {
    setLogs((prev) => [
      { time: new Date().toLocaleTimeString("en-IN", { hour12: false }), message, type },
      ...prev.slice(0, 49),
    ]);
  }, []);

  const setPhaseSync = useCallback((next: PredictionAutoPhase) => {
    phaseRef.current = next;
    setPhase(next);
    setTradeStatus(next === "in_position" || next === "exiting" ? "Open" : "Closed");
  }, []);

  const syncFromZerodhaPosition = useCallback((pos: KiteNetPositionSnapshot) => {
    const botQty = Math.max(0, pos.quantity - positionBaselineQtyRef.current);
    const displayGross = calcBotDisplayGrossPnlFromZerodha(pos, botQty > 0 ? botQty : quantityRef.current);
    const mark = pos.last_price > 0 ? pos.last_price : ltpRef.current;
    if (mark > 0) {
      ltpRef.current = mark;
      setLtp(mark);
    }
    liveGrossPnlRef.current = displayGross;
    const exitGross = calcBotCycleGrossPnl(
      zerodhaPositionGrossPnl(pos),
      positionPnlAtEntryRef.current,
      botQty > 0 ? botQty : quantityRef.current,
      pos.quantity,
    );
    cycleExitGrossRef.current = exitGross;
    setKitePositions((prev) => {
      const idx = prev.findIndex(
        (row) => row.tradingsymbol === pos.tradingsymbol && row.product === pos.product,
      );
      if (idx < 0) return [...prev, pos];
      const next = [...prev];
      next[idx] = pos;
      return next;
    });
    return {
      displayGross,
      exitGross,
    };
  }, []);

  const refreshLtp = useCallback(async () => {
    const symbol = tradingsymbolRef.current;
    if (!symbol) return 0;
    const pos = await fetchKiteNetPosition(symbol, product);
    if (pos) {
      syncFromZerodhaPosition(pos);
      return pos.last_price > 0 ? pos.last_price : ltpRef.current;
    }
    const quote = await fetchOptionQuote(symbol);
    if (quote.mark > 0) {
      ltpRef.current = quote.mark;
      setLtp(quote.mark);
      return quote.mark;
    }
    return 0;
  }, [product, syncFromZerodhaPosition]);

  const adoptFromZerodha = useCallback(
    async (pos: KiteNetPositionSnapshot, note: string): Promise<boolean> => {
      const botQty = Math.max(0, pos.quantity - positionBaselineQtyRef.current);
      if (botQty <= 0) return false;

      const inferredLeg = legFromOptionSymbol(pos.tradingsymbol);
      if (inferredLeg) {
        legRef.current = inferredLeg;
        setLeg(inferredLeg);
      }

      const parsedStrike = strikeFromOptionSymbol(pos.tradingsymbol);
      if (parsedStrike > 0) setStrike(parsedStrike);

      tradingsymbolRef.current = pos.tradingsymbol;
      setTradingsymbol(pos.tradingsymbol);
      quantityRef.current = botQty;
      setQuantity(botQty);

      const entryPx =
        entryPremiumRef.current > 0
          ? entryPremiumRef.current
          : pos.average_price > 0
            ? pos.average_price
            : pos.last_price;
      if (entryPx > 0) {
        entryPremiumRef.current = entryPx;
        setEntryPremium(entryPx);
      }

      // Baseline open P/L at fill so live P/L starts near ₹0 for this bot cycle.
      if (phaseRef.current === "entering") {
        positionPnlAtEntryRef.current = zerodhaPositionGrossPnl(pos);
      }

      syncFromZerodhaPosition(pos);

      positionSyncedRef.current = true;
      enteringRef.current = false;
      managingExistingRef.current = true;
      setPendingEntryOrderId("");
      setPhaseSync("in_position");
      setWatchNote(
        `Managing ${pos.tradingsymbol} · target +${formatCurrency(PREDICTION_AUTO_TARGET_NET_INR)} net · stop −${formatCurrency(PREDICTION_AUTO_STOP_LOSS_NET_INR)} net · no new entries`,
      );
      pushLog(
        `${note} · ${pos.tradingsymbol} · ${botQty} qty @ ₹${formatNumber(entryPremiumRef.current, 2)} · exit at +${formatCurrency(PREDICTION_AUTO_TARGET_NET_INR)} net or −${formatCurrency(PREDICTION_AUTO_STOP_LOSS_NET_INR)} net stop`,
        "success",
      );
      return true;
    },
    [pushLog, setPhaseSync, syncFromZerodhaPosition],
  );

  const syncZerodhaPosition = useCallback(async (): Promise<boolean> => {
    const symbol = tradingsymbolRef.current;
    if (!symbol || !runningRef.current) return false;
    const phase = phaseRef.current;
    if (phase !== "entering" && phase !== "in_position") return false;

    try {
      const pos = await fetchKiteNetPosition(symbol, product);
      if (!pos) return false;

      const botQty = pos.quantity - positionBaselineQtyRef.current;
      if (botQty <= 0) return false;

      if (phase === "in_position" && quantityRef.current === botQty) {
        return true;
      }

      return adoptFromZerodha(pos, "Zerodha position detected");
    } catch {
      return false;
    }
  }, [adoptFromZerodha, product]);

  const tryAdoptExistingPositions = useCallback(async (): Promise<boolean> => {
    if (!runningRef.current) return false;
    const phase = phaseRef.current;
    if (phase === "in_position" || phase === "exiting" || phase === "entering") {
      return false;
    }

    try {
      const positions = await fetchKiteOpenPositions(product);
      setKitePositions(positions);
      const next = pickPositionToManage(positions);
      if (!next) {
        managingExistingRef.current = false;
        return false;
      }

      positionBaselineQtyRef.current = 0;
      positionPnlAtEntryRef.current = zerodhaPositionGrossPnl(next);

      const note =
        positions.length > 1
          ? `Existing ${positions.length} open positions — managing one at a time`
          : "Existing Zerodha position — no new entries";

      return adoptFromZerodha(next, note);
    } catch {
      return false;
    }
  }, [adoptFromZerodha, product]);

  const refreshKitePositions = useCallback(async () => {
    if (!connected) return;
    setPositionsLoading(true);
    try {
      const positions = await fetchKiteOpenPositions(product);
      setKitePositions(positions);

      if (
        runningRef.current &&
        phaseRef.current === "entering" &&
        tradingsymbolRef.current
      ) {
        const match = positions.find((p) => p.tradingsymbol === tradingsymbolRef.current);
        if (match && match.quantity > positionBaselineQtyRef.current) {
          await adoptFromZerodha(match, "Zerodha fill confirmed");
        }
      }

      if (runningRef.current && phaseRef.current === "scanning" && positions.length > 0) {
        await tryAdoptExistingPositions();
      }
    } catch {
      /* retry on next poll */
    } finally {
      setPositionsLoading(false);
    }
  }, [adoptFromZerodha, connected, product, tryAdoptExistingPositions]);

  const resetPositionState = useCallback(() => {
    setTradingsymbol("");
    setStrike(0);
    setQuantity(0);
    setEntryPremium(0);
    setLtp(0);
    liveGrossPnlRef.current = 0;
    cycleExitGrossRef.current = 0;
    tradingsymbolRef.current = "";
    quantityRef.current = 0;
    entryPremiumRef.current = 0;
    ltpRef.current = 0;
    positionBaselineQtyRef.current = 0;
    positionPnlAtEntryRef.current = 0;
    pendingEntryOrderIdRef.current = "";
    setPendingEntryOrderId("");
    positionSyncedRef.current = false;
    managingExistingRef.current = false;
  }, []);

  const finishTradeCycle = useCallback(
    (_exitPremium: number) => {
      const net = netPremiumPnl(cycleExitGrossRef.current);
      setLastClosedPnl(net);
      setCycles((c) => c + 1);
      pushLog(
        `Trade closed · Zerodha gross ${formatCurrency(liveGrossPnlRef.current)} · cycle net ${formatCurrency(net)}`,
        net >= 0 ? "success" : "warning",
      );
      resetPositionState();
      exitingRef.current = false;
      enteringRef.current = false;

      void (async () => {
        if (!runningRef.current) {
          setPhaseSync("idle");
          return;
        }
        const remaining = await fetchKiteOpenPositions(product);
        setKitePositions(remaining);
        const next = pickPositionToManage(remaining);
        if (next) {
          positionBaselineQtyRef.current = 0;
          positionPnlAtEntryRef.current = zerodhaPositionGrossPnl(next);
          await adoptFromZerodha(
            next,
            remaining.length > 1
              ? `Next of ${remaining.length} open positions`
              : "Remaining open position",
          );
          pushLog(`${remaining.length} position(s) still open — managing next`, "info");
        } else {
          pushLog(
            `Flat · scanning for ≥${formatNumber(autoConfidenceThreshold(interval) * 100, 0)}% signals`,
            "info",
          );
          setPhaseSync("scanning");
        }
      })();
    },
    [adoptFromZerodha, pushLog, product, resetPositionState, setPhaseSync],
  );

  const squareOff = useCallback(
    async (reason: string) => {
      if (exitingRef.current || phaseRef.current !== "in_position") return;
      exitingRef.current = true;
      setPhaseSync("exiting");
      pushLog(reason, "warning");
      try {
        const symbol = tradingsymbolRef.current;
        const baselineQty = positionBaselineQtyRef.current;
        let openQty = await fetchNetPositionQty(symbol, product);
        if (openQty <= baselineQty) {
          finishTradeCycle(ltpRef.current);
          return;
        }

        const exitSide = exitTransactionType(legRef.current);
        const result = await placeKiteOrder(
          buildProtectedMarketOrder({
            tradingsymbol: symbol,
            exchange: "NFO",
            transaction_type: exitSide,
            product,
            quantity: quantityRef.current,
          }),
        );
        pushLog(`Exit order ${result.order_id} submitted`, "info");
        await waitForKiteExitFill(result.order_id, symbol, product, 45_000, 750, {
          targetQtyAfterExit: positionBaselineQtyRef.current,
        });
        await refreshLtp();
        finishTradeCycle(ltpRef.current);
      } catch (err) {
        const baselineQty = positionBaselineQtyRef.current;
        const openQty = await fetchNetPositionQty(tradingsymbolRef.current, product);
        if (openQty <= baselineQty) {
          finishTradeCycle(ltpRef.current);
          return;
        }
        exitingRef.current = false;
        setPhaseSync("in_position");
        pushLog(err instanceof Error ? err.message : "Exit failed — will retry", "error");
      }
    },
    [finishTradeCycle, pushLog, refreshLtp, setPhaseSync],
  );

  const applyZerodhaPositionAndMaybeExit = useCallback(
    (pos: KiteNetPositionSnapshot) => {
      if (quantityRef.current <= 0) return;
      const { exitGross } = syncFromZerodhaPosition(pos);
      if (phaseRef.current === "in_position" && !exitingRef.current) {
        const trigger = getPredictionAutoExitTrigger(exitGross);
        if (trigger) {
          void squareOff(AUTO_TRADE_EXIT_LABEL[trigger](netPremiumPnl(exitGross)));
        }
      }
    },
    [squareOff, syncFromZerodhaPosition],
  );

  const tickInPositionQuote = useCallback(async () => {
    if (quoteInflightRef.current) return;
    if (phaseRef.current !== "in_position" && phaseRef.current !== "exiting") return;
    const symbol = tradingsymbolRef.current;
    if (!symbol) return;

    quoteInflightRef.current = true;
    try {
      const pos = await fetchKiteNetPosition(symbol, product);
      if (pos) {
        applyZerodhaPositionAndMaybeExit(pos);
      }
    } finally {
      quoteInflightRef.current = false;
    }
  }, [applyZerodhaPositionAndMaybeExit, product]);

  const tryEnter = useCallback(
    async (live: PredictionLiveResult, nextLeg: TradeLeg) => {
      if (!runningRef.current || phaseRef.current !== "scanning" || enteringRef.current) return;

      const openBefore = await fetchKiteOpenPositions(product);
      if (openBefore.length > 0) {
        await tryAdoptExistingPositions();
        return;
      }

      enteringRef.current = true;
      setPhaseSync("entering");
      const window = nextMinuteWatchLabel(live, interval);
      pushLog(`${window} → ${legLabel(nextLeg)} ATM`, "success");

      try {
        const ctx = getIndianMarketContext();
        if (!ctx.isMarketOpen) {
          throw new Error("Market closed");
        }

        const chain = await fetchFormulaOptionChain("nifty50");
        if (!chain) throw new Error("Failed to load option chain");

        const resolved = resolveFormulaInstrument(chain, nextLeg, chain.spotPrice);
        if (!resolved) throw new Error("ATM option not found");

        const baselineQty = await fetchNetPositionQty(resolved.tradingsymbol, product);
        const allOpen = await fetchKiteOpenPositions(product);
        const entryGate = canEnterPredictionTrade(baselineQty, allOpen.length);
        if (!entryGate.ok) {
          enteringRef.current = false;
          setPhaseSync("scanning");
          if (allOpen.length > 0) {
            await tryAdoptExistingPositions();
          } else {
            pushLog(entryGate.reason, "warning");
          }
          return;
        }

        const preEntryPos = await fetchKiteNetPosition(resolved.tradingsymbol, product);
        positionBaselineQtyRef.current = baselineQty;
        if (preEntryPos && baselineQty > 0) {
          positionPnlAtEntryRef.current = zerodhaPositionGrossPnl(preEntryPos);
        }

        const { transactionType } = parseTradeLeg(nextLeg);
        const qty = resolved.lotSize;

        legRef.current = nextLeg;
        setLeg(nextLeg);
        setStrike(resolved.strike);
        tradingsymbolRef.current = resolved.tradingsymbol;
        setTradingsymbol(resolved.tradingsymbol);
        quantityRef.current = qty;
        setQuantity(qty);
        positionSyncedRef.current = false;

        const result = await placeKiteOrder(
          buildProtectedMarketOrder({
            tradingsymbol: resolved.tradingsymbol,
            exchange: "NFO",
            transaction_type: transactionType,
            product,
            quantity: qty,
          }),
        );

        pendingEntryOrderIdRef.current = result.order_id;
        setPendingEntryOrderId(result.order_id);
        pushLog(`Entry order ${result.order_id} · ${resolved.tradingsymbol}`, "info");
        void refreshKitePositions();
        await waitForKiteEntryFill(
          result.order_id,
          resolved.tradingsymbol,
          product,
          qty,
          45_000,
          750,
          { baselineQty },
        );

        const order = await fetchKiteOrder(result.order_id);
        const { fillPrice, filledQty } = order
          ? readOrderFill(order, qty)
          : { fillPrice: 0, filledQty: qty };
        const fillLtp =
          fillPrice > 0
            ? fillPrice
            : (await fetchOptionLtp(resolved.tradingsymbol)) || ltpRef.current;
        const botQty = filledQty > 0 ? filledQty : qty;
        legRef.current = nextLeg;
        tradingsymbolRef.current = resolved.tradingsymbol;
        quantityRef.current = botQty;
        consumedSignalsRef.current.add(live.asOf);

        const filledPos = await fetchKiteNetPosition(resolved.tradingsymbol, product);
        const entryPx =
          filledPos && filledPos.average_price > 0 ? filledPos.average_price : fillLtp;
        entryPremiumRef.current = entryPx;
        setEntryPremium(entryPx);

        setLeg(nextLeg);
        setStrike(resolved.strike);
        setTradingsymbol(resolved.tradingsymbol);
        setQuantity(botQty);
        if (filledPos) {
          positionPnlAtEntryRef.current = zerodhaPositionGrossPnl(filledPos);
          syncFromZerodhaPosition(filledPos);
        } else {
          positionPnlAtEntryRef.current = 0;
          setLtp(fillLtp);
          ltpRef.current = fillLtp;
        }

        enteringRef.current = false;
        setPhaseSync("in_position");
        setPendingEntryOrderId("");
        pushLog(
          `In position · entry ₹${formatNumber(entryPremiumRef.current, 2)} · ${botQty} qty · target +${formatCurrency(PREDICTION_AUTO_TARGET_NET_INR)} net · stop −${formatCurrency(PREDICTION_AUTO_STOP_LOSS_NET_INR)} net`,
          "success",
        );
      } catch (err) {
        if (await syncZerodhaPosition()) {
          void refreshKitePositions();
          return;
        }
        enteringRef.current = false;
        setPhaseSync("scanning");
        pushLog(err instanceof Error ? err.message : "Entry failed", "error");
      }
    },
    [interval, pushLog, product, refreshKitePositions, setPhaseSync, syncFromZerodhaPosition, syncZerodhaPosition, tryAdoptExistingPositions],
  );

  const processSnapshot = useCallback(
    async (live: PredictionLiveResult) => {
      if (!runningRef.current) return;
      lastLiveRef.current = live;
      setLastLive(live);

      if (phaseRef.current === "in_position") {
        setWatchNote(
          tradingsymbolRef.current
            ? `Managing ${tradingsymbolRef.current} · target +${formatCurrency(PREDICTION_AUTO_TARGET_NET_INR)} net · stop −${formatCurrency(PREDICTION_AUTO_STOP_LOSS_NET_INR)} net`
            : nextMinuteWatchLabel(live, interval),
        );
        await refreshLtp();
        const exitGross = cycleExitGrossRef.current;
        const trigger = getPredictionAutoExitTrigger(exitGross);
        if (trigger) {
          void squareOff(`${AUTO_TRADE_EXIT_LABEL[trigger](netPremiumPnl(exitGross))} — exiting`);
        }
        return;
      }

      if (phaseRef.current !== "scanning") {
        setWatchNote(nextMinuteWatchLabel(live, interval));
        return;
      }

      const open = await fetchKiteOpenPositions(product);
      setKitePositions(open);
      if (open.length > 0) {
        if (await tryAdoptExistingPositions()) return;
        const skipKey = "managing-open-positions";
        if (lastSkipLogRef.current !== skipKey) {
          lastSkipLogRef.current = skipKey;
          pushLog(
            `${open.length} open position(s) on Zerodha — managing until +₹${PREDICTION_AUTO_TARGET_NET_INR} net or −₹${PREDICTION_AUTO_STOP_LOSS_NET_INR} stop, not scanning`,
            "warning",
          );
        }
        setWatchNote(`Managing ${open.length} open position(s) · no new entries`);
        return;
      }

      managingExistingRef.current = false;
      setWatchNote(nextMinuteWatchLabel(live, interval));

      const action = isActionableNextMinuteSignal(
        live,
        consumedSignalsRef.current,
        interval,
      );
      if (!action.ok) {
        const skipKey = `${live.asOf}:${action.reason}`;
        if (lastSkipLogRef.current !== skipKey) {
          lastSkipLogRef.current = skipKey;
          pushLog(action.reason, "info");
        }
        return;
      }

      lastSkipLogRef.current = "";
      await tryEnter(live, action.leg);
    },
    [interval, product, pushLog, refreshLtp, squareOff, tryAdoptExistingPositions, tryEnter],
  );

  processSnapshotRef.current = processSnapshot;

  const fetchAndProcess = useCallback(async () => {
    const live = await fetchPredictionLive(interval);
    if (live) await processSnapshot(live);
  }, [interval, processSnapshot]);

  useEffect(() => {
    if (!running || !liveSnapshot?.asOf) return;
    lastLiveRef.current = liveSnapshot;
    setLastLive(liveSnapshot);
    if (phaseRef.current === "scanning") {
      void processSnapshotRef.current?.(liveSnapshot);
    }
  }, [liveSnapshot, running]);

  useEffect(() => {
    runningRef.current = running;
    if (!running) {
      setPhaseSync("idle");
      return;
    }
    setPhaseSync("scanning");
    consumedSignalsRef.current.clear();
    lastSkipLogRef.current = "";
    pushLog(
      `Automated trading started · ${horizonLabel(interval)} model · ≥${formatNumber(autoConfidenceThreshold(interval) * 100, 0)}% on closed candle · +₹${PREDICTION_AUTO_TARGET_NET_INR} net · −₹${PREDICTION_AUTO_STOP_LOSS_NET_INR} stop`,
      "info",
    );
    void (async () => {
      if (await tryAdoptExistingPositions()) {
        pushLog(
          `Open Zerodha position(s) found — managing until +₹${PREDICTION_AUTO_TARGET_NET_INR} net or −₹${PREDICTION_AUTO_STOP_LOSS_NET_INR} stop (no new entries)`,
          "warning",
        );
      }
      await fetchAndProcess();
    })();

    let cancelled = false;
    let timer = 0;
    const schedule = () => {
      const delay = msUntilNextAutoTradePoll(lastLiveRef.current, interval);
      timer = window.setTimeout(() => {
        if (cancelled) return;
        void fetchAndProcess().finally(schedule);
      }, delay);
    };
    schedule();

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [running, interval, pushLog, fetchAndProcess, setPhaseSync, tryAdoptExistingPositions]);

  useEffect(() => {
    if (!running || phase !== "scanning") return;
    const tick = () => {
      if (lastLiveRef.current) {
        setWatchNote(nextMinuteWatchLabel(lastLiveRef.current, interval));
      }
    };
    tick();
    const id = window.setInterval(tick, 1000);
    return () => window.clearInterval(id);
  }, [running, phase, interval]);

  useEffect(() => {
    if (!running || !connected) return;
    void refreshKitePositions();
    const id = window.setInterval(() => void refreshKitePositions(), PREDICTION_POSITION_SYNC_MS);
    return () => window.clearInterval(id);
  }, [running, connected, refreshKitePositions]);

  useEffect(() => {
    if (phase !== "entering" && phase !== "in_position") return;
    if (!tradingsymbol) return;
    void syncZerodhaPosition();
    const id = window.setInterval(
      () => void syncZerodhaPosition(),
      PREDICTION_AUTO_POSITION_VERIFY_MS,
    );
    return () => window.clearInterval(id);
  }, [phase, tradingsymbol, syncZerodhaPosition]);

  useEffect(() => {
    if (phase !== "entering") return;
    if (!tradingsymbol) return;
    void refreshLtp();
    const id = window.setInterval(() => void refreshLtp(), 500);
    return () => window.clearInterval(id);
  }, [phase, tradingsymbol, refreshLtp]);

  useEffect(() => {
    if (phase !== "in_position" && phase !== "exiting") return;
    void tickInPositionQuote();
    const id = window.setInterval(() => void tickInPositionQuote(), PREDICTION_AUTO_QUOTE_MS);
    return () => window.clearInterval(id);
  }, [phase, tickInPositionQuote]);

  useEffect(() => {
    const onFullscreenChange = () => {
      setFullscreen(Boolean(document.fullscreenElement));
    };
    document.addEventListener("fullscreenchange", onFullscreenChange);
    return () => document.removeEventListener("fullscreenchange", onFullscreenChange);
  }, []);

  const toggleFullscreen = async () => {
    const el = dashboardRef.current;
    if (!el) return;
    if (document.fullscreenElement) {
      await document.exitFullscreen();
    } else {
      await el.requestFullscreen();
    }
  };

  const stop = async () => {
    setStopping(true);
    runningRef.current = false;
    setRunning(false);
    if (phaseRef.current === "in_position") {
      await squareOff("Stopping automated trading — squaring off");
    } else if (tradingsymbolRef.current) {
      await syncZerodhaPosition();
      await squareOff("Stopping automated trading — squaring off");
    }
    setPhaseSync("idle");
    pushLog("Automated trading stopped", "warning");
    setStopping(false);
  };

  const isCall = leg.startsWith("CE");
  const targetGross = grossPnlForNetTarget();
  const inTrade = phase === "in_position" || phase === "exiting";
  const pendingEntry = phase === "entering" && Boolean(tradingsymbol);
  const activeKitePosition = tradingsymbol
    ? kitePositions.find((p) => p.tradingsymbol === tradingsymbol)
    : kitePositions[0];
  const zerodhaLivePnl =
    activeKitePosition != null ? zerodhaPositionGrossPnl(activeKitePosition) : null;
  const showDashboard =
    inTrade || pendingEntry || kitePositions.length > 0 || lastClosedPnl != null;

  return (
    <section className={cn("pat-card card", inTrade && "pat-card--live")}>
      <header className="pat-head">
        <div className="pat-head-left">
          <Bot size={18} />
          <div>
            <h2 className="pat-title">Automated trading</h2>
            <p className="pat-sub">
              {horizonLabel(interval)} chart · ≥{formatNumber(autoConfidenceThreshold(interval) * 100, 0)}% on
              closed candle → enter predicted {horizonLabel(interval).toLowerCase()} bar · +₹
              {PREDICTION_AUTO_TARGET_NET_INR} net · −₹{PREDICTION_AUTO_STOP_LOSS_NET_INR} stop
            </p>
          </div>
        </div>
        <div className="pat-head-actions">
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            onClick={() => void toggleFullscreen()}
            title="Full screen dashboard"
          >
            {fullscreen ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
            {fullscreen ? "Exit full screen" : "Full screen"}
          </button>
          {!running ? (
            <button
              type="button"
              className="btn btn-primary btn-sm"
              disabled={!connected || !modelReady || stopping}
              onClick={() => setRunning(true)}
            >
              <Play size={14} />
              Start automated trading
            </button>
          ) : (
            <button
              type="button"
              className="btn btn-secondary btn-sm pat-stop"
              disabled={stopping}
              onClick={() => void stop()}
            >
              <Square size={14} />
              {stopping ? "Stopping…" : "Stop"}
            </button>
          )}
        </div>
      </header>

      <div className="pat-status-row">
        <span className={cn("pat-badge", running ? "pat-badge--on" : "pat-badge--off")}>
          {running ? phase.replace("_", " ") : "Idle"}
        </span>
        <span className={cn("pat-badge", tradeStatus === "Open" ? "pat-badge--open" : "pat-badge--closed")}>
          {pendingEntry ? "Pending fill" : tradeStatus}
        </span>
        {running && watchNote && (
          <span className="pat-scan-note pat-scan-note--watch">{watchNote}</span>
        )}
        {lastLive && !running && (
          <span className="pat-scan-note">
            Last scan: {predictionConfidenceLabel(lastLive, interval)} · {lastLive.asOf.slice(11, 19)}
          </span>
        )}
        {cycles > 0 && <span className="pat-scan-note">{cycles} completed trade(s)</span>}
      </div>

      {showDashboard && (
        <div className="pat-dashboard">
          {kitePositions.length > 0 && (
            <div className="pat-kite-positions">
              <div className="pat-kite-positions-head">
                <span className="pat-stat-label">Zerodha open positions (MIS)</span>
                {positionsLoading && <span className="pat-kite-sync">Syncing…</span>}
              </div>
              <div className="pat-kite-positions-table-wrap">
                <table className="pat-kite-positions-table">
                  <thead>
                    <tr>
                      <th>Symbol</th>
                      <th className="text-right">Qty</th>
                      <th className="text-right">Avg</th>
                      <th className="text-right">LTP</th>
                      <th className="text-right">P/L</th>
                    </tr>
                  </thead>
                  <tbody>
                    {kitePositions.map((pos) => (
                      <tr
                        key={`${pos.tradingsymbol}:${pos.product}`}
                        className={cn(pos.tradingsymbol === tradingsymbol && "is-active")}
                      >
                        <td>{pos.tradingsymbol}</td>
                        <td className="text-right">{pos.quantity}</td>
                        <td className="text-right">₹{formatNumber(pos.average_price, 2)}</td>
                        <td className="text-right">₹{formatNumber(pos.last_price, 2)}</td>
                        <td className={cn("text-right font-bold", getChangeClass(zerodhaPositionGrossPnl(pos)))}>
                          {formatCurrency(zerodhaPositionGrossPnl(pos))}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {(inTrade || pendingEntry || lastClosedPnl != null) && (
          <>
          <div className="pat-dashboard-grid">
            <div className="pat-stat">
              <span className="pat-stat-label">Position</span>
              <span className={cn("pat-stat-value", isCall ? "text-up" : "text-down")}>
                {inTrade || pendingEntry ? (
                  <>
                    {isCall ? <TrendingUp size={14} /> : <TrendingDown size={14} />}
                    {legLabel(leg)}
                  </>
                ) : (
                  "—"
                )}
              </span>
              {tradingsymbol && <span className="pat-stat-hint">{tradingsymbol}</span>}
              {pendingEntry && (
                <span className="pat-stat-hint">Waiting for Zerodha fill…</span>
              )}
            </div>
            <div className="pat-stat">
              <span className="pat-stat-label">Entry price</span>
              <span className="pat-stat-value">
                {entryPremium > 0
                  ? `₹${formatNumber(entryPremium, 2)}`
                  : activeKitePosition
                    ? `₹${formatNumber(activeKitePosition.average_price, 2)} (Zerodha avg)`
                    : "—"}
              </span>
              {strike > 0 && <span className="pat-stat-hint">Strike {strike}</span>}
            </div>
            <div className="pat-stat">
              <span className="pat-stat-label">LTP (Zerodha)</span>
              <span className="pat-stat-value">
                {(inTrade || pendingEntry) && (ltp > 0 || activeKitePosition)
                  ? `₹${formatNumber(ltp > 0 ? ltp : activeKitePosition?.last_price ?? 0, 2)}`
                  : "—"}
              </span>
            </div>
            <div className="pat-stat">
              <span className="pat-stat-label">Quantity</span>
              <span className="pat-stat-value">
                {quantity > 0
                  ? quantity
                  : activeKitePosition
                    ? activeKitePosition.quantity
                    : "—"}
              </span>
            </div>
            <div className="pat-stat pat-stat--target">
              <span className="pat-stat-label">
                <Target size={12} /> Profit target
              </span>
              <span className="pat-stat-value text-up">
                +{formatCurrency(PREDICTION_AUTO_TARGET_NET_INR)} net
              </span>
              <span className="pat-stat-hint">Gross ₹{targetGross} incl. ₹50 charges</span>
            </div>
            <div className="pat-stat pat-stat--stop">
              <span className="pat-stat-label">
                <TrendingDown size={12} /> Stop loss
              </span>
              <span className="pat-stat-value text-down">
                −{formatCurrency(PREDICTION_AUTO_STOP_LOSS_NET_INR)} net
              </span>
              <span className="pat-stat-hint">Exits when net P&amp;L hits −₹{PREDICTION_AUTO_STOP_LOSS_NET_INR}</span>
            </div>
          </div>

          <div
            className={cn(
              "pat-pnl-block",
              zerodhaLivePnl != null
                ? zerodhaLivePnl >= PREDICTION_AUTO_TARGET_NET_INR
                  ? "is-hit"
                  : zerodhaLivePnl <= -PREDICTION_AUTO_STOP_LOSS_NET_INR
                    ? "is-stop"
                    : zerodhaLivePnl < 0
                      ? "is-down"
                      : "is-up"
                : lastClosedPnl != null
                  ? lastClosedPnl >= 0
                    ? "is-up"
                    : "is-down"
                  : undefined,
            )}
          >
            <span className="pat-pnl-label">Live P&amp;L (Zerodha)</span>
            <p className={cn("pat-pnl-value", zerodhaLivePnl != null && getChangeClass(zerodhaLivePnl))}>
              {zerodhaLivePnl != null
                ? `${zerodhaLivePnl >= 0 ? "+" : ""}${formatCurrency(zerodhaLivePnl)}`
                : lastClosedPnl != null
                  ? `${lastClosedPnl >= 0 ? "+" : ""}${formatCurrency(lastClosedPnl)}`
                  : "—"}
            </p>
            {inTrade && (
              <span className="pat-pnl-sub text-muted">
                Real-time from Zerodha positions · sync {PREDICTION_AUTO_QUOTE_MS}ms
              </span>
            )}
            {pendingEntry && !inTrade && (
              <span className="pat-pnl-sub">
                Order {pendingEntryOrderId || "submitted"} — syncing from Zerodha every 2s
              </span>
            )}
          </div>
          </>
          )}
        </div>
      )}

      {!running && (
        <p className="pat-idle-note text-muted">
          Uses the same {horizonLabel(interval).toLowerCase()} model as Live signal: when a candle closes,
          it predicts the next {horizonLabel(interval).toLowerCase()} bar and enters only if Up/Down ≥
          {formatNumber(autoConfidenceThreshold(interval) * 100, 0)}% during that predicted bar. Exits at
          +₹{PREDICTION_AUTO_TARGET_NET_INR} net or −₹{PREDICTION_AUTO_STOP_LOSS_NET_INR} stop on the new order only. If Zerodha already has open positions, the bot manages them first (no new entries) and exits each at the same targets.
        </p>
      )}

      {logs.length > 0 && (
        <div className="pat-log">
          {logs.slice(0, 6).map((entry, i) => (
            <div key={`${entry.time}-${i}`} className={cn("pat-log-line", entry.type && `is-${entry.type}`)}>
              <span className="pat-log-time">{entry.time}</span>
              {entry.message}
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
