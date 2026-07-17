import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useKite } from "@/contexts/kite-context";
import type { ParsedCandle } from "@/lib/candles";
import {
  appendQuoteToCandles,
  buildGeminiSnapshotFromFeed,
  emptyInstrumentRecord,
  GEMINI_AI_KEY,
  GEMINI_INSTRUMENT_KEY,
  MARKET_STREAM_LIVE_KEY,
  quotesToStreamsByInstrument,
} from "@/lib/market-stream-utils";
import {
  DEFAULT_STREAM_INSTRUMENT_ID,
  getStreamInstrument,
  isStreamInstrumentId,
  STREAM_INSTRUMENTS,
} from "@/lib/stream-instruments";
import type { OptionChainResponse } from "@/types/kite";
import type { GeminiSuggestionResponse, NiftySessionResponse, NiftyStreamResponse } from "@/types/streaming";
import type { StreamingGeminiPayload } from "@/lib/streaming-snapshot";

const REFRESH_MS = 1000;
const SESSION_REFRESH_MS = 60000;

export function useGeminiMarketStream() {
  const { connected } = useKite();
  const [stream, setStream] = useState<NiftyStreamResponse | null>(null);
  const [candlesByInstrument, setCandlesByInstrument] = useState<Record<string, ParsedCandle[]>>(() =>
    emptyInstrumentRecord([])
  );
  const [streamsByInstrument, setStreamsByInstrument] = useState<Record<string, NiftyStreamResponse>>({});
  const [sessionsByInstrument, setSessionsByInstrument] = useState<Record<string, NiftySessionResponse>>({});
  const [chain, setChain] = useState<OptionChainResponse | null>(null);
  const [gemini, setGemini] = useState<GeminiSuggestionResponse | null>(null);
  const [geminiError, setGeminiError] = useState("");
  const [geminiWarning, setGeminiWarning] = useState("");
  const [loading, setLoading] = useState(false);
  const [streamError, setStreamError] = useState("");
  const [marketStreaming, setMarketStreaming] = useState(() => {
    try {
      return sessionStorage.getItem(MARKET_STREAM_LIVE_KEY) !== "off";
    } catch {
      return true;
    }
  });
  const [streamInstrumentId, setStreamInstrumentId] = useState(() => {
    try {
      const saved = sessionStorage.getItem(GEMINI_INSTRUMENT_KEY);
      return saved && isStreamInstrumentId(saved) ? saved : DEFAULT_STREAM_INSTRUMENT_ID;
    } catch {
      return DEFAULT_STREAM_INSTRUMENT_ID;
    }
  });
  const [aiStreaming, setAiStreaming] = useState(() => {
    try {
      return sessionStorage.getItem(GEMINI_AI_KEY) === "on";
    } catch {
      return false;
    }
  });

  const geminiInflight = useRef(false);
  const lastVolumeByInstrumentRef = useRef<Record<string, number>>(emptyInstrumentRecord(0));

  const selectedInstrument = useMemo(() => getStreamInstrument(streamInstrumentId), [streamInstrumentId]);
  const secondCandles = candlesByInstrument[streamInstrumentId] ?? [];

  useEffect(() => {
    setStream(streamsByInstrument[streamInstrumentId] ?? null);
  }, [streamInstrumentId, streamsByInstrument]);

  const buildGeminiSnapshot = useCallback((): StreamingGeminiPayload | null => {
    return buildGeminiSnapshotFromFeed({
      streamInstrumentId,
      stream,
      secondCandles,
      sessionsByInstrument,
      candlesByInstrument,
      streamsByInstrument,
      chain,
    });
  }, [streamInstrumentId, stream, secondCandles, sessionsByInstrument, candlesByInstrument, streamsByInstrument, chain]);

  const loadAllSessions = useCallback(async () => {
    if (!connected) return;
    await Promise.all(
      STREAM_INSTRUMENTS.map(async (inst) => {
        try {
          const res = await fetch(
            `/api/kite/instrument-session?instrument=${encodeURIComponent(inst.kiteKey)}`,
            { credentials: "include" }
          );
          const json = await res.json();
          if (!res.ok) return;
          setSessionsByInstrument((prev) => ({
            ...prev,
            [inst.id]: json.data as NiftySessionResponse,
          }));
        } catch {
          /* keep prior session */
        }
      })
    );
  }, [connected]);

  const pollAllMarkets = useCallback(async () => {
    if (!connected || !marketStreaming) return;
    const keys = STREAM_INSTRUMENTS.map((item) => item.kiteKey).join(",");
    try {
      const res = await fetch(
        `/api/kite/quotes?instruments=${encodeURIComponent(keys)}`,
        { credentials: "include" }
      );
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Failed to load quotes");

      const prevVolumes = { ...lastVolumeByInstrumentRef.current };

      setCandlesByInstrument((prev) =>
        appendQuoteToCandles(prev, json.data ?? {}, lastVolumeByInstrumentRef.current)
      );

      setStreamsByInstrument((prev) => ({
        ...prev,
        ...quotesToStreamsByInstrument(json.data ?? {}, prevVolumes),
      }));
      setStreamError("");
    } catch (err) {
      setStreamError(err instanceof Error ? err.message : "Stream unavailable");
    }
  }, [connected, marketStreaming]);

  const loadChain = useCallback(async () => {
    if (!connected) return;
    try {
      const res = await fetch(
        `/api/kite/option-chain?underlying=${encodeURIComponent(streamInstrumentId)}`,
        { credentials: "include" }
      );
      const json = await res.json();
      if (!res.ok) return;
      setChain(json.data as OptionChainResponse);
    } catch {
      setChain(null);
    }
  }, [connected, streamInstrumentId]);

  const loadGemini = useCallback(async () => {
    if (
      !connected ||
      !marketStreaming ||
      !aiStreaming ||
      geminiInflight.current ||
      !stream ||
      secondCandles.length === 0
    ) {
      return;
    }
    geminiInflight.current = true;
    try {
      const payload = buildGeminiSnapshot();
      if (!payload) return;
      const res = await fetch("/api/gemini/trade-suggestion", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify(payload),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Options AI unavailable");
      const data = json.data as GeminiSuggestionResponse;
      setGemini(data);
      setGeminiError("");
      setGeminiWarning(data.stale ? (data.warning ?? "Showing last AI suggestion") : (data.warning ?? ""));
    } catch (err) {
      const message = err instanceof Error ? err.message : "Options AI unavailable";
      if (gemini) {
        setGeminiWarning(message);
        setGeminiError("");
      } else {
        setGeminiError(message);
      }
    } finally {
      geminiInflight.current = false;
    }
  }, [connected, marketStreaming, aiStreaming, stream, secondCandles.length, buildGeminiSnapshot, gemini]);

  const selectInstrument = useCallback((id: string) => {
    if (id === streamInstrumentId) return;
    setStreamInstrumentId(id);
    setGemini(null);
    setGeminiError("");
    setGeminiWarning("");
    try {
      sessionStorage.setItem(GEMINI_INSTRUMENT_KEY, id);
    } catch {
      /* ignore */
    }
  }, [streamInstrumentId]);

  const toggleMarketStreaming = useCallback(() => {
    setMarketStreaming((prev) => {
      const next = !prev;
      try {
        sessionStorage.setItem(MARKET_STREAM_LIVE_KEY, next ? "on" : "off");
      } catch {
        /* ignore */
      }
      return next;
    });
  }, []);

  const toggleAiStreaming = useCallback(() => {
    setAiStreaming((prev) => {
      const next = !prev;
      try {
        sessionStorage.setItem(GEMINI_AI_KEY, next ? "on" : "off");
      } catch {
        /* ignore */
      }
      return next;
    });
  }, []);

  const setAiStreamingEnabled = useCallback((next: boolean, persist = false) => {
    setAiStreaming(next);
    if (persist) {
      try {
        sessionStorage.setItem(GEMINI_AI_KEY, next ? "on" : "off");
      } catch {
        /* ignore */
      }
    }
  }, []);

  useEffect(() => {
    if (!connected) {
      setCandlesByInstrument(emptyInstrumentRecord([]));
      setStreamsByInstrument({});
      setSessionsByInstrument({});
      lastVolumeByInstrumentRef.current = emptyInstrumentRecord(0);
      setStream(null);
    }
  }, [connected]);

  useEffect(() => {
    if (!connected || !marketStreaming || !aiStreaming) return;
    const interval = window.setInterval(loadGemini, REFRESH_MS);
    void loadGemini();
    return () => window.clearInterval(interval);
  }, [connected, marketStreaming, aiStreaming, streamInstrumentId, loadGemini]);

  useEffect(() => {
    if (!connected || !marketStreaming) return;
    void loadChain();
  }, [connected, marketStreaming, streamInstrumentId, loadChain]);

  useEffect(() => {
    if (!connected || !marketStreaming) return;
    setLoading(true);
    Promise.all([pollAllMarkets(), loadAllSessions(), loadChain()]).finally(() => setLoading(false));
  }, [connected, marketStreaming, pollAllMarkets, loadAllSessions, loadChain]);

  useEffect(() => {
    if (!connected || !marketStreaming) return;
    const interval = window.setInterval(loadAllSessions, SESSION_REFRESH_MS);
    return () => window.clearInterval(interval);
  }, [connected, marketStreaming, loadAllSessions]);

  useEffect(() => {
    if (!connected || !marketStreaming) return;
    const interval = window.setInterval(pollAllMarkets, REFRESH_MS);
    void pollAllMarkets();
    return () => window.clearInterval(interval);
  }, [connected, marketStreaming, pollAllMarkets]);

  return {
    connected,
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
    loadGemini,
    sessionsByInstrument,
  };
}
