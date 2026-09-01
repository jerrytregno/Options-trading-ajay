import { TrapsBacktestRunner } from "@/components/traps/TrapsBacktestRunner";

export default function TrapsBacktest1PtPage() {
  return (
    <TrapsBacktestRunner
      apiPath="/api/kite/traps-backtest-1pt"
      title="Traps backtest — 1 pt range"
      subtitle="Same Traps entry and exit rules as live, but the signal candle only needs a green/red high-to-low range > 1 pt instead of > 2 pt. This does not change the live bot."
      backtestOnlyNote="Signal range threshold is > 1 pt here. Live Traps still requires > 2 pt — compare the two backtest pages side by side without touching production."
    />
  );
}
