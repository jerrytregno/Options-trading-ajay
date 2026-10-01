import { useCallback, useEffect, useState } from "react";
import { RefreshCw, Server } from "lucide-react";
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
  nineFifteenTakeProfitPct?: number;
  nineFifteenTpLimitPrice?: number | null;
  nineFifteenDeployedCapital?: number | null;
  nineFifteenTpProfitAim?: number | null;
  nineFifteenPnlRemaining?: number | null;
  nineFifteenTpOrderStatus?: "none" | "pending" | "partial" | "complete" | "cancelled" | "failed";
  nineFifteenTpOrderIds?: string[];
  nineFifteenTpFilledQty?: number;
  nineFifteenTpPendingQty?: number;
  nineFifteenTpPlacedAt?: string | null;
  nineFifteenTpLastSyncedAt?: string | null;
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

export function ServerNineSixteenBotPanel({ connected: _connected }: { connected: boolean }) {
  const [status, setStatus] = useState<BotStatus | null>(null);
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

  const nineFifteenTpPct = status.nineFifteenTakeProfitPct ?? status.nineFifteenTrailArmPct ?? 5;
  const onNineFifteenLeg = status.tradeSlot === "nine-fifteen" && inPosition;
  const onNineSixteenLeg = status.tradeSlot === "nine-sixteen" && inPosition;
  const onTpLimitLeg = onNineFifteenLeg || onNineSixteenLeg;
  const livePnlPct =
    status.pnlPct ??
    (livePnl != null && status.entryPrice != null && status.quantity != null && status.quantity > 0
      ? (livePnl / (status.entryPrice * status.quantity)) * 100
      : null);

  const nineFifteenMarkChange = status.nineFifteenMarkChange ?? null;
  const deployedCapital = status.nineFifteenDeployedCapital ?? null;
  const profitAim = status.nineFifteenTpProfitAim ?? status.pnlTargetAmount ?? null;
  const pnlRemaining = status.nineFifteenPnlRemaining ?? null;
  const tpOrderStatus = status.nineFifteenTpOrderStatus ?? "none";
  const tpProgressPct =
    profitAim != null && profitAim > 0 && livePnl != null
      ? Math.min(100, Math.max(0, (livePnl / profitAim) * 100))
      : null;

  function tpStatusLabel(): string {
    switch (tpOrderStatus) {
      case "pending":
        return "Live on Kite — waiting for fill";
      case "partial":
        return "Partially filled";
      case "complete":
        return "Fully filled — closing trade";
      case "cancelled":
        return "Cancelled — market backup active";
      case "failed":
        return `Not placed — market backup at +${nineFifteenTpPct}%`;
      default:
        return "Not armed yet";
    }
  }

  // Both legs exit on a resting take-profit limit (+ market backup at the same %).
  const pnlTargetReached =
    inPosition &&
    status.pnlTargetAmount != null &&
    livePnl != null &&
    livePnl >= status.pnlTargetAmount &&
    onTpLimitLeg;

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

  const pnlBlockClass =
    livePnl == null
      ? ""
      : livePnl >= 0
        ? "is-up"
        : "is-down";

  return (
    <section className={cn("pat-card card ns916-trader", isLive && "pat-card--live")}>
      <header className="pat-head">
        <div className="pat-head-left">
          <Server size={18} />
          <div>
            <h2 className="pat-title">Server 9:16 bot (Lightsail)</h2>
              <p className="pat-sub">
                9:15 + 9:16 trading armed on server · websocket 9:00–16:00
              </p>
          </div>
        </div>
        <div className="pat-head-actions">
          <button type="button" className="btn btn-secondary btn-sm" onClick={() => void load()}>
            <RefreshCw size={14} />
          </button>
          <span className="pat-badge pat-badge--on">9:15 always on</span>
          <span className={cn("pat-badge", status.enabled ? "pat-badge--on" : "pat-badge--off")}>
            {status.enabled ? "9:16 armed" : "9:16 off"}
          </span>
        </div>
      </header>

      {tradingDisabled && (
        <div className="ms-bot-warn ms-bot-warn--hold">
          <strong>9:16 entries are disabled on the server.</strong> Only the 9:15 trade runs — websocket tick
          capture and per-second samples stay active.
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
              {nineFifteenMarkChange <= -5
                ? "red ≥ 5 pts, buying the ATM PE"
                : nineFifteenMarkChange >= 10
                  ? "green ≥ 10 pts, buying the ATM CE"
                  : nineFifteenMarkChange < 0
                    ? "red but under 5 pts, no 9:15 trade"
                    : nineFifteenMarkChange === 0
                      ? "flat, no 9:15 trade"
                      : "green but under 10 pts, no 9:15 trade"}
              .
            </>
          ) : (
            <>Waiting for the 9:15:10 read.</>
          )}
          {status.nineFifteenNote && <> {status.nineFifteenNote}.</>}
          {status.nineFifteenBlocked916 && <> The 9:16 trade is skipped today.</>}
        </div>
      )}

      <div className="ns916-exit-rules">
        <div className="bb-bot-section">Entry rules (9:15 &amp; 9:16)</div>
        <div className="pat-metric-grid">
          <div className="pat-metric">
            <span className="pat-metric-label">Sizing</span>
            <span className="pat-metric-value">Full balance · 25 lots/order</span>
            <span className="pat-metric-hint">
              Total lots = floor(available ÷ (LTP × lot size)). Larger sizes split into parallel Kite orders of max{" "}
              <strong>25 lots</strong> each (e.g. 27 lots → <strong>25 + 2</strong> orders, one leg).
            </span>
          </div>
          <div className="pat-metric">
            <span className="pat-metric-label">Entry order</span>
            <span className="pat-metric-value">9:15 market · 9:16 limit</span>
            <span className="pat-metric-hint">
              <strong>9:15:11</strong> — <strong>NRML market BUY</strong> (REST LTP sizing, fast fill).{" "}
              <strong>9:16:01</strong> — websocket CE + PE from <strong>9:15:58</strong>;{" "}
              <strong>NRML limit BUY</strong> at the 2nd option tick in that second (size on the lower of 1st + 2nd;
              ≥3% spike logged; market backup in 8s). Take-profit exits are <strong>LIMIT sells</strong> rounded to
              nearest <strong>₹0.05</strong>.
            </span>
          </div>
          <div className="pat-metric">
            <span className="pat-metric-label">Margin retry</span>
            <span className="pat-metric-value">Top-up + downsize</span>
            <span className="pat-metric-hint">
              If a chunk is rejected, missing qty is topped up until <strong>9:15:20</strong> /{" "}
              <strong>9:16:30</strong>. On insufficient margin at <strong>9:15:11</strong>, lot count steps down
              instantly (25 → 24 → 23…) until <strong>9:15:15</strong> using Kite&apos;s required vs available figures.
            </span>
          </div>
        </div>
      </div>

      <div className="ns916-exit-rules">
        <div className="bb-bot-section">Exit rules (9:15 &amp; 9:16)</div>
        <div className="pat-metric-grid">
          <div className="pat-metric">
            <span className="pat-metric-label">P&amp;L exit</span>
            <span className="pat-metric-value">
              {onNineFifteenLeg
                ? `9:15 · +${nineFifteenTpPct}% limit`
                : onNineSixteenLeg
                  ? `9:16 · +${nineFifteenTpPct}% limit`
                  : "9:16 · +5% / +7% limit (weekday)"}
            </span>
            <span className="pat-metric-hint">
              {onNineFifteenLeg ? (
                <>
                  Target is <strong>+{nineFifteenTpPct}% profit on capital deployed</strong> (entry premium × qty
                  {status.leg === "CE_BUY"
                    ? " — CE 3% every day"
                    : " — PE Mon/Tue 5% · Wed/Thu/Fri 3%"}
                  ). On fill at
                  9:15:11 a resting{" "}
                  <strong>limit sell</strong> (not market) is placed at the tick-rounded price for that %; retries
                  instantly if Kite rejects placement
                  {status.nineFifteenTpLimitPrice != null
                    ? ` (limit ₹${formatNumber(status.nineFifteenTpLimitPrice, 2)} per unit today)`
                    : ""}
                  . <strong>Market backup</strong> at the same +{nineFifteenTpPct}% if P&amp;L prints before the
                  limit fills. <strong>Small-body exit</strong> — if the 9:15 WS close has |Δ| &lt; 5 and the leg
                  is still open, market exit on the first Nifty WS tick at <strong>9:16:01</strong> (any P&amp;L).{" "}
                  <strong>3:25 PM</strong> square-off if still open.
                </>
              ) : onNineSixteenLeg ? (
                <>
                  Target is <strong>+{nineFifteenTpPct}% profit on capital deployed</strong> (Mon/Wed/Thu{" "}
                  <strong>5%</strong> · Tue/Fri <strong>7%</strong>). On fill at 9:16:01 a resting{" "}
                  <strong>limit sell</strong> is placed; retries instantly if Kite rejects
                  {status.nineFifteenTpLimitPrice != null
                    ? ` (limit ₹${formatNumber(status.nineFifteenTpLimitPrice, 2)} per unit today)`
                    : ""}
                  . <strong>Market backup</strong> at the same % if price prints before the limit fills.
                  Parallel <strong>flat −12/−8/−6 Nifty index exit</strong> (−12 or −8 until 9:17:00; if the 9:16
                  minute closes green, retarget to <strong>−6 from 9:17:00</strong>) runs alongside —{" "}
                  <strong>first wins</strong>. <strong>3:25 PM</strong> square-off.
                </>
              ) : (
                <>
                  9:16 take-profit on <strong>capital deployed</strong>: Mon/Wed/Thu <strong>+5%</strong> · Tue/Fri{" "}
                  <strong>+7%</strong> — resting limit sell with instant retries; market backup at the same %;
                  parallel flat <strong>−12</strong> (9:16:00 open ≤ 9:15:59 close · both red) or <strong>−8</strong> (9:16:00
                  open &gt; 9:15:59 close · green gap) until <strong>9:17:00</strong>; if 9:16:59 close &gt; 9:15:59 close
                  (green 9:16 minute), retarget to <strong>−6 from 9:17:00</strong>. <strong>3:25 PM</strong> square-off.
                </>
              )}
            </span>
          </div>
          {onNineSixteenLeg && status.indexExitSchedule && (
            <div className="pat-metric pat-metric--highlight">
              <span className="pat-metric-label">Parallel index exit</span>
              <span className="pat-metric-value">
                {status.targetSpot != null ? formatNumber(status.targetSpot, 2) : "—"}
              </span>
              <span className="pat-metric-hint">
                {status.indexExitSchedule}
                {status.niftyPointsToTarget != null
                  ? ` · ${formatNumber(status.niftyPointsToTarget, 2)} pts until target (market sell)`
                  : " · market sell when Nifty hits target"}
              </span>
            </div>
          )}
          <div className="pat-metric pat-metric--highlight">
            <span className="pat-metric-label">Hard stop</span>
            <span className="pat-metric-value">
              {hardStopStartLabel} · ±{hardStopPoints} pts adverse
            </span>
            <span className="pat-metric-hint">
              From {hardStopStartLabel} IST, exit at market if Nifty is {hardStopPoints} pts against the entry
              spot — PE when spot ≥ entry + {hardStopPoints}, CE when spot ≤ entry − {hardStopPoints}. Applies to
              both the 9:15 and 9:16 legs (runs alongside take-profit limit; first wins).
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
          {status.enabled ? "9:16 armed" : "9:16 off"}
        </span>
        <span className={cn("pat-badge", status.wsConnected ? "pat-badge--open" : "pat-badge--off")}>
          {status.wsConnected ? "Websocket live" : "Websocket off"}
        </span>
        <span className={cn("pat-badge", status.sessionConnected ? "pat-badge--open" : "pat-badge--closed")}>
          {status.sessionConnected ? "Kite session saved" : "Kite not connected"}
        </span>
        <span className="pat-scan-note pat-scan-note--watch">{status.message}</span>
        {hardStopBreached && (
          <span className="pat-badge pat-badge--closed">Hard stop breached — bot exiting</span>
        )}
        {status.hardStopActive && !hardStopBreached && hardStopSpot != null && inPosition && (
          <span className="pat-badge pat-badge--off">
            Hard stop live · exit if Nifty {isPeLeg ? "≥" : "≤"} {formatNumber(hardStopSpot, 2)}
          </span>
        )}
      </div>

      {status.nineFifteenSettled && status.nineFifteenNote?.startsWith("TRADE EXITED") && (
        <div className="ns916-exit-banner card">
          <strong>9:15 trade closed</strong>
          <p>{status.nineFifteenNote}</p>
        </div>
      )}

      {inPosition && (
        <div className={cn("pat-pnl-block", pnlBlockClass, (targetReached || pnlTargetReached) && "is-hit")}>
          <div className="pat-pnl-label">
            {onNineFifteenLeg
              ? "Live P&L · 9:15 leg (until exit)"
              : onNineSixteenLeg
                ? "Live P&L · 9:16 leg (until exit)"
                : "Live P&L (Zerodha)"}
          </div>
          <div className={cn("pat-pnl-value", livePnl != null && getChangeClass(livePnl))}>
            {livePnl != null ? formatCurrency(livePnl) : "Syncing…"}
            {livePnlPct != null && (
              <span className="pat-pnl-pct">
                {" "}
                ({livePnlPct >= 0 ? "+" : ""}
                {formatNumber(livePnlPct, 2)}%)
              </span>
            )}
          </div>
          {onTpLimitLeg && deployedCapital != null && (
            <p className="pat-pnl-sub">
              Deployed {formatCurrency(deployedCapital)} · profit aim +{nineFifteenTpPct}% (
              {profitAim != null ? formatCurrency(profitAim) : "—"})
              {pnlRemaining != null && pnlRemaining > 0
                ? ` · ${formatCurrency(pnlRemaining)} to target`
                : pnlTargetReached
                  ? " · target reached"
                  : ""}
            </p>
          )}
          {onTpLimitLeg && tpProgressPct != null && (
            <div className="pat-pnl-bar" aria-hidden>
              <div
                className="pat-pnl-bar-fill"
                style={{ width: `${tpProgressPct}%` }}
              />
            </div>
          )}
          {!onTpLimitLeg && status.entryPrice != null && status.lastOptionPrice != null && status.quantity != null && (
            <p className="pat-pnl-sub">
              Entry ₹{formatNumber(status.entryPrice, 2)} → LTP ₹{formatNumber(status.lastOptionPrice, 2)} ·{" "}
              {status.quantity} qty
            </p>
          )}
          {onTpLimitLeg && status.entryPrice != null && status.lastOptionPrice != null && status.quantity != null && (
            <p className="pat-pnl-sub">
              Entry ₹{formatNumber(status.entryPrice, 2)} → LTP ₹{formatNumber(status.lastOptionPrice, 2)} ·{" "}
              {status.quantity} qty
            </p>
          )}
          {onTpLimitLeg && pnlTargetReached && (
            <span className="pat-badge pat-badge--on">+{nineFifteenTpPct}% profit aim reached</span>
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
                reference · take-profit limit on capital deployed · {hardStopStartLabel} hard stop ±
                {hardStopPoints} pts
                {status.exitMode === "main" ? " · main entry (|Δ| ≥ 15)" : ""}
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
              <span className="pat-stat-label">
                {onTpLimitLeg ? `Take-profit (+${status.pnlTargetPct}%)` : "Take-profit"}
              </span>
              <span className={cn("pat-stat-value", pnlTargetReached && "text-up")}>
                {status.pnlTargetAmount != null ? formatCurrency(status.pnlTargetAmount) : "—"}
              </span>
              <span className="pat-stat-hint">
                {onTpLimitLeg ? (
                  <>
                    Resting limit
                    {status.nineFifteenTpLimitPrice != null
                      ? ` @ ₹${formatNumber(status.nineFifteenTpLimitPrice, 2)}`
                      : ""}
                    {livePnlPct != null ? ` · now ${livePnlPct >= 0 ? "+" : ""}${formatNumber(livePnlPct, 2)}%` : ""}
                  </>
                ) : (
                  <>Mon/Wed/Thu +5% · Tue/Fri +7% on capital deployed</>
                )}
              </span>
            </div>
            {onTpLimitLeg && (
              <div
                className={cn(
                  "pat-stat ns916-stat-tp-order",
                  tpOrderStatus === "pending" && "ns916-stat-tp-order--live",
                  tpOrderStatus === "partial" && "ns916-stat-tp-order--partial",
                  tpOrderStatus === "complete" && "ns916-stat-tp-order--done",
                  (tpOrderStatus === "failed" || tpOrderStatus === "cancelled") &&
                    "ns916-stat-tp-order--warn",
                )}
              >
                <span className="pat-stat-label">Limit sell (+{nineFifteenTpPct}% TP)</span>
                <span className="pat-stat-value">{tpStatusLabel()}</span>
                <span className="pat-stat-hint">
                  {status.nineFifteenTpLimitPrice != null
                    ? `Limit ₹${formatNumber(status.nineFifteenTpLimitPrice, 2)} · `
                    : ""}
                  {status.quantity != null
                    ? `${status.nineFifteenTpFilledQty ?? 0}/${status.quantity} qty filled`
                    : ""}
                  {(status.nineFifteenTpOrderIds?.length ?? 0) > 0
                    ? ` · ${status.nineFifteenTpOrderIds?.length} Kite order(s)`
                    : ""}
                  {status.nineFifteenTpLastSyncedAt
                    ? ` · synced ${new Date(status.nineFifteenTpLastSyncedAt).toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata" })} IST`
                    : ""}
                </span>
              </div>
            )}
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
        <strong>9:15 trade</strong> (always on server): first tick at 9:15:00 = open; last tick before 9:15:10 vs
        open — red ≥ <strong>5 pts</strong> → <strong>NRML market BUY</strong> ATM PE · green ≥ <strong>10 pts</strong>{" "}
        → ATM CE at 9:15:11 (full balance, split <strong>25 lots</strong> per order). Exit: <strong>limit sell</strong>{" "}
        <strong>PE Mon/Tue 5%</strong> · <strong>Wed/Thu/Fri 3%</strong> · <strong>CE 3% all days</strong> on capital deployed;{" "}
        <strong>market backup at the same %</strong>; if WS 9:15 close
        |Δ| &lt; 5 and still open → <strong>market exit on first Nifty WS tick @ 9:16:01</strong>;{" "}
        <strong>3:25 PM</strong> square-off.
        <br />
        <br />
        <strong>9:16 trade</strong> (armed on server): 9:15 WS close − open = Δ · flat or green → skip · red with{" "}
        <strong>|Δ| ≥ 15</strong> → <strong>NRML limit BUY</strong> at the 2nd option WS tick @{" "}
        <strong>9:16:01</strong> (CE + PE WS from 9:15:58 · size on lower tick · market backup in 8s · retries until{" "}
        <strong>9:16:30</strong>). Skipped if the 9:15 leg is still open at 9:16:00. Exit: limit sell{" "}
        <strong>+5% Mon/Wed/Thu</strong> · <strong>+7% Tue/Fri</strong> on capital deployed; market backup;{" "}
        parallel flat <strong>−12</strong> / <strong>−8</strong> until 9:17:00; if 9:16:59 close &gt; 9:15:59 close (green
        9:16 minute), retarget to <strong>−6 from 9:17:00</strong> — Nifty index exit via <strong>market sell</strong>{" "}
        (first wins vs TP limit); <strong>3:25 PM</strong> square-off.
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
