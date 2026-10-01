/**
 * Nifty 9:15 open ±5 / entry ±10 backtest — thin wrapper around the shared session engine.
 */
import path from "path";
import { fileURLToPath } from "url";
import type { NineFifteenHighMinus5BacktestResult } from "../src/types/nine-fifteen-high-minus5-backtest.js";
import { NIFTY_INDEX_PROFILE, NINE_FIFTEEN_BACKTEST_MAX_SESSIONS, type IndexProfile } from "./nine-fifteen-candles.js";
import {
  NIFTY_OPEN_OFFSET_SESSION,
  ensureOpenOffsetBacktest,
  fetchAndBuildOpenOffsetBacktest,
  simulateHighMinus5Day,
  simulateHighPlus5Day,
  simulateOpenAtOpenMinus10Day,
  buildOpenOffsetFromMinuteMap,
  isSmallGreen915Body,
  isSmallRed915Body,
  maxRallyBefore10FromOpen,
  maxSelloffBefore10FromOpen,
  SMALL_GREEN_MAX_BODY_PTS,
  SMALL_RED_MAX_BODY_PTS,
  PRE10_RALLY_FROM_OPEN_PTS,
  PRE10_SELLOFF_FROM_OPEN_PTS,
} from "./open-offset-session-backtest.js";

export {
  simulateHighMinus5Day,
  simulateHighPlus5Day,
  simulateOpenAtOpenMinus10Day,
  buildOpenOffsetFromMinuteMap,
  isSmallGreen915Body,
  isSmallRed915Body,
  maxRallyBefore10FromOpen,
  maxSelloffBefore10FromOpen,
  SMALL_GREEN_MAX_BODY_PTS,
  SMALL_RED_MAX_BODY_PTS,
  PRE10_RALLY_FROM_OPEN_PTS,
  PRE10_SELLOFF_FROM_OPEN_PTS,
  NIFTY_OPEN_OFFSET_SESSION,
};

export const NINE_FIFTEEN_HIGH_MINUS5_ENTRY_OFFSET = 5;
export const NINE_FIFTEEN_HIGH_MINUS5_TP_OFFSET = 10;
export const NINE_FIFTEEN_HIGH_MINUS5_DEFAULT_DAYS = 365;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, "..", "data");

const NIFTY_STORE = {
  cacheFile: path.join(DATA_DIR, "nine-fifteen-high-minus5-backtest.json.gz"),
  metaFile: path.join(DATA_DIR, "nine-fifteen-high-minus5-backtest.meta.json"),
  cacheVersion: 14,
  defaultDays: NINE_FIFTEEN_HIGH_MINUS5_DEFAULT_DAYS,
  maxDays: NINE_FIFTEEN_BACKTEST_MAX_SESSIONS,
};

async function resolveNiftySpotKey(_accessToken: string, _asOfDate: string): Promise<string> {
  return NIFTY_INDEX_PROFILE.spotKey;
}

export async function ensureHighMinus5Backtest(
  accessToken: string,
  daysRequested = NINE_FIFTEEN_HIGH_MINUS5_DEFAULT_DAYS,
  force = false,
  _profile: IndexProfile = NIFTY_INDEX_PROFILE,
): Promise<{ data: NineFifteenHighMinus5BacktestResult; cached: boolean; builtAt: number }> {
  return ensureOpenOffsetBacktest(
    accessToken,
    NIFTY_STORE,
    NIFTY_OPEN_OFFSET_SESSION,
    resolveNiftySpotKey,
    daysRequested,
    force,
    "full",
  );
}

export async function fetchAndBuildHighMinus5(
  accessToken: string,
  days: number,
): Promise<NineFifteenHighMinus5BacktestResult> {
  return fetchAndBuildOpenOffsetBacktest(
    accessToken,
    days,
    NIFTY_OPEN_OFFSET_SESSION,
    resolveNiftySpotKey,
    "full",
  );
}
