import { useEffect, useId, useMemo, useState } from "react";
import { ChevronDown, RefreshCw } from "lucide-react";
import type { NineFifteenCePeFailureTrade } from "@/types/nine-fifteen";
import { formatWeekdayFromDateKey } from "@/lib/market-time";
import { cn, formatNumber } from "@/lib/utils";
import { useBacktestIndex } from "@/contexts/backtest-index-context";

type MinuteCandle = {
  time: string;
  open: number;
  high: number;
  low: number;
  close: number;
};

type SwitchTarget = {
  afterIst: string;
  points: number;
};

function formatRsi(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "—";
  return formatNumber(value, 2);
}

function rsiClass(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "";
  if (value >= 70) return "text-up";
  if (value <= 30) return "text-down";
  return "";
}

function TargetGapAt1000Summary({ gap }: { gap: NonNullable<NineFifteenCePeFailureTrade["targetGapAt1000"]> }) {
  return (
    <span className="text-sm text-muted">
      @10:00{" "}
      <span className="font-mono">
        {formatNumber(gap.pointsFromTarget, 2)} pts from target
      </span>
      {" · Nifty "}
      <span className="font-mono">{formatNumber(gap.indexPrice, 2)}</span>
      {" · target "}
      <span className="font-mono">{formatNumber(gap.targetIndexPrice, 2)}</span>
    </span>
  );
}

function TargetGapAt1000Meta({ gap }: { gap: NonNullable<NineFifteenCePeFailureTrade["targetGapAt1000"]> }) {
  return (
    <>
      {" "}
      · @10:00 Nifty {formatNumber(gap.indexPrice, 2)} vs target{" "}
      {formatNumber(gap.targetIndexPrice, 2)} ({formatNumber(gap.pointsFromTarget, 2)} pts away)
    </>
  );
}
function DirectionBadge({ direction }: { direction: "up" | "down" | "flat" }) {
  if (direction === "up") return <span className="nf-direction nf-direction--up">Up</span>;
  if (direction === "down") return <span className="nf-direction nf-direction--down">Down</span>;
  return <span className="nf-direction nf-direction--flat">Flat</span>;
}

function istHmFromCandleTime(time: string): string {
  const m = /(\d{2}):(\d{2})/.exec(time);
  if (!m) return time;
  return `${m[1]}:${m[2]}`;
}

function minutesFromIstLabel(label: string): number | null {
  const m = /^(\d{1,2}):(\d{2})/.exec(label.trim());
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
}

function SessionMinuteChart({
  candles,
  entryPrice,
  side,
  targetPoints,
  switchTarget,
}: {
  candles: MinuteCandle[];
  entryPrice: number | null;
  side: "CE" | "PE";
  targetPoints: number;
  switchTarget?: SwitchTarget;
}) {
  const index = useBacktestIndex();
  const gradId = useId().replace(/:/g, "");
  const width = 920;
  const height = 280;
  const padL = 52;
  const padR = 12;
  const padT = 16;
  const padB = 28;
  const plotW = width - padL - padR;
  const plotH = height - padT - padB;

  const levels = useMemo(() => {
    const list: { price: number; label: string; tone: "entry" | "target" | "switch" }[] = [];
    if (entryPrice != null) {
      list.push({ price: entryPrice, label: "Entry", tone: "entry" });
      const signed = side === "CE" ? 1 : -1;
      list.push({
        price: entryPrice + signed * targetPoints,
        label: `±${targetPoints}`,
        tone: "target",
      });
      if (switchTarget) {
        list.push({
          price: entryPrice + signed * switchTarget.points,
          label: `±${switchTarget.points} @${switchTarget.afterIst.slice(0, 5)}`,
          tone: "switch",
        });
      }
    }
    return list;
  }, [entryPrice, side, targetPoints, switchTarget]);

  const { yMin, yMax, candleW } = useMemo(() => {
    const prices = candles.flatMap((c) => [c.high, c.low]);
    for (const lv of levels) prices.push(lv.price);
    const min = Math.min(...prices);
    const max = Math.max(...prices);
    const pad = Math.max(2, (max - min) * 0.06);
    return {
      yMin: min - pad,
      yMax: max + pad,
      candleW: Math.max(1.2, plotW / Math.max(candles.length, 1)),
    };
  }, [candles, levels, plotW]);

  const yScale = (price: number) => padT + ((yMax - price) / (yMax - yMin || 1)) * plotH;
  const xScale = (i: number) => padL + i * candleW + candleW / 2;

  const switchMinute = switchTarget ? minutesFromIstLabel(switchTarget.afterIst) : null;
  let switchX: number | null = null;
  if (switchMinute != null) {
    const idx = candles.findIndex((c) => {
      const hm = istHmFromCandleTime(c.time);
      const mins = minutesFromIstLabel(hm);
      return mins != null && mins >= switchMinute;
    });
    if (idx >= 0) switchX = xScale(idx);
  }

  const tickIdx = [0, Math.floor(candles.length / 3), Math.floor((candles.length * 2) / 3), candles.length - 1].filter(
    (v, i, arr) => v >= 0 && arr.indexOf(v) === i,
  );

  return (
    <svg
      className="nf-day-chart-svg"
      viewBox={`0 0 ${width} ${height}`}
      role="img"
      aria-label={`${index.shortLabel} 1-minute candles 9:15 to 15:30`}
    >
      <defs>
        <linearGradient id={`nf-day-grid-${gradId}`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="currentColor" stopOpacity="0.08" />
          <stop offset="100%" stopColor="currentColor" stopOpacity="0.02" />
        </linearGradient>
      </defs>
      <rect x={padL} y={padT} width={plotW} height={plotH} fill={`url(#nf-day-grid-${gradId})`} />

      {[0, 0.25, 0.5, 0.75, 1].map((t) => {
        const y = padT + plotH * t;
        const price = yMax - t * (yMax - yMin);
        return (
          <g key={t}>
            <line x1={padL} y1={y} x2={padL + plotW} y2={y} className="nf-day-chart-grid" />
            <text x={padL - 6} y={y + 3} textAnchor="end" className="nf-day-chart-axis">
              {price.toFixed(0)}
            </text>
          </g>
        );
      })}

      {candles.map((c, i) => {
        const x = xScale(i);
        const yO = yScale(c.open);
        const yC = yScale(c.close);
        const yH = yScale(c.high);
        const yL = yScale(c.low);
        const up = c.close >= c.open;
        const bodyTop = Math.min(yO, yC);
        const bodyH = Math.max(1, Math.abs(yC - yO));
        const w = Math.max(1, candleW * 0.7);
        return (
          <g key={`${c.time}-${i}`} className={up ? "nf-day-candle--up" : "nf-day-candle--down"}>
            <line x1={x} y1={yH} x2={x} y2={yL} />
            <rect x={x - w / 2} y={bodyTop} width={w} height={bodyH} />
          </g>
        );
      })}

      {levels.map((lv) => {
        const y = yScale(lv.price);
        return (
          <g key={lv.label}>
            <line
              x1={padL}
              y1={y}
              x2={padL + plotW}
              y2={y}
              className={cn(
                "nf-day-chart-level",
                lv.tone === "entry" && "nf-day-chart-level--entry",
                lv.tone === "target" && "nf-day-chart-level--target",
                lv.tone === "switch" && "nf-day-chart-level--switch",
              )}
            />
            <text x={padL + plotW - 4} y={y - 4} textAnchor="end" className="nf-day-chart-level-label">
              {lv.label} {lv.price.toFixed(2)}
            </text>
          </g>
        );
      })}

      {switchX != null && (
        <line
          x1={switchX}
          y1={padT}
          x2={switchX}
          y2={padT + plotH}
          className="nf-day-chart-switch-x"
        />
      )}

      {tickIdx.map((i) => (
        <text key={i} x={xScale(i)} y={height - 8} textAnchor="middle" className="nf-day-chart-axis">
          {istHmFromCandleTime(candles[i].time)}
        </text>
      ))}
    </svg>
  );
}

/** Win target first hit at or after 10:00 IST (10 AM hour bucket and later). */
export function isWinAfterTenAm(trade: NineFifteenCePeFailureTrade): boolean {
  const raw = trade.targetHit?.timeIst ?? trade.targetHitAt;
  if (!raw) return false;
  const match = /^(\d{1,2}):/.exec(raw.trim());
  if (!match) return false;
  const hour = Number(match[1]);
  return Number.isFinite(hour) && hour >= 10;
}

function SessionDayAccordionItem({
  trade,
  targetPoints,
  switchTarget,
  showAlt20After1010,
  variant = "loss",
}: {
  trade: NineFifteenCePeFailureTrade;
  targetPoints: number;
  switchTarget?: SwitchTarget;
  showAlt20After1010?: boolean;
  variant?: "loss" | "win";
}) {
  const index = useBacktestIndex();
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [candles, setCandles] = useState<MinuteCandle[] | null>(null);

  useEffect(() => {
    if (!open || candles != null) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    void (async () => {
      try {
        const res = await fetch(
          `/api/kite/index-session-minutes?date=${encodeURIComponent(trade.date)}&index=${index.key}`,
          { credentials: "include" },
        );
        const json = (await res.json()) as {
          data?: { candles?: MinuteCandle[] };
          error?: string;
        };
        if (!res.ok) throw new Error(json.error ?? "Failed to load candles");
        if (!cancelled) setCandles(json.data?.candles ?? []);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : "Failed to load candles");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, candles, trade.date, index.key]);

  const entry = trade.entryAt?.indexPrice ?? null;
  const shortfall =
    trade.maxMoveInDirection < targetPoints
      ? targetPoints - trade.maxMoveInDirection
      : 0;
  const effectiveTarget = trade.targetPoints ?? targetPoints;
  const hit = trade.targetHit ?? null;

  return (
    <details
      className={cn("nf-loss-day", variant === "win" && "nf-loss-day--win")}
      onToggle={(e) => setOpen((e.target as HTMLDetailsElement).open)}
    >
      <summary className="nf-loss-day-summary">
        <ChevronDown size={14} className="nf-loss-day-chevron" aria-hidden />
        <span className="nf-loss-day-date font-mono">{trade.date}</span>
        <span className="text-muted text-sm">{formatWeekdayFromDateKey(trade.date)}</span>
        <span className={cn("nf-side-tag", trade.side === "CE" ? "nf-side-tag--ce" : "nf-side-tag--pe")}>
          {trade.side}
        </span>
        <DirectionBadge direction={trade.direction} />
        <span className="text-sm">
          Δ{" "}
          <span
            className={cn(
              "font-mono",
              trade.change > 0 ? "text-up" : trade.change < 0 ? "text-down" : "",
            )}
          >
            {trade.change >= 0 ? "+" : ""}
            {formatNumber(trade.change, 2)}
          </span>
        </span>
        <span className="text-sm text-muted">
          RSI @9:15{" "}
          <span className={cn("font-mono", rsiClass(trade.rsi915))}>{formatRsi(trade.rsi915)}</span>
          {" · "}
          @9:16{" "}
          <span className={cn("font-mono", rsiClass(trade.rsi916))}>{formatRsi(trade.rsi916)}</span>
        </span>
        <span className="text-sm text-muted">
          Entry{" "}
          <span className="font-mono">
            {entry != null ? formatNumber(entry, 2) : "—"}
          </span>
        </span>
        {variant === "win" && hit && (
          <span className="text-sm text-up">
            Hit{" "}
            <span className="font-mono">
              {hit.timeIst} · {hit.levelLabel} @ {formatNumber(hit.indexPrice, 2)}
            </span>
          </span>
        )}
        {variant === "win" && trade.targetGapAt1000 && (
          <TargetGapAt1000Summary gap={trade.targetGapAt1000} />
        )}
        {variant === "loss" && (
          <span className="text-sm text-muted">
            Best {formatNumber(trade.maxMoveInDirection, 2)} pts
            {shortfall > 0 ? ` · need ${formatNumber(shortfall, 2)} more` : ""}
          </span>
        )}
        {variant === "loss" && trade.targetGapAt1000 && (
          <TargetGapAt1000Summary gap={trade.targetGapAt1000} />
        )}
        {variant === "loss" && trade.nrmlCarry && (
          <span
            className={cn(
              "text-sm nf-loss-day-nrml",
              trade.nrmlCarry.wouldWin ? "text-up" : "text-muted",
            )}
          >
            NRML → {trade.nrmlCarry.deadlineLabel}:{" "}
            <strong>{trade.nrmlCarry.wouldWin ? "Won" : "Loss"}</strong>
            {trade.nrmlCarry.wouldWin && trade.nrmlCarry.hit && trade.nrmlCarry.hitDate && (
              <>
                {" "}
                · {trade.nrmlCarry.hitDate} {trade.nrmlCarry.hit.timeIst}
              </>
            )}
            {!trade.nrmlCarry.wouldWin && (
              <>
                {" "}
                · carry best {formatNumber(trade.nrmlCarry.maxMoveInDirection, 2)} pts
              </>
            )}
          </span>
        )}
        {variant === "loss" && showAlt20After1010 && trade.altTargetAfter1010?.wouldWin && (
          <span className="nf-loss-day-alt text-up">alt ±20 hit</span>
        )}
        {variant === "loss" && showAlt20After1010 && trade.altTarget10After1010?.wouldWin && (
          <span className="nf-loss-day-alt text-up">alt ±10 hit</span>
        )}
      </summary>

      <div className="nf-loss-day-body">
        <div className="nf-loss-day-meta text-muted text-sm">
          9:15 {formatNumber(trade.open915, 2)} → {formatNumber(trade.close915, 2)}
          {trade.rsi915 != null && Number.isFinite(trade.rsi915) && (
            <>
              {" "}
              · RSI(14) @9:15 {formatRsi(trade.rsi915)}
              {trade.rsi916 != null && Number.isFinite(trade.rsi916) && (
                <> · @9:16 {formatRsi(trade.rsi916)}</>
              )}
            </>
          )}
          {trade.rsi915 == null && trade.rsi916 != null && Number.isFinite(trade.rsi916) && (
            <>
              {" "}
              · RSI(14) @9:16 {formatRsi(trade.rsi916)}
            </>
          )}
          {trade.exitTargetIndexPrice != null && (
            <>
              {" "}
              · Target {trade.side === "CE" ? "+" : "−"}
              {targetPoints} @ {formatNumber(trade.exitTargetIndexPrice, 2)}
            </>
          )}
          {switchTarget && (
            <>
              {" "}
              · After {switchTarget.afterIst.slice(0, 5)}: ±{switchTarget.points}
            </>
          )}
          {variant === "loss" && trade.nrmlCarry && (
            <>
              {" "}
              · NRML carry to {trade.nrmlCarry.deadlineLabel}
              {trade.nrmlCarry.wouldWin && trade.nrmlCarry.hit
                ? ` · won ${trade.nrmlCarry.hitDate} ${trade.nrmlCarry.hit.timeIst}`
                : ` · still short after carry (best ${formatNumber(trade.nrmlCarry.maxMoveInDirection, 2)} pts post-entry)`}
            </>
          )}
          {trade.targetGapAt1000 && <TargetGapAt1000Meta gap={trade.targetGapAt1000} />}
          {" "}
          · Full session 1-min candles (9:15–15:30)
        </div>

        {loading && (
          <div className="nf-loss-day-status">
            <RefreshCw size={14} className="spin" /> Loading minute candles…
          </div>
        )}
        {error && <div className="nf-loss-day-status nf-loss-day-status--err">{error}</div>}
        {!loading && !error && candles && candles.length === 0 && (
          <div className="nf-loss-day-status">No Kite minute candles for this session.</div>
        )}
        {!loading && !error && candles && candles.length > 0 && (
          <div className="nf-day-chart-wrap">
            <SessionMinuteChart
              candles={candles}
              entryPrice={entry}
              side={trade.side}
              targetPoints={effectiveTarget}
              switchTarget={variant === "loss" ? switchTarget : undefined}
            />
          </div>
        )}
      </div>
    </details>
  );
}

export function LossTradesAccordion({
  trades,
  targetPoints,
  showAlt20After1010,
  switchTarget,
}: {
  trades: NineFifteenCePeFailureTrade[];
  targetPoints: number;
  showAlt20After1010?: boolean;
  switchTarget?: SwitchTarget;
}) {
  const index = useBacktestIndex();
  if (trades.length === 0) return null;

  return (
    <div className="nf-loss-accordion">
      <p className="nf-loss-accordion-hint text-muted text-sm">
        Expand a loss day to load that session’s {index.label} 1-min candles (9:15–15:30). Each row
        shows Nifty at <strong>10:00:00 IST</strong> vs the exit target. Entry and target levels are
        overlaid on the chart.
      </p>
      {trades.map((trade) => (
        <SessionDayAccordionItem
          key={trade.date}
          trade={trade}
          targetPoints={trade.targetPoints ?? targetPoints}
          showAlt20After1010={showAlt20After1010 && Math.abs(trade.change) >= 15}
          switchTarget={
            switchTarget ??
            (Math.abs(trade.change) >= 11 && Math.abs(trade.change) < 15
              ? { afterIst: "10:01:00", points: 10 }
              : undefined)
          }
          variant="loss"
        />
      ))}
    </div>
  );
}

export function LateWinTradesAccordion({
  trades,
  targetPoints,
}: {
  trades: NineFifteenCePeFailureTrade[];
  targetPoints: number;
}) {
  const index = useBacktestIndex();
  const lateWins = trades.filter(isWinAfterTenAm);
  if (lateWins.length === 0) return null;

  return (
    <details className="nf-failures-details nf-wins-late-details">
      <summary className="nf-failures-summary">
        <span className="nf-failures-rule">Wins after 10:00 AM IST</span>
        <span className="nf-failures-count text-muted">
          {lateWins.length} win{lateWins.length === 1 ? "" : "s"} · expand a day for 1-min chart
        </span>
      </summary>
      <div className="nf-loss-accordion">
        <p className="nf-loss-accordion-hint text-muted text-sm">
          Target hit at or after 10:00 AM — each row shows how many index points Nifty was from the
          exit target at <strong>10:00:00 IST</strong> (10:00 bar open). Expand to load that session’s{" "}
          {index.label} 1-min candles (9:15–15:30). Entry and exit levels are overlaid.
        </p>
        {lateWins.map((trade) => (
          <SessionDayAccordionItem
            key={trade.date}
            trade={trade}
            targetPoints={trade.targetPoints ?? targetPoints}
            variant="win"
          />
        ))}
      </div>
    </details>
  );
}
