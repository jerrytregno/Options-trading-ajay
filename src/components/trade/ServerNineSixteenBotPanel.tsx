import { useCallback, useEffect, useState } from "react";
import { Bot, RefreshCw, Server } from "lucide-react";
import { cn, formatCurrency, formatNumber, getChangeClass } from "@/lib/utils";
import { getIndianMarketContext } from "@/lib/market-time";
import "@/styles/prediction-auto-trade.css";
import "@/styles/log-test-page.css";

interface LiveSpotSample {
  seq: number;
  dateIST: string;
  timeIST: string;
  epochMs: number;
  niftySpot: number | null;
  openSpot?: number | null;
  highSpot?: number | null;
  lowSpot?: number | null;
  rangePts?: number | null;
  ticksInSecond: number;
  lastTickAtIST: string | null;
  stale: boolean;
}

interface RawTickRow {
  seq: number;
  dateIST: string;
  timeIST: string;
  epochMs: number;
  exchangeTimeIST: string | null;
  kind: "nifty" | "option";
  instrumentToken: number;
  price: number;
  changePts: number | null;
}

interface BotStatus {
  enabled: boolean;
  phase: string;
  dateIST: string;
  message: string;
  open915: number | null;
  close915?: number | null;
  wsConnected?: boolean;
  entrySpot: number | null;
  exitMode?: "main" | "near_miss" | null;
  indexExitSchedule?: string | null;
  hardStopSpot?: number | null;
  hardStopActive?: boolean;
  hardStopPoints?: number;
  hardStopStartLabel?: string;
  leg: string | null;
  tradingsymbol: string | null;
  targetSpot: number | null;
  lastSpot: number | null;
  entryPrice: number | null;
  lastOptionPrice: number | null;
  quantity: number | null;
  unrealisedPnl: number | null;
  niftyPointsToTarget: number | null;
  pnlTargetAmount: number | null;
  pnlTargetPct: number;
  pnlExitActive: boolean;
  pnlExitStartLabel?: string;
  pnlExitSchedule?: string;
  pnlPct?: number | null;
  pnlLockedPct?: number;
  pnlStopPct?: number | null;
  pnlStopAmount?: number | null;
  pnlTrailArmed?: boolean;
  pnlTrailArmPct?: number;
  pnlTrailStepPct?: number;
  nineFifteenEnabled?: boolean;
  tradeSlot?: "nine-fifteen" | "nine-sixteen";
  nineFifteenMarkPrice?: number | null;
  nineFifteenMarkAt?: string | null;
  nineFifteenMarkChange?: number | null;
  nineFifteenSettled?: boolean;
  nineFifteenNote?: string | null;
  nineFifteenBlocked916?: boolean;
  nineFifteenLadder?: string;
  nineFifteenTrailArmPct?: number;
  nineFifteenTrailStepPct?: number;
  sessionConnected: boolean;
  sessionAgeHours: number | null;
  updatedAt?: string;
  spotPollMs?: number;
  logs: { time: string; message: string; type: string }[];
  liveSpotSamples?: LiveSpotSample[];
  liveSpotSampleCount?: number;
  rawTicks?: RawTickRow[];
  rawTickCount?: number;
  rawTickFile?: string | null;
}

interface LiveTick {
  lastSpot: number | null;
  lastOptionPrice: number | null;
  entryPrice: number | null;
  quantity: number | null;
  unrealisedPnl: number | null;
  niftyPointsToTarget: number | null;
  targetSpot: number | null;
  updatedAt: string;
}

const STATUS_POLL_MS = 8000;
const WS_LIVE_POLL_MS = 1000;
const LIVE_POLL_MS = 500;

export function ServerNineSixteenBotPanel({ connected }: { connected: boolean }) {
  const [status, setStatus] = useState<BotStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const [lastLiveAt, setLastLiveAt] = useState<string | null>(null);
  const [tickView, setTickView] = useState<"seconds" | "raw">("seconds");

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/nine-sixteen/bot/status", { credentials: "include" });
      const json = await res.json();
      if (res.ok) setStatus(json.data as BotStatus);
    } catch {
      /* ignore */
    }
  }, []);

  const loadLive = useCallback(async () => {
    try {
      const res = await fetch("/api/nine-sixteen/bot/live", { credentials: "include" });
      const json = await res.json();
      if (!res.ok) return;
      const tick = json.data as LiveTick;
      setLastLiveAt(tick.updatedAt);
      setStatus((prev) => (prev ? { ...prev, ...tick } : prev));
    } catch {
      /* ignore */
    }
  }, []);

  const toggle = useCallback(
    async (enabled: boolean, slot: "nine-fifteen" | "nine-sixteen" = "nine-sixteen") => {
      setLoading(true);
      try {
        const path =
          slot === "nine-fifteen" ? "/api/nine-fifteen/bot/toggle" : "/api/nine-sixteen/bot/toggle";
        const res = await fetch(path, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify({ enabled }),
        });
        const json = await res.json();
        if (res.ok) setStatus(json.data as BotStatus);
      } finally {
        setLoading(false);
      }
    },
    [],
  );

  useEffect(() => {
    void load();
    const id = window.setInterval(() => void load(), STATUS_POLL_MS);
    return () => window.clearInterval(id);
  }, [load]);

  const inTrade = status?.phase === "in_position" || status?.phase === "exiting";
  const wsLive = Boolean(status?.wsConnected);
  const tradingDisabled = status != null && !status.enabled;

  useEffect(() => {
    if (!wsLive && !inTrade && status?.enabled !== false) return;
    void load();
    const id = window.setInterval(() => void load(), WS_LIVE_POLL_MS);
    return () => window.clearInterval(id);
  }, [wsLive, inTrade, status?.enabled, load]);

  useEffect(() => {
    if (!inTrade) return;

    void loadLive();
    const id = window.setInterval(() => void loadLive(), LIVE_POLL_MS);
    return () => window.clearInterval(id);
  }, [inTrade, loadLive]);

  if (!status) return null;

  const inPosition = status.phase === "in_position" || status.phase === "exiting";
  const sessionDone = status.phase === "done";
  const isLive = inPosition || status.phase === "entering" || wsLive;
  const liveSamples = status.liveSpotSamples ?? [];
  const rawTickRows = status.rawTicks ?? [];
  const latestSpot =
    status.lastSpot ??
    liveSamples.find((s) => s.niftySpot != null)?.niftySpot ??
    null;
  const ticksPerSec = liveSamples.length
    ? liveSamples.slice(0, 30).reduce((sum, s) => sum + s.ticksInSecond, 0) /
      Math.min(30, liveSamples.length)
    : 0;
  const targetReached =
    inPosition && status.niftyPointsToTarget != null && status.niftyPointsToTarget <= 0;

  const livePnl =
    status.unrealisedPnl ??
    (status.entryPrice != null &&
    status.lastOptionPrice != null &&
    status.quantity != null &&
    status.quantity > 0
      ? (status.lastOptionPrice - status.entryPrice) * status.quantity
      : null);

  const trailArmPct = status.pnlTrailArmPct ?? 5;
  const trailStepPct = status.pnlTrailStepPct ?? 5;
  const lockedPct = status.pnlLockedPct ?? 0;
  const trailArmed = status.pnlTrailArmed ?? lockedPct >= trailArmPct;
  const livePnlPct =
    status.pnlPct ??
    (livePnl != null && status.entryPrice != null && status.quantity != null && status.quantity > 0
      ? (livePnl / (status.entryPrice * status.quantity)) * 100
      : null);

  // Take-profit no longer exits — hitting it just promotes the ladder one rung.
  const pnlTargetReached =
    inPosition &&
    status.pnlTargetAmount != null &&
    livePnl != null &&
    livePnl >= status.pnlTargetAmount;

  const pnlBlockClass =
    livePnl == null
      ? ""
      : livePnl >= 0
        ? "is-up"
        : "is-down";

  const nineFifteenArmPct = status.nineFifteenTrailArmPct ?? 3;
  const nineFifteenStepPct = status.nineFifteenTrailStepPct ?? 2;
  const nineFifteenMarkChange = status.nineFifteenMarkChange ?? null;

  const spotPollSec =
    status.spotPollMs != null && status.spotPollMs > 0
      ? (status.spotPollMs / 1000).toFixed(2).replace(/\.?0+$/, "")
      : "0.25";

  const hardStopPoints = status.hardStopPoints ?? 30;
  const hardStopStartLabel = status.hardStopStartLabel ?? "10:00";
  const isPeLeg = status.leg === "PE_BUY" || (status.leg?.startsWith("PE") ?? false);
  const isCeLeg = status.leg === "CE_BUY" || (status.leg?.startsWith("CE") ?? false);
  const hardStopSpot =
    status.hardStopSpot ??
    (status.entrySpot != null && status.entrySpot > 0 && status.leg
      ? isCeLeg
        ? status.entrySpot - hardStopPoints
        : status.entrySpot + hardStopPoints
      : null);
  const hardStopBreached =
    inPosition &&
    Boolean(status.hardStopActive) &&
    status.lastSpot != null &&
    status.lastSpot > 0 &&
    hardStopSpot != null &&
    (isCeLeg
      ? status.lastSpot <= hardStopSpot
      : isPeLeg
        ? status.lastSpot >= hardStopSpot
        : false);
  const ptsToHardStop =
    inPosition && status.lastSpot != null && status.lastSpot > 0 && hardStopSpot != null
      ? isPeLeg
        ? hardStopSpot - status.lastSpot
        : isCeLeg
          ? status.lastSpot - hardStopSpot
          : null
      : null;

  return (
    <section className={cn("pat-card card ns916-trader", isLive && "pat-card--live")}>
      <header className="pat-head">
        <div className="pat-head-left">
          <Server size={18} />
          <div>
            <h2 className="pat-title">Server 9:16 bot (Lightsail)</h2>
            <p className="pat-sub">
              Websocket monitor runs 9:00–16:00 · 9:16 <strong>trading</strong> can be turned off while ticks and
              9:15 capture keep running
            </p>
          </div>
        </div>
        <div className="pat-head-actions">
          <button type="button" className="btn btn-secondary btn-sm" onClick={() => void load()}>
            <RefreshCw size={14} />
          </button>
          {status.nineFifteenEnabled ? (
            <button
              type="button"
              className="btn btn-secondary btn-sm pat-stop"
              disabled={loading}
              onClick={() => void toggle(false, "nine-fifteen")}
              title="Stop the 9:15:11 entry — the 9:16 trade is unaffected"
            >
              Disable 9:15 trading
            </button>
          ) : (
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              disabled={!connected || loading}
              onClick={() => void toggle(true, "nine-fifteen")}
              title="Arm the 9:15:11 PE entry and its own P&L ladder"
            >
              <Bot size={14} />
              Enable 9:15 trading
            </button>
          )}
          {status.enabled ? (
            <button
              type="button"
              className="btn btn-secondary btn-sm pat-stop"
              disabled={loading}
              onClick={() => void toggle(false)}
              title="Stop 9:16 entries — websocket and tick logging keep running"
            >
              Disable 9:16 trading
            </button>
          ) : (
            <button
              type="button"
              className="btn btn-primary btn-sm"
              disabled={!connected || loading}
              onClick={() => void toggle(true)}
              title="Arm 9:16:00 entry and auto-exit rules"
            >
              <Bot size={14} />
              Enable 9:16 trading
            </button>
          )}
        </div>
      </header>

      {tradingDisabled && (
        <div className="ms-bot-warn ms-bot-warn--hold">
          <strong>9:16 trading disabled now.</strong> No orders at 9:16:00 and no new entry logs — the Kite
          websocket, 9:15 tick capture, and per-second samples below stay active.
        </div>
      )}

      {status.nineFifteenEnabled && (
        <div className="ms-bot-warn ms-bot-warn--hold">
          <strong>
            {status.tradeSlot === "nine-fifteen" && inPosition ? "In the 9:15 trade." : "9:15 trade armed."}
          </strong>{" "}
          {status.nineFifteenMarkPrice != null && nineFifteenMarkChange != null ? (
            <>
              9:15:10 read {formatNumber(status.nineFifteenMarkPrice, 2)} against the open{" "}
              {formatNumber(status.open915 ?? 0, 2)} · Δ {nineFifteenMarkChange >= 0 ? "+" : ""}
              {formatNumber(nineFifteenMarkChange, 2)} pts —{" "}
              {nineFifteenMarkChange < 0 ? "red, buying the ATM PE" : "green, no 9:15 trade"}.
            </>
          ) : (
            <>Waiting for the 9:15:10 read.</>
          )}
          {status.nineFifteenNote && <> {status.nineFifteenNote}.</>}
          {status.nineFifteenBlocked916 && <> The 9:16 trade is skipped today.</>}
        </div>
      )}

      <div className="ns916-exit-rules">
        <div className="bb-bot-section">Exit rules (9:15 &amp; 9:16)</div>
        <div className="pat-metric-grid">
          <div className="pat-metric">
            <span className="pat-metric-label">P&amp;L trail</span>
            <span className="pat-metric-value">Premium ladder</span>
            <span className="pat-metric-hint">
              9:15: arms at +{nineFifteenArmPct}%, then +{nineFifteenStepPct}% rungs. 9:16: arms at +
              {trailArmPct}%, then +{trailStepPct}% rungs. Hitting a rung never sells — slipping back to the
              locked stop does.
            </span>
          </div>
          <div className="pat-metric pat-metric--highlight">
            <span className="pat-metric-label">Hard stop</span>
            <span className="pat-metric-value">
              {hardStopStartLabel} · ±{hardStopPoints} pts adverse
            </span>
            <span className="pat-metric-hint">
              From {hardStopStartLabel} IST, exit at market if Nifty is {hardStopPoints} pts against the entry
              spot — PE when spot ≥ entry + {hardStopPoints}, CE when spot ≤ entry − {hardStopPoints}. Applies to
              both the 9:15 and 9:16 legs.
            </span>
          </div>
          <div className="pat-metric">
            <span className="pat-metric-label">Square-off</span>
            <span className="pat-metric-value">3:25 PM IST</span>
            <span className="pat-metric-hint">
              Any leg still open at the intraday cutoff is squared off at market.
            </span>
          </div>
        </div>
      </div>

      <div className="pat-status-row">
        {inPosition && (
          <span className="pat-badge pat-badge--on">In position</span>
        )}
        {sessionDone && (
          <span className="pat-badge pat-badge--open">Session complete</span>
        )}
        <span className={cn("pat-badge", status.enabled ? "pat-badge--on" : "pat-badge--off")}>
          {status.enabled ? "9:16 trading on" : "9:16 trading off"}
        </span>
        <span className={cn("pat-badge", status.wsConnected ? "pat-badge--open" : "pat-badge--off")}>
          {status.wsConnected ? "Websocket live" : "Websocket off"}
        </span>
        <span className={cn("pat-badge", status.sessionConnected ? "pat-badge--open" : "pat-badge--closed")}>
          {status.sessionConnected ? "Kite session saved" : "Kite not connected"}
        </span>
        <span className="pat-scan-note pat-scan-note--watch">{status.message}</span>
      </div>

      {inPosition && (
        <div className={cn("pat-pnl-block", pnlBlockClass, (targetReached || pnlTargetReached) && "is-hit")}>
          <div className="pat-pnl-label">Live P&L (Zerodha)</div>
          <div className={cn("pat-pnl-value", livePnl != null && getChangeClass(livePnl))}>
            {livePnl != null ? formatCurrency(livePnl) : "Syncing…"}
          </div>
          {status.entryPrice != null && status.lastOptionPrice != null && status.quantity != null && (
            <p className="pat-pnl-sub">
              Entry ₹{formatNumber(status.entryPrice, 2)} → LTP ₹{formatNumber(status.lastOptionPrice, 2)} ·{" "}
              {status.quantity} qty
            </p>
          )}
          {targetReached && (
            <span className="pat-badge pat-badge--on">Nifty target zone hit — bot exiting</span>
          )}
          {trailArmed && !targetReached && (
            <span className="pat-badge pat-badge--on">
              Trailing stop locked at +{lockedPct}% — next TP +{status.pnlTargetPct}%
            </span>
          )}
          {hardStopBreached && (
            <span className="pat-badge pat-badge--closed">Hard stop breached — bot exiting</span>
          )}
          {status.hardStopActive && !hardStopBreached && hardStopSpot != null && (
            <span className="pat-badge pat-badge--off">
              Hard stop live · exit if Nifty {isPeLeg ? "≥" : "≤"} {formatNumber(hardStopSpot, 2)}
            </span>
          )}
        </div>
      )}

      {(status.open915 || status.tradingsymbol) && inPosition && (
        <div className="pat-dashboard ns916-dashboard">
          <div className="pat-dashboard-grid ns916-grid">
            {status.tradingsymbol && (
              <div className="pat-stat ns916-stat-symbol">
                <span className="pat-stat-label">Symbol</span>
                <span className="pat-stat-value" title={status.tradingsymbol}>
                  {status.tradingsymbol}
                </span>
              </div>
            )}
            <div className="pat-stat ns916-stat-nifty">
              <span className="pat-stat-label">Nifty spot at entry</span>
              <span className="pat-stat-value">
                {status.entrySpot != null ? formatNumber(status.entrySpot, 2) : "—"}
              </span>
              <span className="pat-stat-hint">
                reference · P&amp;L trail + {hardStopStartLabel} hard stop ±{hardStopPoints} pts
                {status.exitMode === "near_miss"
                  ? " · near-miss entry"
                  : status.exitMode === "main"
                    ? " · main entry"
                    : ""}
              </span>
            </div>
            {status.open915 != null && (
              <div className="pat-stat">
                <span className="pat-stat-label">9:15:00 open (WS)</span>
                <span className="pat-stat-value">{formatNumber(status.open915, 2)}</span>
              </div>
            )}
            {status.close915 != null && (
              <div className="pat-stat">
                <span className="pat-stat-label">9:15:59 close (WS)</span>
                <span className="pat-stat-value">{formatNumber(status.close915, 2)}</span>
              </div>
            )}
            <div className="pat-stat">
              <span className="pat-stat-label">Entry avg (option)</span>
              <span className="pat-stat-value">
                {status.entryPrice != null ? `₹${formatNumber(status.entryPrice, 2)}` : "—"}
              </span>
            </div>
            <div className="pat-stat">
              <span className="pat-stat-label">Option LTP</span>
              <span className={cn("pat-stat-value", livePnl != null && getChangeClass(livePnl))}>
                {status.lastOptionPrice != null ? `₹${formatNumber(status.lastOptionPrice, 2)}` : "—"}
              </span>
            </div>
            <div className="pat-stat">
              <span className="pat-stat-label">Qty</span>
              <span className="pat-stat-value">{status.quantity ?? "—"}</span>
            </div>
            <div className="pat-stat">
              <span className="pat-stat-label">Nifty spot (live)</span>
              <span className="pat-stat-value">
                {status.lastSpot != null ? formatNumber(status.lastSpot, 2) : "—"}
              </span>
            </div>
            <div className="pat-stat">
              <span className="pat-stat-label">Next take-profit rung (+{status.pnlTargetPct}%)</span>
              <span className={cn("pat-stat-value", pnlTargetReached && "text-up")}>
                {status.pnlTargetAmount != null ? formatCurrency(status.pnlTargetAmount) : "—"}
              </span>
              <span className="pat-stat-hint">
                Reaching it does not exit — it moves the stop up to +{status.pnlTargetPct - trailStepPct >= 0
                  ? status.pnlTargetPct - trailStepPct
                  : 0}
                % and the target to +{status.pnlTargetPct + trailStepPct}%
                {livePnlPct != null ? ` · now ${livePnlPct >= 0 ? "+" : ""}${formatNumber(livePnlPct, 2)}%` : ""}
              </span>
            </div>
            <div className="pat-stat">
              <span className="pat-stat-label">Trailing stop</span>
              <span className={cn("pat-stat-value", trailArmed && "text-down")}>
                {trailArmed && status.pnlStopAmount != null
                  ? `${formatCurrency(status.pnlStopAmount)} (+${status.pnlStopPct}%)`
                  : "Not armed"}
              </span>
              <span className="pat-stat-hint">
                {trailArmed
                  ? `Exits the moment P&L slips below +${lockedPct}%`
                  : `Arms once P&L touches +${trailArmPct}% of the premium paid`}
              </span>
            </div>
            <div
              className={cn(
                "pat-stat ns916-stat-hard-stop",
                status.hardStopActive && "ns916-stat-hard-stop--active",
                hardStopBreached && "ns916-stat-hard-stop--breach",
              )}
            >
              <span className="pat-stat-label">Hard stop (from {hardStopStartLabel})</span>
              <span className={cn("pat-stat-value", hardStopBreached && "text-down")}>
                {hardStopSpot != null ? formatNumber(hardStopSpot, 2) : "—"}
              </span>
              <span className="pat-stat-hint">
                {status.hardStopActive
                  ? hardStopBreached
                    ? "Breached — bot exiting at market"
                    : ptsToHardStop != null && ptsToHardStop > 0
                      ? `${formatNumber(ptsToHardStop, 2)} pts until stop (Nifty ${isPeLeg ? "≥" : "≤"} ${formatNumber(hardStopSpot ?? 0, 2)})`
                      : `Exit if Nifty ${isPeLeg ? "≥" : "≤"} ${formatNumber(hardStopSpot ?? 0, 2)}`
                  : `Arms at ${hardStopStartLabel} IST · ${hardStopPoints} pts adverse from entry`}
              </span>
            </div>
          </div>
        </div>
      )}

      {status.logs.length > 0 && (
        <div className="pat-log">
          {status.logs.slice(0, 6).map((entry, idx) => (
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

      {(wsLive || liveSamples.length > 0 || tradingDisabled) && (
        <div className="ns916-live-spot">
          <div className="log-test-summary">
            <div className="card log-test-stat">
              <span className="log-test-label">Websocket</span>
              <span className={cn("log-test-value", wsLive ? "text-up" : "text-muted")}>
                {wsLive ? "Live" : "Off"}
              </span>
            </div>
            <div className="card log-test-stat">
              <span className="log-test-label">Last Nifty spot</span>
              <span className="log-test-value">
                {latestSpot != null ? formatNumber(latestSpot, 2) : "—"}
              </span>
            </div>
            <div className="card log-test-stat">
              <span className="log-test-label">Seconds logged</span>
              <span className="log-test-value">{status.liveSpotSampleCount ?? liveSamples.length}</span>
            </div>
            <div className="card log-test-stat">
              <span className="log-test-label">Ticks today</span>
              <span className="log-test-value">{formatNumber(status.rawTickCount ?? 0, 0)}</span>
            </div>
            <div className="card log-test-stat">
              <span className="log-test-label">Avg ticks / sec</span>
              <span className="log-test-value">{formatNumber(ticksPerSec, 2)}</span>
            </div>
          </div>

          <div className="ns916-tick-toggle">
            <button
              type="button"
              className={cn("ns916-tick-tab", tickView === "seconds" && "is-active")}
              onClick={() => setTickView("seconds")}
            >
              Per second (OHLC)
            </button>
            <button
              type="button"
              className={cn("ns916-tick-tab", tickView === "raw" && "is-active")}
              onClick={() => setTickView("raw")}
            >
              Raw ticks ({rawTickRows.length})
            </button>
          </div>

          <div className="card log-test-table-card">
            <div className="log-test-table-wrap ns916-live-spot-table">
              {tickView === "seconds" ? (
                <table className="log-test-table">
                  <thead>
                    <tr>
                      <th>#</th>
                      <th>IST time</th>
                      <th className="text-right">Open</th>
                      <th className="text-right">High</th>
                      <th className="text-right">Low</th>
                      <th className="text-right">Close</th>
                      <th className="text-right">Range</th>
                      <th className="text-right">Ticks</th>
                      <th>Note</th>
                    </tr>
                  </thead>
                  <tbody>
                    {liveSamples.length === 0 ? (
                      <tr>
                        <td colSpan={9} className="text-muted log-test-empty">
                          Websocket live — waiting for first per-second Nifty sample…
                        </td>
                      </tr>
                    ) : (
                      liveSamples.map((row) => (
                        <tr
                          key={`${row.seq}-${row.epochMs}`}
                          className={row.stale ? "log-test-stale" : undefined}
                        >
                          <td>{row.seq}</td>
                          <td>{row.timeIST}</td>
                          <td className="text-right">
                            {row.openSpot != null ? formatNumber(row.openSpot, 2) : "—"}
                          </td>
                          <td className="text-right">
                            {row.highSpot != null ? formatNumber(row.highSpot, 2) : "—"}
                          </td>
                          <td className="text-right">
                            {row.lowSpot != null ? formatNumber(row.lowSpot, 2) : "—"}
                          </td>
                          <td className="text-right">
                            {row.niftySpot != null ? formatNumber(row.niftySpot, 2) : "—"}
                          </td>
                          <td className="text-right">
                            {row.rangePts != null ? formatNumber(row.rangePts, 2) : "—"}
                          </td>
                          <td className="text-right">{row.ticksInSecond}</td>
                          <td>{row.stale ? "no new tick" : ""}</td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              ) : (
                <table className="log-test-table">
                  <thead>
                    <tr>
                      <th>#</th>
                      <th>Received IST</th>
                      <th>Exchange IST</th>
                      <th>Instrument</th>
                      <th className="text-right">Price</th>
                      <th className="text-right">Δ prev</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rawTickRows.length === 0 ? (
                      <tr>
                        <td colSpan={6} className="text-muted log-test-empty">
                          Websocket live — waiting for first tick…
                        </td>
                      </tr>
                    ) : (
                      rawTickRows.map((row) => (
                        <tr key={`${row.kind}-${row.seq}`}>
                          <td>{row.seq}</td>
                          <td>{row.timeIST}</td>
                          <td>{row.exchangeTimeIST ?? "—"}</td>
                          <td>{row.kind === "nifty" ? "Nifty 50" : "Option"}</td>
                          <td className="text-right">{formatNumber(row.price, 2)}</td>
                          <td className={cn("text-right", getChangeClass(row.changePts ?? 0))}>
                            {row.changePts == null
                              ? "—"
                              : `${row.changePts > 0 ? "+" : ""}${formatNumber(row.changePts, 2)}`}
                          </td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              )}
            </div>
          </div>
        </div>
      )}

      <p className="pat-idle-note text-muted">
        <strong>9:15 trade</strong> (separate switch): the first Nifty tick from 9:15:00 is the open, and the
        last tick before 9:15:10 is read against it. Red → buy the ATM PE at market at 9:15:11; green or flat
        → no trade. Exits: option P&amp;L ladder plus a <strong>10:00 hard stop</strong> — if Nifty is{" "}
        <strong>30 pts adverse</strong> from the entry spot (PE: spot ≥ entry + 30), the leg exits at
        market. Nothing locks until +
        {nineFifteenArmPct}% prints, then every +{nineFifteenStepPct}% rung locks the stop there and moves the
        target one rung on (+{nineFifteenArmPct}→TP +{nineFifteenArmPct + nineFifteenStepPct}/SL +
        {nineFifteenArmPct} · +{nineFifteenArmPct + nineFifteenStepPct}→TP +
        {nineFifteenArmPct + 2 * nineFifteenStepPct}/SL +{nineFifteenArmPct + nineFifteenStepPct} · …).
        Reaching a rung never sells; coming back down to it does, at market.
        <br />
        <br />
        <strong>9:16 trade</strong>: red 9:15 candles only — a green close is skipped rather than bought as a
        CE. |Δ| ≥ 11 (skip under 11) · |Δ| ≥ 15 main band · 11–14 near-miss band (entry sizing only) · WS
        9:00–16:00 · open@9:15:00–15 · close before 9:16 · order@9:16 → PE (ATM). Skipped when the 9:15 leg
        is still open at 9:16:00. Auto exit: trailing P&amp;L plus a <strong>10:00 hard stop</strong> — if
        Nifty is <strong>30 pts adverse</strong> from the entry spot (PE: spot ≥ entry + 30; CE: spot ≤
        entry − 30), the leg exits at market. Nothing locked until +{trailArmPct}% of the premium paid,
        then each +{trailStepPct}% rung locks the stop and moves the target one rung higher
        (+{trailArmPct}→TP +{trailArmPct + trailStepPct}/SL +{trailArmPct} · +{trailArmPct + trailStepPct}→TP
        +{trailArmPct + 2 * trailStepPct}/SL +{trailArmPct + trailStepPct} · …). Hitting the target never
        exits — only slipping back below the locked rung does · 3:25 PM square-off if still open · WS tick
        poll {spotPollSec}s if WS down.
        {!status.enabled && inPosition && (
          <> 9:16 trading is off — re-enable to let the bot auto-manage exits, or square off manually.</>
        )}
        {lastLiveAt && inPosition && (
          <> Last tick {getIndianMarketContext(new Date(lastLiveAt)).timeIST} IST.</>
        )}
        {status.sessionAgeHours != null && status.sessionAgeHours > 20 && (
          <> Session age {formatNumber(status.sessionAgeHours, 1)}h — reconnect before tomorrow.</>
        )}
      </p>
    </section>
  );
}
