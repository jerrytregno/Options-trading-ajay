import { useMemo, useState } from "react";
import { Activity, LineChart } from "lucide-react";
import { StreamingChart } from "@/components/streaming/StreamingChart";
import { useGeminiMarketStream } from "@/hooks/use-gemini-market-stream";
import {
  aggregateCandlesToInterval,
  aggregateSecondCandlesToMinutes,
  mergeMinuteCandles,
} from "@/lib/minute-candles";
import { formatIndianDateTime } from "@/lib/market-time";
import { buildRsiSeries } from "@/lib/technical-indicators";
import { cn, formatNumber, getChangeClass } from "@/lib/utils";

const CHART_HEIGHT = 400;
const CHART_INTERVAL_KEY = "optionflow_prediction_chart_interval";

const CHART_INTERVALS = ["1s", "1m", "3m", "5m"] as const;
type ChartInterval = (typeof CHART_INTERVALS)[number];

const CHART_INTERVAL_NOTES: Record<ChartInterval, string> = {
  "1s": "1-second stream from Market Streaming — volume, RSI, and price action while the bot runs.",
  "1m": "1-minute candles from today’s session — matches the bot’s prediction chart.",
  "3m": "3-minute candles from today’s session — matches the bot’s 3 min prediction chart.",
  "5m": "5-minute candles from today’s session — matches the bot’s 5 min prediction chart.",
};

const CHART_CANDLE_LABELS: Record<ChartInterval, string> = {
  "1s": "1-second candles",
  "1m": "1-minute candles",
  "3m": "3-minute candles",
  "5m": "5-minute candles",
};

const CHART_INTERVAL_MINUTES: Partial<Record<ChartInterval, number>> = {
  "1m": 1,
  "3m": 3,
  "5m": 5,
};

function readChartInterval(): ChartInterval {
  try {
    const saved = sessionStorage.getItem(CHART_INTERVAL_KEY);
    if (saved && (CHART_INTERVALS as readonly string[]).includes(saved)) {
      return saved as ChartInterval;
    }
  } catch {
    /* ignore */
  }
  return "1s";
}

interface PredictionNiftyStreamChartProps {
  connected: boolean;
  loginUrl: string | null;
}

export function PredictionNiftyStreamChart({ connected, loginUrl }: PredictionNiftyStreamChartProps) {
  const [chartInterval, setChartInterval] = useState<ChartInterval>(readChartInterval);
  const {
    marketStreaming,
    toggleMarketStreaming,
    stream,
    secondCandles,
    loading,
    streamError,
    sessionsByInstrument,
  } = useGeminiMarketStream();

  const session = sessionsByInstrument.nifty50;
  const streamMinuteCandles = useMemo(
    () => aggregateSecondCandlesToMinutes(secondCandles),
    [secondCandles]
  );
  const minuteCandles = useMemo(
    () => mergeMinuteCandles(session?.candles ?? [], streamMinuteCandles),
    [session?.candles, streamMinuteCandles]
  );
  const chartCandles = useMemo(() => {
    if (chartInterval === "1s") return secondCandles;
    const intervalMinutes = CHART_INTERVAL_MINUTES[chartInterval] ?? 1;
    if (intervalMinutes === 1) return minuteCandles;
    return aggregateCandlesToInterval(minuteCandles, intervalMinutes);
  }, [chartInterval, secondCandles, minuteCandles]);
  const rsiSeries = useMemo(() => {
    if (chartInterval === "1s") return buildRsiSeries(minuteCandles, 14);
    return buildRsiSeries(chartCandles, 14);
  }, [chartInterval, minuteCandles, chartCandles]);
  const rsiLabel =
    chartInterval === "1s" ? "RSI (14 · 1m)" : `RSI (14 · ${chartInterval})`;
  const hasChartData = chartCandles.length > 0;
  const isSecondView = chartInterval === "1s";

  const selectChartInterval = (next: ChartInterval) => {
    setChartInterval(next);
    try {
      sessionStorage.setItem(CHART_INTERVAL_KEY, next);
    } catch {
      /* ignore */
    }
  };

  return (
    <section className="card prediction-panel prediction-stream-panel">
      <div className="prediction-stream-head">
        <div>
          <h2 className="prediction-panel-title">
            <LineChart size={18} />
            Nifty 50 · live chart
          </h2>
          <p className="text-muted prediction-note">{CHART_INTERVAL_NOTES[chartInterval]}</p>
        </div>
        {connected && (
          <div className="prediction-stream-toolbar">
            <div className="prediction-stream-interval" role="group" aria-label="Chart candle interval">
              {CHART_INTERVALS.map((interval) => (
                <button
                  key={interval}
                  type="button"
                  className={cn(
                    "prediction-stream-interval-btn",
                    chartInterval === interval && "active"
                  )}
                  onClick={() => selectChartInterval(interval)}
                >
                  {interval}
                </button>
              ))}
            </div>
            <span className={cn("stream-live-pill", !marketStreaming && "is-paused")}>
              <span className="stream-live-dot" />
              {marketStreaming ? `Live · ${chartInterval}` : "Paused"}
            </span>
            <label className="stream-ai-toggle" title="Toggle live quotes">
              <span className="stream-ai-toggle-label">Stream</span>
              <input
                type="checkbox"
                checked={marketStreaming}
                onChange={toggleMarketStreaming}
                aria-label="Toggle Nifty 50 streaming"
              />
              <span className="stream-ai-toggle-track" aria-hidden />
            </label>
          </div>
        )}
      </div>

      {!connected ? (
        <p className="text-muted prediction-note">
          Connect Zerodha to stream the Nifty 50 chart.
          {loginUrl && (
            <a href={loginUrl} className="prediction-stream-login">
              Connect Kite
            </a>
          )}
        </p>
      ) : loading && !hasChartData && !stream ? (
        <div className="spinner-center prediction-stream-loading">
          <div className="spinner spinner-sm" />
        </div>
      ) : (
        <article className="stream-chart-card prediction-stream-chart-card">
          <div className="stream-chart-head">
            <div className="stream-chart-head-left">
              <p className="stream-chart-symbol">Nifty 50</p>
              <p className="stream-chart-sub">
                {CHART_CANDLE_LABELS[chartInterval]} · {chartCandles.length} bars
                {stream?.updatedAt && marketStreaming && (
                  <> · {formatIndianDateTime(new Date(stream.updatedAt))}</>
                )}
              </p>
            </div>
            {stream && (
              <div className="stream-chart-price-block">
                <p className={cn("stream-chart-price", getChangeClass(stream.quote.change))}>
                  {formatNumber(stream.quote.last_price)}
                </p>
                <p className={cn("stream-chart-change", getChangeClass(stream.quote.change))}>
                  {stream.quote.change >= 0 ? "+" : ""}
                  {formatNumber(stream.quote.change)} ({formatNumber(stream.quote.change_percent)}%)
                </p>
              </div>
            )}
          </div>

          {streamError && <div className="alert alert-error">{streamError}</div>}

          <div className="stream-chart-body">
            {hasChartData ? (
              <StreamingChart
                candles={chartCandles}
                rsiSeries={rsiSeries}
                rsiLabel={rsiLabel}
                symbol="Nifty 50"
                height={CHART_HEIGHT}
              />
            ) : (
              <div className="stream-chart-empty">
                <Activity size={32} className="stream-chart-empty-icon" />
                <p>
                  {isSecondView
                    ? "Building candles from live quotes…"
                    : `Loading today’s ${CHART_CANDLE_LABELS[chartInterval].replace(" candles", "")} session…`}
                </p>
                {!marketStreaming && (
                  <button type="button" className="btn btn-secondary btn-sm" onClick={toggleMarketStreaming}>
                    Turn stream on
                  </button>
                )}
              </div>
            )}
          </div>
        </article>
      )}
    </section>
  );
}
