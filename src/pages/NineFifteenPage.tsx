import { AlertTriangle, Clock } from "lucide-react";
import { DashboardShell } from "@/components/layout/dashboard-shell";
import { ServerNineSixteenBotPanel } from "@/components/trade/ServerNineSixteenBotPanel";
import { ServerMomentumScalperBotPanel } from "@/components/trade/ServerMomentumScalperBotPanel";
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
              Morning legs at 9:15 and 9:16 IST · Traps scans 10:30–12:00 & 13:45–15:10 · enable each bot separately on the panels
              below
            </p>
          </div>
        </header>

        <div className="card nf-live-rules">
          <h2 className="nf-live-rules-title">Live strategies — entry &amp; exit rules</h2>
          <p className="nf-live-rules-lead text-muted">
            Two independent morning trades on the same server bot, plus Traps later in the session. Each has its
            own enable switch. Historical 9:15-bar studies still live under <strong>Backtesting</strong>.
          </p>

          <div className="nf-live-rules-grid">
            {/* —— 9:15 trade —— */}
            <div className="nf-live-rules-col">
              <h3 className="nf-live-rules-heading text-down">9:15 trade · PE at 9:15:11</h3>
              <p className="nf-live-rules-lead text-muted">
                Short-only burst on the opening minute. Option P&amp;L exits only — no index target and no 30-pt
                hard stop.
              </p>
              <h4 className="nf-live-rules-subheading">Entry</h4>
              <ol className="nf-live-rules-list">
                <li>
                  <strong>Capture the 9:15 open</strong> — first Nifty websocket tick from{" "}
                  <strong>9:15:00</strong>.
                </li>
                <li>
                  <strong>Read direction at 9:15:10</strong> — last tick strictly before 10 seconds vs that open.
                  <ul className="nf-live-rules-sublist">
                    <li>
                      <strong>Red</strong> (any drop) → arm <strong>ATM PE</strong> market buy at{" "}
                      <strong>9:15:11.000</strong>
                    </li>
                    <li>
                      <strong>Green or flat</strong> → no 9:15 trade
                    </li>
                  </ul>
                </li>
                <li>
                  <strong>Order window</strong> — retries until <strong>9:15:20</strong>; miss → no 9:15 leg
                  today.
                </li>
                <li>
                  ATM PE is pre-resolved at <strong>9:15:05</strong> so :11 is placement only.
                </li>
              </ol>
              <h4 className="nf-live-rules-subheading">Exit (option P&amp;L % only)</h4>
              <ol className="nf-live-rules-list">
                <li>
                  <strong>No stop before +3%</strong> — a losing trade relies on the trailing ladder or{" "}
                  <strong>3:25 PM</strong> square-off.
                </li>
                <li>
                  <strong>Trailing from +3%</strong> — each rung locks the stop and steps the target by{" "}
                  <strong>+2%</strong>:
                  <ul className="nf-live-rules-sublist">
                    <li>
                      <strong>+3%</strong> → stop locks <strong>+3%</strong> · next target <strong>+5%</strong>
                    </li>
                    <li>
                      <strong>+5%</strong> → stop locks <strong>+5%</strong> · next target <strong>+7%</strong>
                    </li>
                    <li>
                      Then <strong>+7%→+9%</strong>, <strong>+9%→+11%</strong>, … with no ceiling
                    </li>
                  </ul>
                </li>
                <li>
                  <strong>Exit:</strong> stop hit → immediate <strong>market</strong> sell. Reaching a target
                  never exits — only slipping back to the locked rung does.
                </li>
              </ol>
              <p className="nf-live-rules-foot text-muted">
                If the 9:15 leg is flat before <strong>9:15:59</strong>, the 9:16 leg may still run. If it is
                still open at <strong>9:16:00</strong>, the 9:16 trade is skipped for the day.
              </p>
            </div>

            {/* —— 9:16 trade —— */}
            <div className="nf-live-rules-col">
              <h3 className="nf-live-rules-heading text-down">9:16 trade · PE on a red 9:15 bar</h3>
              <p className="nf-live-rules-lead text-muted">
                Uses the <strong>sealed 9:15 candle</strong> (open from the first tick 9:15:00–15, close from the
                last tick before 9:16:00). <strong>PE only</strong> — a green 9:15 close is skipped, not bought
                as a CE.
              </p>
              <h4 className="nf-live-rules-subheading">Entry</h4>
              <ol className="nf-live-rules-list">
                <li>
                  <strong>Δ = 9:15 close − open</strong>
                  <ul className="nf-live-rules-sublist">
                    <li>Flat → no trade</li>
                    <li>
                      Green (+Δ) → <strong>no trade</strong> (no long side on this leg)
                    </li>
                    <li>
                      |Δ| &lt; <strong>11</strong> → no trade
                    </li>
                    <li>
                      Red, <strong>11 ≤ |Δ| &lt; 15</strong> → <strong>PE</strong> (near-miss entry band)
                    </li>
                    <li>
                      Red, <strong>|Δ| ≥ 15</strong> → <strong>PE</strong> (main entry band)
                    </li>
                  </ul>
                </li>
                <li>
                  <strong>Order at 9:16:00.000</strong> (dedicated timer, not the poll loop) · window until{" "}
                  <strong>9:16:30</strong>.
                </li>
                <li>
                  <strong>Blocked</strong> when the 9:15 leg is still open at 9:16:00, or when 9:15 closed
                  green.
                </li>
                <li>ATM weekly PE · <strong>MIS market</strong> · max <strong>25 lots</strong> per order (split in parallel if larger).</li>
              </ol>
              <h4 className="nf-live-rules-subheading">Exit (option P&amp;L % only)</h4>
              <ol className="nf-live-rules-list">
                <li>
                  <strong>Trailing option P&amp;L</strong> — nothing locked until <strong>+5%</strong>, then each{" "}
                  <strong>+5%</strong> rung locks the stop and raises the next target. Slipping{" "}
                  <strong>below</strong> the locked rung exits at market.
                </li>
                <li>
                  <strong>3:25 PM</strong> force square-off if still open.
                </li>
              </ol>
            </div>
          </div>
        </div>

        <div className="card nf-live-rules nf-live-rules--traps">
          <h2 className="nf-live-rules-title">Traps bot (10:30–12:00 & 13:45–15:10 IST)</h2>
          <p className="nf-live-rules-lead text-muted">
            Separate strategy on the panel below — not tied to the 9:15 candle. Scans every completed 1-minute
            Nifty bar in two weekday windows until the afternoon entry cutoff. A trade still open when a window
            ends is not cut — it runs to its own exit.
          </p>
          <div className="nf-live-rules-grid nf-live-rules-grid--single">
            <div className="nf-live-rules-col">
              <ol className="nf-live-rules-list">
                <li>
                  <strong>Signal candle:</strong> high − low &gt; <strong>2 pts</strong>; green body → CE idea,
                  red → PE.
                </li>
                <li>
                  <strong>10-second gate on the next minute:</strong> websocket ticks for the first{" "}
                  <strong>10 seconds</strong>. CE needs Nifty ≥ signal close <strong>+0.2</strong>; PE needs ≤
                  close <strong>−0.2</strong>. The open alone is not enough.
                </li>
                <li>
                  <strong>Entry at :11</strong> — if the gate was seen <strong>and</strong> Wilder RSI(14)
                  on Nifty 1-min closes is in <strong>0–10</strong>, <strong>40–50</strong>, or{" "}
                  <strong>70–100</strong> (updated every websocket tick), <strong>MIS market buy</strong> on
                  the ATM leg at second <strong>:11</strong>. Otherwise the setup is dropped.
                </li>
                <li>
                  <strong>Exit ladder:</strong> initial stop <strong>−4%</strong> P&amp;L (instant, no hold) ·
                  rungs at <strong>+0.5%</strong>, <strong>+0.7%</strong>, <strong>+1%</strong>, then{" "}
                  <strong>+0.5%</strong> steps.
                  Profit exits fire on the way back down to a locked rung, not when the rung is first reached.
                </li>
              </ol>
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
        {connected && <ServerMomentumScalperBotPanel connected={connected} />}
      </div>
    </DashboardShell>
  );
}
