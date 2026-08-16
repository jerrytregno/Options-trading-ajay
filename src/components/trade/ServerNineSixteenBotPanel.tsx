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
    async (enabled: boolean) => {
      setLoading(true);
      try {
        const res = await fetch("/api/nine-sixteen/bot/toggle", {
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
  const wsLive = Boolean(status?.enabled && status?.wsConnected);

  useEffect(() => {
    if (!wsLive && !inTrade) return;
    void load();
    const id = window.setInterval(() => void load(), WS_LIVE_POLL_MS);
    return () => window.clearInterval(id);
  }, [wsLive, inTrade, load]);

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

  const pnlTargetReached =
    inPosition &&
    status.pnlExitActive &&
    status.pnlTargetAmount != null &&
    livePnl != null &&
    livePnl >= status.pnlTargetAmount;

  const pnlBlockClass =
    livePnl == null
      ? ""
      : livePnl >= 0
        ? "is-up"
        : "is-down";

  const indexTargetPts =
    status.entrySpot != null && status.targetSpot != null
      ? Math.round(Math.abs(status.targetSpot - status.entrySpot))
      : 25;
  const spotPollSec =
    status.spotPollMs != null && status.spotPollMs > 0
      ? (status.spotPollMs / 1000).toFixed(2).replace(/\.?0+$/, "")
      : "0.25";

  return (
    <section className={cn("pat-card card ns916-trader", isLive && "pat-card--live")}>
      <header className="pat-head">
        <div className="pat-head-left">
          <Server size={18} />
          <div>
            <h2 className="pat-title">Server 9:16 bot (Lightsail)</h2>
            <p className="pat-sub">
              Runs on the server — WS 9:00–16:00 · open@9:15:00–15 · close before 9:16 · enter@9:16 if |Δ| ≥ 11 · |Δ|≥15 main exits · 11≤|Δ|&lt;15 near-miss ±20→±10@10:01 · UP→CE, DOWN→PE
            </p>
          </div>
        </div>
        <div className="pat-head-actions">
          <button type="button" className="btn btn-secondary btn-sm" onClick={() => void load()}>
            <RefreshCw size={14} />
          </button>
          {!status.enabled ? (
            <button
              type="button"
              className="btn btn-primary btn-sm"
              disabled={!connected || loading}
              onClick={() => void toggle(true)}
            >
              <Bot size={14} />
              Enable server bot
            </button>
          ) : (
            <button
              type="button"
              className="btn btn-secondary btn-sm pat-stop"
              disabled={loading}
              onClick={() => void toggle(false)}
            >
              Disable server bot
            </button>
          )}
        </div>
      </header>

      <div className="pat-status-row">
        {inPosition && (
          <span className="pat-badge pat-badge--on">In position</span>
        )}
        {sessionDone && (
          <span className="pat-badge pat-badge--open">Session complete</span>
        )}
        <span className={cn("pat-badge", status.enabled ? "pat-badge--on" : "pat-badge--off")}>
          {status.enabled ? "Auto exit on" : "Auto exit off"}
        </span>
        <span className={cn("pat-badge", status.sessionConnected ? "pat-badge--open" : "pat-badge--closed")}>
          {status.sessionConnected ? "Kite session saved" : "Kite not connected"}
        </span>
        <span className={cn("pat-badge", status.wsConnected ? "pat-badge--open" : "pat-badge--off")}>
          {status.wsConnected ? "Websocket live" : "Websocket off"}
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
          {pnlTargetReached && !targetReached && (
            <span className="pat-badge pat-badge--on">P&L target hit — bot exiting</span>
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
                exit ±{indexTargetPts} pts
                {status.exitMode === "near_miss"
                  ? " · near-miss"
                  : status.exitMode === "main"
                    ? " · main"
                    : ""}{" "}
                from this spot
              </span>
            </div>
            <div className="pat-stat ns916-stat-nifty">
              <span className="pat-stat-label">Target Nifty spot</span>
              <span className="pat-stat-value text-up">
                {status.targetSpot != null ? formatNumber(status.targetSpot, 2) : "—"}
              </span>
              <span className="pat-stat-hint">
                {status.leg === "PE_BUY"
                  ? `spot − ${indexTargetPts}`
                  : `spot + ${indexTargetPts}`}
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
              <span className="pat-stat-label">Points to target</span>
              <span
                className={cn(
                  "pat-stat-value",
                  status.niftyPointsToTarget != null && status.niftyPointsToTarget <= 0 && "text-up",
                )}
              >
                {status.niftyPointsToTarget != null
                  ? status.niftyPointsToTarget <= 0
                    ? "Hit ✓"
                    : formatNumber(status.niftyPointsToTarget, 2)
                  : "—"}
              </span>
            </div>
            <div className="pat-stat">
              <span className="pat-stat-label">P&L exit target</span>
              <span
                className={cn(
                  "pat-stat-value",
                  pnlTargetReached && "text-up",
                )}
              >
                {status.pnlTargetAmount != null
                  ? formatCurrency(status.pnlTargetAmount)
                  : "—"}
              </span>
              <span className="pat-stat-hint">
                {status.pnlExitSchedule ?? "9:16–10:00 +10% · 10:01–11:00 +5% · 11:01+ +3%"} ·{" "}
                {status.pnlExitActive && status.pnlTargetPct != null
                  ? `active now (+${status.pnlTargetPct}%)`
                  : "outside P&L window"}
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

      {(wsLive || liveSamples.length > 0) && (
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
        Entry: |Δ| ≥ 11 (skip under 11) · |Δ| ≥ 15 → main ±25/±20@10:01/±15@11:01 · 11 ≤ |Δ| &lt; 15 → near-miss
        ±20 then ±10@10:01 · WS 9:00–16:00 · open@9:15:00–15 · close before 9:16 · order@9:16 · UP→CE, DOWN→PE
        (ATM). Auto exit: WS ticks · {status.indexExitSchedule ?? `±${indexTargetPts} from fill spot`} · fallback
        poll {spotPollSec}s if WS down · P&L{" "}
        {status.pnlExitSchedule ?? "9:16–10:00 +10% · 10:01–11:00 +5% · 11:01+ +3%"}.
        {!status.enabled && inPosition && <> Re-enable auto exit to let the bot square off at target.</>}
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
