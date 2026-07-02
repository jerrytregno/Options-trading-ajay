import { KitePriceChart } from "@/components/KitePriceChart";

interface KiteMiniChartProps {
  label: string;
  kiteKey: string;
  candles: unknown[];
  loading?: boolean;
  error?: string;
}

export function KiteMiniChart({ label, kiteKey, candles, loading, error }: KiteMiniChartProps) {
  return (
    <div className="kite-mini-card">
      <div className="kite-mini-header">
        <p className="font-medium">{label}</p>
        <p className="text-muted" style={{ fontSize: "0.75rem" }}>{kiteKey}</p>
      </div>
      <KitePriceChart
        candles={candles}
        height={180}
        loading={loading}
        emptyMessage={error ?? "No Zerodha history available"}
      />
    </div>
  );
}
