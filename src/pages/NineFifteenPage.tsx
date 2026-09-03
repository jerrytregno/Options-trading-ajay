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
              Morning legs at 9:15 and 9:16 IST · Traps scans after 9:16:30 · enable each bot separately on the panels
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
              <h3 className="nf-live-rules-heading text-down">9:15 trade · PE at 9:15:06</h3>
              <p className="nf-live-rules-lead text-muted">
                Short-only burst on the opening minute. Exit: resting <strong>+5% take-profit limit</strong> on
                capital deployed at fill, plus a <strong>10:00 hard stop</strong> on adverse Nifty movement from
                the entry spot.
              </p>
              <h4 className="nf-live-rules-subheading">Entry</h4>
              <ol className="nf-live-rules-list">
                <li>
                  <strong>Capture the 9:15 open</strong> — first Nifty websocket tick from{" "}
                  <strong>9:15:00</strong>.
                </li>
                <li>
                  <strong>Read direction at 9:15:05</strong> — last tick strictly before 5 seconds vs that open.
                  <ul className="nf-live-rules-sublist">
                    <li>
                      <strong>Red ≥ 5 pts</strong> (open − mark ≥ <strong>5</strong> at 9:15:05) → arm{" "}
                      <strong>ATM PE</strong> market buy at <strong>9:15:06.000</strong>
                    </li>
                    <li>
                      <strong>Red &lt; 5 pts, green, or flat</strong> → no 9:15 trade
                    </li>
                  </ul>
                </li>
                <li>
                  <strong>Order window</strong> — retries until <strong>9:15:20</strong>; miss → no 9:15 leg
                  today.
                </li>
                <li>
                  ATM PE is pre-resolved at <strong>9:15:04</strong> so :06 is placement only.
                </li>
              </ol>
              <h4 className="nf-live-rules-subheading">Exit (+5% limit + hard stop)</h4>
              <p className="nf-live-rules-callout">
                <strong>Hard stop — 10:00 IST · ±30 pts adverse</strong> (PE: spot ≥ entry + 30, CE: spot ≤
                entry − 30). From <strong>10:00</strong>, exit at market if Nifty has moved 30 pts against the
                entry spot.
              </p>
              <ol className="nf-live-rules-list">
                <li>
                  <strong>Take profit — +5% on capital deployed</strong> — the moment the 9:15:06 PE buy fills,
                  a resting <strong>limit sell</strong> is placed at entry premium × 1.05 (e.g. ₹1,00,000 deployed
                  → ₹5,000 profit aim).
                </li>
                <li>
                  <strong>No trailing ladder</strong> — there is no P&amp;L stop before the limit fills. A losing
                  leg still exits on the <strong>10:00 hard stop</strong> or <strong>3:25 PM</strong> square-off.
                </li>
                <li>
                  <strong>Market backup</strong> — if the limit is rejected or price prints +5% without a fill, the
                  bot squares off at market.
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
                      |Δ| &lt; <strong>15</strong> → no trade
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
              <h4 className="nf-live-rules-subheading">Exit (P&amp;L trail + hard stop)</h4>
              <p className="nf-live-rules-callout">
                <strong>Hard stop — 10:00 IST · ±30 pts adverse</strong> (PE: spot ≥ entry + 30, CE: spot ≤
                entry − 30). Same rule as the 9:15 leg — measured from the entry spot, not the 9:15 open.
              </p>
              <ol className="nf-live-rules-list">
                <li>
                  <strong>Trailing option P&amp;L</strong> — tiers lock a stop floor when profit prints:
                  <strong> +8→lock+3%</strong> on Tue/Fri (<strong>+4→lock+3%</strong> Mon/Wed ·{" "}
                  <strong>+5→lock+3%</strong> Thu), then <strong>+12→+6%</strong>,{" "}
                  <strong>+16→+9%</strong>, <strong>+20→+12%</strong>, <strong>+25→+16%</strong>,{" "}
                  <strong>+30→+20%</strong>, <strong>+40→+28%</strong>. Slipping <strong>below</strong> the
                  locked floor exits at market. At <strong>+50%</strong> the bot exits at market instantly.
                </li>
                <li>
                  <strong>3:25 PM</strong> force square-off if still open.
                </li>
              </ol>
            </div>
          </div>
        </div>

        <div className="card nf-live-rules nf-live-rules--traps">
          <h2 className="nf-live-rules-title">Traps bot (after 9:16:30 – 15:10 IST)</h2>
          <p className="nf-live-rules-lead text-muted">
            Separate strategy on the panel below — not tied to the 9:15 candle. Starts scanning after the
            9:16 morning trade entry window closes (9:16:30 IST), through the afternoon entry cutoff. Disabled
            until you press Enable on the panel.
          </p>
          <div className="nf-live-rules-grid nf-live-rules-grid--single">
            <div className="nf-live-rules-col">
              <ol className="nf-live-rules-list">
                <li>
                  <strong>Signal candle:</strong> high − low ≥ <strong>5 pts</strong>; green body → CE idea,
                  red → PE.
                </li>
                <li>
                  <strong>First-tick gate on candle 2:</strong> compare the signal minute&apos;s{" "}
                  <strong>last websocket tick</strong> to the next minute&apos;s <strong>first tick</strong>.
                  Green → first tick ≥ last + <strong>0.2</strong>; red → first tick ≤ last −{" "}
                  <strong>0.2</strong>.
                </li>
                <li>
                  <strong>Pullback entry:</strong> once the gate passes, green waits for a{" "}
                  <strong>2 pt drop</strong> from the start (call buy); red waits for a <strong>2 pt gain</strong>{" "}
                  (put buy). <strong>MIS market buy</strong> on the ATM leg when the pullback prints.
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
