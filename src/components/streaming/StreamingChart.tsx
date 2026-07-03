import { useEffect, useRef } from "react";
import type { ParsedCandle } from "@/lib/candles";
import type { RsiPoint } from "@/lib/technical-indicators";

interface StreamingChartProps {
  candles: ParsedCandle[];
  rsiSeries: RsiPoint[];
  height?: number;
}

const COLORS = {
  bg: "#050505",
  panelBorder: "rgba(255, 255, 255, 0.18)",
  grid: "rgba(255, 255, 255, 0.06)",
  axis: "rgba(255, 255, 255, 0.35)",
  label: "rgba(255, 255, 255, 0.72)",
  labelDim: "rgba(255, 255, 255, 0.45)",
  bull: "#26a69a",
  bear: "#ef5350",
  bullVol: "rgba(38, 166, 154, 0.65)",
  bearVol: "rgba(239, 83, 80, 0.65)",
  rsi: "#c084fc",
  rsiBand: "rgba(255, 255, 255, 0.12)",
  lastPrice: "#ef5350",
  lastPriceBg: "rgba(239, 83, 80, 0.15)",
};

const MAX_VISIBLE = 120;
const MIN_SLOT = 5;
const MAX_SLOT = 14;

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

  const pad = { top: 10, right: 68, bottom: 26, left: 58 };
  const innerH = height - pad.top - pad.bottom;
  const gap = 8;
  const priceH = Math.floor(innerH * 0.58);
  const volH = Math.floor(innerH * 0.16);
  const rsiH = innerH - priceH - volH - gap * 2;
  const plotW = width - pad.left - pad.right;

  const visibleCount = Math.min(candles.length, MAX_VISIBLE);
  const startIndex = candles.length - visibleCount;
  const visible = candles.slice(startIndex);
  const slotWidth = Math.min(MAX_SLOT, Math.max(MIN_SLOT, plotW / visibleCount));

  const minPrice = Math.min(...visible.map((c) => c.low));
  const maxPrice = Math.max(...visible.map((c) => c.high));
  const priceRange = Math.max(maxPrice - minPrice, 0.5);
  const yMin = minPrice - priceRange * 0.08;
  const yMax = maxPrice + priceRange * 0.08;

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
      ctx.fillText(labelFormatter(value), panel.left - 8, y);
    }
  }
}

function drawVerticalTimeGrid(
  ctx: CanvasRenderingContext2D,
  panels: PanelRect[],
  xPositions: number[]
) {
  ctx.strokeStyle = COLORS.grid;
  ctx.lineWidth = 1;
  const top = panels[0].top;
  const bottom = panels[panels.length - 1].top + panels[panels.length - 1].height;

  for (const x of xPositions) {
    ctx.beginPath();
    ctx.moveTo(x + 0.5, top);
    ctx.lineTo(x + 0.5, bottom);
    ctx.stroke();
  }
}

function drawTimeAxis(
  ctx: CanvasRenderingContext2D,
  layout: ChartLayout,
  candles: ParsedCandle[],
  xForIndex: (index: number) => number
) {
  const visible = candles.slice(layout.startIndex);
  const tickStep = Math.max(1, Math.floor(visible.length / 6));
  const axisY = layout.height - 8;

  ctx.strokeStyle = COLORS.axis;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(layout.pad.left, layout.rsi.top + layout.rsi.height);
  ctx.lineTo(layout.pad.left + layout.price.width, layout.rsi.top + layout.rsi.height);
  ctx.stroke();

  ctx.fillStyle = COLORS.label;
  ctx.font = "10px ui-monospace, SFMono-Regular, Menlo, monospace";
  ctx.textAlign = "center";
  ctx.textBaseline = "top";

  for (let localIdx = 0; localIdx < visible.length; localIdx += tickStep) {
    const candle = visible[localIdx];
    const x = xForIndex(layout.startIndex + localIdx);
    ctx.fillText(
      new Date(candle.timestamp).toLocaleTimeString("en-IN", {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      }),
      x,
      axisY
    );
  }
}

export function StreamingChart({ candles, rsiSeries, height = 480 }: StreamingChartProps) {
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

      ctx.fillStyle = COLORS.bg;
      ctx.fillRect(0, 0, width, height);

      const plotRight = layout.pad.left + layout.price.width;
      const xForIndex = (globalIndex: number) =>
        plotRight - (candles.length - 1 - globalIndex) * layout.slotWidth - layout.slotWidth / 2;

      const visible = candles.slice(layout.startIndex);
      const priceTickValues = priceTicks(layout.yMin, layout.yMax, 5);
      const timeGridX: number[] = [];
      const tickStep = Math.max(1, Math.floor(visible.length / 6));
      for (let i = 0; i < visible.length; i += tickStep) {
        timeGridX.push(xForIndex(layout.startIndex + i));
      }

      drawHorizontalGrid(ctx, layout.price, priceTickValues, layout.yMin, layout.yMax, true, (v) =>
        v.toFixed(2)
      );
      drawPanelFrame(ctx, layout.price);
      drawVerticalTimeGrid(ctx, [layout.price, layout.volume, layout.rsi], timeGridX);

      visible.forEach((candle, localIdx) => {
        const index = layout.startIndex + localIdx;
        const x = xForIndex(index);
        const openY = yForPrice(candle.open, layout.price, layout.yMin, layout.yMax);
        const closeY = yForPrice(candle.close, layout.price, layout.yMin, layout.yMax);
        const highY = yForPrice(candle.high, layout.price, layout.yMin, layout.yMax);
        const lowY = yForPrice(candle.low, layout.price, layout.yMin, layout.yMax);
        const bullish = candle.close >= candle.open;
        const color = bullish ? COLORS.bull : COLORS.bear;
        const bodyW = Math.max(3, layout.slotWidth * 0.55);

        ctx.strokeStyle = color;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(x + 0.5, highY);
        ctx.lineTo(x + 0.5, lowY);
        ctx.stroke();

        const bodyTop = Math.min(openY, closeY);
        let bodyHeight = Math.abs(closeY - openY);
        if (bodyHeight < 1) bodyHeight = 1;
        ctx.fillStyle = color;
        ctx.fillRect(x - bodyW / 2, bodyTop, bodyW, bodyHeight);
      });

      const last = candles[candles.length - 1];
      const lastY = yForPrice(last.close, layout.price, layout.yMin, layout.yMax);
      ctx.strokeStyle = COLORS.lastPrice;
      ctx.lineWidth = 1;
      ctx.setLineDash([5, 4]);
      ctx.beginPath();
      ctx.moveTo(layout.pad.left, lastY);
      ctx.lineTo(plotRight, lastY);
      ctx.stroke();
      ctx.setLineDash([]);

      const lastLabel = last.close.toFixed(2);
      ctx.font = "11px ui-monospace, SFMono-Regular, Menlo, monospace";
      const labelW = ctx.measureText(lastLabel).width + 12;
      const labelH = 18;
      const labelX = plotRight + 6;
      ctx.fillStyle = COLORS.lastPriceBg;
      ctx.strokeStyle = COLORS.lastPrice;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.roundRect(labelX, lastY - labelH / 2, labelW, labelH, 4);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = COLORS.lastPrice;
      ctx.textAlign = "left";
      ctx.textBaseline = "middle";
      ctx.fillText(lastLabel, labelX + 6, lastY);

      drawPanelFrame(ctx, layout.volume);
      ctx.fillStyle = COLORS.labelDim;
      ctx.font = "10px ui-sans-serif, system-ui";
      ctx.textAlign = "left";
      ctx.textBaseline = "top";
      ctx.fillText("Volume", layout.volume.left + 6, layout.volume.top + 4);

      const maxVol = Math.max(...visible.map((c) => c.volume), 1);
      const barW = Math.max(3, layout.slotWidth * 0.55);
      visible.forEach((candle, localIdx) => {
        const index = layout.startIndex + localIdx;
        const x = xForIndex(index);
        const barH = Math.max(1, (candle.volume / maxVol) * (layout.volume.height - 16));
        const bullish = candle.close >= candle.open;
        ctx.fillStyle = bullish ? COLORS.bullVol : COLORS.bearVol;
        ctx.fillRect(
          x - barW / 2,
          layout.volume.top + layout.volume.height - barH - 4,
          barW,
          barH
        );
      });

      drawPanelFrame(ctx, layout.rsi);
      const rsiY = (value: number) =>
        layout.rsi.top + ((100 - value) / 100) * layout.rsi.height;

      [30, 50, 70].forEach((level) => {
        const y = rsiY(level);
        ctx.strokeStyle = level === 50 ? COLORS.rsiBand : COLORS.grid;
        ctx.setLineDash(level === 50 ? [4, 4] : []);
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
      ctx.fillText("70", layout.rsi.left - 8, rsiY(70));
      ctx.fillText("50", layout.rsi.left - 8, rsiY(50));
      ctx.fillText("30", layout.rsi.left - 8, rsiY(30));

      ctx.fillStyle = COLORS.labelDim;
      ctx.font = "10px ui-sans-serif, system-ui";
      ctx.textAlign = "left";
      ctx.textBaseline = "top";
      ctx.fillText("RSI (14)", layout.rsi.left + 6, layout.rsi.top + 4);

      const visibleRsi = rsiSeries.filter((point) => {
        const idx = candles.findIndex((c) => c.time === point.time);
        return idx >= layout.startIndex;
      });

      if (visibleRsi.length >= 2) {
        ctx.strokeStyle = COLORS.rsi;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        visibleRsi.forEach((point, idx) => {
          const candleIndex = candles.findIndex((c) => c.time === point.time);
          if (candleIndex < 0) return;
          const x = xForIndex(candleIndex);
          const y = rsiY(Math.min(100, Math.max(0, point.value)));
          if (idx === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        });
        ctx.stroke();
      }

      drawTimeAxis(ctx, layout, candles, xForIndex);

      ctx.fillStyle = COLORS.labelDim;
      ctx.font = "10px ui-sans-serif, system-ui";
      ctx.textAlign = "center";
      ctx.textBaseline = "bottom";
      ctx.fillText("Time (IST)", layout.pad.left + layout.price.width / 2, layout.height - 2);
    };

    draw();
    const observer = new ResizeObserver(draw);
    observer.observe(container);
    return () => observer.disconnect();
  }, [candles, rsiSeries, height]);

  return (
    <div ref={containerRef} className="stream-chart-wrap">
      <canvas ref={canvasRef} aria-label="Nifty 50 one second streaming chart" />
      <div className="stream-chart-legend">
        <span><i className="legend-dot legend-bull" /> Bull</span>
        <span><i className="legend-dot legend-bear" /> Bear</span>
        <span><i className="legend-dot legend-vol" /> Volume</span>
        <span><i className="legend-dot legend-rsi" /> RSI</span>
      </div>
    </div>
  );
}
