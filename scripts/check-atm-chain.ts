/**
 * The ATM chain reduction picks the contract every bot actually buys, and it is now memoised and
 * indexed by strike instead of scanned. This checks the fast path against a straight-line
 * reference over a synthetic instrument dump — same filter, same expiry, same CE/PE pick — and
 * confirms the cache returns the same object for repeat calls and rebuilds when the rows change.
 *
 * Run: npx tsx scripts/check-atm-chain.ts
 */
import { findAtmStrike } from "../src/lib/greeks.js";
import { nearestExpiryChain } from "../server/atm-option.js";

let failures = 0;

function check(label: string, ok: boolean, detail = "") {
  if (!ok) failures += 1;
  console.log(`${ok ? "ok  " : "FAIL"} ${label}${detail ? ` — ${detail}` : ""}`);
}

const SYMBOL = "NIFTY";
const EXCHANGE = "NFO";

type Row = {
  instrument_token?: number;
  tradingsymbol: string;
  name?: string;
  expiry?: string;
  strike?: number;
  lot_size?: number;
  instrument_type?: string;
  segment?: string;
  exchange?: string;
};

function iso(daysFromToday: number): string {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + daysFromToday);
  return d.toISOString().slice(0, 10);
}

const FRONT = iso(3);
const BACK = iso(10);
const EXPIRED = iso(-4);

let token = 1;
function option(strike: number, type: "CE" | "PE", expiry: string, extra: Partial<Row> = {}): Row {
  return {
    instrument_token: token++,
    tradingsymbol: `NIFTY${expiry.replace(/-/g, "")}${strike}${type}`,
    name: SYMBOL,
    expiry,
    strike,
    lot_size: 75,
    instrument_type: type,
    segment: `${EXCHANGE}-OPT`,
    exchange: EXCHANGE,
    ...extra,
  };
}

const rows: Row[] = [];

// Three expiries so expiry selection has something to get wrong, plus an already-expired one.
for (const expiry of [EXPIRED, FRONT, BACK]) {
  for (let strike = 23_000; strike <= 26_000; strike += 50) {
    rows.push(option(strike, "CE", expiry));
    rows.push(option(strike, "PE", expiry));
  }
}

// Noise the filter has to reject: another underlying, futures, the cash segment, a zero strike,
// and a duplicate contract that must lose to the one listed first.
for (let i = 0; i < 40_000; i += 1) {
  rows.push(option(23_000 + (i % 60) * 50, i % 2 ? "CE" : "PE", FRONT, { name: "BANKNIFTY" }));
}
rows.push(option(24_000, "CE", FRONT, { segment: `${EXCHANGE}-FUT`, instrument_type: "FUT" }));
rows.push(option(24_000, "CE", FRONT, { segment: "NSE" }));
rows.push(option(0, "CE", FRONT));
rows.push({ tradingsymbol: "NIFTY-EQ", name: SYMBOL, segment: `${EXCHANGE}-OPT` });
const shadow = option(24_100, "CE", FRONT);
rows.push(shadow);

/** The original implementation, written out plainly. */
function reference(spot: number, type: "CE" | "PE") {
  const underlying = rows.filter(
    (item) =>
      item.segment === `${EXCHANGE}-OPT` &&
      item.name === SYMBOL &&
      (item.tradingsymbol.endsWith("CE") || item.tradingsymbol.endsWith("PE")),
  );
  const expiries = [...new Set(underlying.map((i) => i.expiry).filter(Boolean))] as string[];
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const sorted = [...expiries].sort((a, b) => new Date(a).getTime() - new Date(b).getTime());
  const selected = sorted.filter((e) => new Date(e) >= today)[0] ?? sorted[0];
  const expiryOptions = underlying.filter((i) => i.expiry === selected);
  const strikes = [...new Set(expiryOptions.map((i) => i.strike!).filter(Boolean))];
  const atm = findAtmStrike(strikes, spot);
  const match = expiryOptions.find(
    (i) => i.strike === atm && i.tradingsymbol.endsWith(type),
  );
  return { atm, tradingsymbol: match?.tradingsymbol ?? null };
}

const chain = nearestExpiryChain(rows, SYMBOL, EXCHANGE);
check("a chain is built", chain != null);

if (chain) {
  console.log("\n— The indexed chain agrees with the reference on every spot —");
  let mismatches = 0;
  let checked = 0;
  for (let spot = 23_010; spot <= 25_990; spot += 7.5) {
    for (const type of ["CE", "PE"] as const) {
      checked += 1;
      const want = reference(spot, type);
      const atm = findAtmStrike(chain.strikes, spot);
      const got = chain.byStrike.get(atm)?.[type]?.tradingsymbol ?? null;
      if (atm !== want.atm || got !== want.tradingsymbol) {
        mismatches += 1;
        if (mismatches <= 3) {
          console.log(`     spot ${spot} ${type}: got ${atm}/${got}, want ${want.atm}/${want.tradingsymbol}`);
        }
      }
    }
  }
  check(`${checked} spot/side combinations resolve identically`, mismatches === 0, `${mismatches} mismatches`);

  console.log("\n— The reduction rejects everything that is not a front-expiry NIFTY option —");
  const everyExpiry = new Set(
    [...chain.byStrike.values()].flatMap((e) => [e.CE?.expiry, e.PE?.expiry].filter(Boolean)),
  );
  check(
    "only the front expiry survives",
    everyExpiry.size === 1 && everyExpiry.has(FRONT),
    [...everyExpiry].join(", "),
  );
  check("a zero strike is not a strike", !chain.strikes.includes(0));
  check("BANKNIFTY is not in the chain", [...chain.byStrike.values()].every((e) => !e.CE?.name || e.CE.name === SYMBOL));
  check(
    "the first listing wins a duplicated strike, as find() did",
    chain.byStrike.get(24_100)?.CE?.instrument_token !== shadow.instrument_token,
  );
  check("both sides are indexed", chain.byStrike.get(24_000)?.CE != null && chain.byStrike.get(24_000)?.PE != null);
}

console.log("\n— The cache is keyed on the rows it was built from —");
check("the same rows return the same chain", nearestExpiryChain(rows, SYMBOL, EXCHANGE) === chain);
const rebuilt = nearestExpiryChain([...rows], SYMBOL, EXCHANGE);
check("a refreshed master rebuilds it", rebuilt !== chain);
check("and rebuilds to the same answer", rebuilt?.byStrike.get(24_000)?.CE?.tradingsymbol === chain?.byStrike.get(24_000)?.CE?.tradingsymbol);
check("an underlying with no options yields no chain", nearestExpiryChain(rows, "NOSUCH", EXCHANGE) === null);

console.log(failures === 0 ? "\nATM chain reduction is unchanged." : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
