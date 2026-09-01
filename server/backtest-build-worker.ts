/**
 * Builds one index's backtest payload, writes the gzipped cache to disk, and exits.
 *
 * Run in the API process, a build peaked around 1.5 GB and V8 never handed those pages back, so
 * the long-lived server — which also runs the live 9:16 bot — sat at that RSS for good and pushed
 * this 2 GB host permanently into swap. As a throwaway child, the whole working set is reclaimed
 * by the OS the moment it exits.
 *
 * Usage: backtest-build-worker <indexId> <days>, with the Kite token in KITE_BUILD_ACCESS_TOKEN
 * (env rather than argv, which every user on the box can read out of `ps`).
 */
import "./load-env.js";
import { fetchHistoricalCandles } from "./kite-candles.js";
import {
  buildAndWriteNineFifteenPayload,
  NIFTY_INDEX_PROFILE,
  NINE_FIFTEEN_DEFAULT_HISTORY_DAYS,
  type IndexProfile,
} from "./nine-fifteen-candles.js";

const PROFILES: IndexProfile[] = [NIFTY_INDEX_PROFILE];

async function main() {
  const [indexId, daysArg] = process.argv.slice(2);
  const profile = PROFILES.find((item) => item.id === indexId);
  if (!profile) {
    throw new Error(`Unknown index "${indexId}" — expected one of ${PROFILES.map((p) => p.id).join(", ")}`);
  }

  const accessToken = process.env.KITE_BUILD_ACCESS_TOKEN;
  if (!accessToken) {
    throw new Error("KITE_BUILD_ACCESS_TOKEN is not set");
  }

  const days = Number(daysArg) || NINE_FIFTEEN_DEFAULT_HISTORY_DAYS;
  const started = Date.now();
  await buildAndWriteNineFifteenPayload(accessToken, fetchHistoricalCandles, days, profile);
  const seconds = Math.round((Date.now() - started) / 1000);
  const peakMb = Math.round(process.memoryUsage().rss / 1024 / 1024);
  console.log(`[backtest-build] ${profile.id} built in ${seconds}s (rss ${peakMb} MB)`);
}

main().then(
  () => process.exit(0),
  (error: unknown) => {
    console.error(`[backtest-build] failed — ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  },
);
