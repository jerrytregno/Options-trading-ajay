import { Link } from "react-router-dom";
import { useEffect, useState } from "react";
import { Bot, Brain, Sparkles, Zap } from "lucide-react";
import { GeminiAutoTrader, type GeminiAutoTradePhase } from "@/components/trade/GeminiAutoTrader";
import { AI_AUTO_TARGET_PROFIT_INR, isAiLoopEntryAction } from "@/lib/auto-trade";
import type { StreamingGeminiPayload } from "@/lib/streaming-snapshot";
import type { StreamInstrument } from "@/lib/stream-instruments";
import type { GeminiSuggestionResponse } from "@/types/streaming";
import { cn, formatCurrency } from "@/lib/utils";
import { formatIndianDateTime } from "@/lib/market-time";

function legToUrl(action: string, strike: number | null, auto = false) {
  if (!strike || action === "WAIT") return null;
  const leg = action.toLowerCase().replace(/_/g, "-");
  return `/dashboard/trade?strike=${strike}&leg=${leg}${auto ? "&auto=1" : ""}`;
}

interface GeminiTradingPanelProps {
  connected: boolean;
  marketStreaming: boolean;
  aiStreaming: boolean;
  selectedInstrument: StreamInstrument;
  gemini: GeminiSuggestionResponse | null;
  geminiError: string;
  geminiWarning: string;
  aiAutoTrading: boolean;
  onStartLoop: () => void;
  onStopLoop: () => void;
  onGeminiPause: () => void;
  onGeminiResume: () => void;
  onTradeLiveChange?: (live: boolean) => void;
  getSnapshot: () => StreamingGeminiPayload | null;
}

export function GeminiTradingPanel({
  connected,
  marketStreaming,
  aiStreaming,
  selectedInstrument,
  gemini,
  geminiError,
  geminiWarning,
  aiAutoTrading,
  onStartLoop,
  onStopLoop,
  onGeminiPause,
  onGeminiResume,
  onTradeLiveChange,
  getSnapshot,
}: GeminiTradingPanelProps) {
  const [tradeLive, setTradeLive] = useState(false);
  const tradeUrl = gemini?.suggestion ? legToUrl(gemini.suggestion.action, gemini.suggestion.strike) : null;

  const handleAutoPhaseChange = (phase: GeminiAutoTradePhase) => {
    const live = phase === "in_position" || phase === "exiting";
    setTradeLive(live);
    onTradeLiveChange?.(live);
  };

  useEffect(() => {
    if (!aiAutoTrading) setTradeLive(false);
  }, [aiAutoTrading]);

  return (
    <div className={cn("gemini-panel", tradeLive && "gemini-panel--trade-live")}>
      {aiAutoTrading && connected && marketStreaming && (
        <GeminiAutoTrader
          connected={connected}
          marketStreaming={marketStreaming}
          aiStreaming={aiStreaming}
          underlyingId={selectedInstrument.id}
          getSnapshot={getSnapshot}
          onStop={onStopLoop}
          onGeminiPause={onGeminiPause}
          onGeminiResume={onGeminiResume}
          onPhaseChange={handleAutoPhaseChange}
        />
      )}

      {!tradeLive && (
        <>
      <div className="gemini-panel-head">
        <div className="gemini-panel-brand">
          <span className="gemini-panel-icon">
            <Brain size={20} />
          </span>
          <div>
            <h2 className="gemini-panel-title">Live AI analysis</h2>
            <p className="gemini-panel-sub">
              {selectedInstrument.label} · Call/Put Buy only · +{formatCurrency(AI_AUTO_TARGET_PROFIT_INR)} auto exit
            </p>
          </div>
        </div>
      </div>

      {!marketStreaming && (
        <div className="stream-ai-notice stream-ai-notice-warning">
          Market stream is paused. Turn on live data first.
        </div>
      )}

      {marketStreaming && !aiStreaming && (
        <div className="stream-ai-notice stream-ai-notice-warning">
          {aiAutoTrading ? (
            <>
              Options AI paused during open trade — auto exit at{" "}
              <strong>+{formatCurrency(AI_AUTO_TARGET_PROFIT_INR)}</strong> (no API calls). AI resumes after sell.
            </>
          ) : (
            <>
              Options AI is paused — no API calls. Toggle <strong>AI On</strong> in the toolbar to analyze markets.
            </>
          )}
        </div>
      )}

      {geminiError && marketStreaming && aiStreaming && (
        <div className="stream-ai-notice stream-ai-notice-error">{geminiError}</div>
      )}
      {geminiWarning && !geminiError && marketStreaming && aiStreaming && (
        <div className="stream-ai-notice stream-ai-notice-warning">{geminiWarning}</div>
      )}

      {!aiStreaming && gemini?.suggestion ? (
        <div className="gemini-suggestion">
          <span className="stream-ai-tag">Last suggestion</span>
          <p className="stream-ai-summary">{gemini.suggestion.summary}</p>
          <p className="text-muted" style={{ fontSize: "0.8125rem" }}>
            {gemini.suggestion.action.replace(/_/g, " ")}
            {gemini.suggestion.strike ? ` · ${gemini.suggestion.strike}` : ""}
          </p>
        </div>
      ) : gemini?.suggestion && aiStreaming ? (
        <div className="gemini-suggestion">
          <div className="stream-ai-tags">
            <span
              className={cn(
                "stream-ai-tag",
                gemini.suggestion.bias === "bullish" && "stream-ai-tag-bull",
                gemini.suggestion.bias === "bearish" && "stream-ai-tag-bear"
              )}
            >
              {gemini.suggestion.bias}
            </span>
            <span className="stream-ai-tag">{gemini.suggestion.confidence}</span>
            <span className="stream-ai-tag">{gemini.suggestion.action.replace(/_/g, " ")}</span>
            {gemini.cached && <span className="stream-ai-tag">Cached</span>}
          </div>

          <p className="stream-ai-summary">{gemini.suggestion.summary}</p>

          {gemini.thinking && (
            <div className="stream-ai-block">
              <p className="stream-ai-block-title">Reasoning</p>
              <p className="text-muted stream-ai-thinking-text">{gemini.thinking}</p>
            </div>
          )}

          <div className="gemini-plan-grid">
            <div className="stream-ai-block">
              <p className="stream-ai-block-title">Entry plan</p>
              <p className="text-muted" style={{ fontSize: "0.8125rem" }}>
                {gemini.suggestion.entryPlan}
              </p>
            </div>
            <div className="stream-ai-block">
              <p className="stream-ai-block-title">Risk</p>
              <p className="text-muted" style={{ fontSize: "0.8125rem" }}>
                {gemini.suggestion.riskPlan}
              </p>
            </div>
          </div>

          {isAiLoopEntryAction(gemini.suggestion.action) && !aiAutoTrading && marketStreaming && aiStreaming && (
            <button type="button" className="stream-ai-cta" onClick={onStartLoop}>
              <span className="stream-ai-cta-icon">
                <Zap size={16} />
              </span>
              <span className="stream-ai-cta-text">
                <strong>Start AI Loop</strong>
                <small>Buy CE/PE · auto exit +{formatCurrency(AI_AUTO_TARGET_PROFIT_INR)}</small>
              </span>
              <Bot size={18} className="stream-ai-cta-bot" />
            </button>
          )}

          {tradeUrl && (
            <Link to={tradeUrl} className="btn btn-secondary btn-full mt-2">
              Open manual trade ticket
            </Link>
          )}

          <p className="text-muted mt-3" style={{ fontSize: "0.6875rem" }}>
            {gemini.model}
            {gemini.updatedAt ? ` · ${formatIndianDateTime(new Date(gemini.updatedAt))}` : ""}
          </p>
        </div>
      ) : marketStreaming && aiStreaming ? (
        <div className="stream-ai-empty">
          <Sparkles size={28} className="stream-chart-empty-icon" />
          <p>Analyzing {selectedInstrument.label} with full streaming context…</p>
        </div>
      ) : marketStreaming ? (
        <div className="stream-ai-empty">
          <Brain size={28} className="stream-chart-empty-icon" />
          <p>Turn on Options AI to get live trade suggestions.</p>
        </div>
      ) : (
        <div className="stream-ai-empty">
          <Brain size={28} className="stream-chart-empty-icon" />
          <p>Enable live stream to get AI trade suggestions.</p>
        </div>
      )}
        </>
      )}
    </div>
  );
}
