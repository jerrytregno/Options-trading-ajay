import { AlertTriangle, Clock } from "lucide-react";
import { DashboardShell } from "@/components/layout/dashboard-shell";
import { ServerNineSixteenBotPanel } from "@/components/trade/ServerNineSixteenBotPanel";
import { ServerMomentumScalperBotPanel } from "@/components/trade/ServerMomentumScalperBotPanel";
import { useKite } from "@/contexts/kite-context";
import { NINE_FIFTEEN_RED_916_BACKTEST_TITLE } from "@/types/nine-fifteen";
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
              9:15 + 9:16 morning legs armed on server · Traps off on server
            </p>
          </div>
        </header>

        <div className="card nf-live-rules">
          <h2 className="nf-live-rules-title">Live strategies — entry &amp; exit rules</h2>
          <p className="nf-live-rules-lead text-muted">
            Two independent morning trades on the same server bot, plus Traps later in the session. Each has its
            own enable switch. Historical 9:15-bar studies still live under{" "}
            <strong>{NINE_FIFTEEN_RED_916_BACKTEST_TITLE}</strong>.
          </p>

          <div className="nf-live-rules-grid">
            {/* —— 9:15 trade —— */}
            <div className="nf-live-rules-col">
              <h3 className="nf-live-rules-heading">9:15 trade · PE or CE at 9:15:11</h3>
              <p className="nf-live-rules-lead text-muted">
                Burst on the opening minute — red ≥ 5 pts → ATM PE · green ≥ 10 pts → ATM CE. Exit: resting
                take-profit limit — <strong>PE: Mon/Tue 5%</strong> · <strong>Wed/Thu/Fri 3%</strong> ·{" "}
                <strong>CE: 3% every day</strong> on capital deployed at fill.
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
                      <strong>Red ≥ 5 pts</strong> (open − mark ≥ <strong>5</strong> at 9:15:10) →{" "}
                      <strong>ATM PE</strong> at <strong>9:15:11.000</strong>
                    </li>
                    <li>
                      <strong>Green ≥ 10 pts</strong> (mark − open ≥ <strong>10</strong> at 9:15:10) →{" "}
                      <strong>ATM CE</strong> at <strong>9:15:11.000</strong>
                    </li>
                    <li>
                      <strong>Red &lt; 5 pts</strong> or <strong>green &lt; 10 pts</strong> or flat → no 9:15 trade
                    </li>
                  </ul>
                </li>
                <li>
                  <strong>Order window</strong> — insufficient-fund downsize retries until <strong>9:15:15</strong>{" "}
                  (skip 9:15 leg if not in by 9:15:16); partial top-ups until <strong>9:15:20</strong>.
                </li>
                <li>
                  ATM CE + PE are pre-resolved at <strong>9:15:04</strong> so :11 is placement only.
                </li>
                <li>
                  <strong>Sizing &amp; orders</strong> — full available balance; max <strong>25 lots</strong> per
                  Kite order (split in parallel if larger). <strong>Entry = NRML market BUY</strong> at the live
                  print (fast fill at 9:15:11 — not a limit entry). Sizing uses two REST LTP reads 1s apart
                  (size on the lower quote).
                </li>
                <li>
                  <strong>Partial fill / margin short</strong> — on insufficient funds at 9:15:11, reduce{" "}
                  <strong>1 lot</strong> (or Kite&apos;s scaled size) and retry instantly until{" "}
                  <strong>9:15:15</strong>. After a partial fill, top-up until <strong>9:15:20</strong> with the same
                  downsize logic.
                </li>
              </ol>
              <h4 className="nf-live-rules-subheading">Exit (take-profit limit)</h4>
              <ol className="nf-live-rules-list">
                <li>
                  <strong>Take profit — LIMIT sell only</strong> (% on capital deployed = entry premium × quantity,
                  not Nifty index %). Limit price is entry × (1 + weekday %), rounded to the nearest{" "}
                  <strong>₹0.05</strong> (NSE option price step). The moment the 9:15:11 buy fills, a resting{" "}
                  <strong>limit sell</strong> is placed at the price that locks in:
                  <ul className="nf-live-rules-sublist">
                    <li>
                      <strong>PE (put buy)</strong> — <strong>Mon/Tue → 5%</strong> · <strong>Wed/Thu/Fri → 3%</strong>{" "}
                      on deployed capital
                    </li>
                    <li>
                      <strong>CE (call buy)</strong> — <strong>3% every weekday</strong> on deployed capital
                    </li>
                  </ul>
                  If placement fails, the bot retries instantly until the limit is live on Kite.
                </li>
                <li>
                  <strong>No trailing ladder</strong> — there is no option P&amp;L stop before the limit fills.
                  If still open at <strong>3:25 PM</strong>, it is squared off at market regardless of P&amp;L.
                </li>
                <li>
                  <strong>Market backup</strong> — if the limit never fills and unrealised P&amp;L reaches the
                  day&apos;s target (PE weekday % or CE 3%), the bot squares off at market.
                </li>
                <li>
                  <strong>Hard stop — from 10:00 AM IST</strong> — exit at market if Nifty moves{" "}
                  <strong>30 points against</strong> the entry direction from the spot at fill:{" "}
                  <strong>PE</strong> when spot ≥ entry + 30. Runs alongside the take-profit limit; whichever
                  hits first closes the leg.
                </li>
                <li>
                  <strong>Small-body exit @ 9:16:01</strong> — if the 9:15 leg is still open when the{" "}
                  <strong>websocket 9:15:59 close</strong> seals and <strong>|close − open| &lt; 5</strong>, exit
                  at market on the <strong>first Nifty WS tick at 9:16:01</strong>, whatever the P&amp;L.
                </li>
              </ol>
              <p className="nf-live-rules-foot text-muted">
                When the 9:15 leg closes before 9:16:00, the 9:16 decision still runs at 9:16:01 unless the
                9:15 trade is still open.
              </p>
            </div>

            {/* —— 9:16 trade —— */}
            <div className="nf-live-rules-col">
              <h3 className="nf-live-rules-heading">9:16 trade · PE or CE at 9:16:01</h3>
              <p className="nf-live-rules-lead text-muted">
                Second morning leg on the same server bot — 9:15 candle with |Δ| ≥ 15 buys ATM PE when red or ATM
                CE when green at 9:16:01. Always armed on the server alongside the 9:15 trade.
              </p>
              <h4 className="nf-live-rules-subheading">Entry</h4>
              <ol className="nf-live-rules-list">
                <li>
                  <strong>Δ = 9:15 close − open</strong>
                  <ul className="nf-live-rules-sublist">
                    <li>Flat → no trade</li>
                    <li>
                      |Δ| &lt; <strong>15</strong> → no trade
                    </li>
                    <li>
                      Red, <strong>|Δ| ≥ 15</strong> → <strong>PE</strong> (main entry band)
                    </li>
                    <li>
                      Green, <strong>|Δ| ≥ 15</strong> → <strong>CE</strong> (main entry band)
                    </li>
                  </ul>
                </li>
                <li>
                  <strong>9:15 close from websocket</strong> — last Nifty tick strictly before{" "}
                  <strong>9:16:00</strong> (logged as 9:15:59 close).
                </li>
                <li>
                  <strong>Order at 9:16:01.000</strong> (dedicated timer) · option websocket armed from{" "}
                  <strong>9:15:58</strong> (ATM CE + PE pre-resolved) · collect the{" "}
                  <strong>1st and 2nd option websocket ticks in the 9:16:01 second</strong> on the entry leg.
                </li>
                <li>
                  <strong>Entry = NRML limit BUY</strong> at the <strong>2nd tick</strong> (limit price rounded to
                  nearest <strong>₹0.05</strong>) · size lots on the <strong>lower</strong> of the two ticks · log
                  if the 1st tick is ≥ <strong>3%</strong> above the 2nd · <strong>market backup in 8s</strong> if
                  the limit does not fill · retries until <strong>9:16:30</strong>.
                </li>
                <li>
                  <strong>Blocked</strong> when the 9:15 leg is still open at 9:16:00.
                </li>
                <li>
                  <strong>Partial fill / margin short</strong> — tops up missing qty until <strong>9:16:30</strong>;
                  on insufficient margin, steps lots down instantly (25 → 24 → 23…) from Kite&apos;s quoted figures.
                </li>
              </ol>
              <h4 className="nf-live-rules-subheading">Exit (take-profit limit + parallel index exit)</h4>
              <ol className="nf-live-rules-list">
                <li>
                  <strong>Take-profit — LIMIT sell only</strong> (% on capital deployed = entry premium × quantity).
                  Limit price is entry × (1 + weekday %), rounded to the nearest <strong>₹0.05</strong>. The moment
                  the 9:16 limit entry fills, a resting <strong>limit sell</strong> is placed at that profit aim;
                  if Kite rejects placement, the bot retries instantly until the order is accepted.
                  <ul className="nf-live-rules-sublist">
                    <li>
                      <strong>PE (put buy)</strong> — <strong>Monday, Wednesday &amp; Thursday +5%</strong> ·{" "}
                      <strong>Tuesday &amp; Friday +7%</strong> profit on capital deployed
                    </li>
                    <li>
                      <strong>CE (call buy)</strong> — <strong>+3% every weekday</strong> profit on capital deployed
                    </li>
                  </ul>
                </li>
                <li>
                  <strong>Market backup</strong> — if the take-profit limit never fills and unrealised P&amp;L
                  reaches the day&apos;s target (PE: Mon/Wed/Thu <strong>+5%</strong> · Tue/Fri <strong>+7%</strong> ·
                  CE: <strong>+3%</strong> on capital deployed), the bot cancels the limit and squares off at market —
                  same behaviour as the 9:15 leg.
                </li>
                <li>
                  <strong>Parallel Nifty index exit — MARKET sell</strong> (runs alongside the TP limit;{" "}
                  <strong>whichever hits first</strong> closes the leg). Measured from the Nifty spot at fill:
                  <ul className="nf-live-rules-sublist">
                    <li>
                      <strong>PE leg (red 9:15)</strong>
                      <ul className="nf-live-rules-sublist">
                        <li>
                          <strong>9:16:00 open ≤ 9:15:59 close</strong> (both red) → exit at market when Nifty ≤{" "}
                          <strong>entry spot − 12</strong> (until 9:17:00)
                        </li>
                        <li>
                          <strong>9:16:00 open &gt; 9:15:59 close</strong> (green gap at 9:16) → exit at market when
                          Nifty ≤ <strong>entry spot − 8</strong> (until 9:17:00)
                        </li>
                        <li>
                          <strong>9:16 minute closes green</strong> — 9:16:59 last WS tick &gt; 9:15:59 last WS tick →
                          from <strong>9:17:00</strong> exit at market when Nifty ≤ <strong>entry spot − 6</strong>
                        </li>
                      </ul>
                    </li>
                    <li>
                      <strong>CE leg (green 9:15)</strong>
                      <ul className="nf-live-rules-sublist">
                        <li>
                          <strong>9:16:00 open ≥ 9:15:59 close</strong> (both green) → exit at market when Nifty ≥{" "}
                          <strong>entry spot + 12</strong> (until 9:17:00)
                        </li>
                        <li>
                          <strong>9:16:00 open &lt; 9:15:59 close</strong> (red gap at 9:16) → exit at market when
                          Nifty ≥ <strong>entry spot + 8</strong> (until 9:17:00)
                        </li>
                        <li>
                          <strong>9:16 minute closes red</strong> — 9:16:59 last WS tick &lt; 9:15:59 last WS tick →
                          from <strong>9:17:00</strong> exit at market when Nifty ≥ <strong>entry spot + 6</strong>
                        </li>
                      </ul>
                    </li>
                  </ul>
                  9:15:59 close = last Nifty websocket tick in the 9:15:59 second; 9:16:00 open = first Nifty
                  websocket tick in the 9:16:00 second; 9:16:59 close = last tick in the 9:16:59 second (even a tick
                  slightly below 9:15:59 close counts the 9:16:00 open as red; slightly above counts as green; an
                  exactly equal open counts as the 9:15 colour for that leg).
                </li>
                <li>
                  <strong>No trailing ladder</strong> — there is no option P&amp;L stop before the limit fills,
                  the index target, the hard stop, or the market backup fires.
                </li>
                <li>
                  <strong>Hard stop — from 10:00 AM IST</strong> — same as the 9:15 leg: exit at market when Nifty
                  is <strong>30 pts adverse</strong> from entry spot (PE ≥ entry + 30 · CE ≤ entry − 30). Runs
                  alongside the take-profit limit and parallel index exit; first wins.
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
            until you press Enable on the panel; two losing trades stop the day.
          </p>
          <div className="nf-live-rules-grid nf-live-rules-grid--single">
            <div className="nf-live-rules-col">
              <ol className="nf-live-rules-list">
                <li>
                  <strong>Signal candle:</strong> high − low ≥ <strong>3 pts</strong>; green body → CE idea,
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
                  <strong>2 pt gain</strong> from that first tick (put buy). <strong>MIS market buy</strong> when
                  the pullback prints.
                </li>
                <li>
                  <strong>RSI filter:</strong> Wilder RSI(14) on 1-min Nifty closes must be between{" "}
                  <strong>40 and 60</strong> when the signal forms and at entry.
                </li>
                <li>
                  <strong>Exit:</strong> on fill, resting <strong>limit sell at +1%</strong> on deployed
                  capital · stop <strong>−2% P&amp;L held 3 seconds</strong> · market backup at +1% if the
                  limit has not filled.
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
