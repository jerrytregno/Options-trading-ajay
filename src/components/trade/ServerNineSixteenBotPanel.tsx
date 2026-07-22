import { useCallback, useEffect, useState } from "react";
import { Bot, RefreshCw, Server } from "lucide-react";
import { cn, formatNumber } from "@/lib/utils";
import "@/styles/prediction-auto-trade.css";

interface BotStatus {
  enabled: boolean;
  phase: string;
  dateIST: string;
  message: string;
  open915: number | null;
  leg: string | null;
  tradingsymbol: string | null;
  targetSpot: number | null;
  lastSpot: number | null;
  sessionConnected: boolean;
  sessionAgeHours: number | null;
  logs: { time: string; message: string; type: string }[];
}

export function ServerNineSixteenBotPanel({ connected }: { connected: boolean }) {
  const [status, setStatus] = useState<BotStatus | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/nine-sixteen/bot/status", { credentials: "include" });
      const json = await res.json();
      if (res.ok) setStatus(json.data as BotStatus);
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
    const id = window.setInterval(() => void load(), 5000);
    return () => window.clearInterval(id);
  }, [load]);

  if (!status) return null;

  const isLive = status.phase === "in_position" || status.phase === "entering" || status.phase === "exiting";

  return (
    <section className={cn("pat-card card ns916-trader", isLive && "pat-card--live")}>
      <header className="pat-head">
        <div className="pat-head-left">
          <Server size={18} />
          <div>
            <h2 className="pat-title">Server 9:16 bot (Lightsail)</h2>
            <p className="pat-sub">
              Runs on the server — no browser tab needed · connect Kite once each morning before 9:15
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
        <span className={cn("pat-badge", status.enabled ? "pat-badge--on" : "pat-badge--off")}>
          {status.enabled ? status.phase.replace(/_/g, " ") : "disabled"}
        </span>
        <span className={cn("pat-badge", status.sessionConnected ? "pat-badge--open" : "pat-badge--closed")}>
          {status.sessionConnected ? "Kite session saved" : "Kite not connected"}
        </span>
        <span className="pat-scan-note pat-scan-note--watch">{status.message}</span>
      </div>

      {(status.open915 || status.tradingsymbol) && (
        <div className="pat-dashboard-grid ns916-grid">
          <div className="pat-stat">
            <span className="pat-stat-label">9:15 open</span>
            <span className="pat-stat-value">
              {status.open915 != null ? formatNumber(status.open915, 2) : "—"}
            </span>
          </div>
          <div className="pat-stat">
            <span className="pat-stat-label">Symbol</span>
            <span className="pat-stat-value">{status.tradingsymbol ?? "—"}</span>
          </div>
          <div className="pat-stat">
            <span className="pat-stat-label">Exit target</span>
            <span className="pat-stat-value">
              {status.targetSpot != null ? formatNumber(status.targetSpot, 2) : "—"}
            </span>
          </div>
          <div className="pat-stat">
            <span className="pat-stat-label">Nifty spot</span>
            <span className="pat-stat-value">
              {status.lastSpot != null ? formatNumber(status.lastSpot, 2) : "—"}
            </span>
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

      <p className="pat-idle-note text-muted">
        Set <code>NINE_SIXTEEN_BOT_ENABLED=1</code> on Lightsail. Daily: open app → Settings → Connect Kite → done.
        {status.sessionAgeHours != null && status.sessionAgeHours > 20 && (
          <> Session age {formatNumber(status.sessionAgeHours, 1)}h — reconnect before tomorrow.</>
        )}
      </p>
    </section>
  );
}
