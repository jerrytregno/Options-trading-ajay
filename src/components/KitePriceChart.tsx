import { formatChartDate, parseKiteCandles, type KiteCandle } from "@/lib/kite-candles";
import { formatNumber } from "@/lib/utils";

interface KitePriceChartProps {
  candles: unknown[];
  height?: number;
  loading?: boolean;
  emptyMessage?: string;
}

function buildPaths(candles: KiteCandle[], width: number, height: number) {
  const padding = { top: 16, right: 8, bottom: 28, left: 8 };
  const chartWidth = width - padding.left - padding.right;
  const chartHeight = height - padding.top - padding.bottom;
  const min = Math.min(...candles.map((c) => c.low));
  const max = Math.max(...candles.map((c) => c.high));
  const range = max - min || 1;

  const coords = candles.map((candle, index) => {
    const x = padding.left + (index / Math.max(candles.length - 1, 1)) * chartWidth;
    const y = padding.top + chartHeight - ((candle.close - min) / range) * chartHeight;
    return { x, y, candle };
  });

  const line = coords.map((point) => `${point.x},${point.y}`).join(" ");
  const area = [
    `M ${coords[0]?.x ?? padding.left} ${padding.top + chartHeight}`,
    ...coords.map((point) => `L ${point.x} ${point.y}`),
    `L ${coords[coords.length - 1]?.x ?? padding.left} ${padding.top + chartHeight}`,
    "Z",
  ].join(" ");

  return { coords, line, area, min, max, padding, chartHeight };
}

export function KitePriceChart({
  candles,
  height = 420,
  loading = false,
  emptyMessage = "No historical data from Zerodha",
}: KitePriceChartProps) {
  if (loading) {
    return (
      <div className="kite-chart kite-chart-empty" style={{ height }}>
        <div className="spinner spinner-sm" />
      </div>
    );
  }

  const parsed = parseKiteCandles(candles);
  if (parsed.length === 0) {
    return (
      <div className="kite-chart kite-chart-empty" style={{ height }}>
        <p className="text-muted">{emptyMessage}</p>
      </div>
    );
  }

  const width = 960;
  const { coords, line, area, min, max, padding, chartHeight } = buildPaths(parsed, width, height);
  const first = parsed[0];
  const last = parsed[parsed.length - 1];
  const change = last.close - first.close;
  const changePct = first.close ? (change / first.close) * 100 : 0;
  const isUp = change >= 0;

  return (
    <div className="kite-chart-wrap">
      <div className="kite-chart-meta">
        <div>
          <p className="text-muted" style={{ fontSize: "0.75rem" }}>Period close</p>
          <p className="font-semibold">{formatNumber(last.close)}</p>
        </div>
        <div className="text-right">
          <p className="text-muted" style={{ fontSize: "0.75rem" }}>{parsed.length} sessions</p>
          <p className={isUp ? "text-up" : "text-down"} style={{ fontSize: "0.875rem" }}>
            {isUp ? "+" : ""}{change.toFixed(2)} ({isUp ? "+" : ""}{changePct.toFixed(2)}%)
          </p>
        </div>
      </div>

      <svg viewBox={`0 0 ${width} ${height}`} className="kite-chart" preserveAspectRatio="none">
        <defs>
          <linearGradient id="kiteAreaFill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={isUp ? "rgba(34, 197, 94, 0.35)" : "rgba(239, 68, 68, 0.35)"} />
            <stop offset="100%" stopColor="rgba(15, 20, 25, 0)" />
          </linearGradient>
        </defs>

        {[0, 0.25, 0.5, 0.75, 1].map((ratio) => {
          const y = padding.top + chartHeight * ratio;
          return (
            <line
              key={ratio}
              x1={padding.left}
              x2={width - padding.right}
              y1={y}
              y2={y}
              stroke="rgba(148, 163, 184, 0.12)"
              strokeWidth="1"
            />
          );
        })}

        <path d={area} fill="url(#kiteAreaFill)" />
        <polyline
          fill="none"
          points={line}
          stroke={isUp ? "#22c55e" : "#ef4444"}
          strokeWidth="2"
          strokeLinejoin="round"
          strokeLinecap="round"
        />

        {coords.length > 1 && (
          <>
            <text x={padding.left} y={height - 8} fill="#94a3b8" fontSize="11">
              {formatChartDate(first.date)}
            </text>
            <text x={width / 2 - 24} y={height - 8} fill="#94a3b8" fontSize="11">
              {formatChartDate(parsed[Math.floor(parsed.length / 2)].date)}
            </text>
            <text x={width - padding.right - 56} y={height - 8} fill="#94a3b8" fontSize="11">
              {formatChartDate(last.date)}
            </text>
          </>
        )}

        <text x={padding.left} y={padding.top + 8} fill="#94a3b8" fontSize="11">
          {formatNumber(max)}
        </text>
        <text x={padding.left} y={padding.top + chartHeight} fill="#94a3b8" fontSize="11">
          {formatNumber(min)}
        </text>
      </svg>
    </div>
  );
}
