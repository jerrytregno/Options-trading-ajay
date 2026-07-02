import { FormEvent, useState } from "react";
import { DashboardShell } from "@/components/layout/dashboard-shell";
import { useKite } from "@/contexts/kite-context";

const ORDER_TYPES = ["MARKET", "LIMIT", "SL", "SL-M"] as const;
const PRODUCTS = ["MIS", "NRML", "CNC"] as const;

export default function TradePage() {
  const { connected, loginUrl } = useKite();
  const [form, setForm] = useState({
    tradingsymbol: "", exchange: "NFO", transaction_type: "BUY" as "BUY" | "SELL",
    order_type: "MARKET" as (typeof ORDER_TYPES)[number], product: "MIS" as (typeof PRODUCTS)[number],
    quantity: "", price: "", trigger_price: "",
  });
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<{ success?: string; error?: string }>({});

  const update = (key: string, value: string) => setForm((p) => ({ ...p, [key]: value }));

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    setResult({});
    try {
      const payload: Record<string, string | number> = {
        tradingsymbol: form.tradingsymbol.toUpperCase(), exchange: form.exchange,
        transaction_type: form.transaction_type, order_type: form.order_type,
        product: form.product, quantity: Number(form.quantity), validity: "DAY",
      };
      if (form.order_type === "LIMIT" || form.order_type === "SL") payload.price = Number(form.price);
      if (form.order_type === "SL" || form.order_type === "SL-M") payload.trigger_price = Number(form.trigger_price);

      const res = await fetch("/api/kite/orders", {
        method: "POST", headers: { "Content-Type": "application/json" },
        credentials: "include", body: JSON.stringify(payload),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Order failed");
      setResult({ success: `Order placed. ID: ${json.data.order_id}` });
    } catch (err) {
      setResult({ error: err instanceof Error ? err.message : "Order failed" });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <DashboardShell>
      <div className="page-header">
        <h1>Trade</h1>
        <p>Place options orders via Zerodha Kite</p>
      </div>

      {!connected ? (
        <div className="card">
          <p className="text-muted">Connect Zerodha to place live orders.</p>
          {loginUrl && <a href={loginUrl} className="mt-4" style={{ display: "inline-block" }}><button className="btn btn-primary">Connect Kite</button></a>}
        </div>
      ) : (
        <div className="grid-2 grid-2-lg">
          <div className="card">
            <div className="card-header">
              <h3 className="card-title">Order Form</h3>
              <p className="card-desc">Symbol format: NIFTY25JUL24800CE</p>
            </div>
            <form onSubmit={handleSubmit}>
              <div className="grid-2">
                <div className="field">
                  <label className="label">Trading Symbol</label>
                  <input className="input" value={form.tradingsymbol} onChange={(e) => update("tradingsymbol", e.target.value)} placeholder="NIFTY25JUL24800CE" required />
                </div>
                <div className="field">
                  <label className="label">Exchange</label>
                  <select className="select" value={form.exchange} onChange={(e) => update("exchange", e.target.value)}>
                    <option value="NFO">NFO</option><option value="BFO">BFO</option>
                    <option value="NSE">NSE</option><option value="BSE">BSE</option>
                  </select>
                </div>
              </div>

              <div className="flex gap-2 mb-4">
                {(["BUY", "SELL"] as const).map((type) => (
                  <button key={type} type="button"
                    className={`btn ${type === "BUY" ? "btn-buy" : "btn-sell"} ${form.transaction_type === type ? "active btn-primary" : "btn-outline"}`}
                    onClick={() => update("transaction_type", type)}>
                    {type}
                  </button>
                ))}
              </div>

              <div className="grid-3">
                <div className="field">
                  <label className="label">Order Type</label>
                  <select className="select" value={form.order_type} onChange={(e) => update("order_type", e.target.value)}>
                    {ORDER_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
                  </select>
                </div>
                <div className="field">
                  <label className="label">Product</label>
                  <select className="select" value={form.product} onChange={(e) => update("product", e.target.value)}>
                    {PRODUCTS.map((p) => <option key={p} value={p}>{p}</option>)}
                  </select>
                </div>
                <div className="field">
                  <label className="label">Quantity</label>
                  <input className="input" type="number" value={form.quantity} onChange={(e) => update("quantity", e.target.value)} required min={1} />
                </div>
              </div>

              {(form.order_type === "LIMIT" || form.order_type === "SL") && (
                <div className="field">
                  <label className="label">Price</label>
                  <input className="input" type="number" step="0.05" value={form.price} onChange={(e) => update("price", e.target.value)} required />
                </div>
              )}
              {(form.order_type === "SL" || form.order_type === "SL-M") && (
                <div className="field">
                  <label className="label">Trigger Price</label>
                  <input className="input" type="number" step="0.05" value={form.trigger_price} onChange={(e) => update("trigger_price", e.target.value)} required />
                </div>
              )}

              {result.success && <div className="alert alert-success">{result.success}</div>}
              {result.error && <div className="alert alert-error">{result.error}</div>}

              <button type="submit" className="btn btn-primary" disabled={submitting}>
                {submitting ? "Placing order..." : "Place Order"}
              </button>
            </form>
          </div>

          <div className="card">
            <h3 className="card-title">Order Tips</h3>
            <ul className="text-muted mt-4" style={{ fontSize: "0.875rem", listStyle: "none", display: "flex", flexDirection: "column", gap: "0.75rem" }}>
              <li>• Use MIS for intraday options trading.</li>
              <li>• NRML is for overnight F&O positions.</li>
              <li>• Quantity must match lot size multiples.</li>
              <li>• Copy symbols from the Options Chain page.</li>
            </ul>
            <span className="badge badge-warning mt-4">Live orders — real money</span>
          </div>
        </div>
      )}
    </DashboardShell>
  );
}
