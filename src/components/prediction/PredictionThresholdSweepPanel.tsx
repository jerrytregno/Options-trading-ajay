import { useCallback, useEffect, useState } from "react";
import { BarChart3, RefreshCw } from "lucide-react";
import {
  displayConfidenceThreshold,
  DISPLAY_CONFIDENCE_AGGRESSIVE,
} from "@/lib/prediction-confidence";
import type { PredictionInterval } from "@/lib/prediction-intervals";
import type { ThresholdSweepResult } from "@/types/prediction";
import { cn, formatNumber } from "@/lib/utils";

type Props = {
  connected: boolean;
  modelReady: boolean;
  interval: PredictionInterval;
  onLoaded?: (sweep: ThresholdSweepResult | null) => void;
};

export function PredictionThresholdSweepPanel({
  connected,
  modelReady,
  interval,
  onLoaded,
}: Props) {
  const [sweep, setSweep] = useState<ThresholdSweepResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadSweep = useCallback(
    async (refresh = false) => {
      if (!modelReady || interval !== "5minute") return;
      setLoading(true);
      setError(null);
      try {
        const params = new URLSearchParams({
          interval,
          days: "30",
          ...(refresh ? { refresh: "1" } : {}),
        });
        const res = await fetch(`/api/prediction/threshold-sweep?${params}`, {
          credentials: "include",
        });
        const json = await res.json();
        if (!res.ok) throw new Error(json.error ?? "Threshold sweep failed");
        setSweep(json.data as ThresholdSweepResult);
      } catch (e) {
        setError(e instanceof Error ? e.message : "Threshold sweep failed");
      } finally {
        setLoading(false);
      }
    },
    [interval, modelReady],
  );

  useEffect(() => {
    if (interval === "5minute" && modelReady) {
      void loadSweep(false);
    } else {
      setSweep(null);
      setError(null);
      onLoaded?.(null);
    }
  }, [interval, modelReady, loadSweep, onLoaded]);

  useEffect(() => {
    onLoaded?.(sweep);
  }, [sweep, onLoaded]);

  if (interval !== "5minute") return null;

  const tradeThreshold = displayConfidenceThreshold(interval);
  const aggressive = DISPLAY_CONFIDENCE_AGGRESSIVE["5minute"];
  const rows = (sweep?.sweep ?? []).filter((row) => row.calls > 0 || row.threshold >= 0.75);

  return (
    <section className="card prediction-panel prediction-threshold-panel">
      <div className="prediction-threshold-head">
        <h2 className="prediction-panel-title">
          <BarChart3 size={18} />
          5 min threshold backtest
        </h2>
        <button
          type="button"
          className="btn btn-secondary btn-sm"
          onClick={() => void loadSweep(true)}
          disabled={!connected || !modelReady || loading}
        >
          <RefreshCw size={14} className={loading ? "spin" : ""} />
          {loading ? "Analyzing…" : "Re-run 30d"}
        </button>
      </div>

      {!modelReady ? (
        <p className="text-muted prediction-note">Train the 5 min model to analyze trade thresholds.</p>
      ) : error ? (
        <p className="text-down prediction-note">{error}</p>
      ) : !sweep ? (
        <p className="text-muted prediction-note">Loading threshold analysis…</p>
      ) : (
        <>
          <p className="prediction-note text-muted">
            Walk-forward on saved {sweep.days}-day candles
            {sweep.dateRange ? ` (${sweep.dateRange.from} → ${sweep.dateRange.to})` : ""}.{" "}
            Max confidence seen: <strong>{formatNumber(sweep.probStats.maxSideMax * 100, 1)}%</strong> — so{" "}
            <strong>75% never fires</strong>. Live/auto-trader uses{" "}
            <strong>≥{formatNumber(tradeThreshold * 100, 0)}%</strong>
            {sweep.recommended ? (
              <>
                {" "}
                (backtest pick: {formatNumber(sweep.recommended.thresholdPct, 0)}% →{" "}
                {formatNumber(sweep.recommended.hitPct ?? 0, 1)}% hit, ~
                {formatNumber(sweep.recommended.avgCallsPerDay, 1)}/day)
              </>
            ) : null}
            .
            {aggressive != null && (
              <>
                {" "}
                Optional aggressive: ≥{formatNumber(aggressive * 100, 0)}% (~17 signals/day, ~70% hit).
              </>
            )}
          </p>

          <div className="prediction-threshold-table-wrap">
            <table className="prediction-threshold-table">
              <thead>
                <tr>
                  <th>Threshold</th>
                  <th>Signals</th>
                  <th>Hit rate</th>
                  <th>Per day</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => {
                  const isLive = Math.abs(row.threshold - tradeThreshold) < 0.001;
                  const isRec =
                    sweep.recommended != null &&
                    Math.abs(row.threshold - sweep.recommended.threshold) < 0.001;
                  return (
                    <tr
                      key={row.threshold}
                      className={cn(isLive && "is-live-threshold", isRec && "is-recommended")}
                    >
                      <td>
                        ≥{formatNumber(row.thresholdPct, 0)}%
                        {isLive && <span className="prediction-threshold-tag">Live</span>}
                        {isRec && !isLive && (
                          <span className="prediction-threshold-tag">Backtest pick</span>
                        )}
                      </td>
                      <td>{row.calls > 0 ? row.calls : "—"}</td>
                      <td>{row.hitPct != null ? `${formatNumber(row.hitPct, 1)}%` : "—"}</td>
                      <td>
                        {row.calls > 0 ? formatNumber(row.avgCallsPerDay, 1) : "—"}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      )}
    </section>
  );
}
