import { useEffect, useId, useRef } from "react";

interface TradingViewChartProps {
  symbol: string;
  interval?: string;
  height?: number;
}

declare global {
  interface Window {
    TradingView?: {
      widget: new (options: Record<string, unknown>) => void;
    };
  }
}

let tvScriptPromise: Promise<void> | null = null;

function loadTradingViewScript() {
  if (window.TradingView) return Promise.resolve();
  if (tvScriptPromise) return tvScriptPromise;

  tvScriptPromise = new Promise((resolve, reject) => {
    const existing = document.querySelector('script[data-tradingview="tv.js"]');
    if (existing) {
      existing.addEventListener("load", () => resolve());
      existing.addEventListener("error", () => reject(new Error("TradingView script failed")));
      return;
    }

    const script = document.createElement("script");
    script.src = "https://s3.tradingview.com/tv.js";
    script.async = true;
    script.dataset.tradingview = "tv.js";
    script.onload = () => resolve();
    script.onerror = () => reject(new Error("TradingView script failed"));
    document.head.appendChild(script);
  });

  return tvScriptPromise;
}

export function TradingViewChart({ symbol, interval = "D", height = 520 }: TradingViewChartProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const containerId = useId().replace(/:/g, "");

  useEffect(() => {
    let cancelled = false;

    async function renderChart() {
      await loadTradingViewScript();
      if (cancelled || !containerRef.current || !window.TradingView) return;

      containerRef.current.innerHTML = "";
      const mount = document.createElement("div");
      mount.id = containerId;
      mount.style.height = "100%";
      containerRef.current.appendChild(mount);

      new window.TradingView.widget({
        autosize: true,
        symbol,
        interval,
        timezone: "Asia/Kolkata",
        theme: "dark",
        style: "1",
        locale: "en",
        toolbar_bg: "#0f1419",
        enable_publishing: false,
        hide_top_toolbar: false,
        hide_legend: false,
        save_image: false,
        container_id: containerId,
        studies: [],
      });
    }

    renderChart().catch(() => {
      if (containerRef.current) {
        containerRef.current.innerHTML = `<p class="text-muted" style="padding:1rem">Unable to load TradingView chart.</p>`;
      }
    });

    return () => {
      cancelled = true;
    };
  }, [symbol, interval, containerId]);

  return <div ref={containerRef} className="tv-chart" style={{ height }} />;
}
