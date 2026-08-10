import { useCallback, useEffect, useState } from "react";
import { Activity, Download, Play, Square, Trash2 } from "lucide-react";
import { DashboardShell } from "@/components/layout/dashboard-shell";
import { cn, formatNumber } from "@/lib/utils";
import "@/styles/log-test-page.css";

interface LogSample {
  seq: number;
  dateIST: string;
  timeIST: string;
  epochMs: number;
  niftySpot: number | null;
  ticksInSecond: number;
  lastTickAtIST: string | null;
  stale: boolean;
}

interface LogTestStatus {
  running: boolean;
  wsConnected: boolean;
  startedAt: string | null;
  stoppedAt: string | null;
  message: string;
  sampleCount: number;
  lastPrice: number | null;
  samples: LogSample[];
}

export default function LogTestPage() {
  const [status, setStatus] = useState<LogTestStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/log-test/status", { credentials: "include" });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Failed to load log test");
      setStatus(json.data as LogTestStatus);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load log test");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!status?.running) return;
    const id = window.setInterval(() => void load(), 1000);
    return () => window.clearInterval(id);
  }, [load, status?.running]);

  async function postAction(path: string) {
    setBusy(true);
    try {
      const res = await fetch(path, { method: "POST", credentials: "include" });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Request failed");
      setStatus(json.data as LogTestStatus);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Request failed");
    } finally {
      setBusy(false);
    }
  }

  function downloadCsv() {
    const rows = [...(status?.samples ?? [])].reverse();
    const header = "seq,dateIST,timeIST,niftySpot,ticksInSecond,lastTickAtIST,stale";
    const body = rows
      .map((row) =>
        [
          row.seq,
          row.dateIST,
          row.timeIST,
          row.niftySpot ?? "",
          row.ticksInSecond,
          row.lastTickAtIST ?? "",
          row.stale ? "1" : "0",
        ].join(","),
      )
      .join("\n");
    const blob = new Blob([`${header}\n${body}\n`], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `nifty-log-test-${status?.startedAt?.slice(0, 19).replace(/[:T]/g, "-") ?? "export"}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <DashboardShell>
      <div className="log-test-page">
        <header className="page-header log-test-head">
          <div>
            <h1>Log Test</h1>
            <p>Record Nifty 50 websocket spot once every second to check capture accuracy.</p>
          </div>
          <div className="log-test-actions">
            {!status?.running ? (
              <button
                type="button"
                className="btn btn-primary"
                disabled={busy}
                onClick={() => void postAction("/api/log-test/start")}
              >
                <Play size={16} />
                Start
              </button>
            ) : (
              <button
                type="button"
                className="btn btn-danger"
                disabled={busy}
                onClick={() => void postAction("/api/log-test/stop")}
              >
                <Square size={16} />
                Stop
              </button>
            )}
            <button
              type="button"
              className="btn btn-secondary"
              disabled={busy || !status?.sampleCount}
              onClick={downloadCsv}
            >
              <Download size={16} />
              CSV
            </button>
            <button
              type="button"
              className="btn btn-ghost"
              disabled={busy || status?.running}
              onClick={() => void postAction("/api/log-test/clear")}
            >
              <Trash2 size={16} />
              Clear
            </button>
          </div>
        </header>

        {error && <div className="alert alert-error">{error}</div>}

        <div className="log-test-summary">
          <div className="card log-test-stat">
            <span className="log-test-label">Status</span>
            <span className={cn("log-test-value", status?.running && "text-up")}>
              {status?.running ? "Running" : "Stopped"}
            </span>
          </div>
          <div className="card log-test-stat">
            <span className="log-test-label">Websocket</span>
            <span className={cn("log-test-value", status?.wsConnected ? "text-up" : "text-muted")}>
              {status?.wsConnected ? "Live" : "Off"}
            </span>
          </div>
          <div className="card log-test-stat">
            <span className="log-test-label">Last Nifty spot</span>
            <span className="log-test-value">
              {status?.lastPrice != null ? formatNumber(status.lastPrice, 2) : "—"}
            </span>
          </div>
          <div className="card log-test-stat">
            <span className="log-test-label">Seconds logged</span>
            <span className="log-test-value">{status?.sampleCount ?? 0}</span>
          </div>
        </div>

        <p className="log-test-message">
          <Activity size={14} />
          {status?.message ?? "Idle"}
        </p>

        <div className="card log-test-table-card">
          <div className="log-test-table-wrap">
            <table className="log-test-table">
              <thead>
                <tr>
                  <th>#</th>
                  <th>IST time</th>
                  <th className="text-right">Nifty spot</th>
                  <th className="text-right">Ticks / sec</th>
                  <th>Last tick at</th>
                  <th>Note</th>
                </tr>
              </thead>
              <tbody>
                {(status?.samples ?? []).length === 0 ? (
                  <tr>
                    <td colSpan={6} className="text-muted log-test-empty">
                      Press Start to log Nifty spot at every IST second.
                    </td>
                  </tr>
                ) : (
                  status?.samples.map((row) => (
                    <tr key={`${row.seq}-${row.epochMs}`} className={row.stale ? "log-test-stale" : undefined}>
                      <td>{row.seq}</td>
                      <td>
                        {row.dateIST} {row.timeIST}
                      </td>
                      <td className="text-right">
                        {row.niftySpot != null ? formatNumber(row.niftySpot, 2) : "—"}
                      </td>
                      <td className="text-right">{row.ticksInSecond}</td>
                      <td>{row.lastTickAtIST ?? "—"}</td>
                      <td>{row.stale ? "no new tick" : ""}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </DashboardShell>
  );
}
