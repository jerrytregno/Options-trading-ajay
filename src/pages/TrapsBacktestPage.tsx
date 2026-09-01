import { TrapsBacktestRunner } from "@/components/traps/TrapsBacktestRunner";

export default function TrapsBacktestPage() {
  return (
    <TrapsBacktestRunner
      apiPath="/api/kite/traps-backtest"
      title="Traps backtest"
      subtitle="Live Traps rules replayed against Zerodha's real 1-minute option candles — range > 2 pt signal, 10s ±0.2 pt gate on candle 2, market entry at :11, same ladder exits."
    />
  );
}
