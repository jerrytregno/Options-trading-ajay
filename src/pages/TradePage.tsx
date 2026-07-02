import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { DashboardShell } from "@/components/layout/dashboard-shell";
import { useKite } from "@/contexts/kite-context";
import {
  calculateTradeMetrics,
  getExecutionPrice,
  legLabel,
  parseTradeLeg,
  productForExchange,
  type OrderType,
  type ProductType,
  type TradeLeg,
} from "@/lib/trade-calculations";
import type { OptionChainResponse } from "@/types/kite";
import type { OrderMarginResponse } from "@/types/trade";
import { cn, formatCurrency, formatNumber } from "@/lib/utils";

const ORDER_TYPES: OrderType[] = ["MARKET", "LIMIT", "SL", "SL-M"];
const PRODUCTS: ProductType[] = ["MIS", "NRML", "CNC"];
const LEGS: TradeLeg[] = ["CE_BUY", "CE_SELL", "PE_BUY", "PE_SELL"];

function parseLegParam(value: string | null): TradeLeg | null {
  if (!value) return null;
  const normalized = value.toUpperCase().replace("-", "_") as TradeLeg;
  return LEGS.includes(normalized) ? normalized : null;
}

export default function TradePage() {
  const { connected, loginUrl } = useKite();
  const [searchParams] = useSearchParams();
  const [chainData, setChainData] = useState<OptionChainResponse | null>(null);
  const [loadingChain, setLoadingChain] = useState(false);
  const [selectedStrike, setSelectedStrike] = useState<number>(0);
  const [leg, setLeg] = useState<TradeLeg>("CE_BUY");
  const [product, setProduct] = useState<ProductType>("MIS");
  const [orderType, setOrderType] = useState<OrderType>("LIMIT");
  const [lots, setLots] = useState(1);
  const [limitPrice, setLimitPrice] = useState("");
  const [triggerPrice, setTriggerPrice] = useState("");
  const [targetPrice, setTargetPrice] = useState("");
  const [stopLossPrice, setStopLossPrice] = useState("");
  const [availableMargin, setAvailableMargin] = useState(0);
  const [requiredMargin, setRequiredMargin] = useState<number | null>(null);
  const [marginLoading, setMarginLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<{ success?: string; error?: string }>({});

  const selectedRow = useMemo(
    () => chainData?.chain.find((row) => row.strike === selectedStrike),
    [chainData, selectedStrike]
  );

  const { optionType, transactionType } = parseTradeLeg(leg);
  const instrument = optionType === "CE" ? selectedRow?.ce : selectedRow?.pe;
  const ltp = instrument?.quote?.last_price ?? 0;
  const lotSize = instrument?.lot_size ?? 75;
  const effectiveProduct = productForExchange(product, "NFO");

  const metrics = useMemo(
    () =>
      calculateTradeMetrics({
        leg,
        orderType,
        ltp,
        limitPrice: Number(limitPrice) || 0,
        targetPrice: Number(targetPrice) || 0,
        stopLossPrice: Number(stopLossPrice) || 0,
        lots,
        lotSize,
        strike: selectedStrike,
      }),
    [leg, orderType, ltp, limitPrice, targetPrice, stopLossPrice, lots, lotSize, selectedStrike]
  );

  const loadChain = useCallback(async () => {
    if (!connected) return;
    setLoadingChain(true);
    try {
      const res = await fetch("/api/kite/option-chain", { credentials: "include" });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Failed to load Nifty chain");
      const data = json.data as OptionChainResponse;
      setChainData(data);

      const strikeParam = Number(searchParams.get("strike"));
      const defaultStrike =
        Number.isFinite(strikeParam) && data.chain.some((row) => row.strike === strikeParam)
          ? strikeParam
          : data.atmStrike || data.chain[Math.floor(data.chain.length / 2)]?.strike || 0;

      setSelectedStrike(defaultStrike);
      const legParam = parseLegParam(searchParams.get("leg"));
      if (legParam) setLeg(legParam);
    } catch {
      setChainData(null);
    } finally {
      setLoadingChain(false);
    }
  }, [connected, searchParams]);

  useEffect(() => {
    loadChain();
  }, [loadChain]);

  useEffect(() => {
    if (!connected) return;
    fetch("/api/kite/margins", { credentials: "include" })
      .then((res) => res.json())
      .then((json) => setAvailableMargin(json.data?.available ?? 0))
      .catch(() => setAvailableMargin(0));
  }, [connected]);

  useEffect(() => {
    if (ltp > 0) setLimitPrice(ltp.toFixed(2));
  }, [selectedStrike, leg, ltp]);

  useEffect(() => {
    if (!connected || !instrument?.tradingsymbol || metrics.quantity <= 0) {
      setRequiredMargin(null);
      return;
    }

    const timer = window.setTimeout(async () => {
      setMarginLoading(true);
      try {
        const orderPayload: Record<string, string | number> = {
          exchange: "NFO",
          tradingsymbol: instrument.tradingsymbol,
          transaction_type: transactionType,
          variety: "regular",
          product: effectiveProduct,
          order_type: orderType,
          quantity: metrics.quantity,
          price: 0,
          trigger_price: 0,
        };

        const execPrice = getExecutionPrice(orderType, ltp, Number(limitPrice) || 0);
        if (orderType === "LIMIT" || orderType === "SL") orderPayload.price = execPrice;
        if (orderType === "SL" || orderType === "SL-M") {
          orderPayload.trigger_price = Number(triggerPrice) || execPrice;
        }

        const res = await fetch("/api/kite/order-margin", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify(orderPayload),
        });
        const json = await res.json();
        if (!res.ok) throw new Error(json.error ?? "Margin unavailable");
        const margin = json.data as OrderMarginResponse;
        setRequiredMargin(margin.total ?? null);
      } catch {
        setRequiredMargin(null);
      } finally {
        setMarginLoading(false);
      }
    }, 350);

    return () => window.clearTimeout(timer);
  }, [
    connected,
    instrument?.tradingsymbol,
    transactionType,
    effectiveProduct,
    orderType,
    metrics.quantity,
    ltp,
    limitPrice,
    triggerPrice,
  ]);

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    if (!instrument?.tradingsymbol) {
      setResult({ error: "Select a valid strike with live quotes" });
      return;
    }

    setSubmitting(true);
    setResult({});
    try {
      const payload: Record<string, string | number> = {
        tradingsymbol: instrument.tradingsymbol,
        exchange: "NFO",
        transaction_type: transactionType,
        order_type: orderType,
        product: effectiveProduct,
        quantity: metrics.quantity,
        validity: "DAY",
        variety: "regular",
      };

      const execPrice = getExecutionPrice(orderType, ltp, Number(limitPrice) || 0);
      if (orderType === "LIMIT" || orderType === "SL") payload.price = execPrice;
      if (orderType === "SL" || orderType === "SL-M") {
        payload.trigger_price = Number(triggerPrice) || execPrice;
      }

      const res = await fetch("/api/kite/orders", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify(payload),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Order failed");
      setResult({ success: `${legLabel(leg)} order placed. ID: ${json.data.order_id}` });
    } catch (err) {
      setResult({ error: err instanceof Error ? err.message : "Order failed" });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <DashboardShell>
      <div className="flex-between flex-wrap gap-4 mb-6">
        <div className="page-header" style={{ marginBottom: 0 }}>
          <h1>Nifty 50 Order Ticket</h1>
          <p>Call/Put buy & sell with margin, premium, and risk before you place the trade</p>
        </div>
        {chainData && (
          <div className="flex gap-2 flex-wrap">
            <span className="badge badge-default">Spot: {formatNumber(chainData.spotPrice)}</span>
            <span className="badge badge-warning">Expiry: {chainData.expiry}</span>
            <Link to="/dashboard/options" className="btn btn-ghost btn-sm">Open Chain</Link>
          </div>
        )}
      </div>

      {!connected ? (
        <div className="card">
          <p className="text-muted">Connect Zerodha to place Nifty options orders.</p>
          {loginUrl && (
            <a href={loginUrl} className="mt-4" style={{ display: "inline-block" }}>
              <button className="btn btn-primary">Connect Kite</button>
            </a>
          )}
        </div>
      ) : (
        <div className="trade-layout">
          <div className="card">
            <div className="card-header">
              <h3 className="card-title">Select Strike</h3>
              <p className="card-desc">Pick a strike from the live Nifty chain</p>
            </div>

            {loadingChain ? (
              <div className="spinner-center" style={{ minHeight: "12rem" }}>
                <div className="spinner spinner-sm" />
              </div>
            ) : (
              <div className="trade-strike-list">
                {chainData?.chain.map((row) => (
                  <button
                    key={row.strike}
                    type="button"
                    className={cn("trade-strike-btn", selectedStrike === row.strike && "active", row.isAtm && "atm")}
                    onClick={() => setSelectedStrike(row.strike)}
                  >
                    <span className="font-semibold">{formatNumber(row.strike, 0)}</span>
                    <span className="text-muted" style={{ fontSize: "0.75rem" }}>
                      CE {row.ce?.quote?.last_price ? formatNumber(row.ce.quote.last_price) : "—"}
                      {" · "}
                      PE {row.pe?.quote?.last_price ? formatNumber(row.pe.quote.last_price) : "—"}
                    </span>
                  </button>
                ))}
              </div>
            )}
          </div>

          <div className="card">
            <div className="card-header">
              <h3 className="card-title">Order Ticket</h3>
              <p className="card-desc">
                {instrument?.tradingsymbol ?? "Select strike"} · Lot size {lotSize}
              </p>
            </div>

            <form onSubmit={handleSubmit}>
              <p className="label mb-4">Trade Side</p>
              <div className="trade-leg-grid mb-6">
                {LEGS.map((item) => (
                  <button
                    key={item}
                    type="button"
                    className={cn(
                      "trade-leg-btn",
                      item.includes("BUY") ? "buy" : "sell",
                      leg === item && "active"
                    )}
                    onClick={() => setLeg(item)}
                  >
                    {legLabel(item)}
                  </button>
                ))}
              </div>

              <div className="grid-2 mb-4">
                <div className="field">
                  <label className="label">Product</label>
                  <div className="trade-toggle-row">
                    {PRODUCTS.map((item) => (
                      <button
                        key={item}
                        type="button"
                        className={cn("btn btn-sm", product === item ? "btn-primary" : "btn-outline")}
                        onClick={() => setProduct(item)}
                      >
                        {item}
                      </button>
                    ))}
                  </div>
                  {product === "CNC" && (
                    <p className="text-muted mt-3" style={{ fontSize: "0.75rem" }}>
                      CNC is for equity delivery. Nifty options will use NRML.
                    </p>
                  )}
                </div>
                <div className="field">
                  <label className="label">Order Type</label>
                  <select
                    className="select"
                    value={orderType}
                    onChange={(e) => setOrderType(e.target.value as OrderType)}
                  >
                    {ORDER_TYPES.map((type) => (
                      <option key={type} value={type}>
                        {type === "SL" ? "SL (Stop Loss Limit)" : type === "SL-M" ? "SL-M (Stop Loss Market)" : type}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              <div className="grid-3 mb-4">
                <div className="field">
                  <label className="label">Lots</label>
                  <input
                    className="input"
                    type="number"
                    min={1}
                    value={lots}
                    onChange={(e) => setLots(Math.max(1, Number(e.target.value) || 1))}
                  />
                </div>
                <div className="field">
                  <label className="label">Quantity</label>
                  <input className="input" value={metrics.quantity} readOnly />
                </div>
                <div className="field">
                  <label className="label">LTP</label>
                  <input className="input" value={ltp > 0 ? ltp.toFixed(2) : "—"} readOnly />
                </div>
              </div>

              <div className="grid-2 mb-4">
                {(orderType === "LIMIT" || orderType === "SL") && (
                  <div className="field">
                    <label className="label">Limit Price</label>
                    <input
                      className="input"
                      type="number"
                      step="0.05"
                      value={limitPrice}
                      onChange={(e) => setLimitPrice(e.target.value)}
                      required
                    />
                  </div>
                )}
                {(orderType === "SL" || orderType === "SL-M") && (
                  <div className="field">
                    <label className="label">Trigger Price (SL)</label>
                    <input
                      className="input"
                      type="number"
                      step="0.05"
                      value={triggerPrice}
                      onChange={(e) => setTriggerPrice(e.target.value)}
                      required
                    />
                  </div>
                )}
                <div className="field">
                  <label className="label">Target Price (TGT)</label>
                  <input
                    className="input"
                    type="number"
                    step="0.05"
                    value={targetPrice}
                    onChange={(e) => setTargetPrice(e.target.value)}
                    placeholder="Optional exit target"
                  />
                </div>
                <div className="field">
                  <label className="label">Stop Loss Price</label>
                  <input
                    className="input"
                    type="number"
                    step="0.05"
                    value={stopLossPrice}
                    onChange={(e) => setStopLossPrice(e.target.value)}
                    placeholder="Optional risk level"
                  />
                </div>
              </div>

              <div className="trade-summary-grid mb-6">
                <div className="trade-summary-item">
                  <p className="trade-summary-label">Net Premium</p>
                  <p className={cn("trade-summary-value", metrics.netPremium >= 0 ? "text-up" : "text-down")}>
                    {metrics.netPremium >= 0 ? "+" : ""}
                    {formatCurrency(metrics.netPremium)}
                  </p>
                  <p className="text-muted" style={{ fontSize: "0.75rem" }}>
                    {metrics.netPremium >= 0 ? "Credit" : "Debit"}
                  </p>
                </div>
                <div className="trade-summary-item">
                  <p className="trade-summary-label">Total Value</p>
                  <p className="trade-summary-value">{formatCurrency(metrics.total)}</p>
                  <p className="text-muted" style={{ fontSize: "0.75rem" }}>
                    @ {formatNumber(metrics.price)} × {metrics.quantity}
                  </p>
                </div>
                <div className="trade-summary-item">
                  <p className="trade-summary-label">Required Margin</p>
                  <p className="trade-summary-value">
                    {marginLoading ? "…" : requiredMargin != null ? formatCurrency(requiredMargin) : "—"}
                  </p>
                  <p className="text-muted" style={{ fontSize: "0.75rem" }}>From Zerodha Kite</p>
                </div>
                <div className="trade-summary-item">
                  <p className="trade-summary-label">Available Margin</p>
                  <p className="trade-summary-value">{formatCurrency(availableMargin)}</p>
                  <p className="text-muted" style={{ fontSize: "0.75rem" }}>Live balance</p>
                </div>
                <div className="trade-summary-item">
                  <p className="trade-summary-label">Max Loss</p>
                  <p className="trade-summary-value text-down">
                    {Number.isFinite(metrics.maxLoss) ? formatCurrency(metrics.maxLoss) : "Unlimited"}
                  </p>
                  <p className="text-muted" style={{ fontSize: "0.75rem" }}>{metrics.maxLossNote}</p>
                </div>
                <div className="trade-summary-item">
                  <p className="trade-summary-label">Target Profit</p>
                  <p className={cn("trade-summary-value", metrics.targetProfit > 0 ? "text-up" : "")}>
                    {metrics.targetProfit > 0 ? formatCurrency(metrics.targetProfit) : "—"}
                  </p>
                  <p className="text-muted" style={{ fontSize: "0.75rem" }}>
                    {metrics.rewardRisk ? `R:R ${metrics.rewardRisk.toFixed(2)}` : "Set target to estimate"}
                  </p>
                </div>
              </div>

              {result.success && <div className="alert alert-success">{result.success}</div>}
              {result.error && <div className="alert alert-error">{result.error}</div>}

              <div className="flex gap-3 flex-wrap">
                <button
                  type="submit"
                  className={cn("btn", transactionType === "BUY" ? "btn-buy active" : "btn-sell active")}
                  disabled={submitting || !instrument?.tradingsymbol}
                >
                  {submitting ? "Placing order..." : `Place ${legLabel(leg)}`}
                </button>
                <span className="badge badge-warning" style={{ alignSelf: "center" }}>
                  Live order — real money
                </span>
              </div>
            </form>
          </div>
        </div>
      )}
    </DashboardShell>
  );
}
