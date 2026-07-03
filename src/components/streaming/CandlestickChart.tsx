import { useEffect, useRef } from "react";
import type { ParsedCandle } from "@/lib/candles";
import type { MovingAveragePoint } from "@/lib/technical-indicators";

interface CandlestickChartProps {
  candles: ParsedCandle[];
  sma9?: MovingAveragePoint[];
  sma20?: MovingAveragePoint[];
  height?: number;
}

export function CandlestickChart({ candles, sma9 = [], sma20 = [], height = 360 }: CandlestickChartProps) {
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

      const padding = { top: 16, right: 12, bottom: 28, left: 52 };
      const plotW = width - padding.left - padding.right;
      const plotH = height - padding.top - padding.bottom;

      const highs = candles.map((c) => c.high);
      const lows = candles.map((c) => c.low);
      const minPrice = Math.min(...lows);
      const maxPrice = Math.max(...highs);
      const priceRange = Math.max(maxPrice - minPrice, 1);
      const yMin = minPrice - priceRange * 0.08;
      const yMax = maxPrice + priceRange * 0.08;

      const xForIndex = (index: number) =>
        padding.left + (index / Math.max(candles.length - 1, 1)) * plotW;
      const yForPrice = (price: number) =>
        padding.top + ((yMax - price) / (yMax - yMin)) * plotH;

      ctx.strokeStyle = "rgba(36, 48, 71, 0.8)";
      ctx.lineWidth = 1;
      for (let i = 0; i <= 4; i += 1) {
        const price = yMin + ((yMax - yMin) * i) / 4;
        const y = yForPrice(price);
        ctx.beginPath();
        ctx.moveTo(padding.left, y);
        ctx.lineTo(width - padding.right, y);
        ctx.stroke();
        ctx.fillStyle = "#94a3b8";
        ctx.font = "11px ui-sans-serif, system-ui";
        ctx.textAlign = "right";
        ctx.fillText(price.toFixed(1), padding.left - 6, y + 4);
      }

      const candleWidth = Math.max(2, plotW / candles.length - 1.5);
      candles.forEach((candle, index) => {
        const x = xForIndex(index);
        const openY = yForPrice(candle.open);
        const closeY = yForPrice(candle.close);
        const highY = yForPrice(candle.high);
        const lowY = yForPrice(candle.low);
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

      const drawMa = (series: MovingAveragePoint[], color: string) => {
        if (series.length < 2) return;
        ctx.strokeStyle = color;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        series.forEach((point, index) => {
          const candleIndex = candles.findIndex((c) => c.time === point.time);
          if (candleIndex < 0) return;
          const x = xForIndex(candleIndex);
          const y = yForPrice(point.value);
          if (index === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        });
        ctx.stroke();
      };

      drawMa(sma9, "#60a5fa");
      drawMa(sma20, "#fbbf24");

      const last = candles[candles.length - 1];
      ctx.fillStyle = "#e2e8f0";
      ctx.font = "11px ui-sans-serif, system-ui";
      ctx.textAlign = "center";
      ctx.fillText(
        new Date(last.timestamp).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" }),
        width - padding.right,
        height - 8
      );
    };

    draw();
    const observer = new ResizeObserver(draw);
    observer.observe(container);
    return () => observer.disconnect();
  }, [candles, sma9, sma20, height]);

  return (
    <div ref={containerRef} className="stream-chart-wrap">
      <canvas ref={canvasRef} aria-label="Nifty 50 one minute candlestick chart" />
      <div className="stream-chart-legend">
        <span><i className="legend-dot legend-sma9" /> SMA 9</span>
        <span><i className="legend-dot legend-sma20" /> SMA 20</span>
      </div>
    </div>
  );
}
