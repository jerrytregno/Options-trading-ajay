import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, RefreshCw, TrendingDown } from "lucide-react";
import { DashboardShell } from "@/components/layout/dashboard-shell";
import { BacktestSection } from "@/components/nine-fifteen/HighMinus5BacktestSection";
import { FullDayBacktestSection } from "@/components/nine-fifteen/FullDayBacktestSection";
import { SmallGreenPre10RallySection } from "@/components/nine-fifteen/SmallGreenPre10RallySection";
import { SmallRedPre10SelloffSection } from "@/components/nine-fifteen/SmallRedPre10SelloffSection";
import { useKite } from "@/contexts/kite-context";
import { NSE_SESSIONS_ONE_YEAR } from "@/types/nine-fifteen";
import type { NineFifteenHighMinus5BacktestResult } from "@/types/nine-fifteen-high-minus5-backtest";
import { cn } from "@/lib/utils";
import "@/styles/nine-fifteen-backtest-page.css";

const BACKTEST_WINDOWS = [
  { id: "1y", label: "1 year", sessions: NSE_SESSIONS_ONE_YEAR, historyLabel: "last 1 year" },
  { id: "2y", label: "2 years", sessions: NSE_SESSIONS_ONE_YEAR * 2, historyLabel: "last 2 years" },
] as const;

type BacktestWindowId = (typeof BACKTEST_WINDOWS)[number]["id"];

export default function NineFifteenBacktestPage() {
  const { connected } = useKite();
  const [data, setData] = useState<NineFifteenHighMinus5BacktestResult | null>(null);
  const [windowId, setWindowId] = useState<BacktestWindowId>("1y");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const activeWindow = BACKTEST_WINDOWS.find((w) => w.id === windowId) ?? BACKTEST_WINDOWS[0];

  const load = useCallback(async (win: (typeof BACKTEST_WINDOWS)[number], refresh = false) => {
    setLoading(true);
    setError(null);
    try {
      const qs = new URLSearchParams({ days: String(win.sessions) });
      if (refresh) qs.set("refresh", "1");
      const res = await fetch(`/api/kite/nine-fifteen-high-minus5-backtest?${qs}`, {
        credentials: "include",
      });
      const json = (await res.json()) as { data?: NineFifteenHighMinus5BacktestResult; error?: string };
      if (!res.ok) throw new Error(json.error ?? "Backtest request failed");
      if (!json.data) throw new Error("Empty backtest response");
      if (json.data.daysRequested < win.sessions) {
        throw new Error(
          `Only ${json.data.daysRequested} sessions loaded (need ${win.sessions}) — hit Run backtest to rebuild ${win.label}`,
        );
      }
      setData(json.data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load backtest");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!connected) return;
    const win = BACKTEST_WINDOWS.find((w) => w.id === windowId) ?? BACKTEST_WINDOWS[0];
    setData(null);
    void load(win, false);
  }, [connected, windowId, load]);

  const rangeLabel = data ? `${data.from} → ${data.to}` : "";

  return (
    <DashboardShell>
      <div className="nf915bt-page">
        <header className="nf915bt-header">
          <div className="nf915bt-header-copy">
            <h1 className="nf915bt-title">9:15 backtesting</h1>
            <p className="nf915bt-subtitle">
              Nifty index-point studies on Zerodha 1-minute candles · {activeWindow.label}
              {data ? ` · ${rangeLabel} · ${data.daysRequested} sessions` : ""}. Expand each accordion
              for rules, stats, and the full session log. Win = TP during the 9:15 minute; late win = TP
              later in the session; loss = entered but TP never hit.
            </p>
          </div>

          <div className="nf915bt-toolbar">
            <div className="nf915bt-window-filter" role="group" aria-label="Backtest date range">
              <span className="nf915bt-filter-label text-muted">Date range</span>
              {BACKTEST_WINDOWS.map((win) => (
                <button
                  key={win.id}
                  type="button"
                  className={cn("btn btn-sm", windowId === win.id ? "btn-primary" : "btn-secondary")}
                  disabled={!connected || loading}
                  onClick={() => setWindowId(win.id)}
                >
                  {win.label}
                </button>
              ))}
            </div>
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              onClick={() => void load(activeWindow, true)}
              disabled={loading || !connected}
            >
              <RefreshCw size={14} className={loading ? "spin" : undefined} />
              {loading ? "Running…" : "Run backtest"}
            </button>
          </div>
        </header>

        {!connected && (
          <div className="card nf915bt-error">
            <AlertTriangle size={16} />
            <p>Connect Zerodha to pull Nifty 1-minute history from Kite.</p>
          </div>
        )}

        {error && (
          <div className="card nf915bt-error">
            <AlertTriangle size={16} />
            <p>{error}</p>
          </div>
        )}

        {loading && !data && (
          <div className="card nf915bt-loading">
            <div className="spinner" />
            <p>
              Pulling {activeWindow.label} of Nifty session minutes
              {activeWindow.sessions >= NSE_SESSIONS_ONE_YEAR ? " (first load can take a few minutes)…" : "…"}
            </p>
          </div>
        )}

        {data && (
          <div className="nf915bt-accordions">
            <BacktestSection
              slice={data.all}
              builtAt={data.builtAt}
              rangeLabel={rangeLabel}
              defaultOpen
            />

            <BacktestSection
              slice={data.red915Only}
              builtAt={data.builtAt}
              rangeLabel={rangeLabel}
              subtitle="Same open − 5 entry and entry − 10 TP, but only on days where the 9:15 candle closed red (below its open). Green and flat opening minutes are not traded."
            />

            <BacktestSection
              slice={data.green915Only}
              builtAt={data.builtAt}
              rangeLabel={rangeLabel}
              subtitle="Mirror of the red study: open + 5 entry and entry + 10 TP, but only on days where the 9:15 candle closed green (above its open). Red and flat opening minutes are not traded."
            />

            {data.smallGreenPre10Rally ? (
              <SmallGreenPre10RallySection
                slice={data.smallGreenPre10Rally}
                builtAt={data.builtAt}
                rangeLabel={rangeLabel}
              />
            ) : (
              <div className="card nf915bt-error">
                <AlertTriangle size={16} />
                <p>
                  Small-green pre-10 rally study is not in the cached backtest — hit <strong>Run backtest</strong>{" "}
                  to rebuild {activeWindow.label} data.
                </p>
              </div>
            )}

            {data.smallRedPre10Selloff ? (
              <SmallRedPre10SelloffSection
                slice={data.smallRedPre10Selloff}
                builtAt={data.builtAt}
                rangeLabel={rangeLabel}
              />
            ) : (
              <div className="card nf915bt-error">
                <AlertTriangle size={16} />
                <p>
                  Small-red pre-10 selloff study is not in the cached backtest — hit <strong>Run backtest</strong>{" "}
                  to rebuild {activeWindow.label} data.
                </p>
              </div>
            )}

            <BacktestSection
              slice={data.openAtOpen}
              builtAt={data.builtAt}
              rangeLabel={rangeLabel}
              subtitle="Every session enters at the 9:15 open. Take profit when Nifty touches open − 10 pts."
            />

            <header className="nf915bt-section-header">
              <h2 className="nf915bt-section-title">Full day backtesting</h2>
              <p className="nf915bt-section-lead">
                Same open ± 5 entry and entry ± 5 take-profit on every qualifying 1-minute candle from{" "}
                <strong>9:20</strong> through <strong>15:00</strong> IST — each minute is its own signal
                (independent of the 9:15 studies, which still use entry ± 10).
              </p>
            </header>

            {data.fullDay && (
              <>
                <FullDayBacktestSection
                  slice={data.fullDay.redOpenMinus5}
                  builtAt={data.builtAt}
                  rangeLabel={rangeLabel}
                  defaultOpen
                  subtitle="Mirror of Open − 5 · red 9:15 only — red body on any minute 9:20–15:00."
                />
                <FullDayBacktestSection
                  slice={data.fullDay.greenOpenPlus5}
                  builtAt={data.builtAt}
                  rangeLabel={rangeLabel}
                  subtitle="Mirror of Open + 5 · green 9:15 only — green body on any minute 9:20–15:00."
                />
              </>
            )}

            <details className="nf915bt-accordion">
              <summary className="nf915bt-accordion-summary">
                <span className="nf915bt-accordion-title">How outcomes are scored</span>
              </summary>
              <div className="nf915bt-accordion-body">
                <section className="card nf915bt-notes">
                  <h2>
                    <TrendingDown size={16} /> Scoring notes
                  </h2>
                  <p>
                    These backtests use Nifty index points on Zerodha 1-minute candles — not option
                    premium P&amp;L. The 9:15 open is the opening minute&apos;s first print; entry and
                    TP are checked on every session bar from 9:15 through 15:30.
                  </p>
                </section>
              </div>
            </details>
          </div>
        )}
      </div>
    </DashboardShell>
  );
}
