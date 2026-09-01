import { useEffect, useId, useMemo, useState, type MouseEvent } from "react";
import { ChevronDown, RefreshCw } from "lucide-react";
import type { NineFifteenBreakoutTrade } from "@/types/nine-fifteen";
import { formatWeekdayFromDateKey } from "@/lib/market-time";
import { computeGapToTargetSeries } from "@/lib/breakout-target-gap";
import { rsiAtBarIndex } from "@/lib/rsi";
import { cn, formatNumber } from "@/lib/utils";
import { useBacktestIndex } from "@/contexts/backtest-index-context";

type MinuteCandle = {
  time: string;
  open: number;
  high: number;
  low: number;
  close: number;
};

const RSI_PERIOD = 14;

function computeRsiSeries(candles: MinuteCandle[]): (number | null)[] {
  const closes = candles.map((c) => c.close);
  return closes.map((_, i) => rsiAtBarIndex(closes, i, RSI_PERIOD));
}

function rsiTone(rsi: number | null | undefined): string {
  if (rsi == null || !Number.isFinite(rsi)) return "";
  if (rsi >= 70) return "text-up";
  if (rsi <= 30) return "text-down";
  return "";
}

function istHmFromCandleTime(time: string): string {
  const m = /(\d{2}):(\d{2})/.exec(time);
  if (!m) return time;
  return `${m[1]}:${m[2]}`;
}

function minutesFromIstLabel(label: string): number | null {
  const m = /^(\d{1,2}):(\d{2})/.exec(label.trim());
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
}

function formatClosestToTargetLabel(
  approach: NonNullable<NineFifteenBreakoutTrade["closestToTarget"]>,
  indexLabel: string,
): string {
  const time = approach.timeIst.slice(0, 8);
  const spot = formatNumber(approach.indexPrice, 2);
  const target = formatNumber(approach.targetIndexPrice, 2);
  if (approach.gapToTargetPts <= 0) {
    return `Nearest to target · ${time} IST · ${indexLabel} ${spot} · target ±${approach.targetPoints} hit @ ${target}`;
  }
  return `Nearest to target · ${time} IST · ${indexLabel} ${spot} · ${formatNumber(approach.gapToTargetPts, 2)} pts from target ${target} (±${approach.targetPoints})`;
}

function breakoutBandLabel(band: NineFifteenBreakoutTrade["band"]): string {
  return band === "main" ? "Main" : "Near-miss";
}

function formatExitVsStopPts(pts: number | undefined): { text: string; className: string } {
  if (pts == null || !Number.isFinite(pts)) {
    return { text: "—", className: "text-muted" };
  }
  const rounded = Number(pts.toFixed(2));
  if (rounded === 0) {
    return { text: "0.00", className: "text-muted" };
  }
  const sign = rounded > 0 ? "+" : "−";
  return {
    text: `${sign}${formatNumber(Math.abs(rounded), 2)}`,
    className: rounded > 0 ? "text-down" : "text-up",
  };
}

function BreakoutSessionMinuteChart({
  candles,
  entryPrice,
  side,
  stopPoints,
  targetPoints,
  stopActiveFromIst,
  stopExitTimeIst,
}: {
  candles: MinuteCandle[];
  entryPrice: number | null;
  side: "CE" | "PE";
  stopPoints: number;
  targetPoints: number;
  stopActiveFromIst: string;
  stopExitTimeIst?: string | null;
}) {
  const index = useBacktestIndex();
  const gradId = useId().replace(/:/g, "");
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);
  const width = 920;
  const padL = 52;
  const padR = 12;
  const padT = 16;
  const padB = 28;
  const pricePlotH = 248;
  const rsiGap = 14;
  const rsiPlotH = 68;
  const height = padT + pricePlotH + rsiGap + rsiPlotH + padB;
  const plotW = width - padL - padR;
  const rsiTop = padT + pricePlotH + rsiGap;

  const rsiSeries = useMemo(() => computeRsiSeries(candles), [candles]);

  const levels = useMemo(() => {
    const list: { price: number; label: string; tone: "entry" | "target" | "stop" }[] = [];
    if (entryPrice == null) return list;
    const signed = side === "CE" ? 1 : -1;
    list.push({ price: entryPrice, label: "Entry", tone: "entry" });
    list.push({
      price: entryPrice + signed * targetPoints,
      label: `Target ±${targetPoints}`,
      tone: "target",
    });
    list.push({
      price: entryPrice - signed * stopPoints,
      label: `Stop ∓${stopPoints}`,
      tone: "stop",
    });
    return list;
  }, [entryPrice, side, stopPoints, targetPoints]);

  const { yMin, yMax, candleW } = useMemo(() => {
    const prices = candles.flatMap((c) => [c.high, c.low]);
    for (const lv of levels) prices.push(lv.price);
    const min = Math.min(...prices);
    const max = Math.max(...prices);
    const pad = Math.max(2, (max - min) * 0.06);
    return {
      yMin: min - pad,
      yMax: max + pad,
      candleW: Math.max(1.2, plotW / Math.max(candles.length, 1)),
    };
  }, [candles, levels, plotW]);

  const yScale = (price: number) => padT + ((yMax - price) / (yMax - yMin || 1)) * pricePlotH;
  const yScaleRsi = (rsi: number) => rsiTop + ((100 - rsi) / 100) * rsiPlotH;
  const xScale = (i: number) => padL + i * candleW + candleW / 2;

  const verticalAtIst = (istTime: string | null | undefined): number | null => {
    const minute = istTime ? minutesFromIstLabel(istTime) : null;
    if (minute == null) return null;
    const idx = candles.findIndex((c) => {
      const mins = minutesFromIstLabel(istHmFromCandleTime(c.time));
      return mins != null && mins >= minute;
    });
    return idx >= 0 ? xScale(idx) : null;
  };

  const stopActiveX = verticalAtIst(stopActiveFromIst);
  const stopExitX = verticalAtIst(stopExitTimeIst);

  const tickIdx = [0, Math.floor(candles.length / 3), Math.floor((candles.length * 2) / 3), candles.length - 1].filter(
    (v, i, arr) => v >= 0 && arr.indexOf(v) === i,
  );

  const rsiLinePath = useMemo(() => {
    const parts: string[] = [];
    for (let i = 0; i < rsiSeries.length; i += 1) {
      const rsi = rsiSeries[i];
      if (rsi == null) continue;
      const cmd = parts.length === 0 ? "M" : "L";
      parts.push(`${cmd}${xScale(i).toFixed(2)},${yScaleRsi(rsi).toFixed(2)}`);
    }
    return parts.join(" ");
  }, [rsiSeries, candleW, rsiTop, rsiPlotH]);

  const handleChartMouseMove = (e: MouseEvent<SVGSVGElement>) => {
    const svg = e.currentTarget;
    const pt = svg.createSVGPoint();
    pt.x = e.clientX;
    pt.y = e.clientY;
    const ctm = svg.getScreenCTM();
    if (!ctm) return;
    const svgPt = pt.matrixTransform(ctm.inverse());
    const i = Math.floor((svgPt.x - padL) / candleW);
    if (i >= 0 && i < candles.length) setHoverIndex(i);
    else setHoverIndex(null);
  };

  const hoverCandle = hoverIndex != null ? candles[hoverIndex] : null;
  const hoverRsi = hoverIndex != null ? rsiSeries[hoverIndex] : null;
  const hoverX = hoverIndex != null ? xScale(hoverIndex) : null;
  const tipX =
    hoverX != null ? Math.min(Math.max(hoverX + 10, padL + 4), width - padR - 168) : 0;
  const tipY = padT + 6;

  return (
    <svg
      className="nf-day-chart-svg nf-day-chart-svg--rsi"
      viewBox={`0 0 ${width} ${height}`}
      role="img"
      aria-label={`${index.shortLabel} 1-minute candles 9:15 to 15:30 with RSI`}
      onMouseMove={handleChartMouseMove}
      onMouseLeave={() => setHoverIndex(null)}
    >
      <defs>
        <linearGradient id={`nf-breakout-grid-${gradId}`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="currentColor" stopOpacity="0.08" />
          <stop offset="100%" stopColor="currentColor" stopOpacity="0.02" />
        </linearGradient>
        <linearGradient id={`nf-breakout-rsi-grid-${gradId}`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="currentColor" stopOpacity="0.05" />
          <stop offset="100%" stopColor="currentColor" stopOpacity="0.02" />
        </linearGradient>
      </defs>

      <rect x={padL} y={padT} width={plotW} height={pricePlotH} fill={`url(#nf-breakout-grid-${gradId})`} />
      <rect
        x={padL}
        y={rsiTop}
        width={plotW}
        height={rsiPlotH}
        fill={`url(#nf-breakout-rsi-grid-${gradId})`}
      />

      {[0, 0.25, 0.5, 0.75, 1].map((t) => {
        const y = padT + pricePlotH * t;
        const price = yMax - t * (yMax - yMin);
        return (
          <g key={t}>
            <line x1={padL} y1={y} x2={padL + plotW} y2={y} className="nf-day-chart-grid" />
            <text x={padL - 6} y={y + 3} textAnchor="end" className="nf-day-chart-axis">
              {price.toFixed(0)}
            </text>
          </g>
        );
      })}

      {candles.map((c, i) => {
        const x = xScale(i);
        const yO = yScale(c.open);
        const yC = yScale(c.close);
        const yH = yScale(c.high);
        const yL = yScale(c.low);
        const up = c.close >= c.open;
        const bodyTop = Math.min(yO, yC);
        const bodyH = Math.max(1, Math.abs(yC - yO));
        const w = Math.max(1, candleW * 0.7);
        const dimmed = hoverIndex != null && hoverIndex !== i;
        return (
          <g
            key={`${c.time}-${i}`}
            className={cn(
              up ? "nf-day-candle--up" : "nf-day-candle--down",
              dimmed && "nf-day-candle--dimmed",
            )}
          >
            <line x1={x} y1={yH} x2={x} y2={yL} />
            <rect x={x - w / 2} y={bodyTop} width={w} height={bodyH} />
          </g>
        );
      })}

      {levels.map((lv) => (
        <g key={lv.label}>
          <line
            x1={padL}
            y1={yScale(lv.price)}
            x2={padL + plotW}
            y2={yScale(lv.price)}
            className={cn(
              "nf-day-chart-level",
              lv.tone === "entry" && "nf-day-chart-level--entry",
              lv.tone === "target" && "nf-day-chart-level--target",
              lv.tone === "stop" && "nf-day-chart-level--stop",
            )}
          />
          <text
            x={padL + plotW - 4}
            y={yScale(lv.price) - 4}
            textAnchor="end"
            className="nf-day-chart-level-label"
          >
            {lv.label} {lv.price.toFixed(2)}
          </text>
        </g>
      ))}

      {stopActiveX != null && (
        <line
          x1={stopActiveX}
          y1={padT}
          x2={stopActiveX}
          y2={rsiTop + rsiPlotH}
          className="nf-day-chart-switch-x"
        />
      )}
      {stopExitX != null && (
        <line
          x1={stopExitX}
          y1={padT}
          x2={stopExitX}
          y2={rsiTop + rsiPlotH}
          className="nf-day-chart-stop-exit-x"
        />
      )}

      <text x={padL} y={rsiTop - 4} className="nf-day-chart-rsi-label">
        RSI({RSI_PERIOD})
      </text>
      {[30, 50, 70].map((level) => (
        <g key={level}>
          <line
            x1={padL}
            y1={yScaleRsi(level)}
            x2={padL + plotW}
            y2={yScaleRsi(level)}
            className={cn(
              "nf-day-chart-rsi-grid",
              (level === 30 || level === 70) && "nf-day-chart-rsi-grid--band",
            )}
          />
          <text x={padL - 6} y={yScaleRsi(level) + 3} textAnchor="end" className="nf-day-chart-axis">
            {level}
          </text>
        </g>
      ))}
      {rsiLinePath && <path d={rsiLinePath} className="nf-day-chart-rsi-line" fill="none" />}

      {hoverIndex != null && hoverRsi != null && hoverX != null && (
        <circle
          cx={hoverX}
          cy={yScaleRsi(hoverRsi)}
          r={3.5}
          className="nf-day-chart-rsi-dot"
        />
      )}

      {hoverX != null && (
        <line
          x1={hoverX}
          y1={padT}
          x2={hoverX}
          y2={rsiTop + rsiPlotH}
          className="nf-day-chart-crosshair"
        />
      )}

      {hoverCandle && hoverX != null && (
        <g className="nf-chart-hover-tip" transform={`translate(${tipX}, ${tipY})`}>
          <rect x={0} y={0} width={168} height={44} rx={4} className="nf-chart-hover-tip-bg" />
          <text x={8} y={14} className="nf-chart-hover-tip-text">
            {istHmFromCandleTime(hoverCandle.time)} IST
          </text>
          <text x={8} y={28} className="nf-chart-hover-tip-text">
            {index.shortLabel} {formatNumber(hoverCandle.close, 2)}
          </text>
          <text
            x={8}
            y={40}
            className={cn("nf-chart-hover-tip-text nf-chart-hover-tip-rsi", rsiTone(hoverRsi))}
          >
            RSI {hoverRsi != null ? formatNumber(hoverRsi, 2) : "—"}
          </text>
        </g>
      )}

      {tickIdx.map((i) => (
        <text key={i} x={xScale(i)} y={height - 8} textAnchor="middle" className="nf-day-chart-axis">
          {istHmFromCandleTime(candles[i].time)}
        </text>
      ))}

      <rect
        x={padL}
        y={padT}
        width={plotW}
        height={pricePlotH + rsiGap + rsiPlotH}
        fill="transparent"
        className="nf-day-chart-hover-layer"
      />
    </svg>
  );
}

function BreakoutTargetGapChart({
  candles,
  entryPrice,
  side,
  targetPoints,
  stopActiveFromIst,
  stopExitTimeIst,
}: {
  candles: MinuteCandle[];
  entryPrice: number | null;
  side: "CE" | "PE";
  targetPoints: number;
  stopActiveFromIst: string;
  stopExitTimeIst?: string | null;
}) {
  const gradId = useId().replace(/:/g, "");
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);
  const width = 920;
  const padL = 52;
  const padR = 12;
  const padT = 20;
  const padB = 28;
  const plotH = 112;
  const height = padT + plotH + padB;
  const plotW = width - padL - padR;

  const gapByIndex = useMemo(() => {
    if (entryPrice == null) return candles.map(() => null as number | null);
    const series = computeGapToTargetSeries(candles, entryPrice, side, targetPoints);
    const byMins = new Map(series.map((p) => [p.mins, p.gapPts]));
    return candles.map((c) => {
      const mins = minutesFromIstLabel(istHmFromCandleTime(c.time));
      return mins != null ? (byMins.get(mins) ?? null) : null;
    });
  }, [candles, entryPrice, side, targetPoints]);

  const { yMax, candleW } = useMemo(() => {
    const gaps = gapByIndex.filter((g): g is number => g != null);
    const maxGap = gaps.length > 0 ? Math.max(...gaps) : 10;
    const pad = Math.max(2, maxGap * 0.08);
    return {
      yMax: maxGap + pad,
      candleW: Math.max(1.2, plotW / Math.max(candles.length, 1)),
    };
  }, [gapByIndex, candles.length, plotW]);

  const yScale = (gap: number) => padT + ((yMax - gap) / (yMax || 1)) * plotH;
  const xScale = (i: number) => padL + i * candleW + candleW / 2;

  const verticalAtIst = (istTime: string | null | undefined): number | null => {
    const minute = istTime ? minutesFromIstLabel(istTime) : null;
    if (minute == null) return null;
    const idx = candles.findIndex((c) => {
      const mins = minutesFromIstLabel(istHmFromCandleTime(c.time));
      return mins != null && mins >= minute;
    });
    return idx >= 0 ? xScale(idx) : null;
  };

  const stopActiveX = verticalAtIst(stopActiveFromIst);
  const stopExitX = verticalAtIst(stopExitTimeIst);

  const linePath = useMemo(() => {
    const parts: string[] = [];
    for (let i = 0; i < gapByIndex.length; i += 1) {
      const gap = gapByIndex[i];
      if (gap == null) continue;
      const cmd = parts.length === 0 ? "M" : "L";
      parts.push(`${cmd}${xScale(i).toFixed(2)},${yScale(gap).toFixed(2)}`);
    }
    return parts.join(" ");
  }, [gapByIndex, candleW, yMax, plotH]);

  const tickIdx = [0, Math.floor(candles.length / 3), Math.floor((candles.length * 2) / 3), candles.length - 1].filter(
    (v, i, arr) => v >= 0 && arr.indexOf(v) === i,
  );

  const handleChartMouseMove = (e: MouseEvent<SVGSVGElement>) => {
    const svg = e.currentTarget;
    const pt = svg.createSVGPoint();
    pt.x = e.clientX;
    pt.y = e.clientY;
    const ctm = svg.getScreenCTM();
    if (!ctm) return;
    const svgPt = pt.matrixTransform(ctm.inverse());
    const i = Math.floor((svgPt.x - padL) / candleW);
    if (i >= 0 && i < candles.length && gapByIndex[i] != null) setHoverIndex(i);
    else setHoverIndex(null);
  };

  const hoverGap = hoverIndex != null ? gapByIndex[hoverIndex] : null;
  const hoverX = hoverIndex != null ? xScale(hoverIndex) : null;
  const tipX =
    hoverX != null ? Math.min(Math.max(hoverX + 10, padL + 4), width - padR - 176) : 0;
  const tipY = padT + 4;

  if (entryPrice == null) return null;

  return (
    <svg
      className="nf-day-chart-svg nf-day-chart-svg--gap"
      viewBox={`0 0 ${width} ${height}`}
      role="img"
      aria-label={`Distance from fixed ±${targetPoints} profit target over the session`}
      onMouseMove={handleChartMouseMove}
      onMouseLeave={() => setHoverIndex(null)}
    >
      <defs>
        <linearGradient id={`nf-breakout-gap-grid-${gradId}`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="currentColor" stopOpacity="0.06" />
          <stop offset="100%" stopColor="currentColor" stopOpacity="0.02" />
        </linearGradient>
      </defs>

      <rect x={padL} y={padT} width={plotW} height={plotH} fill={`url(#nf-breakout-gap-grid-${gradId})`} />

      <text x={padL} y={padT - 6} className="nf-day-chart-gap-label">
        Pts from target ±{targetPoints} (0 = target touched)
      </text>

      {[0, 0.5, 1].map((t) => {
        const y = padT + plotH * t;
        const gap = yMax - t * yMax;
        return (
          <g key={t}>
            <line x1={padL} y1={y} x2={padL + plotW} y2={y} className="nf-day-chart-grid" />
            <text x={padL - 6} y={y + 3} textAnchor="end" className="nf-day-chart-axis">
              {gap.toFixed(0)}
            </text>
          </g>
        );
      })}

      <line
        x1={padL}
        y1={yScale(0)}
        x2={padL + plotW}
        y2={yScale(0)}
        className="nf-day-chart-gap-zero"
      />
      <text x={padL + plotW - 4} y={yScale(0) - 4} textAnchor="end" className="nf-day-chart-level-label">
        Target hit (0 pts)
      </text>

      {linePath && <path d={linePath} className="nf-day-chart-gap-line" fill="none" />}

      {stopActiveX != null && (
        <line
          x1={stopActiveX}
          y1={padT}
          x2={stopActiveX}
          y2={padT + plotH}
          className="nf-day-chart-switch-x"
        />
      )}
      {stopExitX != null && (
        <line
          x1={stopExitX}
          y1={padT}
          x2={stopExitX}
          y2={padT + plotH}
          className="nf-day-chart-stop-exit-x"
        />
      )}

      {hoverX != null && (
        <line
          x1={hoverX}
          y1={padT}
          x2={hoverX}
          y2={padT + plotH}
          className="nf-day-chart-crosshair"
        />
      )}

      {hoverIndex != null && hoverGap != null && hoverX != null && (
        <>
          <circle
            cx={hoverX}
            cy={yScale(hoverGap)}
            r={3.5}
            className="nf-day-chart-gap-dot"
          />
          <g className="nf-chart-hover-tip" transform={`translate(${tipX}, ${tipY})`}>
            <rect x={0} y={0} width={176} height={44} rx={4} className="nf-chart-hover-tip-bg" />
            <text x={8} y={14} className="nf-chart-hover-tip-text">
              {istHmFromCandleTime(candles[hoverIndex].time)} IST
            </text>
            <text x={8} y={28} className="nf-chart-hover-tip-text">
              {formatNumber(hoverGap, 2)} pts from target
            </text>
            <text x={8} y={40} className="nf-chart-hover-tip-text">
              Target ±{targetPoints}
            </text>
          </g>
        </>
      )}

      {tickIdx.map((i) => (
        <text key={i} x={xScale(i)} y={height - 8} textAnchor="middle" className="nf-day-chart-axis">
          {istHmFromCandleTime(candles[i].time)}
        </text>
      ))}

      <rect
        x={padL}
        y={padT}
        width={plotW}
        height={plotH}
        fill="transparent"
        className="nf-day-chart-hover-layer"
      />
    </svg>
  );
}

function BreakoutDayAccordionItem({
  trade,
  kind,
}: {
  trade: NineFifteenBreakoutTrade;
  kind: "missed-win" | "stopped-loss";
}) {
  const index = useBacktestIndex();
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [candles, setCandles] = useState<MinuteCandle[] | null>(null);

  useEffect(() => {
    if (!open || candles != null) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    void (async () => {
      try {
        const res = await fetch(
          `/api/kite/index-session-minutes?date=${encodeURIComponent(trade.date)}&index=${index.key}`,
          { credentials: "include" },
        );
        const json = (await res.json()) as {
          data?: { candles?: MinuteCandle[] };
          error?: string;
        };
        if (!res.ok) throw new Error(json.error ?? "Failed to load candles");
        if (!cancelled) setCandles(json.data?.candles ?? []);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : "Failed to load candles");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, candles, trade.date]);

  const entry = trade.entry?.indexPrice ?? null;
  const vsStop = formatExitVsStopPts(trade.stopHit?.exitVsStopPts);
  const stopActiveLabel = trade.stopActiveFromIst.slice(0, 5);

  return (
    <details
      className="nf-loss-day"
      onToggle={(e) => setOpen((e.target as HTMLDetailsElement).open)}
    >
      <summary className="nf-loss-day-summary">
        <ChevronDown size={14} className="nf-loss-day-chevron" aria-hidden />
        <span className="nf-loss-day-date font-mono">{trade.date}</span>
        <span className="text-muted text-sm">{formatWeekdayFromDateKey(trade.date)}</span>
        <span className={cn("nf-side-tag", trade.side === "CE" ? "nf-side-tag--ce" : "nf-side-tag--pe")}>
          {trade.side}
        </span>
        <span className="text-sm text-muted">{breakoutBandLabel(trade.band)}</span>
        <span className="text-sm">
          Δ{" "}
          <span
            className={cn(
              "font-mono",
              trade.change > 0 ? "text-up" : trade.change < 0 ? "text-down" : "",
            )}
          >
            {formatNumber(trade.change, 2)}
          </span>
        </span>
        <span className="text-sm text-muted">
          Entry <span className="font-mono">{entry != null ? formatNumber(entry, 2) : "—"}</span>
        </span>
        <span className="text-sm text-down">
          Stop {trade.stopHit?.timeIst ?? "—"}
          {trade.stopHit?.exitIndexPrice != null && (
            <>
              {" "}
              @ <span className="font-mono">{formatNumber(trade.stopHit.exitIndexPrice, 2)}</span>
            </>
          )}
        </span>
        <span className={cn("text-sm font-mono", vsStop.className)}>Δ stop {vsStop.text}</span>
        {trade.closestToTarget && (
          <span
            className={cn(
              "text-sm",
              trade.closestToTarget.gapToTargetPts <= 0 ? "text-up" : "text-muted",
            )}
          >
            {formatClosestToTargetLabel(trade.closestToTarget, index.shortLabel)}
          </span>
        )}
        {kind === "missed-win" && trade.targetHit && (
          <span className="text-sm text-up">
            Target {trade.targetHit.timeIst} ({trade.targetHit.levelLabel})
          </span>
        )}
        {kind === "stopped-loss" && (
          <span className="text-sm text-muted">
            {trade.targetHit ? (
              <span className="text-up">
                Target {trade.targetHit.timeIst} ({trade.targetHit.levelLabel})
              </span>
            ) : (
              "Target never reached"
            )}
          </span>
        )}
      </summary>

      <div className="nf-loss-day-body">
        <div className="nf-loss-day-meta text-muted text-sm">
          {trade.closestToTarget ? (
            <>
              Nearest to profit target:{" "}
              <strong>{trade.closestToTarget.timeIst}</strong> IST · {index.shortLabel}{" "}
              {formatNumber(trade.closestToTarget.indexPrice, 2)}
              {trade.closestToTarget.gapToTargetPts <= 0 ? (
                <>
                  {" "}
                  — <span className="text-up">±{trade.closestToTarget.targetPoints} target hit</span> @{" "}
                  {formatNumber(trade.closestToTarget.targetIndexPrice, 2)}
                </>
              ) : (
                <>
                  {" "}
                  —{" "}
                  <span className="font-mono">
                    {formatNumber(trade.closestToTarget.gapToTargetPts, 2)} pts
                  </span>{" "}
                  away from target {formatNumber(trade.closestToTarget.targetIndexPrice, 2)} (±
                  {trade.closestToTarget.targetPoints} at that minute)
                </>
              )}
              .{" "}
            </>
          ) : null}
          Stop level{" "}
          {trade.stopHit
            ? `${formatNumber(trade.stopHit.indexPrice, 2)} (${trade.stopHit.levelLabel})`
            : "—"}
          {" · "}
          Stop active from {stopActiveLabel} IST (blue line)
          {trade.stopHit?.timeIst && <> · Exit at {trade.stopHit.timeIst} (red line)</>}
          {" · "}
          Full session 1-min candles (9:15–15:30) · hover charts for RSI and gap-to-target
        </div>

        {loading && (
          <div className="nf-loss-day-status">
            <RefreshCw size={14} className="spin" /> Loading minute candles…
          </div>
        )}
        {error && <div className="nf-loss-day-status nf-loss-day-status--err">{error}</div>}
        {!loading && !error && candles && candles.length === 0 && (
          <div className="nf-loss-day-status">No Kite minute candles for this session.</div>
        )}
        {!loading && !error && candles && candles.length > 0 && (
          <div className="nf-day-chart-stack">
            <div className="nf-day-chart-wrap">
              <BreakoutSessionMinuteChart
                candles={candles}
                entryPrice={entry}
                side={trade.side}
                stopPoints={trade.stopPoints}
                targetPoints={trade.targetPoints}
                stopActiveFromIst={trade.stopActiveFromIst}
                stopExitTimeIst={trade.stopHit?.timeIst}
              />
            </div>
            <div className="nf-day-chart-wrap nf-day-chart-wrap--gap">
              <BreakoutTargetGapChart
                candles={candles}
                entryPrice={entry}
                side={trade.side}
                targetPoints={trade.targetPoints}
                stopActiveFromIst={trade.stopActiveFromIst}
                stopExitTimeIst={trade.stopHit?.timeIst}
              />
            </div>
          </div>
        )}
      </div>
    </details>
  );
}

export function BreakoutTradesAccordion({
  trades,
  kind,
  stopActiveFromIst,
  stopActiveFromIstTuesday,
}: {
  trades: NineFifteenBreakoutTrade[];
  kind: "missed-win" | "stopped-loss";
  stopActiveFromIst: string;
  stopActiveFromIstTuesday: string;
}) {
  const index = useBacktestIndex();
  const sc = (points: number) => points * index.pointScale;
  if (trades.length === 0) return null;

  const stopLabel = stopActiveFromIst.slice(0, 5);
  const stopTuesdayLabel = stopActiveFromIstTuesday.slice(0, 5);

  return (
    <div className="nf-loss-accordion">
      <p className="nf-loss-accordion-hint text-muted text-sm">
        Expand a day to load that session’s {index.label} 1-min candles (9:15–15:30). Entry, initial
        target, and stop levels are overlaid on the price chart; RSI(14) sits below it. A second chart
        shows how many index points {index.shortLabel} was from the entry profit target (±{sc(25)} main
        · ±{sc(20)} near-miss · ±{sc(10)} on {index.expiryWeekday}) at each minute (0 = target touched).
        Hover either chart for details. Blue vertical = stop active from {stopLabel} IST (
        {stopTuesdayLabel} IST on {index.expiryWeekday}); red vertical = stop exit minute (when
        applicable).
      </p>
      {trades.map((trade) => (
        <BreakoutDayAccordionItem key={`${kind}-${trade.date}`} trade={trade} kind={kind} />
      ))}
    </div>
  );
}
