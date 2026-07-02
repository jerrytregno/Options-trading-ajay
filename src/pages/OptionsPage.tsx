import { useCallback, useEffect, useRef, useState } from "react";
import { DashboardShell } from "@/components/layout/dashboard-shell";
import { useKite } from "@/contexts/kite-context";
import { POPULAR_UNDERLYINGS, type OptionChainRow, type OptionChainResponse, type OptionGreeks } from "@/types/kite";
import { cn, formatNumber } from "@/lib/utils";

const REFRESH_MS = 2000;

function formatGreek(value: number | undefined, digits = 2) {
  if (value === undefined || Number.isNaN(value)) return "—";
  return value.toFixed(digits);
}

function GreeksCell({ greeks }: { greeks?: OptionGreeks }) {
  if (!greeks) return <span className="text-muted">—</span>;
  return (
    <span className="mono" title={`IV ${formatGreek(greeks.iv)}%`}>
      {formatGreek(greeks.delta, 2)}
    </span>
  );
}

export default function OptionsPage() {
  const { connected, loginUrl } = useKite();
  const [symbol, setSymbol] = useState("NIFTY");
  const [exchange, setExchange] = useState("NFO");
  const [chain, setChain] = useState<OptionChainRow[]>([]);
  const [expiry, setExpiry] = useState("");
  const [spotPrice, setSpotPrice] = useState(0);
  const [atmStrike, setAtmStrike] = useState(0);
  const [updatedAt, setUpdatedAt] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState("");
  const atmRowRef = useRef<HTMLTableRowElement | null>(null);
  const shouldScrollRef = useRef(true);

  const loadChain = useCallback(async (sym: string, exch: string, currentExpiry?: string, initial = false) => {
    if (!connected) return;

    if (initial) setLoading(true);
    else setRefreshing(true);

    try {
      const params = new URLSearchParams({ symbol: sym, exchange: exch });
      if (currentExpiry) params.set("expiry", currentExpiry);

      const res = await fetch(`/api/kite/option-chain?${params.toString()}`, { credentials: "include" });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Failed to load chain");

      const data = json.data as OptionChainResponse;
      setChain(data.chain);
      setExpiry(data.expiry);
      setSpotPrice(data.spotPrice);
      setAtmStrike(data.atmStrike);
      setUpdatedAt(data.updatedAt);
      setError("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load");
      if (initial) setChain([]);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [connected]);

  useEffect(() => {
    if (!connected) return;
    shouldScrollRef.current = true;
    loadChain(symbol, exchange, undefined, true);
  }, [symbol, exchange, connected, loadChain]);

  useEffect(() => {
    if (!connected || !expiry) return;

    const interval = window.setInterval(() => {
      loadChain(symbol, exchange, expiry, false);
    }, REFRESH_MS);

    return () => window.clearInterval(interval);
  }, [connected, symbol, exchange, expiry, loadChain]);

  useEffect(() => {
    if (!shouldScrollRef.current || !atmRowRef.current) return;
    atmRowRef.current.scrollIntoView({ block: "center", behavior: "smooth" });
    shouldScrollRef.current = false;
  }, [chain, atmStrike]);

  return (
    <DashboardShell>
      <div className="flex-between flex-wrap gap-4 mb-6">
        <div className="page-header" style={{ marginBottom: 0 }}>
          <h1>Options Chain</h1>
          <p>Live CE/PE data from Zerodha Kite · refreshes every {REFRESH_MS / 1000}s</p>
        </div>
        <div className="flex gap-2 flex-wrap">
          {connected && spotPrice > 0 && (
            <span className="badge badge-default">Spot: {formatNumber(spotPrice)}</span>
          )}
          {connected && atmStrike > 0 && (
            <span className="badge badge-warning">ATM: {formatNumber(atmStrike, 0)}</span>
          )}
          {connected && (
            <span className={`badge ${refreshing ? "badge-warning" : "badge-success"}`}>
              {refreshing ? "Updating..." : "Live"}
            </span>
          )}
          {updatedAt && (
            <span className="text-muted" style={{ fontSize: "0.75rem", alignSelf: "center" }}>
              {new Date(updatedAt).toLocaleTimeString("en-IN")}
            </span>
          )}
        </div>
      </div>

      {!connected ? (
        <div className="card">
          <p className="text-muted">Connect your Zerodha account to view live options chains.</p>
          {loginUrl && (
            <a href={loginUrl} className="mt-4" style={{ display: "inline-block" }}>
              <button className="btn btn-primary">Connect Kite</button>
            </a>
          )}
        </div>
      ) : (
        <>
          <div className="flex flex-wrap gap-2 mb-4">
            {POPULAR_UNDERLYINGS.map((item) => (
              <button
                key={item.symbol}
                className={`btn btn-sm ${symbol === item.symbol ? "btn-primary" : "btn-outline"}`}
                onClick={() => {
                  shouldScrollRef.current = true;
                  setSymbol(item.symbol);
                  setExchange(item.exchange);
                }}
              >
                {item.label}
              </button>
            ))}
          </div>

          {expiry && (
            <p className="text-muted mb-4" style={{ fontSize: "0.875rem" }}>
              Nearest expiry: <strong style={{ color: "var(--text)" }}>{expiry}</strong>
              {" · "}Showing strikes around ATM
            </p>
          )}
          {error && <div className="alert alert-error">{error}</div>}

          <div className="card card-flush">
            {loading && chain.length === 0 ? (
              <div className="spinner-center" style={{ minHeight: "16rem" }}>
                <div className="spinner" />
              </div>
            ) : (
              <div className="table-wrap options-table-wrap">
                <table className="options-table">
                  <thead>
                    <tr>
                      <th colSpan={8} className="text-center text-up">CALLS (CE)</th>
                      <th className="text-center strike-col">STRIKE</th>
                      <th colSpan={8} className="text-center text-down">PUTS (PE)</th>
                    </tr>
                    <tr className="options-subhead">
                      <th className="text-right">OI</th>
                      <th className="text-right">Vol</th>
                      <th className="text-right">IV</th>
                      <th className="text-right">LTP</th>
                      <th className="text-right">Delta</th>
                      <th className="text-right">Gamma</th>
                      <th className="text-right">Theta</th>
                      <th className="text-right">Vega</th>
                      <th></th>
                      <th className="text-right">Vega</th>
                      <th className="text-right">Theta</th>
                      <th className="text-right">Gamma</th>
                      <th className="text-right">Delta</th>
                      <th className="text-right">LTP</th>
                      <th className="text-right">IV</th>
                      <th className="text-right">Vol</th>
                      <th className="text-right">OI</th>
                    </tr>
                  </thead>
                  <tbody>
                    {chain.map((row) => {
                      const isAtm = row.isAtm || row.strike === atmStrike;
                      return (
                        <tr
                          key={row.strike}
                          ref={isAtm ? atmRowRef : undefined}
                          className={cn(isAtm && "row-atm")}
                        >
                          <td className="text-right text-muted">{row.ce?.quote?.oi?.toLocaleString("en-IN") ?? "—"}</td>
                          <td className="text-right text-muted">{row.ce?.quote?.volume?.toLocaleString("en-IN") ?? "—"}</td>
                          <td className="text-right text-muted">{formatGreek(row.ce?.quote?.greeks?.iv)}</td>
                          <td className="text-right font-medium text-up">
                            {row.ce?.quote ? formatNumber(row.ce.quote.last_price) : "—"}
                          </td>
                          <td className="text-right"><GreeksCell greeks={row.ce?.quote?.greeks} /></td>
                          <td className="text-right text-muted">{formatGreek(row.ce?.quote?.greeks?.gamma, 4)}</td>
                          <td className="text-right text-muted">{formatGreek(row.ce?.quote?.greeks?.theta)}</td>
                          <td className="text-right text-muted">{formatGreek(row.ce?.quote?.greeks?.vega)}</td>

                          <td className={cn("text-center font-semibold strike-col", isAtm && "strike-atm")}>
                            {formatNumber(row.strike, 0)}
                            {isAtm && <span className="atm-tag">ATM</span>}
                          </td>

                          <td className="text-right text-muted">{formatGreek(row.pe?.quote?.greeks?.vega)}</td>
                          <td className="text-right text-muted">{formatGreek(row.pe?.quote?.greeks?.theta)}</td>
                          <td className="text-right text-muted">{formatGreek(row.pe?.quote?.greeks?.gamma, 4)}</td>
                          <td className="text-right"><GreeksCell greeks={row.pe?.quote?.greeks} /></td>
                          <td className="text-right font-medium text-down">
                            {row.pe?.quote ? formatNumber(row.pe.quote.last_price) : "—"}
                          </td>
                          <td className="text-right text-muted">{formatGreek(row.pe?.quote?.greeks?.iv)}</td>
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
