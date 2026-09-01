import { createContext, useContext, type ReactNode } from "react";

export interface BacktestIndexMeta {
  key: "nifty";
  /** Page heading. */
  title: string;
  /** Full index name, e.g. "Nifty 50". */
  label: string;
  /** Short form used inline in chart labels and prose. */
  shortLabel: string;
  /** Weekly options expiry weekday — drives the early square-off and flat expiry target. */
  expiryWeekday: string;
  /** Nifty baseline — every point threshold is in raw index points. */
  pointScale: number;
}

export const NIFTY_BACKTEST_META: BacktestIndexMeta = {
  key: "nifty",
  title: "Backtesting",
  label: "Nifty 50",
  shortLabel: "Nifty",
  expiryWeekday: "Tuesday",
  pointScale: 1,
};

const BacktestIndexContext = createContext<BacktestIndexMeta>(NIFTY_BACKTEST_META);

export function BacktestIndexProvider({
  meta,
  children,
}: {
  meta?: BacktestIndexMeta;
  children: ReactNode;
}) {
  return (
    <BacktestIndexContext.Provider value={meta ?? NIFTY_BACKTEST_META}>
      {children}
    </BacktestIndexContext.Provider>
  );
}

export function useBacktestIndex(): BacktestIndexMeta {
  return useContext(BacktestIndexContext);
}

/** Three-letter form used where the old copy said "Tue". */
export function shortWeekday(weekday: string): string {
  return weekday.slice(0, 3);
}
