import { createContext, useContext, type ReactNode } from "react";
import type { NineFifteenCandleRow } from "@/types/nine-fifteen";

/**
 * Every 9:15 session row in the loaded backtest sample.
 *
 * Panels nested several levels down need the whole sample to describe the market itself rather
 * than the subset a strategy traded, and threading the array through each intermediate strategy
 * block would add a prop none of them use.
 */
const BacktestSessionsContext = createContext<NineFifteenCandleRow[]>([]);

export function BacktestSessionsProvider({
  rows,
  children,
}: {
  rows: NineFifteenCandleRow[];
  children: ReactNode;
}) {
  return (
    <BacktestSessionsContext.Provider value={rows}>{children}</BacktestSessionsContext.Provider>
  );
}

export function useBacktestSessions(): NineFifteenCandleRow[] {
  return useContext(BacktestSessionsContext);
}
