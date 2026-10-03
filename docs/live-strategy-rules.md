# Live strategies: entry and exit rules (reference)

Reference only. This describes what the live server bot does as of 1 Oct 2026. Nothing here changes the code.

All times are IST. "Nifty" means the NIFTY 50 spot index. "WS" means the Zerodha Kite websocket (live tick feed). All examples use a Nifty lot size of 65.

---

## 0. The big picture

The server runs two independent morning trades on the same bot:

| | 9:15 trade | 9:16 trade |
|---|---|---|
| What it reads | The first 10 seconds of the 9:15 minute | The full 9:15 minute (open to close) |
| When it buys | 9:15:11 | 9:16:01 |
| Red signal | Drop of 5 points or more → buy ATM PE | Drop of 15 points or more → buy ATM PE |
| Green signal | Rise of 10 points or more → buy ATM CE | Rise of 15 points or more → buy ATM CE |
| Order type | Market buy | Limit buy (market backup after 8 seconds) |
| Main exit | Take-profit limit sell | Take-profit limit sell plus a Nifty index exit |

A day can have no trade, only the 9:15 trade, only the 9:16 trade, or both, one after the other. The two can never be open together. If the 9:15 trade is still open at 9:16:00, the 9:16 trade is skipped for the day (with one exception, see 1.10).

Traps, the later-session strategy, is a separate bot and is currently switched off on the server. It is not covered here.

### Terms used in this document

- **Open (9:15 open):** the first Nifty WS tick from 9:15:00 onwards (must arrive by 9:15:15).
- **Mark (9:15:10 read):** the last Nifty WS tick strictly before 9:15:10. A tick at 9:15:09.98 counts; a tick at 9:15:10.02 does not.
- **9:15 close (for the 9:16 entry):** the last Nifty WS tick strictly before 9:16:00.
- **Δ (delta):** 9:15 close − 9:15 open. Negative means a red candle, positive means green.
- **ATM:** the at-the-money strike, meaning the Nifty strike nearest the current spot.
- **Entry spot:** the Nifty level at the moment the option buy fills. All index-based exits are measured from this number.
- **Capital deployed:** average option entry price × quantity. Take-profit % is always measured on this, never on the Nifty index.
- **₹0.05 tick:** NSE option prices move in steps of ₹0.05, so every limit price is rounded to the nearest ₹0.05.

---

## 1. The 9:15 trade (PE or CE at 9:15:11)

### 1.1 Step 1: capture the 9:15 open

From 9:15:00 the bot listens to the Nifty websocket. The first tick it receives is locked as the 9:15 open.

If no tick arrives between 9:15:00 and 9:15:15, there is no 9:15 trade that day.

> Example: the first tick after 9:15:00 arrives at 9:15:00.21 with Nifty at 24,000.00. **Open = 24,000.00.**

### 1.2 Step 2: pre-resolve both options at 9:15:04

At 9:15:04 the bot uses the live Nifty spot to look up the ATM CE and ATM PE contracts. It also warms them up, so that at 9:15:11 it only has to place the order.

The first order attempt uses this strike even if Nifty has moved a little since 9:15:04. Retries look the strike up again from the latest spot.

> Example: spot at 9:15:04 is 24,003 → ATM strike 24,000 → contracts NIFTY…24000CE and NIFTY…24000PE are ready.

### 1.3 Step 3: read the direction at 9:15:10

The bot compares the mark (last tick before 9:15:10) with the open:

| Read at 9:15:10 | Rule | Result |
|---|---|---|
| Red, drop ≥ 5 points | open − mark ≥ 5 | Buy ATM **PE** at 9:15:11 |
| Green, rise ≥ 10 points | mark − open ≥ 10 | Buy ATM **CE** at 9:15:11 |
| Red but drop < 5 | | No 9:15 trade |
| Green but rise < 10 | | No 9:15 trade |
| Flat (mark = open) | | No 9:15 trade |

Note that green needs a bigger move (10 points) than red (5 points).

> Examples (open = 24,000.00):
>
> | Mark (last tick before 9:15:10) | Move | Decision |
> |---|---|---|
> | 23,993.50 | Red by 6.50 | **Buy PE** |
> | 23,995.00 | Red by exactly 5.00 | **Buy PE** (5 is enough) |
> | 23,996.00 | Red by 4.00 | No trade |
> | 24,011.20 | Green by 11.20 | **Buy CE** |
> | 24,010.00 | Green by exactly 10.00 | **Buy CE** (10 is enough) |
> | 24,007.00 | Green by 7.00 | No trade (green needs 10) |
> | 24,000.00 | Flat | No trade |

### 1.4 Step 4: sizing (how many lots)

1. The bot reads the option's last traded price (LTP) twice over REST, 1 second apart, and sizes on the **lower** of the two prices. This protects against an opening spike in the first quote.
2. It uses the full available balance: lots = floor(available balance ÷ (LTP × 65)).
3. Kite allows at most 25 lots per order, so a larger size is split into parallel orders (for example 30 lots → one order of 25 and one of 5). It is still one position.

Timing note: the two price reads take about 1 second, so the order usually reaches Kite at about 9:15:12, not exactly 9:15:11.000.

> Example: available balance ₹2,00,000. PE quotes are ₹101.00, then ₹100.00 one second later. The bot sizes on ₹100.00. One lot costs 100 × 65 = ₹6,500, so 2,00,000 ÷ 6,500 = 30.7 → **30 lots (1,950 qty)**, sent as 25 + 5 lots.

### 1.5 Step 5: the entry order

- **NRML market buy.** It fills at the live price, not at a fixed limit, so it gets filled fast.
- Your actual entry price is the average fill price Kite reports. It can be a little different from the price used for sizing.

### 1.6 What happens if Kite says "insufficient funds"

The live price can move between sizing and placement, so Kite sometimes rejects for margin.

1. The bot immediately retries with fewer lots:
   - If Kite quotes "Required" and "Available" amounts, the bot scales the size down in one step: new lots = floor(current lots × available ÷ required). It always drops at least 1 lot.
   - If Kite doesn't quote the amounts, it drops exactly 1 lot.
2. It keeps retrying instantly, with no deliberate pause, **until 9:15:15**.
3. If it still hasn't got in by 9:15:16, the 9:15 trade is skipped for the day. The 9:16 trade is not affected.

> Example: the bot tries 30 lots. Kite replies "Required: ₹1,95,800 · Available: ₹1,95,000". The scaled size is floor(30 × 1,95,000 ÷ 1,95,800) = floor(29.88) = **29 lots**, retried at once. If 29 is also rejected, it tries 28, and so on, until 9:15:15.

### 1.7 Partial fill

If some of the split orders fill and others are rejected (for example the 25-lot order fills but the 5-lot order is refused), the bot keeps what filled. It then tops up the missing lots, using the same downsize logic, **until 9:15:20**.

> Example: the target is 30 lots, but only the 25-lot order filled. The bot tries to buy 5 more lots. If 5 is refused for margin, it tries 4, then 3, and so on. It stops trying at 9:15:20 and manages whatever quantity it holds.

### 1.8 Exit 1: take-profit limit sell (the main exit)

The moment the buy fills, the bot places a resting **limit sell** for the whole quantity at:

**limit price = entry price × (1 + take-profit %), rounded to the nearest ₹0.05**

| Leg | Mon | Tue | Wed | Thu | Fri |
|---|---|---|---|---|---|
| **PE** (red 9:15) | 5% | 5% | 3% | 3% | 3% |
| **CE** (green 9:15) | 3% | 3% | 3% | 3% | 3% |

The % is profit on capital deployed (entry price × quantity), not a Nifty move.

> Example A (PE on a Monday): entry ₹100.00 × 1,950 qty = ₹1,95,000 deployed. Limit = 100 × 1.05 = **₹105.00**. If it fills, profit = 5 × 1,950 = **₹9,750** (5% of ₹1,95,000).
>
> Example B (PE on a Wednesday): same entry. Limit = 100 × 1.03 = **₹103.00**. Profit = **₹5,850** (3%).
>
> Example C (CE on any day): same entry. Limit = **₹103.00**. Profit = **₹5,850** (3%).
>
> Example D (rounding): entry ₹87.35 at 3% → 87.35 × 1.03 = 89.9705 → nearest ₹0.05 = **₹89.95**.

If Kite rejects the limit order, the bot retries straight away, up to 15 attempts. If it still can't place it, the market backup below still protects the target.

### 1.9 Exit 2: market backup

The bot also watches live unrealised P&L. If P&L reaches the same target (PE weekday % or CE 3%) but the limit sell hasn't filled, the bot cancels the limit and sells at market.

> Example: the limit sits at ₹105.00, the option trades at ₹105.10 for a moment, but your limit doesn't fill (queue or partial). Live P&L shows ≥ ₹9,750, so the bot cancels the limit and sells at market.

### 1.10 Exit 3: small-body exit at 9:16:01

This checks whether the whole 9:15 minute confirmed the move.

1. At 9:16:00 the bot seals the 9:15 close (last Nifty tick before 9:16:00).
2. If the 9:15 trade is still open and **|9:15 close − 9:15 open| < 5 points**, the exit is armed.
3. On the first Nifty tick in the 9:16:01 second, the bot cancels the take-profit limit and sells everything at market, whatever the P&L.

Why: the trade was bought because of the move at 9:15:10. If the full minute closes almost flat, that move has faded and the reason for the trade is gone.

> Example (PE): open 24,000.00. At 9:15:10 Nifty is 23,993 (red by 7), so the bot buys a PE. By 9:15:59 Nifty has bounced to 23,998, a body of only 2 points. The take-profit hasn't filled, so the PE is sold at market at 9:16:01.
>
> Counter-example: if the close had been 23,990 (body 10 points), nothing happens. The trade carries on with its take-profit, market backup, hard stop and 3:25 PM exit.

It applies the same way to CE trades; only the size of the body matters, not its direction.

When this exit is armed, the 9:16 trade is not marked as skipped, because the 9:15 trade is being closed at 9:16:01 anyway. In every other case where the 9:15 trade is still open at 9:16:00, the 9:16 trade is skipped for the day.

### 1.11 Exit 4: hard stop (from 10:00 AM)

From 10:00 AM, the bot exits at market if Nifty has moved **30 points against** the trade, measured from the entry spot:

- **PE:** exit when Nifty ≥ entry spot + 30
- **CE:** exit when Nifty ≤ entry spot − 30

Before 10:00 there is no hard stop.

> Example (PE): entry spot 23,990. From 10:00 the stop level is 24,020. If Nifty is at 24,035 at 9:45, nothing happens because the stop isn't active yet. If Nifty is 24,020 or higher at any time from 10:00, the bot sells at market.
>
> Example (CE): entry spot 24,012. The stop level is 23,982 from 10:00.

### 1.12 Exit 5: 3:25 PM square-off

Any 9:15 position still open at 3:25 PM is sold at market, whatever the P&L.

### 1.13 There is no trailing stop

Apart from the exits above, there is no option-price stop-loss and no trailing ladder. The trade either hits a take-profit, gets cut by the small-body exit or the hard stop, or runs until 3:25 PM.

### 1.14 9:15 trade, full worked example (a Monday)

1. 9:15:00.2: open = 24,000.00.
2. 9:15:04: ATM 24000 CE and PE are pre-resolved.
3. 9:15:09.9: last tick before 9:15:10 is 23,992.40, red by 7.60, so the decision is to buy the PE.
4. About 9:15:12: quotes are ₹101.00 and ₹100.00, so it sizes on ₹100. With a ₹2,00,000 balance that's 30 lots, sent as 25 + 5.
5. Fills at an average of ₹100.20, 1,950 qty, so ₹1,95,390 deployed.
6. Take-profit limit (Monday, PE, 5%): 100.20 × 1.05 = 105.21 → **₹105.20**.
7. 9:16:00: 9:15 close 23,985 (body 15), so no small-body exit.
8. At 9:22 the option reaches ₹105.20, the limit fills, and profit is about (105.20 − 100.20) × 1,950 = **₹9,750**.

---

## 2. The 9:16 trade (PE or CE at 9:16:01)

### 2.1 Entry decision: Δ of the full 9:15 candle

- **9:15 open:** the same first tick from 9:15:00 used by the 9:15 trade.
- **9:15 close:** the last Nifty WS tick strictly before 9:16:00, logged as the 9:15:59 close.
- **Δ = close − open.**

| Δ | Result |
|---|---|
| Flat (Δ = 0) | No trade |
| \|Δ\| < 15 | No trade |
| Red, \|Δ\| ≥ 15 | Buy ATM **PE** at 9:16:01 |
| Green, \|Δ\| ≥ 15 | Buy ATM **CE** at 9:16:01 |

> Examples (open = 24,000.00):
>
> | 9:15 close | Δ | Decision |
> |---|---|---|
> | 23,980.00 | −20 | **Buy PE** |
> | 23,985.00 | −15 (exactly) | **Buy PE** |
> | 23,990.00 | −10 | No trade |
> | 24,018.00 | +18 | **Buy CE** |
> | 24,015.00 | +15 (exactly) | **Buy CE** |
> | 24,009.00 | +9 | No trade |

**Blocked:** if the 9:15 trade is still open at 9:16:00, the 9:16 trade is skipped for the day. The exception is the small-body exit case in 1.10.

### 2.2 Pre-arming at 9:15:58

At 9:15:58 the bot looks up the ATM CE and PE strikes from the live spot and subscribes both options to the websocket. That way the 9:16:01 order doesn't need any slow REST calls.

### 2.3 Entry price: two websocket ticks in the 9:16:01 second

At exactly 9:16:01.000 (a dedicated timer) the bot takes the **1st and 2nd option ticks** that arrive in the 9:16:01 second for the chosen option:

- **Limit price** = the **2nd tick**, rounded to the nearest ₹0.05.
- **Lot sizing** uses the **lower** of the two ticks.
- If the 1st tick is **3% or more above** the 2nd, it's logged as an opening spike. The lower price is still used, so you don't oversize on a spike.

If the 9:16:01 ticks don't arrive in time, the bot falls back to the next two consecutive websocket ticks, and failing that, to REST quotes.

> Example: 1st tick ₹120.40, 2nd tick ₹119.80. Limit buy at **₹119.80**, sized on ₹119.80.
>
> Spike example: 1st ₹124.00, 2nd ₹120.00. The 1st is 3.3% above the 2nd, so it's logged as a spike. The limit is ₹120.00 and sizing uses ₹120.00.

### 2.4 The entry order

- **NRML limit buy** at the limit price above, split into 25-lot orders if larger.
- **Market backup after 8 seconds:** if the limit hasn't filled within 8 seconds, the bot cancels it and buys at market.
- **Retries until 9:16:30:** if an attempt fails, the bot re-reads prices and tries again until 9:16:30. After that there is no 9:16 trade that day.

### 2.5 Partial fill and margin short

- **Partial fill:** the bot keeps what filled and tops up the missing lots until 9:16:30.
- **Insufficient margin:** it steps the size down instantly (for example 25 → 24 → 23), scaling in one jump when Kite quotes the required and available amounts.

> Example: the bot tries 26 lots as 25 + 1. The 25-lot order fills and the 1-lot order is rejected for margin. It keeps the 25 lots and tries to top up 1 lot until 9:16:30.

### 2.6 Exit 1: take-profit limit sell

The moment the entry fills, a resting **limit sell** is placed at:

**limit price = entry price × (1 + take-profit %), rounded to the nearest ₹0.05**

| Leg | Mon | Tue | Wed | Thu | Fri |
|---|---|---|---|---|---|
| **PE** (red 9:15) | 5% | 7% | 5% | 5% | 7% |
| **CE** (green 9:15) | 3% | 3% | 3% | 3% | 3% |

Note that the 9:16 PE percentages differ from the 9:15 PE percentages.

> Example A (PE on a Tuesday): entry ₹64.75 × 1,625 qty (25 lots) = ₹1,05,219 deployed. Limit = 64.75 × 1.07 = 69.28 → **₹69.30**. Profit if filled = 4.55 × 1,625 = about ₹7,394 (7%, a touch more after rounding).
>
> Example B (PE on a Monday): limit = 64.75 × 1.05 = 67.99 → **₹68.00**. Profit about ₹5,281 (5%).
>
> Example C (CE on any day): limit = 64.75 × 1.03 = 66.69 → **₹66.70**. Profit about ₹3,169 (3%).

If Kite rejects the limit order, the bot retries straight away, up to 15 attempts.

### 2.7 Exit 2: market backup

This works the same as the 9:15 trade. If unrealised P&L reaches the target % but the limit hasn't filled, the bot cancels the limit and sells at market.

### 2.8 Exit 3: parallel Nifty index exit (market sell)

This runs at the same time as the take-profit limit; whichever is hit first closes the trade. It watches the Nifty index, not the option price.

Three reference ticks decide the target:

- **9:15:59 close:** the last Nifty tick inside the 9:15:59 second.
- **9:16:00 open:** the first Nifty tick inside the 9:16:00 second.
- **9:16:59 close:** the last Nifty tick inside the 9:16:59 second.

Any difference counts, even 0.05: an open slightly below the 9:15:59 close is red, slightly above is green. An open exactly equal to the 9:15:59 close counts as the same colour as the 9:15 candle for that trade (the 12-point tier).

#### PE trade (red 9:15)

| Condition | Target (until 9:17:00) |
|---|---|
| 9:16:00 open ≤ 9:15:59 close (both candles red) | Nifty ≤ entry spot **− 12** |
| 9:16:00 open > 9:15:59 close (green gap at 9:16) | Nifty ≤ entry spot **− 8** |

**From 9:17:00:** if the 9:16 minute closed green (9:16:59 close > 9:15:59 close), the target moves to Nifty ≤ entry spot **− 6**. Otherwise the original −12 or −8 target stays.

> Example (PE):
> - 9:15:59 close = 23,980.00. 9:16:00 first tick = 23,978.50, which is lower, so both candles are red.
> - Entry spot at fill = 23,976.00, so the **target is 23,964.00** (−12).
> - If instead the 9:16:00 tick had been 23,981.00 (higher, a green gap), the **target would be 23,968.00** (−8).
> - At 9:16:59 the last tick is 23,985.00, above 23,980.00, so the 9:16 minute closed green. **From 9:17:00 the target becomes 23,970.00** (−6).
> - If the 9:16:59 tick had been 23,975.00 (below 23,980), there would be no change and the target stays at 23,964 (or 23,968).

#### CE trade (green 9:15), the mirror image

| Condition | Target (until 9:17:00) |
|---|---|
| 9:16:00 open ≥ 9:15:59 close (both candles green) | Nifty ≥ entry spot **+ 12** |
| 9:16:00 open < 9:15:59 close (red gap at 9:16) | Nifty ≥ entry spot **+ 8** |

**From 9:17:00:** if the 9:16 minute closed red (9:16:59 close < 9:15:59 close), the target moves to Nifty ≥ entry spot **+ 6**. Otherwise the original +12 or +8 target stays.

> Example (CE):
> - 9:15:59 close = 24,018.00. 9:16:00 first tick = 24,019.00, which is higher, so both candles are green.
> - Entry spot at fill = 24,020.00, so the **target is 24,032.00** (+12).
> - If instead the 9:16:00 tick had been 24,017.50 (lower, a red gap), the **target would be 24,028.00** (+8).
> - At 9:16:59 the last tick is 24,010.00, below 24,018.00, so the 9:16 minute closed red. **From 9:17:00 the target becomes 24,026.00** (+6).

Why the target shrinks: when the second candle goes against the trade, the move is weaker, so the bot settles for a smaller, quicker index target.

Edge cases:

- If Nifty is already beyond the new 6-point target at 9:17:00, the exit fires on the next check.
- If no Nifty tick arrives in the 9:16:00 second, the bot uses the entry spot as the 9:16 open.
- If no Nifty tick arrives in the 9:15:59 second, the index exit isn't armed for that day. The trade then relies on the take-profit, market backup, hard stop and 3:25 PM exits. This is rare, because Nifty normally ticks several times a second.

### 2.9 Exit 4: hard stop (from 10:00 AM)

This is the same as the 9:15 trade:

- **PE:** exit at market when Nifty ≥ entry spot + 30
- **CE:** exit at market when Nifty ≤ entry spot − 30

It's only active from 10:00 AM and runs alongside the other exits; the first to trigger wins.

### 2.10 Exit 5: 3:25 PM square-off

Any 9:16 position still open at 3:25 PM is sold at market.

### 2.11 There is no trailing stop

There is no option-price stop-loss or trailing ladder. The trade closes on the first of the take-profit limit, market backup, index exit, hard stop or 3:25 PM.

### 2.12 9:16 trade, full worked example (a Tuesday, PE)

1. 9:15 open 24,000.00, 9:15 close (last tick before 9:16:00) 23,980.00, so Δ = −20, red, and |Δ| ≥ 15. Buy PE.
2. 9:15:58: ATM 24000 CE and PE are resolved and subscribed.
3. 9:16:00 first Nifty tick is 23,978.50, which is ≤ the 9:15:59 close of 23,980.00, so both candles are red and the index tier is −12.
4. 9:16:01 option ticks: ₹65.30, then ₹64.75. Limit buy at ₹64.75, sized on ₹64.75. Fills: 25 lots = 1,625 qty.
5. Entry spot at fill is 23,976.00, so the index target is 23,964.00.
6. Take-profit limit (Tuesday, PE, 7%): 64.75 × 1.07 → **₹69.30**.
7. 9:16:59 last tick is 23,972.00, below 23,980, so the minute did not close green and there's no retarget.
8. 9:19: Nifty touches 23,964.00 before the option reaches ₹69.30, so the index exit fires. The bot cancels the take-profit limit and sells at market.

---

## 3. Quick comparison

| | 9:15 trade | 9:16 trade |
|---|---|---|
| Signal | 9:15:10 read vs open | Full 9:15 candle Δ |
| Red threshold | ≥ 5 points → PE | ≥ 15 points → PE |
| Green threshold | ≥ 10 points → CE | ≥ 15 points → CE |
| Entry time | 9:15:11 (order ~9:15:12) | 9:16:01 |
| Entry order | Market buy | Limit at 2nd tick, market backup after 8s |
| Margin retries until | 9:15:15 (top-ups until 9:15:20) | 9:16:30 |
| PE take-profit | Mon/Tue 5% · Wed/Thu/Fri 3% | Mon/Wed/Thu 5% · Tue/Fri 7% |
| CE take-profit | 3% every day | 3% every day |
| Market backup | Yes, same % | Yes, same % |
| Index exit | No | Yes: ∓12 / ∓8, then ∓6 from 9:17 |
| Small-body exit | Yes, at 9:16:01 if 9:15 body < 5 | No |
| Hard stop | From 10:00, 30 points against | From 10:00, 30 points against |
| Force exit | 3:25 PM | 3:25 PM |
