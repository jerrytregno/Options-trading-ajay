import { useMemo, useState } from "react";
import { Activity, LineChart } from "lucide-react";
import { StreamingChart } from "@/components/streaming/StreamingChart";
import { useGeminiMarketStream } from "@/hooks/use-gemini-market-stream";
import { aggregateSecondCandlesToMinutes, mergeMinuteCandles } from "@/lib/minute-candles";
import { formatIndianDateTime } from "@/lib/market-time";
import { buildRsiSeries } from "@/lib/technical-indicators";
import { cn, formatNumber, getChangeClass } from "@/lib/utils";

const CHART_HEIGHT = 400;
const CHART_INTERVAL_KEY = "optionflow_prediction_chart_interval";

type ChartInterval = "1s" | "1m";

function readChartInterval(): ChartInterval {
  try {
    const saved = sessionStorage.getItem(CHART_INTERVAL_KEY);
    return saved === "1m" ? "1m" : "1s";
  } catch {
    return "1s";
  }
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
  const rsiSeries = useMemo(() => buildRsiSeries(minuteCandles, 14), [minuteCandles]);
  const chartCandles = chartInterval === "1m" ? minuteCandles : secondCandles;
  const hasChartData = chartCandles.length > 0;
  const isMinuteView = chartInterval === "1m";

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
          <p className="text-muted prediction-note">
            {isMinuteView
              ? "1-minute candles from today’s session — matches the bot’s prediction chart."
              : "1-second stream from Market Streaming — volume, RSI, and price action while the bot runs."}
          </p>
        </div>
        {connected && (
          <div className="prediction-stream-toolbar">
            <div className="prediction-stream-interval" role="group" aria-label="Chart candle interval">
              <button
                type="button"
                className={cn("prediction-stream-interval-btn", !isMinuteView && "active")}
                onClick={() => selectChartInterval("1s")}
              >
                1s
              </button>
              <button
                type="button"
                className={cn("prediction-stream-interval-btn", isMinuteView && "active")}
                onClick={() => selectChartInterval("1m")}
              >
                1m
              </button>
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
                {isMinuteView ? "1-minute candles" : "1-second candles"} · {chartCandles.length} bars
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
                symbol="Nifty 50"
                height={CHART_HEIGHT}
              />
            ) : (
              <div className="stream-chart-empty">
                <Activity size={32} className="stream-chart-empty-icon" />
                <p>
                  {isMinuteView
                    ? "Loading today’s 1-minute session…"
                    : "Building candles from live quotes…"}
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
