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
                      Time: fired by a dedicated <strong>9:16:00.000</strong> timer, not the polling loop (window
                      until <strong>9:16:30</strong>; miss → no entry)
                    </li>
                    <li>
                      Pre-warmed at <strong>9:00</strong> (instrument list, whitelisted IP route, balance) and{" "}
                      <strong>9:15:58</strong> (ATM CE + PE strikes from the live tick) — so 9:16:00 is order
                      placement only, with zero lookups
                    </li>
                    <li>
                      Position sync with Zerodha pauses <strong>9:15:58–9:16:30</strong> so nothing competes with
                      the order — a duplicate check still runs <strong>before every order</strong>, so an existing
                      position is adopted instead of bought again
                    </li>
                    <li>
                      Strike: <strong>ATM</strong> Nifty weekly (nearest expiry)
                    </li>
                    <li>
                      Product: <strong>MIS</strong> market
                    </li>
                    <li>Size: max lots balance allows (from live LTP × lot size)</li>
                    <li>
                      Exchange limit: max <strong>25 lots per order</strong> — larger sizes split into parallel
                      orders (e.g. 35 lots → 25+10 at the same time)
                    </li>
                    <li>
                      Needs: bot on, Kite logged in before 9:15, whitelisted IP
                    </li>
                  </ul>
                </li>
                <li>
                  <strong>4. Fallback entry retry (if order fails)</strong>
                  <ul className="nf-live-rules-sublist">
                    <li>
                      Failed / rejected orders are <strong>not</strong> counted as entry — only a{" "}
                      <strong>filled</strong> order starts the trade
                    </li>
                    <li>
                      Until <strong>9:16:30</strong>, retry as fast as possible (~250ms between attempts): fresh{" "}
                      <strong>ATM LTP</strong>, fresh <strong>balance</strong>, recompute lots, place again
                    </li>
                    <li>
                      If Kite <strong>rejects</strong> and you had &gt;1 lot, next attempt caps lots at{" "}
                      <strong>previous − 1</strong> (margin / sizing mismatch)
                    </li>
                    <li>
                      Retries keep the same CE/PE and exit band from step 2 — the <strong>strike is re-checked
                      against the live tick</strong> each attempt, so a fast move still gets the right ATM
                    </li>
                    <li>
                      If the whitelisted-IP check fails from cache, it <strong>re-probes immediately</strong> rather
                      than blocking the rest of the window
                    </li>
                    <li>
                      If nothing fills by <strong>9:16:30</strong> → <strong>NO ENTRY</strong> for the day
                    </li>
                  </ul>
                </li>
              </ol>
            </div>
            <div className="nf-live-rules-col">
              <h3 className="nf-live-rules-heading">Exit (live) — whichever fires first</h3>
              <p className="nf-live-rules-lead text-muted">
                On every Kite websocket tick (REST fallback if WS drops): exit if <strong>either</strong> the index
                rule <strong>or</strong> the option P&amp;L % rule is met — not both required. Split entry orders are
                one single position, so <strong>all lots exit together</strong> (see step 4). Then EOD force
                square-off. Exit checks start the moment the entry fills and are{" "}
                <strong>never paused</strong> — the 9:16 speed-ups only pause position sync, not the exit rules.
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
                      <strong>9:16–10:00 IST:</strong> unrealised ≥ <strong>+10%</strong> of (entry premium × qty)
                    </li>
                    <li>
                      <strong>10:01–11:00 IST:</strong> unrealised ≥ <strong>+5%</strong> of (entry premium × qty)
                    </li>
                    <li>
                      <strong>From 11:01 IST:</strong> unrealised ≥ <strong>+3%</strong> of (entry premium × qty)
                    </li>
                    <li>No P&amp;L % exit before 9:16 (entry)</li>
                    <li>
                      With split entries, P&amp;L uses the <strong>weighted average entry price</strong> and{" "}
                      <strong>total quantity</strong> — not each order separately
                    </li>
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
                <li>
                  <strong>4. Exiting a split (multi-order) position</strong>
                  <ul className="nf-live-rules-sublist">
                    <li>
                      All 9:16 split orders are the <strong>same strike + expiry</strong>, so Zerodha holds them as{" "}
                      <strong>one MIS position</strong> — there are no separate trades to manage
                    </li>
                    <li>
                      Exit rules are checked <strong>once on the whole position</strong> (avg entry, total qty) — never
                      per order, so partial exits can’t happen by rule
                    </li>
                    <li>
                      When a rule fires, the full open quantity is split into <strong>max 25 lots per SELL order</strong>{" "}
                      and <strong>all orders are sent simultaneously</strong> (e.g. 34 lots → 25+9 at once)
                    </li>
                    <li>
                      If any SELL is rejected or unfilled, the bot re-sends only the{" "}
                      <strong>remaining quantity</strong> (up to 3 rounds, then every tick) until Zerodha shows{" "}
                      <strong>flat</strong>
                    </li>
                    <li>
                      Orders already working on Kite are subtracted before a retry, so the position can never be{" "}
                      <strong>double-sold or flipped short</strong>
                    </li>
                    <li>
                      The day is marked complete <strong>only when quantity is 0</strong> — an unfilled leg keeps the
                      bot in position and retrying
                    </li>
                  </ul>
                </li>
              </ol>
              <p className="nf-live-rules-foot text-muted">
                Example after 10:01: Nifty +20 from fill exits even if option P&amp;L is under +5%; or +5% P&amp;L
                exits even if Nifty has not reached ±20. Same OR logic from 11:01 with ±15 / +3%. Split example: entered
                75 lots as 25+25+25 at 9:16 → on target, exits as 25+25+25 SELL orders fired together, not one after
                another.
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
