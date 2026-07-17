/** RSI above this → force Put Buy (server + auto loop). */
export const RSI_PUT_FORCE_THRESHOLD = 70;
/** RSI below this → force Call Buy (server + auto loop). */
export const RSI_CALL_FORCE_THRESHOLD = 30;

export function rsiForcedLeg(rsi: number | null | undefined): "CE_BUY" | "PE_BUY" | null {
  if (rsi == null || !Number.isFinite(rsi)) return null;
  if (rsi > RSI_PUT_FORCE_THRESHOLD) return "PE_BUY";
  if (rsi < RSI_CALL_FORCE_THRESHOLD) return "CE_BUY";
  return null;
}
