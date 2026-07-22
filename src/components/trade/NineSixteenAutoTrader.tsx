import { useCallback, useEffect, useRef, useState } from "react";
import { useConfirm } from "@/contexts/confirm-context";
import {
  exitTransactionType,
  fetchKiteOpenPositions,
  fetchKiteOrder,
  fetchNetPositionQty,
  placeKiteOrder,
  readOrderFill,
  waitForKiteEntryFill,
  waitForKiteExitFill,
  type AutoTradeLogEntry,
} from "@/lib/auto-trade";
import { isPastFormulaForceExit } from "@/lib/formula-trade";
import { fetchFormulaOptionChain, resolveFormulaInstrument } from "@/lib/formula-trade";
import { buildProtectedMarketOrder } from "@/lib/kite-orders";
import { getIndianMarketContext } from "@/lib/market-time";
import {
  fetchNiftySpotPrice,
  fetchToday915Bar,
  hasNineSixteenRanToday,
  isNineSixteenAutoEnabled,
  isPast916EntryWindow,
  isPastNineSixteenForceExit,
  isReadyFor916Entry,
  legFrom915Direction,
  markNineSixteenRanToday,
  msUntil916Entry,
  nineSixteenExitLabel,
  NINE_SIXTEEN_INDEX_TARGET,
  NINE_SIXTEEN_SPOT_POLL_MS,
  setNineSixteenAutoEnabled,
  shouldExitNineSixteen,
  type NineSixteen915Bar,
  type NineSixteenAutoPhase,
} from "@/lib/nine-sixteen-auto-trade";
import { fetchOptionLtp } from "@/lib/prediction-auto-trade";
import { legLabel, parseTradeLeg, type TradeLeg } from "@/lib/trade-calculations";
import { cn, formatNumber } from "@/lib/utils";
import { Bot, Play, Square, Target, TrendingDown, TrendingUp } from "lucide-react";
import "@/styles/prediction-auto-trade.css";

interface NineSixteenAutoTraderProps {
  connected: boolean;
}

export function NineSixteenAutoTrader({ connected }: NineSixteenAutoTraderProps) {
  const { confirm } = useConfirm();
  const [running, setRunning] = useState(false);
  const [phase, setPhase] = useState<NineSixteenAutoPhase>("idle");
  const [leg, setLeg] = useState<TradeLeg>("CE_BUY");
  const [tradingsymbol, setTradingsymbol] = useState("");
  const [entryPremium, setEntryPremium] = useState(0);
  const [open915, setOpen915] = useState(0);
  const [niftySpot, setNiftySpot] = useState(0);
  const [bar915, setBar915] = useState<NineSixteen915Bar | null>(null);
  const [watchNote, setWatchNote] = useState("");
  const [logs, setLogs] = useState<AutoTradeLogEntry[]>([]);
  const [stopping, setStopping] = useState(false);
  const [autoResume, setAutoResume] = useState(isNineSixteenAutoEnabled);

  const runningRef = useRef(false);
  const phaseRef = useRef<NineSixteenAutoPhase>("idle");
  const legRef = useRef<TradeLeg>("CE_BUY");
  const tradingsymbolRef = useRef("");
  const quantityRef = useRef(0);
  const open915Ref = useRef(0);
  const enteringRef = useRef(false);
  const exitingRef = useRef(false);
  const baselineQtyRef = useRef(0);
  const loopBusyRef = useRef(false);

  const product = "MIS";

  const setPhaseSync = useCallback((next: NineSixteenAutoPhase) => {
    phaseRef.current = next;
    setPhase(next);
  }, []);

  const pushLog = useCallback((message: string, type: AutoTradeLogEntry["type"] = "info") => {
    setLogs((prev) => [
      { time: new Date().toLocaleTimeString("en-IN", { hour12: false }), message, type },
      ...prev.slice(0, 49),
    ]);
  }, []);

  const finishDay = useCallback(
    (note: string, type: AutoTradeLogEntry["type"] = "info") => {
      const ctx = getIndianMarketContext();
      markNineSixteenRanToday(ctx.dateIST);
      setPhaseSync("done");
      setWatchNote(note);
      pushLog(note, type);
    },
    [pushLog, setPhaseSync],
  );

  const squareOff = useCallback(
    async (reason: string) => {
      if (exitingRef.current) return;
      const symbol = tradingsymbolRef.current;
      if (!symbol || quantityRef.current <= 0) {
        finishDay(reason, "success");
        return;
      }

      exitingRef.current = true;
      setPhaseSync("exiting");
      pushLog(reason, "success");

      try {
        const openQty = await fetchNetPositionQty(symbol, product);
        if (openQty <= baselineQtyRef.current) {
          exitingRef.current = false;
          finishDay("Position already flat", "info");
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
          targetQtyAfterExit: baselineQtyRef.current,
        });
        exitingRef.current = false;
        finishDay(`Exited · ${reason}`, "success");
      } catch (err) {
        const openQty = await fetchNetPositionQty(symbol, product);
        if (openQty <= baselineQtyRef.current) {
          exitingRef.current = false;
          finishDay("Position flat after exit attempt", "info");
          return;
        }
        exitingRef.current = false;
        setPhaseSync("in_position");
        pushLog(err instanceof Error ? err.message : "Exit failed — will retry", "error");
      }
    },
    [finishDay, pushLog, setPhaseSync],
  );

  const tryEnter = useCallback(async () => {
    if (!runningRef.current || enteringRef.current) return;
    if (phaseRef.current !== "waiting_916" && phaseRef.current !== "idle") return;

    const ctx = getIndianMarketContext();
    if (!ctx.isMarketOpen) {
      setWatchNote("Market closed — waiting for next session");
      return;
    }

    if (hasNineSixteenRanToday(ctx.dateIST)) {
      finishDay("Already completed for today");
      return;
    }

    if (isPast916EntryWindow()) {
      finishDay("Missed 9:16 entry window for today (after 9:18 IST)", "warning");
      return;
    }

    if (!isReadyFor916Entry()) {
      const waitMs = msUntil916Entry();
      setWatchNote(`Waiting for 9:16 entry · ${Math.ceil(waitMs / 1000)}s`);
      setPhaseSync("waiting_916");
      return;
    }

    enteringRef.current = true;
    setPhaseSync("entering");

    try {
      const bar = await fetchToday915Bar();
      if (!bar) throw new Error("9:15 candle not available yet — retrying");

      setBar915(bar);
      setOpen915(bar.open);
      open915Ref.current = bar.open;

      const nextLeg = legFrom915Direction(bar.direction);
      if (!nextLeg) {
        enteringRef.current = false;
        finishDay("9:15 bar flat — no trade today", "warning");
        return;
      }

      const openBefore = await fetchKiteOpenPositions(product);
      if (openBefore.length > 0) {
        throw new Error(`${openBefore.length} open Zerodha position(s) — close manually before auto trade`);
      }

      const chain = await fetchFormulaOptionChain("nifty50");
      if (!chain) throw new Error("Failed to load option chain");

      const resolved = resolveFormulaInstrument(chain, nextLeg, chain.spotPrice);
      if (!resolved) throw new Error("ATM option not found");

      const baselineQty = await fetchNetPositionQty(resolved.tradingsymbol, product);
      if (baselineQty > 0) {
        throw new Error(`Existing qty in ${resolved.tradingsymbol} — close before auto trade`);
      }

      baselineQtyRef.current = baselineQty;
      legRef.current = nextLeg;
      setLeg(nextLeg);
      tradingsymbolRef.current = resolved.tradingsymbol;
      setTradingsymbol(resolved.tradingsymbol);
      quantityRef.current = resolved.lotSize;

      pushLog(
        `9:15 ${bar.direction.toUpperCase()} (${formatNumber(bar.change, 2)} pts) → ${legLabel(nextLeg)} ATM ${resolved.strike}`,
        "success",
      );
      pushLog(`Exit when ${nineSixteenExitLabel(bar.open, nextLeg)}`, "info");

      const { transactionType } = parseTradeLeg(nextLeg);
      const result = await placeKiteOrder(
        buildProtectedMarketOrder({
          tradingsymbol: resolved.tradingsymbol,
          exchange: "NFO",
          transaction_type: transactionType,
          product,
          quantity: resolved.lotSize,
        }),
      );

      pushLog(`Entry order ${result.order_id} · ${resolved.tradingsymbol}`, "info");
      await waitForKiteEntryFill(result.order_id, resolved.tradingsymbol, product, resolved.lotSize, 45_000, 750, {
        baselineQty,
      });

      const order = await fetchKiteOrder(result.order_id);
      const { fillPrice } = order ? readOrderFill(order, resolved.lotSize) : { fillPrice: 0 };
      const fillLtp = fillPrice > 0 ? fillPrice : (await fetchOptionLtp(resolved.tradingsymbol)) || 0;
      setEntryPremium(fillLtp);

      enteringRef.current = false;
      setPhaseSync("in_position");
      setWatchNote(`In position · exit at Nifty ±${NINE_SIXTEEN_INDEX_TARGET} from ${formatNumber(bar.open, 2)}`);
      pushLog(`In position · entry ₹${formatNumber(fillLtp, 2)} · ${resolved.lotSize} qty`, "success");
    } catch (err) {
      enteringRef.current = false;
      if (isPast916EntryWindow()) {
        finishDay(err instanceof Error ? err.message : "Entry failed", "error");
        return;
      }
      setPhaseSync("waiting_916");
      pushLog(err instanceof Error ? err.message : "Entry failed — retrying", "error");
    }
  }, [finishDay, pushLog, setPhaseSync]);

  const tickInPosition = useCallback(async () => {
    if (phaseRef.current !== "in_position" || exitingRef.current) return;

    const spot = await fetchNiftySpotPrice();
    if (spot != null && spot > 0) {
      setNiftySpot(spot);
    }

    if (isPastNineSixteenForceExit() || isPastFormulaForceExit()) {
      void squareOff("End of day — squaring off");
      return;
    }

    const open = open915Ref.current;
    const currentLeg = legRef.current;
    if (spot != null && open > 0 && shouldExitNineSixteen(spot, open, currentLeg)) {
      void squareOff(`Target hit · Nifty ${formatNumber(spot, 2)} · ${nineSixteenExitLabel(open, currentLeg)}`);
    }
  }, [squareOff]);

  const mainLoop = useCallback(async () => {
    if (!runningRef.current || loopBusyRef.current) return;
    loopBusyRef.current = true;
    try {
      const ctx = getIndianMarketContext();

      if (ctx.sessionStatus === "closed_weekend") {
        setWatchNote("Weekend — resumes Monday if auto trading is on");
        return;
      }

      if (
        phaseRef.current === "done" &&
        !hasNineSixteenRanToday(ctx.dateIST) &&
        ctx.sessionStatus !== "post_market"
      ) {
        setBar915(null);
        setOpen915(0);
        open915Ref.current = 0;
        setNiftySpot(0);
        setEntryPremium(0);
        setTradingsymbol("");
        tradingsymbolRef.current = "";
        setPhaseSync("waiting_916");
        setWatchNote("New session — waiting for 9:16 IST entry");
      }

      if (ctx.sessionStatus === "post_market") {
        if (phaseRef.current === "in_position") {
          await tickInPosition();
        } else if (phaseRef.current !== "done") {
          finishDay("Market closed for today");
        }
        return;
      }

      if (hasNineSixteenRanToday(ctx.dateIST)) {
        if (phaseRef.current !== "done") finishDay("Session complete for today");
        return;
      }

      if (phaseRef.current === "in_position" || phaseRef.current === "exiting") {
        await tickInPosition();
        return;
      }

      if (phaseRef.current === "done") return;

      if (isPast916EntryWindow() && phaseRef.current !== "entering") {
        finishDay("Missed 9:16 entry window for today", "warning");
        return;
      }

      if (phaseRef.current === "waiting_916" || phaseRef.current === "idle" || phaseRef.current === "entering") {
        if (!isReadyFor916Entry()) {
          setPhaseSync("waiting_916");
          const waitMs = msUntil916Entry();
          setWatchNote(`Waiting for 9:16 · ${Math.ceil(waitMs / 1000)}s · keep this tab open`);
          return;
        }
        await tryEnter();
      }
    } finally {
      loopBusyRef.current = false;
    }
  }, [finishDay, setPhaseSync, tickInPosition, tryEnter]);

  const start = useCallback(() => {
    runningRef.current = true;
    setRunning(true);
    setNineSixteenAutoEnabled(true);
    setAutoResume(true);
    const ctx = getIndianMarketContext();
    if (hasNineSixteenRanToday(ctx.dateIST)) {
      setPhaseSync("done");
      setWatchNote("Already completed for today");
    } else if (ctx.isMarketOpen && isPast916EntryWindow()) {
      setPhaseSync("done");
      setWatchNote("Missed 9:16 window — enable before market open tomorrow");
    } else {
      setPhaseSync("waiting_916");
      setWatchNote("Waiting for 9:16 IST entry");
    }
    pushLog(
      `9:16 auto trade started · UP→CE / DOWN→PE · exit Nifty ±${NINE_SIXTEEN_INDEX_TARGET} from 9:15 open`,
      "info",
    );
    void mainLoop();
  }, [mainLoop, pushLog, setPhaseSync]);

  const stop = useCallback(async () => {
    setStopping(true);
    runningRef.current = false;
    setRunning(false);
    setNineSixteenAutoEnabled(false);
    setAutoResume(false);
    if (phaseRef.current === "in_position") {
      await squareOff("Stopped by user — squaring off");
    } else {
      setPhaseSync("idle");
      pushLog("Auto trading stopped", "warning");
    }
    setStopping(false);
  }, [pushLog, setPhaseSync, squareOff]);

  const handleStart = useCallback(async () => {
    if (!connected || running) return;
    const ok = await confirm({
      title: "Start 9:16 auto trade?",
      body: (
        <>
          <p>
            Every trading day at <strong>9:16 IST</strong>, reads the closed 9:15 bar:{" "}
            <strong>UP → buy CE</strong>, <strong>DOWN → buy PE</strong> (ATM MIS).
          </p>
          <p>
            Exits when Nifty moves <strong>±{NINE_SIXTEEN_INDEX_TARGET} index points</strong> from the 9:15 open,
            or squares off at 3:25 PM.
          </p>
          <p className="confirm-note">REAL Zerodha orders — keep this tab open before 9:15.</p>
        </>
      ),
      confirmLabel: "Start auto trade",
      tone: "danger",
    });
    if (!ok) return;
    start();
  }, [confirm, connected, running, start]);

  useEffect(() => {
    if (!connected || !autoResume || running) return;
    start();
  }, [connected, autoResume, running, start]);

  useEffect(() => {
    if (!running) return;

    let cancelled = false;
    let timer = 0;

    const schedule = () => {
      const delay =
        phaseRef.current === "in_position" || phaseRef.current === "exiting"
          ? NINE_SIXTEEN_SPOT_POLL_MS
          : Math.max(500, msUntil916Entry());
      timer = window.setTimeout(() => {
        if (cancelled) return;
        void mainLoop().finally(schedule);
      }, delay);
    };

    schedule();
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [running, mainLoop]);

  useEffect(() => {
    if (!running || phase !== "in_position") return;
    const id = window.setInterval(() => void tickInPosition(), NINE_SIXTEEN_SPOT_POLL_MS);
    return () => window.clearInterval(id);
  }, [running, phase, tickInPosition]);

  const inTrade = phase === "in_position" || phase === "exiting" || phase === "entering";
  const isCall = leg.startsWith("CE");
  const targetSpot =
    open915 > 0 ? (isCall ? open915 + NINE_SIXTEEN_INDEX_TARGET : open915 - NINE_SIXTEEN_INDEX_TARGET) : 0;

  return (
    <section className={cn("pat-card card ns916-trader", inTrade && "pat-card--live")}>
      <header className="pat-head">
        <div className="pat-head-left">
          <Bot size={18} />
          <div>
            <h2 className="pat-title">9:16 Auto Trade</h2>
            <p className="pat-sub">
              Daily at 9:16 IST · 9:15 bar UP → CE · DOWN → PE · exit when Nifty ±
              {NINE_SIXTEEN_INDEX_TARGET} from 9:15 open · keep tab open
            </p>
          </div>
        </div>
        <div className="pat-head-actions">
          {!running ? (
            <button
              type="button"
              className="btn btn-primary btn-sm"
              disabled={!connected || stopping}
              onClick={() => void handleStart()}
            >
              <Play size={14} />
              Start auto trade
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
          {running ? phase.replace(/_/g, " ") : "Idle"}
        </span>
        {autoResume && running && <span className="pat-badge pat-badge--open">Auto-resume daily</span>}
        {watchNote && <span className="pat-scan-note pat-scan-note--watch">{watchNote}</span>}
      </div>

      {(bar915 || inTrade) && (
        <div className="pat-dashboard-grid ns916-grid">
          <div className="pat-stat">
            <span className="pat-stat-label">9:15 open</span>
            <span className="pat-stat-value">{open915 > 0 ? formatNumber(open915, 2) : "—"}</span>
          </div>
          <div className="pat-stat">
            <span className="pat-stat-label">9:15 bar</span>
            <span
              className={cn(
                "pat-stat-value",
                bar915?.direction === "up" ? "text-up" : bar915?.direction === "down" ? "text-down" : "",
              )}
            >
              {bar915?.direction?.toUpperCase() ?? "—"}
            </span>
          </div>
          <div className="pat-stat">
            <span className="pat-stat-label">Side</span>
            <span className="pat-stat-value">{inTrade ? legLabel(leg) : "—"}</span>
          </div>
          <div className="pat-stat">
            <span className="pat-stat-label">Nifty spot</span>
            <span className="pat-stat-value">{niftySpot > 0 ? formatNumber(niftySpot, 2) : "—"}</span>
          </div>
          <div className="pat-stat">
            <span className="pat-stat-label">
              {isCall ? <TrendingUp size={12} /> : <TrendingDown size={12} />} Exit target
            </span>
            <span className="pat-stat-value">{targetSpot > 0 ? formatNumber(targetSpot, 2) : "—"}</span>
          </div>
          <div className="pat-stat">
            <span className="pat-stat-label">
              <Target size={12} /> Entry premium
            </span>
            <span className="pat-stat-value">
              {entryPremium > 0 ? `₹${formatNumber(entryPremium, 2)}` : tradingsymbol || "—"}
            </span>
          </div>
        </div>
      )}

      {logs.length > 0 && (
        <div className="pat-log">
          {logs.slice(0, 8).map((entry, idx) => (
            <div
              key={`${entry.time}-${idx}`}
              className={cn(
                "pat-log-line",
                entry.type === "success" && "is-success",
                entry.type === "warning" && "is-warning",
                entry.type === "error" && "is-error",
              )}
            >
              <span className="pat-log-time">{entry.time}</span>
              {entry.message}
            </div>
          ))}
        </div>
      )}

      <p className="pat-idle-note text-muted">
        REAL Zerodha MIS orders. Enable before 9:15 and leave this tab open. Stays enabled across reloads until you
        stop. Squares off at 3:25 PM if target not hit.
      </p>
    </section>
  );
}
