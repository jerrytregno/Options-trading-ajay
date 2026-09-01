export interface MomentumLogPresentation {
  badge: string;
  badgeClass: string;
  text: string;
}

/** Turn raw bot log lines into a short label + plain-English text for the panel. */
export function formatMomentumScalperLog(message: string): MomentumLogPresentation {
  const signal = message.match(
    /^Signal (CE|PE) · (\d{2}:\d{2}) · body ([+-]?\d+(?:\.\d+)?) pts · need momentum open (≥|≤) ([\d.]+) · pullback @ ([\d.]+)$/,
  );
  if (signal) {
    const [, side, candle, body, op, openNeed, entryAt] = signal;
    const bullish = side === "CE";
    return {
      badge: "Setup",
      badgeClass: "ms-log-badge--setup",
      text:
        `${bullish ? "Bullish" : "Bearish"} ${candle} candle (${body} pts) → ${side} idea. ` +
        `Next minute open must be ${op} ${openNeed}; ` +
        `entry if Nifty ${bullish ? "dips to" : "rises to"} ${entryAt}.`,
    };
  }

  const gateFail = message.match(
    /^Skipped · momentum open ([\d.]+) failed (green|red) gate \(need (≥|≤) ([\d.]+) vs signal close ([\d.]+)\)$/,
  );
  if (gateFail) {
    const [, actual, , op, need] = gateFail;
    const tooHigh = op === "≤";
    return {
      badge: "Skipped",
      badgeClass: "ms-log-badge--skip",
      text: tooHigh
        ? `Next minute opened too high (${actual}). Needed ${op} ${need} to continue the down move.`
        : `Next minute opened too low (${actual}). Needed ${op} ${need} to continue the up move.`,
    };
  }

  const noPullback = message.match(
    /^Skipped · no retest of marked (low|high) · signal (\d{2}:\d{2})$/,
  );
  if (noPullback) {
    const [, mark, candle] = noPullback;
    return {
      badge: "Skipped",
      badgeClass: "ms-log-badge--skip",
      text:
        mark === "low"
          ? `Nifty never dipped to the entry level during the minute after the ${candle} CE setup.`
          : `Nifty never rose to the entry level during the minute after the ${candle} PE setup.`,
    };
  }

  const trailExit = message.match(
    /^Trailing stop · P&L fell below locked \+([\d.]+)% · P&L ([\d.-]+)% · Nifty ([\d.]+)$/,
  );
  if (trailExit) {
    const [, locked, pnl, nifty] = trailExit;
    return {
      badge: "Exit",
      badgeClass: "ms-log-badge--exit",
      text: `Closed trade — profit dropped below the locked +${locked}% floor. Booked ${pnl}% on premium. Nifty ${nifty}.`,
    };
  }

  const initialStop = message.match(
    /^Initial stop · P&L ≤ ([\d.-]+)% for (\d+)s(?: · P&L ([\d.-]+)%)?$/,
  );
  if (initialStop) {
    const [, stopPct, secs, pnl] = initialStop;
    const pnlBit = pnl != null ? ` Final P&L ${pnl}%.` : "";
    return {
      badge: "Exit",
      badgeClass: "ms-log-badge--exit",
      text: `Closed trade — option P&L stayed at or below ${stopPct}% for ${secs} seconds.${pnlBit}`,
    };
  }

  const ladder = message.match(
    /^Ladder \+([\d.]+)% locked · SL ([\d.]+)% · TP ([\d.]+)%$/,
  );
  if (ladder) {
    const [, locked, sl, tp] = ladder;
    return {
      badge: "Profit",
      badgeClass: "ms-log-badge--profit",
      text: `Profit rung locked at +${locked}%. Stop raised to +${sl}%, next target +${tp}%.`,
    };
  }

  const entering = message.match(
    /^Pullback (CE|PE) · signal close ([\d.]+) · enter @ ([\d.]+) at ([\d.]+)s · Nifty ([\d.]+)$/,
  );
  if (entering) {
    const [, side, , entryAt, secs] = entering;
    return {
      badge: "Entry",
      badgeClass: "ms-log-badge--entry",
      text: `Nifty hit ${entryAt} (${secs}s into the minute) — placing ${side} order.`,
    };
  }

  if (message.startsWith("Setup —")) {
    return { badge: "Setup", badgeClass: "ms-log-badge--setup", text: message.slice("Setup — ".length) };
  }
  if (message.startsWith("No trade —")) {
    return { badge: "Skipped", badgeClass: "ms-log-badge--skip", text: message.slice("No trade — ".length) };
  }
  if (message.startsWith("Entering ")) {
    return { badge: "Entry", badgeClass: "ms-log-badge--entry", text: message.slice("Entering ".length) };
  }
  if (message.startsWith("Exited —")) {
    return { badge: "Exit", badgeClass: "ms-log-badge--exit", text: message.slice("Exited — ".length) };
  }
  if (message.startsWith("Profit locked")) {
    return { badge: "Profit", badgeClass: "ms-log-badge--profit", text: message };
  }

  if (message.includes("Entered") || message.includes("index entry")) {
    return { badge: "Entry", badgeClass: "ms-log-badge--entry", text: message };
  }

  return { badge: "Info", badgeClass: "ms-log-badge--info", text: message };
}
