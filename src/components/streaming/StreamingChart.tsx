import { useEffect, useRef } from "react";
import type { ParsedCandle } from "@/lib/candles";
import type { RsiPoint } from "@/lib/technical-indicators";

interface StreamingChartProps {
  candles: ParsedCandle[];
  /** 1-minute RSI series (session + stream) — aligned to chart time axis */
  rsiSeries: RsiPoint[];
  height?: number;
  symbol?: string;
}

const COLORS = {
  bgTop: "#0c0c0e",
  bgBottom: "#050506",
  panelBorder: "rgba(255, 255, 255, 0.1)",
  grid: "rgba(255, 255, 255, 0.05)",
  axis: "rgba(255, 255, 255, 0.28)",
  label: "rgba(255, 255, 255, 0.78)",
  labelDim: "rgba(255, 255, 255, 0.42)",
  bull: "#22c997",
  bullGlow: "rgba(34, 201, 151, 0.35)",
  bear: "#f05252",
  bearGlow: "rgba(240, 82, 82, 0.35)",
  bullVol: "rgba(34, 201, 151, 0.55)",
  bearVol: "rgba(240, 82, 82, 0.5)",
  rsi: "#a78bfa",
  rsiFill: "rgba(167, 139, 250, 0.12)",
  rsiBand: "rgba(255, 255, 255, 0.08)",
  lastPrice: "#f05252",
  lastPriceBg: "rgba(240, 82, 82, 0.18)",
};

const MAX_VISIBLE = 120;
const MIN_SLOT = 4;
const MAX_SLOT = 16;
const MIN_LABEL_GAP = 78;

interface PanelRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

interface ChartLayout {
  width: number;
  height: number;
  pad: { top: number; right: number; bottom: number; left: number };
  price: PanelRect;
  volume: PanelRect;
  rsi: PanelRect;
  yMin: number;
  yMax: number;
  startIndex: number;
  visibleCount: number;
  slotWidth: number;
}

function niceStep(range: number, targetTicks: number) {
  const rough = range / Math.max(targetTicks, 1);
  const magnitude = 10 ** Math.floor(Math.log10(rough));
  const normalized = rough / magnitude;
  let nice = 1;
  if (normalized >= 7.5) nice = 10;
  else if (normalized >= 3.5) nice = 5;
  else if (normalized >= 1.5) nice = 2;
  return nice * magnitude;
}

function priceTicks(min: number, max: number, count = 5) {
  const step = niceStep(max - min, count);
  const start = Math.ceil(min / step) * step;
  const ticks: number[] = [];
  for (let v = start; v <= max + step * 0.001; v += step) {
    ticks.push(Number(v.toFixed(2)));
  }
  if (ticks.length < 2) {
    return [min, max].map((v) => Number(v.toFixed(2)));
  }
  return ticks;
}

function computeLayout(width: number, height: number, candles: ParsedCandle[]): ChartLayout | null {
  if (candles.length === 0) return null;

  const pad = { top: 12, right: 72, bottom: 34, left: 56 };
  const innerH = height - pad.top - pad.bottom;
  const gap = 6;
  const priceH = Math.floor(innerH * 0.56);
  const volH = Math.floor(innerH * 0.15);
  const rsiH = innerH - priceH - volH - gap * 2;
  const plotW = width - pad.left - pad.right;

  const visibleCount = Math.min(candles.length, MAX_VISIBLE);
  const startIndex = candles.length - visibleCount;
  const visible = candles.slice(startIndex);
  const slotWidth = Math.min(MAX_SLOT, Math.max(MIN_SLOT, plotW / visibleCount));

  const minPrice = Math.min(...visible.map((c) => c.low));
  const maxPrice = Math.max(...visible.map((c) => c.high));
  const priceRange = Math.max(maxPrice - minPrice, 0.5);
  const yMin = minPrice - priceRange * 0.1;
  const yMax = maxPrice + priceRange * 0.1;

  const priceTop = pad.top;
  const volTop = priceTop + priceH + gap;
  const rsiTop = volTop + volH + gap;

  return {
    width,
    height,
    pad,
    price: { left: pad.left, top: priceTop, width: plotW, height: priceH },
    volume: { left: pad.left, top: volTop, width: plotW, height: volH },
    rsi: { left: pad.left, top: rsiTop, width: plotW, height: rsiH },
    yMin,
    yMax,
    startIndex,
    visibleCount,
    slotWidth,
  };
}

function yForPrice(price: number, panel: PanelRect, yMin: number, yMax: number) {
  return panel.top + ((yMax - price) / (yMax - yMin)) * panel.height;
}

function indexForTimestamp(candles: ParsedCandle[], ts: number) {
  if (candles.length === 0) return 0;
  if (ts <= candles[0].timestamp) return 0;
  for (let i = candles.length - 1; i >= 0; i -= 1) {
    if (candles[i].timestamp <= ts) return i;
  }
  return 0;
}

function formatTimeLabel(ts: number, spanMs: number) {
  const d = new Date(ts);
  if (spanMs <= 90_000) {
    return d.toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
  }
  if (spanMs <= 3_600_000) {
    return d.toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit", hour12: false });
  }
  return d.toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit", hour12: false });
}

function pickTimeLabelIndices(candles: ParsedCandle[], startIndex: number, xForIndex: (i: number) => number) {
  const visible = candles.slice(startIndex);
  if (visible.length === 0) return [] as number[];

  const indices: number[] = [];
  let lastX = -Infinity;

  const maxLabels = Math.max(3, Math.min(8, Math.floor(candles.length / 3)));
  const step = Math.max(1, Math.ceil(visible.length / maxLabels));

  for (let localIdx = 0; localIdx < visible.length; localIdx += step) {
    const globalIdx = startIndex + localIdx;
    const x = xForIndex(globalIdx);
    if (x - lastX >= MIN_LABEL_GAP || indices.length === 0) {
      indices.push(globalIdx);
      lastX = x;
    }
  }

  const lastGlobal = candles.length - 1;
  if (!indices.includes(lastGlobal)) {
    const lastXPos = xForIndex(lastGlobal);
    if (lastXPos - lastX >= MIN_LABEL_GAP * 0.65) {
      indices.push(lastGlobal);
    }
  }

  return indices;
}

function drawPanelFrame(ctx: CanvasRenderingContext2D, panel: PanelRect) {
  ctx.strokeStyle = COLORS.panelBorder;
  ctx.lineWidth = 1;
  ctx.strokeRect(panel.left + 0.5, panel.top + 0.5, panel.width - 1, panel.height - 1);
}

function drawHorizontalGrid(
  ctx: CanvasRenderingContext2D,
  panel: PanelRect,
  ticks: number[],
  yMin: number,
  yMax: number,
  drawLabels: boolean,
  labelFormatter: (v: number) => string
) {
  ctx.strokeStyle = COLORS.grid;
  ctx.lineWidth = 1;
  ctx.fillStyle = COLORS.label;
  ctx.font = "11px ui-monospace, SFMono-Regular, Menlo, monospace";
  ctx.textAlign = "right";
  ctx.textBaseline = "middle";

  for (const value of ticks) {
    const y = yForPrice(value, panel, yMin, yMax);
    ctx.beginPath();
    ctx.moveTo(panel.left, y + 0.5);
    ctx.lineTo(panel.left + panel.width, y + 0.5);
    ctx.stroke();

    if (drawLabels) {
      ctx.fillText(labelFormatter(value), panel.left - 6, y);
    }
  }
}

function drawTimeAxis(
  ctx: CanvasRenderingContext2D,
  layout: ChartLayout,
  candles: ParsedCandle[],
  labelIndices: number[],
  xForIndex: (index: number) => number
) {
  const visible = candles.slice(layout.startIndex);
  const spanMs =
    visible.length >= 2
      ? visible[visible.length - 1].timestamp - visible[0].timestamp
      : 60_000;
  const axisY = layout.rsi.top + layout.rsi.height + 10;

  ctx.strokeStyle = COLORS.axis;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(layout.pad.left, layout.rsi.top + layout.rsi.height);
  ctx.lineTo(layout.pad.left + layout.price.width, layout.rsi.top + layout.rsi.height);
  ctx.stroke();

  ctx.fillStyle = COLORS.labelDim;
  ctx.font = "10px ui-monospace, SFMono-Regular, Menlo, monospace";
  ctx.textAlign = "center";
  ctx.textBaseline = "top";

  for (const idx of labelIndices) {
    const candle = candles[idx];
    if (!candle) continue;
    const x = xForIndex(idx);
    ctx.fillStyle = COLORS.grid;
    ctx.fillRect(x, layout.price.top, 1, layout.rsi.top + layout.rsi.height - layout.price.top);
    ctx.fillStyle = COLORS.labelDim;
    ctx.fillText(formatTimeLabel(candle.timestamp, spanMs), x, axisY);
  }
}

export function StreamingChart({
  candles,
  rsiSeries,
  height = 480,
  symbol = "Chart",
}: StreamingChartProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container || candles.length === 0) return;

    const draw = () => {
      const width = container.clientWidth;
      const dpr = window.devicePixelRatio || 1;
      canvas.width = width * dpr;
      canvas.height = height * dpr;
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;

      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, width, height);

      const layout = computeLayout(width, height, candles);
      if (!layout) return;

      const bgGrad = ctx.createLinearGradient(0, 0, 0, height);
      bgGrad.addColorStop(0, COLORS.bgTop);
      bgGrad.addColorStop(1, COLORS.bgBottom);
      ctx.fillStyle = bgGrad;
      ctx.fillRect(0, 0, width, height);

      const plotRight = layout.pad.left + layout.price.width;
      const xForIndex = (globalIndex: number) =>
        plotRight - (candles.length - 1 - globalIndex) * layout.slotWidth - layout.slotWidth / 2;

      const visible = candles.slice(layout.startIndex);
      const priceTickValues = priceTicks(layout.yMin, layout.yMax, 5);
      const labelIndices = pickTimeLabelIndices(candles, layout.startIndex, xForIndex);

      drawHorizontalGrid(ctx, layout.price, priceTickValues, layout.yMin, layout.yMax, true, (v) =>
        v.toFixed(2)
      );
      drawPanelFrame(ctx, layout.price);

      visible.forEach((candle, localIdx) => {
        const index = layout.startIndex + localIdx;
        const x = xForIndex(index);
        const openY = yForPrice(candle.open, layout.price, layout.yMin, layout.yMax);
        const closeY = yForPrice(candle.close, layout.price, layout.yMin, layout.yMax);
        const highY = yForPrice(candle.high, layout.price, layout.yMin, layout.yMax);
        const lowY = yForPrice(candle.low, layout.price, layout.yMin, layout.yMax);
        const bullish = candle.close >= candle.open;
        const color = bullish ? COLORS.bull : COLORS.bear;
        const bodyW = Math.max(3, layout.slotWidth * 0.62);

        ctx.strokeStyle = color;
        ctx.lineWidth = 1.25;
        ctx.beginPath();
        ctx.moveTo(x + 0.5, highY);
        ctx.lineTo(x + 0.5, lowY);
        ctx.stroke();

        const bodyTop = Math.min(openY, closeY);
        let bodyHeight = Math.abs(closeY - openY);
        if (bodyHeight < 1.5) bodyHeight = 1.5;

        ctx.shadowColor = bullish ? COLORS.bullGlow : COLORS.bearGlow;
        ctx.shadowBlur = 6;
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.roundRect(x - bodyW / 2, bodyTop, bodyW, bodyHeight, 1.5);
        ctx.fill();
        ctx.shadowBlur = 0;
      });

      const last = candles[candles.length - 1];
      const lastY = yForPrice(last.close, layout.price, layout.yMin, layout.yMax);
      ctx.strokeStyle = COLORS.lastPrice;
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 4]);
      ctx.beginPath();
      ctx.moveTo(layout.pad.left, lastY);
      ctx.lineTo(plotRight, lastY);
      ctx.stroke();
      ctx.setLineDash([]);

      const lastLabel = last.close.toFixed(2);
      ctx.font = "11px ui-monospace, SFMono-Regular, Menlo, monospace";
      const labelW = ctx.measureText(lastLabel).width + 14;
      const labelH = 20;
      const labelX = plotRight + 4;
      ctx.fillStyle = COLORS.lastPriceBg;
      ctx.strokeStyle = COLORS.lastPrice;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.roundRect(labelX, lastY - labelH / 2, labelW, labelH, 5);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = COLORS.lastPrice;
      ctx.textAlign = "left";
      ctx.textBaseline = "middle";
      ctx.fillText(lastLabel, labelX + 7, lastY);

      drawPanelFrame(ctx, layout.volume);
      ctx.fillStyle = COLORS.labelDim;
      ctx.font = "600 9px ui-sans-serif, system-ui";
      ctx.textAlign = "left";
      ctx.textBaseline = "top";
      ctx.fillText("VOLUME", layout.volume.left + 8, layout.volume.top + 5);

      const maxVol = Math.max(...visible.map((c) => c.volume), 1);
      const barW = Math.max(3, layout.slotWidth * 0.62);
      visible.forEach((candle, localIdx) => {
        const index = layout.startIndex + localIdx;
        const x = xForIndex(index);
        const barH = Math.max(1, (candle.volume / maxVol) * (layout.volume.height - 18));
        const bullish = candle.close >= candle.open;
        ctx.fillStyle = bullish ? COLORS.bullVol : COLORS.bearVol;
        ctx.beginPath();
        ctx.roundRect(
          x - barW / 2,
          layout.volume.top + layout.volume.height - barH - 6,
          barW,
          barH,
          1
        );
        ctx.fill();
      });

      drawPanelFrame(ctx, layout.rsi);
      const rsiY = (value: number) =>
        layout.rsi.top + ((100 - value) / 100) * layout.rsi.height;

      [30, 50, 70].forEach((level) => {
        const y = rsiY(level);
        ctx.strokeStyle = level === 50 ? COLORS.rsiBand : COLORS.grid;
        ctx.setLineDash(level === 50 ? [3, 4] : []);
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(layout.rsi.left, y + 0.5);
        ctx.lineTo(layout.rsi.left + layout.rsi.width, y + 0.5);
        ctx.stroke();
        ctx.setLineDash([]);
      });

      ctx.fillStyle = COLORS.label;
      ctx.font = "10px ui-monospace, SFMono-Regular, Menlo, monospace";
      ctx.textAlign = "right";
      ctx.textBaseline = "middle";
      ctx.fillText("70", layout.rsi.left - 6, rsiY(70));
      ctx.fillText("50", layout.rsi.left - 6, rsiY(50));
      ctx.fillText("30", layout.rsi.left - 6, rsiY(30));

      ctx.fillStyle = COLORS.labelDim;
      ctx.font = "600 9px ui-sans-serif, system-ui";
      ctx.textAlign = "left";
      ctx.textBaseline = "top";
      ctx.fillText("RSI (14 · 1m)", layout.rsi.left + 8, layout.rsi.top + 5);

      const windowStart = candles[layout.startIndex]?.timestamp ?? 0;
      const windowEnd = candles[candles.length - 1]?.timestamp ?? windowStart;

      const visibleRsi = rsiSeries
        .map((point) => ({
          ...point,
          ts: new Date(point.time).getTime(),
        }))
        .filter((point) => point.ts >= windowStart - 60_000 && point.ts <= windowEnd + 1_000);

      if (visibleRsi.length >= 1) {
        const rsiPoints: { x: number; y: number }[] = [];
        visibleRsi.forEach((point) => {
          const idx = indexForTimestamp(candles, point.ts);
          rsiPoints.push({
            x: xForIndex(idx),
            y: rsiY(Math.min(100, Math.max(0, point.value))),
          });
        });

        if (rsiPoints.length >= 2) {
          ctx.beginPath();
          rsiPoints.forEach((pt, idx) => {
            if (idx === 0) ctx.moveTo(pt.x, pt.y);
            else ctx.lineTo(pt.x, pt.y);
          });
          ctx.lineTo(rsiPoints[rsiPoints.length - 1].x, layout.rsi.top + layout.rsi.height);
          ctx.lineTo(rsiPoints[0].x, layout.rsi.top + layout.rsi.height);
          ctx.closePath();
          ctx.fillStyle = COLORS.rsiFill;
          ctx.fill();

          ctx.strokeStyle = COLORS.rsi;
          ctx.lineWidth = 2;
          ctx.lineJoin = "round";
          ctx.lineCap = "round";
          ctx.shadowColor = "rgba(167, 139, 250, 0.45)";
          ctx.shadowBlur = 8;
          ctx.beginPath();
          rsiPoints.forEach((pt, idx) => {
            if (idx === 0) ctx.moveTo(pt.x, pt.y);
            else ctx.lineTo(pt.x, pt.y);
          });
          ctx.stroke();
          ctx.shadowBlur = 0;

          const lastRsi = visibleRsi[visibleRsi.length - 1];
          const lastPt = rsiPoints[rsiPoints.length - 1];
          ctx.fillStyle = COLORS.rsi;
          ctx.beginPath();
          ctx.arc(lastPt.x, lastPt.y, 3.5, 0, Math.PI * 2);
          ctx.fill();
          ctx.fillStyle = COLORS.label;
          ctx.font = "10px ui-monospace, SFMono-Regular, Menlo, monospace";
          ctx.textAlign = "left";
          ctx.textBaseline = "middle";
          ctx.fillText(lastRsi.value.toFixed(1), lastPt.x + 8, lastPt.y);
        } else if (rsiPoints.length === 1) {
          ctx.fillStyle = COLORS.rsi;
          ctx.beginPath();
          ctx.arc(rsiPoints[0].x, rsiPoints[0].y, 3.5, 0, Math.PI * 2);
          ctx.fill();
        }
      } else {
        ctx.fillStyle = COLORS.labelDim;
        ctx.font = "11px ui-sans-serif, system-ui";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText(
          "RSI loading from session…",
          layout.rsi.left + layout.rsi.width / 2,
          layout.rsi.top + layout.rsi.height / 2
        );
      }

      drawTimeAxis(ctx, layout, candles, labelIndices, xForIndex);
    };

    draw();
    const observer = new ResizeObserver(draw);
    observer.observe(container);
    return () => observer.disconnect();
  }, [candles, rsiSeries, height]);

  return (
    <div ref={containerRef} className="stream-chart-wrap stream-chart-wrap-modern">
      <canvas ref={canvasRef} aria-label={`${symbol} one second streaming chart`} />
      <div className="stream-chart-legend stream-chart-legend-modern">
        <span><i className="legend-dot legend-bull" /> Bull</span>
        <span><i className="legend-dot legend-bear" /> Bear</span>
        <span><i className="legend-dot legend-vol" /> Volume</span>
        <span><i className="legend-dot legend-rsi" /> RSI 1m</span>
      </div>
    </div>
  );
}
