export const NSE_FO_SESSION = {
  timezone: "Asia/Kolkata",
  open: { hour: 9, minute: 15 },
  close: { hour: 15, minute: 30 },
  label: "09:15 AM – 03:30 PM IST",
};

function getIstParts(date: Date) {
  const formatter = new Intl.DateTimeFormat("en-IN", {
    timeZone: NSE_FO_SESSION.timezone,
    weekday: "short",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });

  const parts = formatter.formatToParts(date);
  const pick = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((part) => part.type === type)?.value ?? 0);

  return {
    weekday: parts.find((part) => part.type === "weekday")?.value ?? "",
    year: pick("year"),
    month: pick("month"),
    day: pick("day"),
    hour: pick("hour"),
    minute: pick("minute"),
    second: pick("second"),
  };
}

export function formatIndianDateTime(date = new Date()) {
  return new Intl.DateTimeFormat("en-IN", {
    timeZone: NSE_FO_SESSION.timezone,
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: true,
    timeZoneName: "short",
  }).format(date);
}

export type NseSessionStatus = "open" | "pre_market" | "post_market" | "closed_weekend";

export function getIndianMarketContext(date = new Date()) {
  const ist = getIstParts(date);
  const minutesNow = ist.hour * 60 + ist.minute;
  const openMinutes = NSE_FO_SESSION.open.hour * 60 + NSE_FO_SESSION.open.minute;
  const closeMinutes = NSE_FO_SESSION.close.hour * 60 + NSE_FO_SESSION.close.minute;

  const isWeekend = ist.weekday === "Sat" || ist.weekday === "Sun";
  let sessionStatus: NseSessionStatus = "open";
  if (isWeekend) sessionStatus = "closed_weekend";
  else if (minutesNow < openMinutes) sessionStatus = "pre_market";
  else if (minutesNow > closeMinutes) sessionStatus = "post_market";

  const minutesFromOpen =
    sessionStatus === "open" ? minutesNow - openMinutes : null;
  const minutesToClose =
    sessionStatus === "open" ? closeMinutes - minutesNow : null;

  return {
    currentDateTimeIST: formatIndianDateTime(date),
    dateIST: `${ist.year}-${String(ist.month).padStart(2, "0")}-${String(ist.day).padStart(2, "0")}`,
    timeIST: `${String(ist.hour).padStart(2, "0")}:${String(ist.minute).padStart(2, "0")}:${String(ist.second).padStart(2, "0")}`,
    timezone: "Asia/Kolkata (IST)",
    exchange: "NSE",
    instrument: "Nifty 50 index weekly options (F&O)",
    sessionHoursIST: NSE_FO_SESSION.label,
    sessionDays: "Monday – Friday",
    sessionStatus,
    isMarketOpen: sessionStatus === "open",
    minutesFromOpen,
    minutesToClose,
  };
}

function pad2(value: number) {
  return String(value).padStart(2, "0");
}

/** Kite historical API datetime string in IST (NSE). */
export function formatKiteIstDateTime(date = new Date()) {
  const ist = getIstParts(date);
  return `${ist.year}-${pad2(ist.month)}-${pad2(ist.day)} ${pad2(ist.hour)}:${pad2(ist.minute)}:${pad2(ist.second)}`;
}

/** Today's NSE cash session window for intraday historical candles. */
export function getNseSessionKiteRange(date = new Date()) {
  const ist = getIstParts(date);
  const dateIST = `${ist.year}-${pad2(ist.month)}-${pad2(ist.day)}`;
  return {
    dateIST,
    from: `${dateIST} 09:15:00`,
    to: formatKiteIstDateTime(date),
  };
}
