import type { NineFifteenCePeFailureTrade } from "@/types/nine-fifteen";

export const SMALL_BODY_POINT_GRID_MAX = 10;

export interface SmallBodyPointGridCell {
  trades: number;
  wins: number;
  losses: number;
  /** Winning session dates (YYYY-MM-DD) in this cell. */
  winDates: string[];
  /** Losing session dates (YYYY-MM-DD) in this cell. */
  lossDates: string[];
}

export interface SmallBodyPointGridRow {
  point: number;
  put: SmallBodyPointGridCell;
  call: SmallBodyPointGridCell;
}

function emptyCell(): SmallBodyPointGridCell {
  return { trades: 0, wins: 0, losses: 0, winDates: [], lossDates: [] };
}

/** Integer |9:15 Δ| bucket for the 0–10 win grid (floor, capped at 10). */
export function smallBodyAbsPoint(change: number): number {
  const abs = Math.abs(change);
  if (!Number.isFinite(abs) || abs < 0) return 0;
  return Math.min(SMALL_BODY_POINT_GRID_MAX, Math.floor(abs));
}

/** PUT/CALL win ticks by floor(|9:15 Δ|) for 0…10. */
export function buildSmallBodyPointGrid(
  successes: NineFifteenCePeFailureTrade[] | undefined,
  failures: NineFifteenCePeFailureTrade[] | undefined,
  options?: { columnFrom: "side" | "direction" },
): SmallBodyPointGridRow[] {
  const columnFrom = options?.columnFrom ?? "side";
  const rows: SmallBodyPointGridRow[] = Array.from(
    { length: SMALL_BODY_POINT_GRID_MAX + 1 },
    (_, point) => ({
      point,
      put: emptyCell(),
      call: emptyCell(),
    }),
  );

  const trades = [
    ...(successes ?? []).map((t) => ({ trade: t, won: true as const })),
    ...(failures ?? []).map((t) => ({ trade: t, won: false as const })),
  ];

  for (const { trade, won } of trades) {
    const point = smallBodyAbsPoint(trade.change);
    const key = tradeColumnKey(trade, columnFrom);
    if (!key) continue;
    const cell = rows[point][key];
    cell.trades += 1;
    if (won) {
      cell.wins += 1;
      cell.winDates.push(trade.date);
    } else {
      cell.losses += 1;
      cell.lossDates.push(trade.date);
    }
  }

  return rows;
}

function tradeColumnKey(
  trade: NineFifteenCePeFailureTrade,
  columnFrom: "side" | "direction",
): "put" | "call" | null {
  if (columnFrom === "side") {
    return trade.side === "PE" ? "put" : trade.side === "CE" ? "call" : null;
  }
  if (trade.direction === "down") return "put";
  if (trade.direction === "up") return "call";
  return null;
}

/** Wins only — PUT/CALL column from 9:15 candle direction (UP→CALL · DOWN→PUT). */
export function buildSmallBodyDirectionWinPointGrid(
  successes: NineFifteenCePeFailureTrade[] | undefined,
): SmallBodyPointGridRow[] {
  const rows: SmallBodyPointGridRow[] = Array.from(
    { length: SMALL_BODY_POINT_GRID_MAX + 1 },
    (_, point) => ({
      point,
      put: emptyCell(),
      call: emptyCell(),
    }),
  );

  for (const trade of successes ?? []) {
    const point = smallBodyAbsPoint(trade.change);
    const key = tradeColumnKey(trade, "direction");
    if (!key) continue;
    const cell = rows[point][key];
    cell.trades += 1;
    cell.wins += 1;
    cell.winDates.push(trade.date);
  }

  return rows;
}
