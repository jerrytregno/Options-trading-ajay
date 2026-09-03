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
              <h3 className="nf-live-rules-heading text-down">9:15 trade · PE at 9:15:11</h3>
              <p className="nf-live-rules-lead text-muted">
                Short-only burst on the opening minute. Exit: resting <strong>+3% (Mon/Wed/Thu) or +5% (Tue/Fri) take-profit limit</strong> on
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
                  <strong>Read direction at 9:15:10</strong> — last tick strictly before 10 seconds vs that open.
                  <ul className="nf-live-rules-sublist">
                    <li>
                      <strong>Red ≥ 5 pts</strong> (open − mark ≥ <strong>5</strong> at 9:15:10) → arm{" "}
                      <strong>ATM PE</strong> market buy at <strong>9:15:11.000</strong>
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
                  ATM PE is pre-resolved at <strong>9:15:04</strong> so :11 is placement only.
                </li>
              </ol>
              <h4 className="nf-live-rules-subheading">Exit (take-profit limit + hard stop)</h4>
              <p className="nf-live-rules-callout">
                <strong>Hard stop — from 10:00 IST only · 30 pts adverse on Nifty</strong> (this leg is PE only:
                exit at market when spot <strong>≥ entry spot + 30</strong> — measured from the Nifty spot at
                fill, not from the 9:15 open).
              </p>
              <ol className="nf-live-rules-list">
                <li>
                  <strong>Take profit — % on capital deployed</strong> (entry premium × quantity, not Nifty
                  index %). The moment the 9:15:11 PE buy fills, a resting <strong>limit sell</strong> is placed
                  at the price that locks in:
                  <ul className="nf-live-rules-sublist">
                    <li>
                      <strong>Monday, Wednesday, Thursday → 3%</strong> profit on deployed capital (e.g. ₹1,00,000
                      deployed → ₹3,000 aim)
                    </li>
                    <li>
                      <strong>Tuesday, Friday → 5%</strong> profit on deployed capital (e.g. ₹1,00,000 deployed →
                      ₹5,000 aim)
                    </li>
                  </ul>
                  If placement fails, the bot retries instantly until the limit is live on Kite.
                </li>
                <li>
                  <strong>No trailing ladder</strong> — there is no option P&amp;L stop before the limit fills.
                  From <strong>10:00 IST</strong>, if Nifty spot is <strong>≥ entry spot + 30</strong> (30 index
                  pts against the PE from your entry spot), the bot exits at market. If still open at{" "}
                  <strong>3:25 PM</strong>, it is squared off at market regardless of P&amp;L.
                </li>
                <li>
                  <strong>Market backup</strong> — if the limit never fills and unrealised P&amp;L reaches the
                  day&apos;s target (<strong>3%</strong> Mon/Wed/Thu · <strong>5%</strong> Tue/Fri on capital
                  deployed), the bot squares off at market.
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
              <h4 className="nf-live-rules-subheading">Exit (take-profit limit + hard stop)</h4>
              <p className="nf-live-rules-callout">
                <strong>Hard stop — from 10:00 IST only · 30 pts adverse on Nifty</strong> (PE: exit at market
                when spot <strong>≥ entry spot + 30</strong> — from the Nifty spot at fill, not the 9:15 open).
              </p>
              <ol className="nf-live-rules-list">
                <li>
                  <strong>Take-profit limit on capital deployed</strong> — profit is measured as a{" "}
                  <strong>% of capital deployed</strong> (entry premium × quantity). The moment the 9:16 entry
                  fills, a resting <strong>limit sell</strong> is placed at that profit aim; if Kite rejects
                  placement, the bot retries instantly until the order is accepted.
                  <ul className="nf-live-rules-sublist">
                    <li>
                      <strong>Monday, Wednesday &amp; Thursday</strong> — <strong>+5%</strong> profit on capital
                      deployed
                    </li>
                    <li>
                      <strong>Tuesday &amp; Friday</strong> — <strong>+10%</strong> profit on capital deployed
                    </li>
                    <li>
                      <strong>Market backup</strong> — if the limit does not fill but live P&amp;L reaches the
                      same %, square off at market (same as the 9:15 leg).
                    </li>
                    <li>
                      <strong>No trailing ladder</strong> — there is no option P&amp;L stop before the limit
                      fills or the market backup fires.
                    </li>
                  </ul>
                </li>
                <li>
                  <strong>3:25 PM</strong> force square-off if still open.
                </li>
              </ol>
            </div>
          </div>
        </div>

        <div className="card nf-live-rules nf-live-rules--traps">
          <h2 className="nf-live-rules-title">Traps bot (after 9:16:30 – 15:30 IST)</h2>
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
                  <strong>First-second gate on candle 2:</strong> compare the signal minute&apos;s{" "}
                  <strong>last websocket tick</strong> to every tick in the next minute&apos;s{" "}
                  <strong>first second</strong>. Green → any tick ≥ last + <strong>0.1</strong>; red → any
                  tick ≤ last − <strong>0.1</strong>. If none reach it in that second, the setup is dropped.
                </li>
                <li>
                  <strong>Pullback entry:</strong> once the gate passes, green waits for a{" "}
                  <strong>2 pt drop</strong> from the first tick of candle 2 (call buy); red waits for a{" "}
                  <strong>2 pt gain</strong> from that first tick (put buy). <strong>MIS market buy</strong> on
                  the ATM leg when the pullback prints.
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
