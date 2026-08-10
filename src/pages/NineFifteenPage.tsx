import { AlertTriangle, Clock } from "lucide-react";
import { DashboardShell } from "@/components/layout/dashboard-shell";
import { ServerNineSixteenBotPanel } from "@/components/trade/ServerNineSixteenBotPanel";
import { useKite } from "@/contexts/kite-context";
import "@/styles/nine-fifteen-page.css";

export default function NineFifteenPage() {
  const { connected, loginUrl } = useKite();

  return (
    <DashboardShell>
      <div className="nine-fifteen-page">
        <header className="page-header nf-header">
          <div>
            <h1 className="page-title">
              <Clock size={22} />
              9:15 Candle
            </h1>
            <p className="page-subtitle">
              Live server bot — entry at 9:16 IST from the 9:15 bar · backtests live under Backtesting
            </p>
          </div>
        </header>

        <div className="card nf-live-rules">
          <h2 className="nf-live-rules-title">Live server bot — entry &amp; exit (today&apos;s trades)</h2>
          <div className="nf-live-rules-grid">
            <div className="nf-live-rules-col">
              <h3 className="nf-live-rules-heading text-up">Entry (live)</h3>
              <ol className="nf-live-rules-list">
                <li>
                  <strong>1. Capture 9:15 open/close from Kite websocket</strong>
                  <ul className="nf-live-rules-sublist">
                    <li>
                      Connect at <strong>9:00:00</strong> and keep the websocket until{" "}
                      <strong>16:00:00</strong> (Nifty 50 ticks)
                    </li>
                    <li>
                      <strong>9:15:00 open</strong> = first tick received between <strong>9:15:00–9:15:15</strong>
                    </li>
                    <li>
                      <strong>9:15:59 close</strong> = last tick received <strong>before 9:16:00</strong>
                    </li>
                    <li>
                      Δ = <strong>close − open</strong>
                    </li>
                  </ul>
                </li>
                <li>
                  <strong>2. Decide side + exit band (or skip)</strong>
                  <ul className="nf-live-rules-sublist">
                    <li>Flat (close = open) → <strong>no trade</strong></li>
                    <li>
                      |Δ| &lt; 11 → <strong>no trade</strong>
                    </li>
                    <li>
                      Green, Δ ≥ +15 → <strong>CE BUY</strong> · main exits (±25 → ±20@10:01 → ±15@11:01)
                    </li>
                    <li>
                      Red, Δ ≤ −15 → <strong>PE BUY</strong> · main exits
                    </li>
                    <li>
                      11 ≤ |Δ| &lt; 15 → same CE/PE · <strong>near-miss</strong> exits (±20 → ±10@10:01)
                    </li>
                  </ul>
                </li>
                <li>
                  <strong>3. Place order</strong>
                  <ul className="nf-live-rules-sublist">
                    <li>
                      Time: <strong>immediately at 9:16:00</strong> (window until <strong>9:16:30</strong>; miss → no
                      entry)
                    </li>
                    <li>
                      Strike: <strong>ATM</strong> Nifty weekly (nearest expiry)
                    </li>
                    <li>
                      Product: <strong>MIS</strong> market
                    </li>
                    <li>Size: max lots balance allows</li>
                    <li>
                      Needs: bot on, Kite logged in before 9:15, whitelisted IP
                    </li>
                  </ul>
                </li>
              </ol>
            </div>
            <div className="nf-live-rules-col">
              <h3 className="nf-live-rules-heading">Exit (live) — whichever fires first</h3>
              <p className="nf-live-rules-lead text-muted">
                On every Kite websocket tick (REST fallback if WS drops): exit if <strong>either</strong> the index
                rule <strong>or</strong> the option P&amp;L % rule is met — not both required. Then EOD force
                square-off.
              </p>
              <ol className="nf-live-rules-list">
                <li>
                  <strong>1. Index target from Nifty spot at 9:16:00 fill</strong>
                  <ul className="nf-live-rules-sublist">
                    <li>
                      Anchor = <strong>Nifty 50 spot</strong> when the option fills — not 9:15 open, not option
                      premium
                    </li>
                    <li>
                      <strong>Main</strong> (|Δ| ≥ 15): until <strong>10:01</strong> ±25 · from 10:01 ±20 · from
                      11:01 ±15
                    </li>
                    <li>
                      <strong>Near-miss</strong> (11 ≤ |Δ| &lt; 15): until <strong>10:01</strong> ±20 · from 10:01
                      ±10
                    </li>
                  </ul>
                </li>
                <li>
                  <strong>2. Option P&amp;L %</strong> (independent of index — either exits the trade)
                  <ul className="nf-live-rules-sublist">
                    <li>
                      <strong>10:01–11:00 IST:</strong> unrealised ≥ <strong>+5%</strong> of (entry premium × qty)
                    </li>
                    <li>
                      <strong>From 11:01 IST:</strong> unrealised ≥ <strong>+3%</strong> of (entry premium × qty)
                    </li>
                    <li>No P&amp;L % exit before 10:01</li>
                  </ul>
                </li>
                <li>
                  <strong>3. End of day</strong>
                  <ul className="nf-live-rules-sublist">
                    <li>
                      <strong>3:25 PM IST</strong> → force square-off if still open
                    </li>
                  </ul>
                </li>
              </ol>
              <p className="nf-live-rules-foot text-muted">
                Example after 10:01: Nifty +20 from fill exits even if option P&amp;L is under +5%; or +5% P&amp;L
                exits even if Nifty has not reached ±20. Same OR logic from 11:01 with ±15 / +3%.
              </p>
            </div>
          </div>
        </div>

        {!connected && (
          <div className="card nf-banner">
            <AlertTriangle size={18} />
            <div>
              <p className="font-medium">Connect Zerodha Kite to run the live server bot</p>
              {loginUrl && (
                <a href={loginUrl} className="btn btn-primary btn-sm" style={{ marginTop: "0.5rem" }}>
                  Connect Kite
                </a>
              )}
            </div>
          </div>
        )}

        {connected && <ServerNineSixteenBotPanel connected={connected} />}
      </div>
    </DashboardShell>
  );
}
