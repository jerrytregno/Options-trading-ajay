import { findAtmStrike, filterStrikesAroundAtm } from "../src/lib/greeks.js";
import { getKiteInstruments } from "./kite-instruments.js";
import { kiteHttpFetch } from "./kite-http.js";

const KITE_BASE = "https://api.kite.trade";

interface KiteQuotePayload {
  last_price?: number;
  oi?: number;
  volume?: number;
  change?: number;
  depth?: {
    buy?: { price: number; quantity: number; orders?: number }[];
    sell?: { price: number; quantity: number; orders?: number }[];
  };
  buy_quantity?: number;
  sell_quantity?: number;
}

export interface PredictionLiveSnapshot {
  atm_pcr: number;
  atm_call_oi_change: number;
  atm_put_oi_change: number;
  oi_delta: number;
  iv_change: number;
  max_pain_distance: number;
  bid_volume: number;
  ask_volume: number;
  bid_ask_ratio: number;
  obi: number;
  gemini_sentiment: number;
  gemini_impact: number;
  gemini_banking: number;
  gemini_it: number;
  gemini_energy: number;
}

let lastOptionSnapshot: {
  at: number;
  callOi: number;
  putOi: number;
  iv: number;
} | null = null;

async function kiteGet<T>(path: string, accessToken: string, apiKey: string): Promise<T> {
  const res = await kiteHttpFetch(`${KITE_BASE}${path}`, {
    headers: {
      "X-Kite-Version": "3",
      Authorization: `token ${apiKey}:${accessToken}`,
    },
  });
  const json = (await res.json()) as { status?: string; message?: string; data?: T };
  if (json.status === "error") throw new Error(json.message ?? "Kite API error");
  return json.data as T;
}

function sumDepthQty(levels?: { quantity?: number }[]) {
  return (levels ?? []).reduce((s, l) => s + Math.max(0, l.quantity ?? 0), 0);
}

function calcMaxPainDistance(
  chain: { strike: number; ceOi: number; peOi: number }[],
  spot: number,
): number {
  if (!chain.length || spot <= 0) return 0;
  let bestStrike = spot;
  let minPain = Infinity;
  for (const test of chain) {
    let pain = 0;
    for (const row of chain) {
      pain += Math.max(0, test.strike - row.strike) * row.ceOi;
      pain += Math.max(0, row.strike - test.strike) * row.peOi;
    }
    if (pain < minPain) {
      minPain = pain;
      bestStrike = test.strike;
    }
  }
  return (spot - bestStrike) / spot;
}

export async function buildPredictionLiveSnapshot(
  accessToken: string,
  apiKey: string,
  niftyFutKey: string,
): Promise<PredictionLiveSnapshot> {
  const defaults: PredictionLiveSnapshot = {
    atm_pcr: 1,
    atm_call_oi_change: 0,
    atm_put_oi_change: 0,
    oi_delta: 0,
    iv_change: 0,
    max_pain_distance: 0,
    bid_volume: 0,
    ask_volume: 0,
    bid_ask_ratio: 1,
    obi: 0,
    gemini_sentiment: 0.5,
    gemini_impact: 0,
    gemini_banking: 0,
    gemini_it: 0,
    gemini_energy: 0,
  };

  try {
    const quotes = await kiteGet<Record<string, KiteQuotePayload>>(
      `/quote?i=${encodeURIComponent(niftyFutKey)}&i=${encodeURIComponent("NSE:NIFTY 50")}`,
      accessToken,
      apiKey,
    );

    const futQuote = quotes[niftyFutKey] ?? Object.values(quotes)[0];
    if (futQuote?.depth) {
      const bid = sumDepthQty(futQuote.depth.buy) || (futQuote.buy_quantity ?? 0);
      const ask = sumDepthQty(futQuote.depth.sell) || (futQuote.sell_quantity ?? 0);
      defaults.bid_volume = bid;
      defaults.ask_volume = ask;
      defaults.bid_ask_ratio = ask > 0 ? bid / ask : bid > 0 ? 2 : 1;
      defaults.obi = bid + ask > 0 ? (bid - ask) / (bid + ask) : 0;
    }

    const nfo = await getKiteInstruments("NFO", accessToken, apiKey);
    const options = nfo.filter(
      (i) =>
        i.segment === "NFO-OPT" &&
        i.name === "NIFTY" &&
        (i.tradingsymbol.endsWith("CE") || i.tradingsymbol.endsWith("PE")),
    );
    const expiries = [...new Set(options.map((i) => i.expiry).filter(Boolean))] as string[];
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const expiry =
      expiries.filter((e) => new Date(e) >= today).sort()[0] ?? expiries.sort()[0];
    const expiryOpts = options.filter((i) => i.expiry === expiry);
    const strikes = [...new Set(expiryOpts.map((i) => i.strike!).filter(Boolean))];
    const spotQuotes = await kiteGet<Record<string, KiteQuotePayload>>(
      `/quote?i=${encodeURIComponent("NSE:NIFTY 50")}`,
      accessToken,
      apiKey,
    );
    const spot = spotQuotes["NSE:NIFTY 50"]?.last_price ?? 0;
    const atm = findAtmStrike(strikes, spot);
    const visible = filterStrikesAroundAtm(strikes, atm, 12);
    const scoped = expiryOpts.filter((i) => visible.has(i.strike!));
    const keys = scoped.map((i) => `${i.exchange}:${i.tradingsymbol}`);
    const batch = keys.length
      ? await kiteGet<Record<string, KiteQuotePayload>>(
          `/quote?${keys.map((k) => `i=${encodeURIComponent(k)}`).join("&")}`,
          accessToken,
          apiKey,
        )
      : {};

    const byStrike = new Map<number, { ceOi: number; peOi: number }>();
    for (const inst of scoped) {
      const q = batch[`${inst.exchange}:${inst.tradingsymbol}`];
      const row = byStrike.get(inst.strike!) ?? { ceOi: 0, peOi: 0 };
      if (inst.tradingsymbol.endsWith("CE")) row.ceOi = q?.oi ?? 0;
      if (inst.tradingsymbol.endsWith("PE")) row.peOi = q?.oi ?? 0;
      byStrike.set(inst.strike!, row);
    }

    const chain = Array.from(byStrike.entries()).map(([strike, v]) => ({
      strike,
      ceOi: v.ceOi,
      peOi: v.peOi,
    }));
    const atmRow = byStrike.get(atm) ?? { ceOi: 0, peOi: 0 };
    const callOi = atmRow.ceOi;
    const putOi = atmRow.peOi;
    defaults.atm_pcr = callOi > 0 ? putOi / callOi : 1;
    defaults.oi_delta = callOi - putOi;
    defaults.max_pain_distance = calcMaxPainDistance(chain, spot);

    const now = Date.now();
    if (lastOptionSnapshot && now - lastOptionSnapshot.at < 120_000) {
      defaults.atm_call_oi_change = callOi - lastOptionSnapshot.callOi;
      defaults.atm_put_oi_change = putOi - lastOptionSnapshot.putOi;
      defaults.iv_change = 0;
    }
    lastOptionSnapshot = { at: now, callOi, putOi, iv: 0 };
  } catch {
    // keep defaults for optional live layers
  }

  return defaults;
}

export async function fetchGeminiSentimentFeatures(): Promise<
  Pick<
    PredictionLiveSnapshot,
    "gemini_sentiment" | "gemini_impact" | "gemini_banking" | "gemini_it" | "gemini_energy"
  >
> {
  const defaults = {
    gemini_sentiment: 0.5,
    gemini_impact: 0,
    gemini_banking: 0,
    gemini_it: 0,
    gemini_energy: 0,
  };
  const apiKey = process.env.GEMINI_API_KEY?.trim();
  const model = process.env.GEMINI_MODEL ?? "gemini-3.1-flash-lite";
  if (!apiKey) return defaults;

  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [
            {
              parts: [
                {
                  text: `Return ONLY valid JSON for Indian market right now (no markdown):
{"sentiment":0.0-1.0,"impact":0.0-1.0,"banking":0|1,"it":0|1,"energy":0|1}
sentiment=bullishness, impact=news relevance, sector flags for Nifty next 1 minute.`,
                },
              ],
            },
          ],
          generationConfig: { temperature: 0.1, maxOutputTokens: 128 },
        }),
        signal: AbortSignal.timeout(8000),
      },
    );
    if (!res.ok) return defaults;
    const json = (await res.json()) as {
      candidates?: { content?: { parts?: { text?: string }[] } }[];
    };
    const text = json.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) return defaults;
    const parsed = JSON.parse(match[0]) as Record<string, number>;
    return {
      gemini_sentiment: Number(parsed.sentiment) || 0.5,
      gemini_impact: Number(parsed.impact) || 0,
      gemini_banking: Number(parsed.banking) || 0,
      gemini_it: Number(parsed.it) || 0,
      gemini_energy: Number(parsed.energy) || 0,
    };
  } catch {
    return defaults;
  }
}
