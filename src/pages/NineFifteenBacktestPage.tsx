import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, RefreshCw, TrendingDown } from "lucide-react";
import { DashboardShell } from "@/components/layout/dashboard-shell";
import { BacktestSection } from "@/components/nine-fifteen/HighMinus5BacktestSection";
import { useKite } from "@/contexts/kite-context";
import type { NineFifteenHighMinus5BacktestResult } from "@/types/nine-fifteen-high-minus5-backtest";
import "@/styles/nine-fifteen-backtest-page.css";

const DEFAULT_DAYS = 365;

export default function NineFifteenBacktestPage() {
  const { connected } = useKite();
  const [data, setData] = useState<NineFifteenHighMinus5BacktestResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (refresh = false) => {
    setLoading(true);
    setError(null);
    try {
      const qs = new URLSearchParams({ days: String(DEFAULT_DAYS) });
      if (refresh) qs.set("refresh", "1");
      const res = await fetch(`/api/kite/nine-fifteen-high-minus5-backtest?${qs}`);
      const json = (await res.json()) as { data?: NineFifteenHighMinus5BacktestResult; error?: string };
      if (!res.ok) throw new Error(json.error ?? "Backtest request failed");
      if (!json.data) throw new Error("Empty backtest response");
      setData(json.data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load backtest");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (connected) void load(false);
  }, [connected, load]);

  const rangeLabel = data ? `${data.from} → ${data.to}` : "";

  return (
    <DashboardShell>
      <div className="nf915bt-page">
        <header className="nf915bt-header">
          <div>
            <h1 className="nf915bt-title">9:15 backtesting</h1>
            <p className="nf915bt-subtitle">
              Nifty index-point studies on Zerodha 1-minute candles. Expand each accordion for rules,
              stats, and the full session log. Win = TP during the 9:15 minute; late win = TP later
              in the session; loss = entered but TP never hit.
            </p>
          </div>
          <button className="btn btn-primary btn-sm" onClick={() => void load(true)} disabled={loading || !connected}>
            <RefreshCw size={14} className={loading ? "spin" : undefined} />
            {loading ? "Running…" : "Run backtest"}
          </button>
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
            <p>Pulling ~1 year of Nifty session minutes…</p>
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
              slice={data.openAtOpen}
              builtAt={data.builtAt}
              rangeLabel={rangeLabel}
              subtitle="Every session enters at the 9:15 open. Take profit when Nifty touches open − 10 pts."
            />

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
