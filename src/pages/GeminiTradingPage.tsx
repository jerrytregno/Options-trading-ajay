import { useEffect, useState } from "react";
import { Bot, Radio, ShieldAlert } from "lucide-react";
import { DashboardShell } from "@/components/layout/dashboard-shell";
import { GeminiTradingPanel } from "@/components/gemini/GeminiTradingPanel";
import { useConfirm } from "@/contexts/confirm-context";
import { useKite } from "@/contexts/kite-context";
import { useGeminiMarketStream } from "@/hooks/use-gemini-market-stream";
import { AI_AUTO_TARGET_PROFIT_INR } from "@/lib/auto-trade";
import { buildTechnicalSnapshot } from "@/lib/technical-indicators";
import { aggregateSecondCandlesToMinutes, mergeMinuteCandles } from "@/lib/minute-candles";
import { STREAM_INSTRUMENTS } from "@/lib/stream-instruments";
import type { TradingIpInfo } from "@/lib/kite-trading-ip";
import { cn, formatCurrency, formatNumber, getChangeClass } from "@/lib/utils";

export default function GeminiTradingPage() {
  const { connected, loginUrl } = useKite();
  const { confirm } = useConfirm();
  const [aiAutoTrading, setAiAutoTrading] = useState(false);
  const [tradeLive, setTradeLive] = useState(false);
  const [tradingIpInfo, setTradingIpInfo] = useState<TradingIpInfo | null>(null);
  const {
    marketStreaming,
    toggleMarketStreaming,
    aiStreaming,
    toggleAiStreaming,
    setAiStreamingEnabled,
    streamInstrumentId,
    selectInstrument,
    selectedInstrument,
    stream,
    secondCandles,
    loading,
    streamError,
    gemini,
    geminiError,
    geminiWarning,
    buildGeminiSnapshot,
    sessionsByInstrument,
  } = useGeminiMarketStream();

  const handleStartAiLoop = async () => {
    if (!connected || !marketStreaming || !aiStreaming) return;
    if (aiAutoTrading) return;
    const ok = await confirm({
      title: "Start Options AI loop trading?",
      body: (
        <>
          <p>
            Options AI estimates profit, enters when edge supports <strong>{formatCurrency(AI_AUTO_TARGET_PROFIT_INR)}</strong>,
            then <strong>pauses AI</strong> while the app auto-sells at target. AI resumes for the next trade.
          </p>
          <p>
            Each trade: <strong>Call Buy or Put Buy only</strong> (no naked sell).{" "}
            <strong>Instant sell at {formatCurrency(AI_AUTO_TARGET_PROFIT_INR)} profit</strong> — no AI on exit.
          </p>
          <p className="confirm-note">REAL Zerodha orders — real money.</p>
        </>
      ),
      confirmLabel: "Start AI loop",
      tone: "danger",
    });
    if (!ok) return;
    setAiStreamingEnabled(true);
    setAiAutoTrading(true);
  };

  const handleStopAiLoop = () => {
    setAiAutoTrading(false);
  };

  useEffect(() => {
    if (!marketStreaming && aiAutoTrading) {
      setAiAutoTrading(false);
    }
  }, [marketStreaming, aiAutoTrading]);

  useEffect(() => {
    if (!connected) {
      setTradingIpInfo(null);
      return;
    }
    void (async () => {
      try {
        const res = await fetch("/api/kite/trading-ip?refresh=1", { credentials: "include" });
        const json = await res.json();
        if (res.ok) setTradingIpInfo(json.data as TradingIpInfo);
      } catch {
        /* ignore */
      }
    })();
  }, [connected]);

  const handleGeminiPauseForTrade = () => {
    setAiStreamingEnabled(false);
  };

  const handleGeminiResumeForTrade = () => {
    setAiStreamingEnabled(true);
  };

  const streamMinutes = aggregateSecondCandlesToMinutes(secondCandles);
  const sessionData = sessionsByInstrument[streamInstrumentId] ?? null;
  const minuteCandles = mergeMinuteCandles(sessionData?.candles ?? [], streamMinutes);
  const technicals = buildTechnicalSnapshot(minuteCandles);

  return (
    <DashboardShell>
      <div className="gemini-page">
        <header className={cn("gemini-page-hero", tradeLive && "gemini-page-hero--compact")}>
          <div className="gemini-page-hero-text">
            <div className="gemini-page-hero-icon">
              <Bot size={22} />
            </div>
            <div>
              <h1>Options AI Trading</h1>
              <p>Autonomous loop · buy CE/PE · instant profit exit · separate from streaming charts</p>
            </div>
          </div>
          {connected && (
            <div className="gemini-page-toolbar">
              <span className={cn("stream-live-pill", !marketStreaming && "is-paused")}>
                <span className="stream-live-dot" />
                {marketStreaming ? "Live · 1s" : "Paused"}
              </span>
              {stream && (
                <span className={cn("stream-price-chip", getChangeClass(stream.quote.change))}>
                  {formatNumber(stream.quote.last_price)}
                  {" · "}
                  {stream.quote.change >= 0 ? "+" : ""}
                  {formatNumber(stream.quote.change_percent)}%
                </span>
              )}
              <label className="stream-ai-toggle" title="Toggle live quotes">
                <span className="stream-ai-toggle-label">Stream</span>
                <input
                  type="checkbox"
                  checked={marketStreaming}
                  onChange={toggleMarketStreaming}
                  aria-label="Toggle market streaming"
                />
                <span className="stream-ai-toggle-track" aria-hidden />
              </label>
              <label
                className="stream-ai-toggle stream-ai-toggle-accent"
                title={
                  aiAutoTrading && !aiStreaming
                    ? "Options AI paused during open trade — auto exit only"
                    : aiStreaming
                      ? "Pause Options AI"
                      : "Resume Options AI"
                }
              >
                <span className="stream-ai-toggle-label">
                  {aiAutoTrading && !aiStreaming ? "AI · in trade" : aiStreaming ? "AI On" : "AI Paused"}
                </span>
                <input
                  type="checkbox"
                  checked={aiStreaming}
                  onChange={toggleAiStreaming}
                  disabled={!marketStreaming}
                  aria-label="Toggle Options AI"
                />
                <span className="stream-ai-toggle-track" aria-hidden />
              </label>
            </div>
          )}
        </header>

        {!connected ? (
          <div className="card">
            <p className="text-muted">Connect Zerodha to run Options AI trading.</p>
            {loginUrl && (
              <a href={loginUrl} className="mt-4" style={{ display: "inline-block" }}>
                <button type="button" className="btn btn-primary">
                  Connect Kite
                </button>
              </a>
            )}
          </div>
        ) : loading && secondCandles.length === 0 ? (
          <div className="spinner-center" style={{ minHeight: "12rem" }}>
            <div className="spinner spinner-sm" />
          </div>
        ) : (
          <>
            {streamError && <div className="alert alert-error mb-4">{streamError}</div>}

            {(tradingIpInfo?.ipMismatch || (tradingIpInfo && !tradingIpInfo.egressReady)) && !tradeLive && (
              <div className="alert alert-error mb-4 gemini-ip-alert">
                <ShieldAlert size={18} />
                <div>
                  <strong>
                    Route Kite API through a whitelisted IP ({tradingIpInfo.allowedIps?.join(" or ") ?? "see Settings"}).
                  </strong>
                  <p className="mb-0 mt-1" style={{ fontSize: "0.875rem" }}>
                    {tradingIpInfo.note}{" "}
                    <a href={tradingIpInfo.kiteConsoleUrl} target="_blank" rel="noreferrer">
                      Kite Connect
                    </a>
                  </p>
                </div>
              </div>
            )}

            {STREAM_INSTRUMENTS.length > 1 && (
            <section className="gemini-markets">
              <p className="gemini-markets-label">
                <Radio size={14} /> Focus market
              </p>
              <div className="gemini-markets-grid">
                {STREAM_INSTRUMENTS.map((inst) => (
                  <button
                    key={inst.id}
                    type="button"
                    className={cn("gemini-market-card", streamInstrumentId === inst.id && "is-active")}
                    onClick={() => selectInstrument(inst.id)}
                  >
                    <span className="gemini-market-name">{inst.label}</span>
                    <span className="gemini-market-meta">{inst.chainExchange}</span>
                  </button>
                ))}
              </div>
            </section>
            )}

            <div className={cn("gemini-layout", tradeLive && "gemini-layout--trade-live")}>
              {!tradeLive && (
              <aside className="gemini-context card">
                <h3 className="card-title mb-3">{selectedInstrument.label} context</h3>
                <div className="gemini-context-stats">
                  <div className="gemini-context-stat">
                    <p className="stream-metric-label">Spot</p>
                    <p className="stream-metric-value">
                      {stream ? formatNumber(stream.quote.last_price) : "—"}
                    </p>
                  </div>
                  <div className="gemini-context-stat">
                    <p className="stream-metric-label">RSI 14</p>
                    <p className="stream-metric-value">
                      {technicals.rsi14 != null ? formatNumber(technicals.rsi14, 1) : "—"}
                    </p>
                  </div>
                  <div className="gemini-context-stat">
                    <p className="stream-metric-label">EMA 20</p>
                    <p className="stream-metric-value">
                      {technicals.ema20 != null ? formatNumber(technicals.ema20) : "—"}
                    </p>
                  </div>
                  <div className="gemini-context-stat">
                    <p className="stream-metric-label">VWAP</p>
                    <p className="stream-metric-value">
                      {technicals.vwap != null ? formatNumber(technicals.vwap) : "—"}
                    </p>
                  </div>
                </div>
                <p className="text-muted mt-3" style={{ fontSize: "0.8125rem", lineHeight: 1.5 }}>
                  Options AI scans Nifty 50 for entries · pauses during open trades · auto exit at{" "}
                  {formatCurrency(AI_AUTO_TARGET_PROFIT_INR)}.
                </p>
              </aside>
              )}

              <div className="gemini-main">
                <GeminiTradingPanel
                  connected={connected}
                  marketStreaming={marketStreaming}
                  aiStreaming={aiStreaming}
                  aiAutoTrading={aiAutoTrading}
                  selectedInstrument={selectedInstrument}
                  gemini={gemini}
                  geminiError={geminiError}
                  geminiWarning={geminiWarning}
                  onStartLoop={handleStartAiLoop}
                  onStopLoop={handleStopAiLoop}
                  onGeminiPause={handleGeminiPauseForTrade}
                  onGeminiResume={handleGeminiResumeForTrade}
                  onTradeLiveChange={setTradeLive}
                  getSnapshot={buildGeminiSnapshot}
                />
              </div>
            </div>
          </>
        )}
      </div>
    </DashboardShell>
  );
}
