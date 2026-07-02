import { useEffect, useState } from "react";
import { DashboardShell } from "@/components/layout/dashboard-shell";
import { useKite } from "@/contexts/kite-context";
import { POPULAR_UNDERLYINGS, type OptionChainRow } from "@/types/kite";
import { cn, formatNumber, getChangeClass } from "@/lib/utils";

export default function OptionsPage() {
  const { connected, loginUrl } = useKite();
  const [symbol, setSymbol] = useState("NIFTY");
  const [exchange, setExchange] = useState("NFO");
  const [chain, setChain] = useState<OptionChainRow[]>([]);
  const [expiry, setExpiry] = useState("");
  const [spotPrice, setSpotPrice] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const loadChain = async (sym: string, exch: string) => {
    if (!connected) return;
    setLoading(true);
    setError("");
    try {
      const res = await fetch(`/api/kite/option-chain?symbol=${sym}&exchange=${exch}`, { credentials: "include" });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Failed to load chain");
      setChain(json.data.chain);
      setExpiry(json.data.expiry);
      setSpotPrice(json.data.spotPrice);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load");
      setChain([]);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadChain(symbol, exchange);
    if (!connected) return;
    const interval = setInterval(() => loadChain(symbol, exchange), 20000);
    return () => clearInterval(interval);
  }, [symbol, exchange, connected]);

  return (
    <DashboardShell>
      <div className="flex-between flex-wrap gap-4 mb-6">
        <div className="page-header" style={{ marginBottom: 0 }}>
          <h1>Options Chain</h1>
          <p>Live CE/PE data from Zerodha Kite</p>
        </div>
        {connected && spotPrice > 0 && <span className="badge badge-default">Spot: {formatNumber(spotPrice)}</span>}
      </div>

      {!connected ? (
        <div className="card">
          <p className="text-muted">Connect your Zerodha account to view live options chains.</p>
          {loginUrl && <a href={loginUrl} className="mt-4" style={{ display: "inline-block" }}><button className="btn btn-primary">Connect Kite</button></a>}
        </div>
      ) : (
        <>
          <div className="flex flex-wrap gap-2 mb-4">
            {POPULAR_UNDERLYINGS.map((item) => (
              <button
                key={item.symbol}
                className={`btn btn-sm ${symbol === item.symbol ? "btn-primary" : "btn-outline"}`}
                onClick={() => { setSymbol(item.symbol); setExchange(item.exchange); }}
              >
                {item.label}
              </button>
            ))}
          </div>

          {expiry && <p className="text-muted mb-4" style={{ fontSize: "0.875rem" }}>Nearest expiry: <strong style={{ color: "var(--text)" }}>{expiry}</strong></p>}
          {error && <div className="alert alert-error">{error}</div>}

          <div className="card card-flush">
            {loading && chain.length === 0 ? (
              <div className="spinner-center" style={{ minHeight: "16rem" }}><div className="spinner" /></div>
            ) : (
              <div className="table-wrap">
                <table style={{ minWidth: "900px" }}>
                  <thead>
                    <tr>
                      <th colSpan={4} className="text-center text-up">CALLS (CE)</th>
                      <th className="text-center">STRIKE</th>
                      <th colSpan={4} className="text-center text-down">PUTS (PE)</th>
                    </tr>
                    <tr style={{ fontSize: "0.75rem" }}>
                      <th className="text-right">OI</th>
                      <th className="text-right">Vol</th>
                      <th className="text-right">Chg%</th>
                      <th className="text-right">LTP</th>
                      <th></th>
                      <th className="text-right">LTP</th>
                      <th className="text-right">Chg%</th>
                      <th className="text-right">Vol</th>
                      <th className="text-right">OI</th>
                    </tr>
                  </thead>
                  <tbody>
                    {chain.map((row) => {
                      const step = chain.length > 1 ? Math.abs(chain[1].strike - chain[0].strike) : 50;
                      const isAtm = spotPrice > 0 && Math.abs(row.strike - spotPrice) < step;
                      return (
                        <tr key={row.strike} className={isAtm ? "row-atm" : ""}>
                          <td className="text-right text-muted">{row.ce?.quote?.oi?.toLocaleString("en-IN") ?? "—"}</td>
                          <td className="text-right text-muted">{row.ce?.quote?.volume?.toLocaleString("en-IN") ?? "—"}</td>
                          <td className={cn("text-right", getChangeClass(row.ce?.quote?.change_percent ?? 0))}>
                            {row.ce?.quote ? `${row.ce.quote.change_percent >= 0 ? "+" : ""}${row.ce.quote.change_percent.toFixed(2)}%` : "—"}
                          </td>
                          <td className="text-right font-medium text-up">{row.ce?.quote ? formatNumber(row.ce.quote.last_price) : "—"}</td>
                          <td className="text-center font-semibold">{formatNumber(row.strike, 0)}</td>
                          <td className="text-right font-medium text-down">{row.pe?.quote ? formatNumber(row.pe.quote.last_price) : "—"}</td>
                          <td className={cn("text-right", getChangeClass(row.pe?.quote?.change_percent ?? 0))}>
                            {row.pe?.quote ? `${row.pe.quote.change_percent >= 0 ? "+" : ""}${row.pe.quote.change_percent.toFixed(2)}%` : "—"}
                          </td>
                          <td className="text-right text-muted">{row.pe?.quote?.volume?.toLocaleString("en-IN") ?? "—"}</td>
                          <td className="text-right text-muted">{row.pe?.quote?.oi?.toLocaleString("en-IN") ?? "—"}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </>
      )}
    </DashboardShell>
  );
}
