import { useEffect, useRef } from "react";

interface TradingViewMiniChartProps {
  symbol: string;
  label: string;
  height?: number;
}

export function TradingViewMiniChart({ symbol, label, height = 220 }: TradingViewMiniChartProps) {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    container.innerHTML = "";

    const widgetHost = document.createElement("div");
    widgetHost.className = "tradingview-widget-container";
    widgetHost.style.height = "100%";

    const widget = document.createElement("div");
    widget.className = "tradingview-widget-container__widget";
    widget.style.height = "100%";
    widgetHost.appendChild(widget);

    const script = document.createElement("script");
    script.type = "text/javascript";
    script.src = "https://s3.tradingview.com/external-embedding/embed-widget-mini-symbol-overview.js";
    script.async = true;
    script.innerHTML = JSON.stringify({
      symbol,
      width: "100%",
      height: "100%",
      locale: "en",
      dateRange: "12M",
      colorTheme: "dark",
      isTransparent: true,
      autosize: true,
      chartOnly: false,
    });

    widgetHost.appendChild(script);
    container.appendChild(widgetHost);

    return () => {
      container.innerHTML = "";
    };
  }, [symbol]);

  return (
    <div className="tv-mini-card">
      <p className="tv-mini-label">{label}</p>
      <div ref={containerRef} className="tv-mini-chart" style={{ height }} />
    </div>
  );
}
