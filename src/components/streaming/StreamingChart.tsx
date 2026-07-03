import { useEffect, useRef } from "react";
import type { ParsedCandle } from "@/lib/candles";
import type { FibLevel, RsiPoint } from "@/lib/technical-indicators";

interface StreamingChartProps {
  candles: ParsedCandle[];
  fibLevels: FibLevel[];
  rsiSeries: RsiPoint[];
  height?: number;
}

const COLORS = {
  bg: "#0b0f17",
  grid: "rgba(42, 46, 57, 0.85)",
  text: "#787b86",
  bull: "#26a69a",
  bear: "#ef5350",
  bullVol: "rgba(38, 166, 154, 0.55)",
  bearVol: "rgba(239, 83, 80, 0.55)",
  rsi: "#b388ff",
  fib: "rgba(120, 123, 134, 0.55)",
  fibMid: "rgba(255, 193, 7, 0.75)",
  lastPrice: "#ef5350",
};

const SLOT_WIDTH = 8;
const BODY_WIDTH = 5;
const WICK_WIDTH = 1;
const MAX_VISIBLE = 180;

function drawPanelBg(
  ctx: CanvasRenderingContext2D,
  left: number,
  top: number,
  w: number,
  h: number
) {
  ctx.fillStyle = COLORS.bg;
  ctx.fillRect(left, top, w, h);
}

function drawGrid(
  ctx: CanvasRenderingContext2D,
  left: number,
  top: number,
  w: number,
  h: number,
  rows: number
) {
  ctx.strokeStyle = COLORS.grid;
  ctx.lineWidth = 1;
  for (let i = 0; i <= rows; i += 1) {
    const y = top + (h * i) / rows;
    ctx.beginPath();
    ctx.moveTo(left, y);
    ctx.lineTo(left + w, y);
    ctx.stroke();
  }
}

export function StreamingChart({
  candles,
  fibLevels,
  rsiSeries,
  height = 480,
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
      ctx.scale(dpr, dpr);
      ctx.clearRect(0, 0, width, height);

      const pad = { top: 8, right: 62, bottom: 22, left: 48 };
      const gap = 6;
      const priceH = Math.floor(height * 0.58);
      const volH = Math.floor(height * 0.14);
      const rsiH = height - priceH - volH - gap * 2 - pad.top - pad.bottom;

      const priceTop = pad.top;
      const volTop = priceTop + priceH + gap;
      const rsiTop = volTop + volH + gap;
      const plotW = width - pad.left - pad.right;
      const plotRight = pad.left + plotW;

      const visibleCount = Math.min(
        candles.length,
        Math.floor(plotW / SLOT_WIDTH),
        MAX_VISIBLE
      );
      const startIndex = candles.length - visibleCount;
      const visible = candles.slice(startIndex);

      const xForIndex = (globalIndex: number) =>
        plotRight - (candles.length - 1 - globalIndex) * SLOT_WIDTH - SLOT_WIDTH / 2;

      const highs = visible.map((c) => c.high);
      const lows = visible.map((c) => c.low);
      const minPrice = Math.min(...lows);
      const maxPrice = Math.max(...highs);
      const priceRange = Math.max(maxPrice - minPrice, 0.25);
      const yMin = minPrice - priceRange * 0.12;
      const yMax = maxPrice + priceRange * 0.12;
      const yForPrice = (price: number, top: number, h: number) =>
        top + ((yMax - price) / (yMax - yMin)) * h;

      drawPanelBg(ctx, pad.left, priceTop, plotW, priceH);
      drawGrid(ctx, pad.left, priceTop, plotW, priceH, 5);

      ctx.fillStyle = COLORS.text;
      ctx.font = "10px ui-sans-serif, system-ui";
      ctx.textAlign = "right";
      for (let i = 0; i <= 5; i += 1) {
        const price = yMin + ((yMax - yMin) * i) / 5;
        const y = yForPrice(price, priceTop, priceH);
        ctx.fillText(price.toFixed(2), pad.left - 6, y + 3);
      }

      for (const fib of fibLevels) {
        if (fib.price < yMin || fib.price > yMax) continue;
        const y = yForPrice(fib.price, priceTop, priceH);
        const isMid = fib.ratio === 0.5;
        ctx.strokeStyle = isMid ? COLORS.fibMid : COLORS.fib;
        ctx.lineWidth = isMid ? 1 : 1;
        ctx.setLineDash(isMid ? [6, 3] : [3, 4]);
        ctx.beginPath();
        ctx.moveTo(pad.left, y);
        ctx.lineTo(plotRight, y);
        ctx.stroke();
        ctx.setLineDash([]);
        if (isMid || fib.ratio === 0 || fib.ratio === 1) {
          ctx.fillStyle = isMid ? "#ffc107" : COLORS.text;
          ctx.textAlign = "left";
          ctx.font = "9px ui-sans-serif, system-ui";
          ctx.fillText(fib.label, plotRight + 4, y + 3);
        }
      }

      visible.forEach((candle, localIdx) => {
        const index = startIndex + localIdx;
        const x = xForIndex(index);
        const openY = yForPrice(candle.open, priceTop, priceH);
        const closeY = yForPrice(candle.close, priceTop, priceH);
        const highY = yForPrice(candle.high, priceTop, priceH);
        const lowY = yForPrice(candle.low, priceTop, priceH);
        const bullish = candle.close >= candle.open;
        const color = bullish ? COLORS.bull : COLORS.bear;

        ctx.strokeStyle = color;
        ctx.lineWidth = WICK_WIDTH;
        ctx.beginPath();
        ctx.moveTo(x, highY);
        ctx.lineTo(x, lowY);
        ctx.stroke();

        const bodyTop = Math.min(openY, closeY);
        let bodyHeight = Math.abs(closeY - openY);
        if (bodyHeight < 1) bodyHeight = 1;

        ctx.fillStyle = color;
        ctx.fillRect(x - BODY_WIDTH / 2, bodyTop, BODY_WIDTH, bodyHeight);
      });

      const last = candles[candles.length - 1];
      const lastY = yForPrice(last.close, priceTop, priceH);
      ctx.strokeStyle = COLORS.lastPrice;
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 3]);
      ctx.beginPath();
      ctx.moveTo(pad.left, lastY);
      ctx.lineTo(plotRight, lastY);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = COLORS.lastPrice;
      ctx.textAlign = "left";
      ctx.font = "10px ui-sans-serif, system-ui";
      ctx.fillText(last.close.toFixed(2), plotRight + 4, lastY + 3);

      drawPanelBg(ctx, pad.left, volTop, plotW, volH);
      drawGrid(ctx, pad.left, volTop, plotW, volH, 2);
      const maxVol = Math.max(...visible.map((c) => c.volume), 1);
      visible.forEach((candle, localIdx) => {
        const index = startIndex + localIdx;
        const x = xForIndex(index);
        const barH = Math.max(1, (candle.volume / maxVol) * (volH - 14));
        const bullish = candle.close >= candle.open;
        ctx.fillStyle = bullish ? COLORS.bullVol : COLORS.bearVol;
        ctx.fillRect(x - BODY_WIDTH / 2, volTop + volH - barH - 2, BODY_WIDTH, barH);
      });
      ctx.fillStyle = COLORS.text;
      ctx.font = "9px ui-sans-serif, system-ui";
      ctx.textAlign = "left";
      ctx.fillText("Volume", pad.left + 4, volTop + 11);

      drawPanelBg(ctx, pad.left, rsiTop, plotW, rsiH);
      drawGrid(ctx, pad.left, rsiTop, plotW, rsiH, 4);
      const rsiY = (value: number) => rsiTop + ((100 - value) / 100) * rsiH;
      [30, 70].forEach((level) => {
        const y = rsiY(level);
        ctx.strokeStyle = "rgba(239, 83, 80, 0.25)";
        ctx.setLineDash([2, 4]);
        ctx.beginPath();
        ctx.moveTo(pad.left, y);
        ctx.lineTo(plotRight, y);
        ctx.stroke();
        ctx.setLineDash([]);
      });

      const visibleRsi = rsiSeries.filter((point) => {
        const idx = candles.findIndex((c) => c.time === point.time);
        return idx >= startIndex;
      });

      if (visibleRsi.length >= 2) {
        ctx.strokeStyle = COLORS.rsi;
        ctx.lineWidth = 1.25;
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

      ctx.fillStyle = COLORS.text;
      ctx.font = "9px ui-sans-serif, system-ui";
      ctx.textAlign = "left";
      ctx.fillText("RSI 14", pad.left + 4, rsiTop + 11);
      ctx.textAlign = "right";
      ctx.fillText("70", pad.left - 6, rsiY(70) + 3);
      ctx.fillText("30", pad.left - 6, rsiY(30) + 3);

      const tickStep = Math.max(1, Math.floor(visible.length / 8));
      ctx.fillStyle = COLORS.text;
      ctx.font = "9px ui-sans-serif, system-ui";
      ctx.textAlign = "center";
      for (let localIdx = 0; localIdx < visible.length; localIdx += tickStep) {
        const candle = visible[localIdx];
        const x = xForIndex(startIndex + localIdx);
        ctx.fillText(
          new Date(candle.timestamp).toLocaleTimeString("en-IN", {
            hour: "2-digit",
            minute: "2-digit",
            second: "2-digit",
          }),
          x,
          height - 6
        );
      }
    };

    draw();
    const observer = new ResizeObserver(draw);
    observer.observe(container);
    return () => observer.disconnect();
  }, [candles, fibLevels, rsiSeries, height]);

  return (
    <div ref={containerRef} className="stream-chart-wrap">
      <canvas ref={canvasRef} aria-label="Nifty 50 one second streaming chart" />
      <div className="stream-chart-legend">
        <span><i className="legend-dot legend-fib" /> Fib</span>
        <span><i className="legend-dot legend-vol" /> Volume</span>
        <span><i className="legend-dot legend-rsi" /> RSI</span>
      </div>
    </div>
  );
}
