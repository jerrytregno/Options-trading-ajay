import { useCallback, useEffect, useState } from "react";
import { Bot, RefreshCw, Server } from "lucide-react";
import { cn, formatCurrency, formatNumber, getChangeClass } from "@/lib/utils";
import { formatMomentumScalperLog } from "@/lib/momentum-scalper-log-text";
import "@/styles/prediction-auto-trade.css";

interface ExitRuleSummary {
  armPct: number;
  stepPct: number;
  initialStopPnlPct: number;
  initialStopHoldSec: number;
  stopBreachInclusive: boolean;
  hardStopPnlPct: number;
}

const STANDARD_RULES_FALLBACK: ExitRuleSummary = {
  armPct: 1,
  stepPct: 0,
  initialStopPnlPct: -2,
  initialStopHoldSec: 3,
  stopBreachInclusive: true,
  hardStopPnlPct: 0,
};

interface BotStatus {
  enabled: boolean;
  serverDisabled?: boolean;
  phase: string;
  dateIST: string;
  weekday: string;
  message: string;
  /** Only the fields this panel reads; the API sends the full Day Scalper rule set. */
  rules: {
    minMovePts: number;
    tradeWindowOpenIst: string;
    tradeWindowCloseIst: string;
    tuesdayTradeWindowCloseIst: string;
  };
  wsConnected: boolean;
  tradesToday: number;
  lossesToday?: number;
  stoppedForLossToday?: boolean;
  maxLots?: number;
  plannedLots?: number | null;
  premiumSafetyPct?: number;
  pendingSignal: {
    side: string;
    signalTimeIst: string;
    movePts: number;
    optionMarkPrice?: number | null;
    optionTradingsymbol?: string | null;
    liveRsi?: number | null;
  } | null;
  leg: string | null;
  tradingsymbol: string | null;
  quantity: number | null;
  entryPrice: number | null;
  lastOptionPrice: number | null;
  entryIndexPrice: number | null;
  initialStopPnlPct?: number;
  initialStopHoldSec?: number;
  hardStopPnlPct?: number;
  trailing: boolean;
  pnlPct?: number | null;
  pnlLockedPct?: number;
  pnlTargetPct?: number | null;
  pnlStopPct?: number | null;
  pnlArmPct?: number;
  pnlStepPct?: number;
  lastSpot: number | null;
  unrealisedPnl: number | null;
  indexPnlPts: number | null;
  lastBarTimeIst: string | null;
  completedBars: number;
  nineSixteenSettled?: boolean;
  scanStartIst?: string | null;
  exitProfile?: "opening" | "standard" | null;
  exitRules?: Record<"standard" | "opening", ExitRuleSummary>;
  profitExitPnlPct?: number | null;
  profitExitPrice?: number | null;
  profitExitArmed?: boolean;
  profitExitOrderStatus?: string;
  profitExitGivebackPct?: number;
  forceExitIst?: string;
  liveNiftyRsi?: number | null;
  liveRsiBucketsIst?: string;
  sessionConnected: boolean;
  logs: { time: string; message: string; type: string }[];
}

const STATUS_POLL_MS = 8000;
const LIVE_POLL_MS = 1000;

export function ServerMomentumScalperBotPanel({ connected }: { connected: boolean }) {
  const [status, setStatus] = useState<BotStatus | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/momentum-scalper/bot/status", { credentials: "include" });
      const json = await res.json();
      if (res.ok) setStatus(json.data as BotStatus);
    } catch {
      /* ignore */
    }
  }, []);

  const toggle = useCallback(async (enabled: boolean) => {
    setLoading(true);
    try {
      const res = await fetch("/api/momentum-scalper/bot/toggle", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled }),
      });
      const json = await res.json();
      if (res.ok) setStatus(json.data as BotStatus);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!connected) return;
    void load();
    const inTrade = status?.phase === "in_position" || status?.phase === "exiting";
    const interval = setInterval(() => void load(), inTrade || status?.wsConnected ? LIVE_POLL_MS : STATUS_POLL_MS);
    return () => clearInterval(interval);
  }, [connected, load, status?.phase, status?.wsConnected]);

  const rules = status?.rules;
  const minMove = rules?.minMovePts ?? 2;
  const standardRules = status?.exitRules?.standard ?? STANDARD_RULES_FALLBACK;
  const initialStopPnl = status?.initialStopPnlPct ?? standardRules.initialStopPnlPct;
  const initialStopHoldSec = status?.initialStopHoldSec ?? standardRules.initialStopHoldSec;
  const scanClose = rules?.tradeWindowCloseIst ?? "15:30";
  const scanSchedule = status?.scanStartIst ?? "after 9:16:30–15:30";
  const profitExitPrice = status?.profitExitPrice ?? null;
  const maxLots = status?.maxLots ?? 25;
  const plannedLots = status?.plannedLots ?? null;
  const premiumSafetyPct = status?.premiumSafetyPct ?? 2;
  const forceExit = status?.forceExitIst ?? "15:25";
  const pnlArm = status?.pnlArmPct ?? standardRules.armPct;

  if (!connected) {
    return (
      <section className="pat-card card">
        <header className="pat-head">
          <div className="pat-head-left">
            <Server size={18} />
            <div>
              <h2 className="pat-title">Traps — server bot</h2>
              <p className="pat-sub">Connect Zerodha to run the live bot on the server.</p>
            </div>
          </div>
        </header>
      </section>
    );
  }

  if (!status) return null;

  const inPosition = status.phase === "in_position" || status.phase === "exiting";

  return (
    <section className={cn("pat-card card", (inPosition || status.wsConnected) && "pat-card--live")}>
      <header className="pat-head">
        <div className="pat-head-left">
          <Server size={18} />
          <div>
            <h2 className="pat-title">Traps — server bot</h2>
            <p className="pat-sub">
              Runs on Lightsail · <strong>websocket only</strong> for Nifty 1-min bars (no historical candle
              API) · Kite WS 9:00–16:00 IST
            </p>
          </div>
        </div>
        <div className="pat-head-actions">
          <button
            type="button"
            className={cn("btn btn-sm", status.enabled ? "btn-secondary" : "btn-primary")}
            disabled={loading || status.stoppedForLossToday === true || status.serverDisabled === true}
            onClick={() => void toggle(!status.enabled)}
          >
            <Bot size={14} />
            {status.serverDisabled
              ? "Disabled on server"
              : status.enabled
                ? "Disable bot"
                : "Enable bot"}
          </button>
          <button type="button" className="btn btn-secondary btn-sm" onClick={() => void load()}>
            <RefreshCw size={14} />
            Refresh
          </button>
        </div>
      </header>

      <div className="ms-bot-instructions">
        <p className="ms-bot-instructions-title">
          How it works (live: market entry on the momentum candle)
        </p>
        <ol className="ms-bot-instructions-list">
          <li>
            <strong>Manual arm only.</strong> Traps starts <strong>disabled</strong> every day — press{" "}
            <strong>Enable</strong> in this panel to arm it. Nothing runs until you do.
          </li>
          <li>
            <strong>Scan window — {scanSchedule} IST.</strong> When armed, new entries start{" "}
            <strong>after the 9:16 trade finishes (9:16:30)</strong> through{" "}
            <strong>{scanClose}</strong> IST. A trade still open at cutoff keeps running until its own
            exit.
          </li>
          <li>
            <strong>Signal candle:</strong> the minute is sized by its{" "}
            <strong>high − low</strong>, not its body — every tick of the minute comes off the
            websocket, so the true extremes are known rather than guessed from the first and last
            print. A candle that ran at least <strong>{minMove}</strong> pts high to low is a setup,
            and the <strong>body picks the side</strong>: green → CE, red → PE. A minute that closes
            exactly where it opened has no colour and is skipped however wide it ran.
          </li>
          <li>
            <strong>RSI filter.</strong> Wilder RSI(14) on Nifty 1-min closes from{" "}
            <strong>Zerodha historical candles</strong> must sit between{" "}
            <strong>{status?.liveRsiBucketsIst ?? "40–60"}</strong> (inclusive) when the signal candle
            closes and again when the pullback entry fires. Outside that band → no trade.
          </li>
          <li>
            <strong>First-second gate on candle 2.</strong> The signal minute&apos;s{" "}
            <strong>last websocket tick</strong> is compared to every tick in the next minute&apos;s{" "}
            <strong>first second</strong>. Green needs any tick ≥ last + <strong>0.1</strong>; red needs
            any tick ≤ last − <strong>0.1</strong>. If none reach it in that second, the setup is dropped.
          </li>
          <li>
            <strong>Pullback entry.</strong> Once the gate passes, the start price is the first tick of
            candle 2. Green waits for a <strong>2 pt drop</strong> from start →{" "}
            <strong>CE market buy</strong>. Red waits for a <strong>2 pt gain</strong> from start →{" "}
            <strong>PE market buy</strong>.
          </li>
          <li>
            <strong>Two losses stop the day.</strong> If two Traps trades close at a loss (negative
            premium P&amp;L), the bot disables itself for the rest of that session and does not take new
            setups until the next trading day. One loss keeps scanning.
          </li>
          <li>
            <strong>ATM at pullback.</strong> The strike is chosen from the live Nifty spot when the
            2-pt pullback prints — not from the signal candle close.
          </li>
          <li>
            <strong>Short of margin → smaller, not skipped.</strong> Sizing runs off the last traded
            price with a small premium buffer; a refusal for funds is treated as a sizing miss: the
            order is re-sent a size down until it fits. A refusal that already filled part of the
            quantity is never retried — those lots are held and managed as the position.
          </li>
          <li>
            <strong>Take profit at entry.</strong> The moment the MIS market buy fills, a resting{" "}
            <strong>limit sell at +{pnlArm}%</strong> on capital deployed is placed on Kite
            {profitExitPrice != null ? ` (≈ ₹${formatNumber(profitExitPrice, 2)} per unit today)` : ""}.
            Retries instantly if Kite rejects placement.
          </li>
          <li>
            <strong>Stop loss — −2% for 3 seconds.</strong> While in position, P&amp;L at or below{" "}
            <strong>{initialStopPnl}%</strong> must hold for{" "}
            <strong>{initialStopHoldSec} continuous seconds</strong> before a market sell. Recover above
            {initialStopPnl}% in that window and the timer resets. Exits use <strong>option P&amp;L % only</strong>.
          </li>
          <li>
            <strong>Market backup at +{pnlArm}%.</strong> If the limit has not filled and unrealised P&amp;L
            reaches the same <strong>+{pnlArm}%</strong> target, the bot squares off at market.
          </li>
          <li>
            <strong>Stops cross at market.</strong> The −2% (3s) stop, market backup, {forceExit}{" "}
            square-off, and manual close all send plain market sells — no limit.
          </li>
          <li>
            <strong>No new trade until the last one is flat.</strong> If lots are still open after
            the exit rounds, the bot keeps the position and keeps working it rather than booking the
            trade and scanning again — so a failed exit can never leave a leg open underneath a
            fresh entry.
          </li>
          <li>
            <strong>The cutoff never cuts a live trade.</strong> {scanClose} only stops <em>new</em> entries. A
            position already open keeps running until its limit fills, stop fires, or backup exits. The
            safety square-off at <strong>{forceExit}</strong> applies because Zerodha auto-squares MIS legs
            shortly after.
          </li>
          <li>
            <strong>Size — one order, at most {maxLots} lot{maxLots === 1 ? "" : "s"}.</strong> The entry is a
            single MIS limit order, never split. Whatever the balance would allow beyond{" "}
            <strong>{maxLots} lot{maxLots === 1 ? "" : "s"}</strong> is left unused on purpose: a second order would
            leave part of the position outside what the bot tracks and squares off.
          </li>
          <li>
            <strong>The size is settled in the same breath as the order.</strong> Resolving the ATM
            leg also quotes its premium and reads the balance, so the lot count is priced off the
            premium the buy is about to pay rather than a quote from a minute earlier. At ₹130.00
            with a 65-unit lot, 25 lots is ₹130 × 65 × 25 = <strong>₹2,11,250</strong>; if the
            balance won&apos;t stretch, the lot count comes down right there.
          </li>
          <li>
            <strong>Head-room on sizing.</strong> The limit sits below LTP but charges still apply on top
            of the quoted premium, so sizing adds <strong>{premiumSafetyPct}%</strong> head-room to keep
            the order inside the balance.
          </li>
          <li>
            The bot and its websocket only run during the <strong>{scanSchedule}</strong> IST entry
            windows (or while a position is open). If the server restarts mid-day, only bars{" "}
            <em>after</em> reconnect are used.
          </li>
        </ol>
      </div>

      <div className="pat-status-row">
        <span className={cn("pat-badge", status.enabled ? "pat-badge--on" : "pat-badge--off")}>
          {status.serverDisabled
            ? "Off (server)"
            : status.stoppedForLossToday
              ? "Stopped (2 losses)"
              : status.enabled
                ? "Enabled"
                : "Disabled"}
        </span>
        <span className="pat-badge">{status.phase}</span>
        <span className={cn("pat-badge", status.wsConnected ? "pat-badge--on" : "pat-badge--off")}>
          WS {status.wsConnected ? "connected" : "connecting…"}
        </span>
        <span className="pat-badge">{status.completedBars} bars from ticks</span>
      </div>

      <p className="pat-sub" style={{ marginBottom: "0.75rem" }}>
        {status.message}
      </p>

      {!status.nineSixteenSettled && status.enabled && (
        <p className="ms-bot-warn ms-bot-warn--hold">
          <strong>On hold.</strong> Waiting for the 9:16 trade to finish (after{" "}
          <strong>9:16:30 IST</strong>) or outside the entry window ({scanSchedule}). Bars are still
          being built from ticks in the meantime.
        </p>
      )}

      {status.serverDisabled && (
        <p className="ms-bot-warn ms-bot-warn--hold">
          <strong>Disabled on server.</strong> Traps is turned off via{" "}
          <strong>MOMENTUM_SCALPER_BOT_ENABLED=0</strong> — no new entries until the env is changed and
          the server restarts.
        </p>
      )}

      {!status.enabled && !status.stoppedForLossToday && !status.serverDisabled && (
        <p className="ms-bot-warn ms-bot-warn--hold">
          <strong>Disabled.</strong> Press <strong>Enable bot</strong> to arm Traps — nothing runs until
          you do.
        </p>
      )}

      <div className="pat-metric-grid">
        <div className="pat-metric">
          <span className="pat-metric-label">Nifty spot</span>
          <span className="pat-metric-value">
            {status.lastSpot != null ? formatNumber(status.lastSpot, 2) : "—"}
          </span>
        </div>
        <div className="pat-metric">
          <span className="pat-metric-label">RSI(14)</span>
          <span className="pat-metric-value">
            {status.liveNiftyRsi != null ? formatNumber(status.liveNiftyRsi, 1) : "—"}
          </span>
          <span className="pat-metric-hint">Zerodha 1-min · need {status.liveRsiBucketsIst ?? "40–60"}</span>
        </div>
        <div className="pat-metric">
          <span className="pat-metric-label">Trades today</span>
          <span className="pat-metric-value">{status.tradesToday}</span>
        </div>
        <div className="pat-metric">
          <span className="pat-metric-label">Size</span>
          <span className="pat-metric-value">
            {plannedLots != null
              ? `${plannedLots} lot${plannedLots === 1 ? "" : "s"} armed`
              : `${maxLots} lot${maxLots === 1 ? "" : "s"} max`}
          </span>
          <span className="pat-metric-hint">single MIS market order · never split</span>
        </div>
        <div className="pat-metric">
          <span className="pat-metric-label">Last bar (WS)</span>
          <span className="pat-metric-value">{status.lastBarTimeIst ?? "—"}</span>
        </div>
        {status.pendingSignal && (
          <div className="pat-metric pat-metric--wide">
            <span className="pat-metric-label">Pending signal</span>
            <span className="pat-metric-value">
              {status.pendingSignal.side} · {status.pendingSignal.signalTimeIst} ·{" "}
              {Math.abs(status.pendingSignal.movePts)} pt range
            </span>
            <span className="pat-metric-hint">
              {status.pendingSignal.liveRsi != null
                ? `RSI ${formatNumber(status.pendingSignal.liveRsi, 1)} · `
                : ""}
              {status.pendingSignal.optionMarkPrice != null
                ? `${status.pendingSignal.optionTradingsymbol ?? "option"} at ₹${status.pendingSignal.optionMarkPrice.toFixed(2)} · buying at market`
                : "first-second gate → 2 pt pullback entry"}
            </span>
          </div>
        )}
        {status.tradingsymbol && (
          <>
            <div className="pat-metric pat-metric--wide">
              <span className="pat-metric-label">Position</span>
              <span className="pat-metric-value">
                {status.leg} · {status.tradingsymbol} × {status.quantity ?? "—"}
              </span>
            </div>
            <div className="pat-metric">
              <span className="pat-metric-label">Index entry</span>
              <span className="pat-metric-value">
                {status.entryIndexPrice != null ? formatNumber(status.entryIndexPrice, 2) : "—"}
              </span>
            </div>
            <div className="pat-metric">
              <span className="pat-metric-label">TP limit / stop</span>
              <span className="pat-metric-value">
                +{pnlArm}% limit
                {profitExitPrice != null ? ` @ ₹${formatNumber(profitExitPrice, 2)}` : ""} · stop{" "}
                {initialStopPnl}% ({initialStopHoldSec}s)
              </span>
              <span className="pat-metric-hint">
                {status.profitExitArmed
                  ? `limit ${status.profitExitOrderStatus ?? "pending"} on Kite · market backup at +${pnlArm}%`
                  : `limit placed at entry · backup at +${pnlArm}%`}
              </span>
            </div>
            <div className="pat-metric">
              <span className="pat-metric-label">P&L %</span>
              <span
                className={cn(
                  "pat-metric-value",
                  status.pnlPct != null && getChangeClass(status.pnlPct),
                )}
              >
                {status.pnlPct != null ? `${formatNumber(status.pnlPct, 2)}%` : "—"}
              </span>
              <span className="pat-metric-hint">of premium paid</span>
            </div>
            <div className="pat-metric">
              <span className="pat-metric-label">Option P&L</span>
              <span
                className={cn(
                  "pat-metric-value",
                  status.unrealisedPnl != null && getChangeClass(status.unrealisedPnl),
                )}
              >
                {status.unrealisedPnl != null ? formatCurrency(status.unrealisedPnl) : "—"}
              </span>
            </div>
            <div className="pat-metric">
              <span className="pat-metric-label">Index P&L</span>
              <span
                className={cn(
                  "pat-metric-value",
                  status.indexPnlPts != null && getChangeClass(status.indexPnlPts),
                )}
              >
                {status.indexPnlPts != null
                  ? `${status.indexPnlPts >= 0 ? "+" : ""}${formatNumber(status.indexPnlPts, 2)} pts`
                  : "—"}
              </span>
            </div>
          </>
        )}
      </div>

      {status.logs.length > 0 && (
        <div className="pat-log-block ms-log-block">
          {status.logs.slice(0, 8).map((entry, idx) => {
            const line = formatMomentumScalperLog(entry.message);
            return (
              <div
                key={`${entry.time}-${idx}`}
                className={cn(
                  "ms-log-line",
                  entry.type === "success" && "is-success",
                  entry.type === "warning" && "is-warning",
                  entry.type === "error" && "is-error",
                )}
              >
                <div className="ms-log-line-head">
                  <span className="pat-log-time">{entry.time}</span>
                  <span className={cn("ms-log-badge", line.badgeClass)}>{line.badge}</span>
                </div>
                <p className="ms-log-text">{line.text}</p>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
