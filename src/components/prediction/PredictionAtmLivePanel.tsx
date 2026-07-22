import { useCallback, useEffect, useState } from "react";
import { IndianRupee, TrendingDown, TrendingUp } from "lucide-react";
import { displayConfidenceThreshold } from "@/lib/prediction-confidence";
import { PREDICTION_AUTO_TARGET_NET_INR } from "@/lib/prediction-auto-trade";
import type { PredictionInterval } from "@/lib/prediction-intervals";
import { PREDICTION_INTERVAL_MINUTES } from "@/lib/prediction-intervals";
import type { LiveAtmScenarios, PredictionLiveResult } from "@/types/prediction";
import { cn, formatNumber } from "@/lib/utils";

type Props = {
  connected: boolean;
  modelReady: boolean;
  interval: PredictionInterval;
  live: PredictionLiveResult | null;
  targetCandleLabel: string | null;
};

function formatInr(value: number | null | undefined, signed = false): string {
  if (value == null || !Number.isFinite(value)) return "—";
  const prefix = signed && value > 0 ? "+" : "";
  return `${prefix}₹${formatNumber(value, 0)}`;
}

function ProfitTargetBlock({ scenario }: { scenario: LiveAtmScenarios["up"] }) {
  if (!scenario.signalAtThreshold || scenario.targetExitPremium == null) return null;

  const targetInr = PREDICTION_AUTO_TARGET_NET_INR;

  if (scenario.profitAtMinute && scenario.profitScanReason === "target") {
    return (
      <div className="prediction-atm-profit-target prediction-atm-profit-target--hit">
        <strong className="text-up">
          ₹{targetInr} net at {scenario.profitAtMinute} candle
        </strong>
        <div className="prediction-atm-card-row">
          <span className="text-muted">Hold</span>
          <span>{scenario.profitAtHoldMinutes ?? "—"}m</span>
        </div>
        <div className="prediction-atm-card-row">
          <span className="text-muted">Exit premium</span>
          <span>₹{formatNumber(scenario.profitAtExitPremium ?? 0, 2)}</span>
        </div>
        <div className="prediction-atm-card-row">
          <span className="text-muted">Need premium</span>
          <span>₹{formatNumber(scenario.targetExitPremium, 2)}</span>
        </div>
        <p className="prediction-atm-pending text-muted">
          From today&apos;s 1m closes — first minute where net ≥ ₹{targetInr} (1 lot, after ₹50).
        </p>
      </div>
    );
  }

  let status = `₹${targetInr} not reached in today’s 1m scan yet`;
  if (scenario.profitScanReason === "stop") {
    status = `−15% SL hit before ₹${targetInr} in today’s scan`;
  } else if (scenario.profitScanReason === "eod") {
    status = `₹${targetInr} not hit by 3:29 PM square-off`;
  }

  return (
    <div className="prediction-atm-profit-target">
      <span className="prediction-atm-profit-target-label">{status}</span>
      <div className="prediction-atm-card-row">
        <span className="text-muted">Need premium for ₹{targetInr}</span>
        <span>₹{formatNumber(scenario.targetExitPremium, 2)}</span>
      </div>
      <p className="prediction-atm-pending text-muted">
        Scanning 1m option closes from entry now until target, SL, or 3:29 PM.
      </p>
    </div>
  );
}

function ScenarioCard({
  title,
  icon: Icon,
  tone,
  premium,
  strike,
  costPerLot,
  lotSize,
  symbol,
  scenario,
  targetLabel,
  tradeThresholdPct,
}: {
  title: string;
  icon: typeof TrendingUp;
  tone: "bullish" | "bearish";
  premium: number;
  strike: number;
  costPerLot: number;
  lotSize: number;
  symbol: string;
  scenario: LiveAtmScenarios["up"];
  targetLabel: string;
  tradeThresholdPct: number;
}) {
  const active = scenario.signalAtThreshold;
  const probPct = formatNumber(scenario.probability * 100, 1);
  const entryLabel =
    scenario.entrySource === "target_open"
      ? `Entry (${targetLabel} open)`
      : scenario.entrySource === "prior_close"
        ? "Entry (prior bar close)"
        : "ATM cost (live)";

  return (
    <div
      className={cn(
        "prediction-atm-card",
        tone === "bullish" ? "prediction-atm-card--call" : "prediction-atm-card--put",
        active && "prediction-atm-card--active",
      )}
    >
      <div className="prediction-atm-card-head">
        <Icon size={14} />
        <span className="prediction-atm-card-title">{title}</span>
        <strong className={cn(active && (tone === "bullish" ? "text-up" : "text-down"))}>
          {probPct}%
        </strong>
      </div>
      <div className="prediction-atm-card-row">
        <span className="text-muted">{entryLabel}</span>
        <span className="prediction-atm-card-value">
          {strike > 0 ? `${strike} · ` : ""}₹{formatNumber(premium, 2)}
        </span>
      </div>
      <div className="prediction-atm-card-row">
        <span className="text-muted">1 lot ({lotSize})</span>
        <span>{formatInr(costPerLot)}</span>
      </div>
      {symbol && <span className="prediction-atm-symbol text-muted">{symbol}</span>}

      {active ? (
        <>
          <ProfitTargetBlock scenario={scenario} />
          <div className="prediction-atm-projection">
          <span className="prediction-atm-projection-label">
            If ≥{formatNumber(tradeThresholdPct, 0)}% — enter now, exit at{" "}
            {targetLabel} close
          </span>
          {scenario.candleClosed && scenario.exitPremiumAtClose != null ? (
            <>
              <div className="prediction-atm-card-row">
                <span className="text-muted">Exit premium</span>
                <span>₹{formatNumber(scenario.exitPremiumAtClose, 2)}</span>
              </div>
              <div className="prediction-atm-card-row">
                <span className="text-muted">Gross P/L (1 lot)</span>
                <span className={cn(getPnlClass(scenario.grossPnl1Lot))}>
                  {formatInr(scenario.grossPnl1Lot, true)}
                </span>
              </div>
              <div className="prediction-atm-card-row">
                <span className="text-muted">Net est. (after ₹50)</span>
                <span className={cn(getPnlClass(scenario.netPnl1Lot))}>
                  {formatInr(scenario.netPnl1Lot, true)}
                </span>
              </div>
            </>
          ) : scenario.grossPnlLive1Lot != null ? (
            <>
              <div className="prediction-atm-card-row">
                <span className="text-muted">Live premium now</span>
                <span>₹{formatNumber(scenario.exitPremiumLive ?? 0, 2)}</span>
              </div>
              <div className="prediction-atm-card-row">
                <span className="text-muted">Gross P/L live (1 lot)</span>
                <span className={cn(getPnlClass(scenario.grossPnlLive1Lot))}>
                  {formatInr(scenario.grossPnlLive1Lot, true)}
                </span>
              </div>
              <div className="prediction-atm-card-row">
                <span className="text-muted">Net est. live</span>
                <span className={cn(getPnlClass(scenario.netPnlLive1Lot))}>
                  {formatInr(scenario.netPnlLive1Lot, true)}
                </span>
              </div>
              <p className="prediction-atm-pending text-muted">
                Mark-to-market vs {targetLabel} open — final P/L at {targetLabel} close when the
                minute ends.
              </p>
            </>
          ) : scenario.entrySource === "live" ? (
            <p className="prediction-atm-pending text-muted">
              Live P/L starts at {targetLabel} open — entry and mark are the same until then.
            </p>
          ) : (
            <p className="prediction-atm-pending text-muted">
              {targetLabel} candle still open — profit at close will appear once the minute
              finishes.
            </p>
          )}
          </div>
        </>
      ) : (
        <p className="prediction-atm-muted-note text-muted">
          Needs ≥{formatNumber(tradeThresholdPct, 0)}% to show exit-at-close
          profit for this side.
        </p>
      )}
    </div>
  );
}

function getPnlClass(value: number | null | undefined): string {
  if (value == null) return "";
  if (value > 0) return "text-up";
  if (value < 0) return "text-down";
  return "";
}

export function PredictionAtmLivePanel({
  connected,
  modelReady,
  interval,
  live,
  targetCandleLabel,
}: Props) {
  const [atm, setAtm] = useState<LiveAtmScenarios | null>(null);
  const [loading, setLoading] = useState(false);
  const tradeThreshold = displayConfidenceThreshold(interval);
  const tradeThresholdPct = tradeThreshold * 100;

  const loadAtm = useCallback(async () => {
    if (!connected || !modelReady || !live?.asOf) return;
    setLoading(true);
    try {
      const params = new URLSearchParams({
        asOf: live.asOf,
        interval,
        probUp: String(live.probabilities.up ?? 0),
        probDown: String(live.probabilities.down ?? 0),
        threshold: String(tradeThreshold),
      });
      const res = await fetch(`/api/prediction/atm-scenarios?${params}`, {
        credentials: "include",
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Failed to load ATM prices");
      setAtm(json.data as LiveAtmScenarios);
    } catch {
      setAtm(null);
    } finally {
      setLoading(false);
    }
  }, [connected, modelReady, interval, live?.asOf, live?.probabilities.down, live?.probabilities.up, tradeThreshold]);

  useEffect(() => {
    void loadAtm();
  }, [loadAtm]);

  useEffect(() => {
    if (!connected || !live?.asOf) return;
    const id = window.setInterval(() => void loadAtm(), 2500);
    return () => window.clearInterval(id);
  }, [connected, live?.asOf, loadAtm]);

  const targetLabel =
    atm?.targetCandleLabel || targetCandleLabel?.replace(/^.*~/, "").replace(/ IST$/, "") || "—";
  const intervalMin = PREDICTION_INTERVAL_MINUTES[interval];

  return (
    <section className="card prediction-panel prediction-atm-panel">
      <h2 className="prediction-panel-title">
        <IndianRupee size={18} />
        ATM entry preview
      </h2>
      {!connected ? (
        <p className="text-muted">Connect Zerodha for live ATM option prices.</p>
      ) : !modelReady ? (
        <p className="text-muted">Train the model to preview ATM trades.</p>
      ) : !live?.asOf ? (
        <p className="text-muted">Run prediction to load ATM call/put costs.</p>
      ) : (
        <>
          <p className="prediction-atm-note text-muted">
            {atm?.spotPrice ? <>Nifty {formatNumber(atm.spotPrice, 2)} · </> : null}
            {intervalMin}m signal · buy ATM now · ₹{PREDICTION_AUTO_TARGET_NET_INR} net target
            scans 1m premiums
            {loading && " · Updating…"}
          </p>
          {atm?.error && <p className="prediction-atm-error text-down">{atm.error}</p>}
          {atm && !atm.error && (
            <div className="prediction-atm-grid">
              <ScenarioCard
                title="Call Buy"
                icon={TrendingUp}
                tone="bullish"
                premium={atm.callPremium}
                strike={atm.atmStrike}
                costPerLot={atm.callCostPerLot}
                lotSize={atm.lotSize}
                symbol={atm.callSymbol}
                scenario={atm.up}
                targetLabel={targetLabel}
                tradeThresholdPct={tradeThresholdPct}
              />
              <ScenarioCard
                title="Put Buy"
                icon={TrendingDown}
                tone="bearish"
                premium={atm.putPremium}
                strike={atm.atmStrike}
                costPerLot={atm.putCostPerLot}
                lotSize={atm.lotSize}
                symbol={atm.putSymbol}
                scenario={atm.down}
                targetLabel={targetLabel}
                tradeThresholdPct={tradeThresholdPct}
              />
            </div>
          )}
        </>
      )}
    </section>
  );
}
