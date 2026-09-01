/**
 * Deterministic full-result snapshot for the backtest engine.
 *
 * Feeds a seeded pseudo-random (but realistic) minute series through the real pipeline and
 * prints a hash of the entire NineFifteenCandlesResult. The point is refactor safety: run it
 * before and after a change and the Nifty hash must be identical, otherwise the change moved
 * numbers it should not have.
 *
 * Run: npx tsx scripts/snapshot-backtest.ts [--json out.json]
 */
import crypto from "node:crypto";
import fs from "node:fs";
import {
  fetchNineFifteenCandleHistory,
  NIFTY_INDEX_PROFILE,
  type CandleFetcher,
  type IndexProfile,
} from "../server/nine-fifteen-candles.js";

const SESSION_START = 9 * 60 + 15;
const SESSION_END = 15 * 60 + 30;

/** Mulberry32 — small, fast, fully deterministic across Node versions. */
function makeRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function isWeekday(dateKey: string): boolean {
  const day = new Date(`${dateKey}T12:00:00+05:30`).getUTCDay();
  return day !== 0 && day !== 6;
}

function datesBetween(fromKey: string, toKey: string): string[] {
  const out: string[] = [];
  const cursor = new Date(`${fromKey}T12:00:00+05:30`);
  const end = new Date(`${toKey}T12:00:00+05:30`);
  while (cursor.getTime() <= end.getTime()) {
    const key = cursor.toISOString().slice(0, 10);
    if (isWeekday(key)) out.push(key);
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return out;
}

/**
 * A day of minute candles seeded off the date, so the same date always produces the same bars
 * regardless of which chunk requested it.
 */
function buildDay(dateKey: string, basePrice: number, volatility: number): unknown[] {
  const seed = [...dateKey].reduce((acc, ch) => (acc * 31 + ch.charCodeAt(0)) >>> 0, 7);
  const rng = makeRng(seed);
  const candles: unknown[] = [];
  let price = basePrice + (rng() - 0.5) * volatility * 40;

  for (let mins = SESSION_START; mins <= SESSION_END; mins += 1) {
    const open = price;
    // Occasional bursts so signal thresholds, streaks and stops all get exercised.
    const burst = rng() < 0.06 ? 6 : 1;
    const close = open + (rng() - 0.5) * volatility * burst;
    const high = Math.max(open, close) + rng() * volatility * 0.5;
    const low = Math.min(open, close) - rng() * volatility * 0.5;
    price = close;

    const hh = String(Math.floor(mins / 60)).padStart(2, "0");
    const mm = String(mins % 60).padStart(2, "0");
    candles.push([
      `${dateKey}T${hh}:${mm}:00+05:30`,
      Number(open.toFixed(2)),
      Number(high.toFixed(2)),
      Number(low.toFixed(2)),
      Number(close.toFixed(2)),
      1000,
    ]);
  }

  return candles;
}

function fetcherFor(basePrice: number, volatility: number): CandleFetcher {
  return async (_token, instrument, _interval, from, to) => {
    const candles: unknown[] = [];
    for (const date of datesBetween(from.slice(0, 10), to.slice(0, 10))) {
      candles.push(...buildDay(date, basePrice, volatility));
    }
    return { instrument, candles };
  };
}

async function snapshot(profile: IndexProfile, basePrice: number, volatility: number) {
  const result = await fetchNineFifteenCandleHistory(
    "fake-token",
    fetcherFor(basePrice, volatility),
    365,
    true,
    false,
    profile,
  );
  const json = JSON.stringify(result);
  return {
    result,
    json,
    hash: crypto.createHash("sha256").update(json).digest("hex").slice(0, 16),
  };
}

const jsonFlagIndex = process.argv.indexOf("--json");
const jsonOut = jsonFlagIndex >= 0 ? process.argv[jsonFlagIndex + 1] : null;

const nifty = await snapshot(NIFTY_INDEX_PROFILE, 24000, 14);
console.log(`NIFTY  hash=${nifty.hash}  bytes=${nifty.json.length}`);
console.log(
  `  instrument=${nifty.result.instrument}` +
    `  sessions=${nifty.result.midBacktest1m.sessionsScanned}` +
    `  midSignals=${nifty.result.midBacktest1m.totalSignals}` +
    `  midTarget=${nifty.result.midBacktest1m.targetPoints}` +
    `  midStop=${nifty.result.midBacktest1m.stopPoints}`,
);

if (jsonOut) {
  fs.writeFileSync(jsonOut, JSON.stringify({ nifty: nifty.hash }, null, 2));
  console.log(`wrote ${jsonOut}`);
}
