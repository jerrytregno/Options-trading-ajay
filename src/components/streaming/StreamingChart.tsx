import { useEffect, useRef } from "react";
import type { ParsedCandle } from "@/lib/candles";
import type { FibLevel, RsiPoint } from "@/lib/technical-indicators";

interface StreamingChartProps {
  candles: ParsedCandle[];
  fibLevels: FibLevel[];
  rsiSeries: RsiPoint[];
  height?: number;
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

      const pad = { top: 12, right: 56, bottom: 8, left: 52 };
      const gap = 10;
      const priceH = Math.floor(height * 0.52);
      const volH = Math.floor(height * 0.18);
      const rsiH = height - priceH - volH - gap * 2 - pad.top - pad.bottom;

      const priceTop = pad.top;
      const volTop = priceTop + priceH + gap;
      const rsiTop = volTop + volH + gap;

      const plotW = width - pad.left - pad.right;
      const xForIndex = (index: number) =>
        pad.left + (index / Math.max(candles.length - 1, 1)) * plotW;

      const highs = candles.map((c) => c.high);
      const lows = candles.map((c) => c.low);
      const minPrice = Math.min(...lows);
      const maxPrice = Math.max(...highs);
      const priceRange = Math.max(maxPrice - minPrice, 0.5);
      const yMin = minPrice - priceRange * 0.06;
      const yMax = maxPrice + priceRange * 0.06;
      const yForPrice = (price: number, top: number, h: number) =>
        top + ((yMax - price) / (yMax - yMin)) * h;

      ctx.strokeStyle = "rgba(36, 48, 71, 0.65)";
      ctx.lineWidth = 1;
      for (let i = 0; i <= 4; i += 1) {
        const price = yMin + ((yMax - yMin) * i) / 4;
        const y = yForPrice(price, priceTop, priceH);
        ctx.beginPath();
        ctx.moveTo(pad.left, y);
        ctx.lineTo(width - pad.right, y);
        ctx.stroke();
        ctx.fillStyle = "#94a3b8";
        ctx.font = "10px ui-sans-serif, system-ui";
        ctx.textAlign = "right";
        ctx.fillText(price.toFixed(1), pad.left - 4, y + 3);
      }

      for (const fib of fibLevels) {
        if (fib.price < yMin || fib.price > yMax) continue;
        const y = yForPrice(fib.price, priceTop, priceH);
        ctx.strokeStyle =
          fib.ratio === 0.5
            ? "rgba(251, 191, 36, 0.85)"
            : "rgba(147, 197, 253, 0.45)";
        ctx.setLineDash(fib.ratio === 0.5 ? [] : [5, 4]);
        ctx.beginPath();
        ctx.moveTo(pad.left, y);
        ctx.lineTo(width - pad.right, y);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle = fib.ratio === 0.5 ? "#fbbf24" : "#93c5fd";
        ctx.textAlign = "left";
        ctx.fillText(`Fib ${fib.label}`, width - pad.right + 4, y + 3);
      }

      const candleWidth = Math.max(1.5, plotW / candles.length - 0.5);
      candles.forEach((candle, index) => {
        const x = xForIndex(index);
        const openY = yForPrice(candle.open, priceTop, priceH);
        const closeY = yForPrice(candle.close, priceTop, priceH);
        const highY = yForPrice(candle.high, priceTop, priceH);
        const lowY = yForPrice(candle.low, priceTop, priceH);
        const bullish = candle.close >= candle.open;
        const color = bullish ? "#34d399" : "#fb7185";

        ctx.strokeStyle = color;
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.moveTo(x, highY);
        ctx.lineTo(x, lowY);
        ctx.stroke();

        const bodyTop = Math.min(openY, closeY);
        const bodyHeight = Math.max(Math.abs(closeY - openY), 1);
        ctx.fillRect(x - candleWidth / 2, bodyTop, candleWidth, bodyHeight);
      });

      const maxVol = Math.max(...candles.map((c) => c.volume), 1);
      candles.forEach((candle, index) => {
        const x = xForIndex(index);
        const barH = (candle.volume / maxVol) * (volH - 8);
        const bullish = candle.close >= candle.open;
        ctx.fillStyle = bullish ? "rgba(52, 211, 153, 0.65)" : "rgba(251, 113, 133, 0.65)";
        ctx.fillRect(x - candleWidth / 2, volTop + volH - barH, candleWidth, barH);
      });

      ctx.fillStyle = "#94a3b8";
      ctx.font = "10px ui-sans-serif, system-ui";
      ctx.textAlign = "left";
      ctx.fillText("Volume", pad.left, volTop + 12);

      ctx.strokeStyle = "rgba(36, 48, 71, 0.65)";
      ctx.beginPath();
      ctx.moveTo(pad.left, volTop);
      ctx.lineTo(width - pad.right, volTop);
      ctx.moveTo(pad.left, volTop + volH);
      ctx.lineTo(width - pad.right, volTop + volH);
      ctx.stroke();

      const rsiY = (value: number) => rsiTop + ((100 - value) / 100) * rsiH;
      [30, 50, 70].forEach((level) => {
        const y = rsiY(level);
        ctx.strokeStyle = level === 50 ? "rgba(148, 163, 184, 0.35)" : "rgba(251, 113, 133, 0.35)";
        ctx.setLineDash(level === 50 ? [4, 4] : [2, 4]);
        ctx.beginPath();
        ctx.moveTo(pad.left, y);
        ctx.lineTo(width - pad.right, y);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle = "#64748b";
        ctx.textAlign = "right";
        ctx.fillText(String(level), pad.left - 4, y + 3);
      });

      if (rsiSeries.length >= 2) {
        ctx.strokeStyle = "#a78bfa";
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        rsiSeries.forEach((point, idx) => {
          const candleIndex = candles.findIndex((c) => c.time === point.time);
          if (candleIndex < 0) return;
          const x = xForIndex(candleIndex);
          const y = rsiY(point.value);
          if (idx === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        });
        ctx.stroke();
      }

      ctx.fillStyle = "#94a3b8";
      ctx.textAlign = "left";
      ctx.fillText("RSI (14)", pad.left, rsiTop + 12);

      ctx.strokeStyle = "rgba(36, 48, 71, 0.65)";
      ctx.beginPath();
      ctx.moveTo(pad.left, rsiTop);
      ctx.lineTo(width - pad.right, rsiTop);
      ctx.moveTo(pad.left, rsiTop + rsiH);
      ctx.lineTo(width - pad.right, rsiTop + rsiH);
      ctx.stroke();

      const last = candles[candles.length - 1];
      ctx.fillStyle = "#e2e8f0";
      ctx.textAlign = "center";
      ctx.fillText(
        new Date(last.timestamp).toLocaleTimeString("en-IN", {
          hour: "2-digit",
          minute: "2-digit",
          second: "2-digit",
        }),
        width - pad.right,
        height - 2
      );
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
        <span><i className="legend-dot legend-fib" /> Fib retracement</span>
        <span><i className="legend-dot legend-vol" /> Volume</span>
        <span><i className="legend-dot legend-rsi" /> RSI 14</span>
      </div>
    </div>
  );
}
