export const PREDICTION_INTERVALS = ["minute", "3minute", "5minute", "15minute"] as const;

export type PredictionInterval = (typeof PREDICTION_INTERVALS)[number];

export const PREDICTION_INTERVAL_LABELS: Record<PredictionInterval, string> = {
  minute: "1 min",
  "3minute": "3 min",
  "5minute": "5 min",
  "15minute": "15 min",
};

export const PREDICTION_INTERVAL_MINUTES: Record<PredictionInterval, number> = {
  minute: 1,
  "3minute": 3,
  "5minute": 5,
  "15minute": 15,
};

export function isPredictionInterval(value: string): value is PredictionInterval {
  return (PREDICTION_INTERVALS as readonly string[]).includes(value);
}

export function parsePredictionInterval(value: string | undefined | null): PredictionInterval {
  if (value && isPredictionInterval(value)) return value;
  return "minute";
}

export function horizonLabel(interval: PredictionInterval): string {
  return PREDICTION_INTERVAL_LABELS[interval];
}

export function nextCandleHorizon(interval: PredictionInterval): string {
  return `next_${interval}_candle`;
}

export function getTodayIstDate(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

export function getTomorrowIstDate(): string {
  const today = getTodayIstDate();
  const d = new Date(`${today}T12:00:00+05:30`);
  d.setDate(d.getDate() + 1);
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);
}

export function isTodayIstDate(dateStr: string): boolean {
  return dateStr === getTodayIstDate();
}

export function isTomorrowIstDate(dateStr: string): boolean {
  return dateStr === getTomorrowIstDate();
}

/** Today or tomorrow — uses live Kite candles + auto-reveal in Check model. */
export function isLiveBacktestDate(dateStr: string): boolean {
  return isTodayIstDate(dateStr) || isTomorrowIstDate(dateStr);
}

export function minTrainingBars(interval: PredictionInterval): number {
  return Math.max(100, Math.floor(300 / PREDICTION_INTERVAL_MINUTES[interval]));
}

/** Poll interval for live refresh — one candle length per tab. */
export function autoRefreshMs(interval: PredictionInterval): number {
  return PREDICTION_INTERVAL_MINUTES[interval] * 60_000;
}

function istTimeLabel(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Kolkata",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(d);
}

/** Human label: closed candle → the bar being predicted (usually the open/current 1m bar). */
export function formatLivePredictionWindow(
  asOf: string,
  interval: PredictionInterval,
  nowMs = Date.now(),
): { fromLabel: string; toLabel: string; summary: string; inPredictedWindow: boolean } {
  const fromLabel = istTimeLabel(asOf);
  const d = new Date(asOf);
  if (Number.isNaN(d.getTime())) {
    return {
      fromLabel: "",
      toLabel: "",
      summary: `Predicting the next ${PREDICTION_INTERVAL_LABELS[interval]} candle`,
      inPredictedWindow: false,
    };
  }
  const stepMs = PREDICTION_INTERVAL_MINUTES[interval] * 60_000;
  d.setMinutes(d.getMinutes() + PREDICTION_INTERVAL_MINUTES[interval]);
  const toLabel = istTimeLabel(d.toISOString());
  const targetStart = new Date(asOf).getTime() + stepMs;
  const inPredictedWindow = nowMs >= targetStart && nowMs < targetStart + stepMs;
  const summary =
    fromLabel && toLabel
      ? inPredictedWindow
        ? `Candle ${fromLabel} closed → predicting current ${toLabel} bar (${PREDICTION_INTERVAL_LABELS[interval]})`
        : `Candle ${fromLabel} closed → predicting ${toLabel} (${PREDICTION_INTERVAL_LABELS[interval]})`
      : `Predicting the next ${PREDICTION_INTERVAL_LABELS[interval]} candle`;
  return { fromLabel, toLabel, summary, inPredictedWindow };
}
