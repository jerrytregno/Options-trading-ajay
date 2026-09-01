import "./load-env.js";
import app, { warmBacktestCaches } from "./app.js";
import { startNineSixteenBot, startNineSixteenLiveMonitor } from "./nine-sixteen-bot.js";
import { startMomentumScalperBot, startMomentumScalperLiveMonitor } from "./momentum-scalper-bot.js";
import { formatMomentumLiveScheduleLabel } from "./momentum-scalper-logic.js";
import { startBrokerReconcileLoop } from "./broker-trades.js";
import {
  getEgressRelayUrl,
  getRelaySecret,
  getResolvedProxyUrl,
  isKiteEgressRelayConfigured,
  isKiteProxyEnabled,
  probeDirectIpv4,
  probeRelayEgressIpv4,
} from "./kite-http.js";
import { isIpWhitelistedForKite } from "../src/lib/kite-trading-ip.js";
import { startKiteAutoLogin } from "./kite-auto-login.js";

const PORT = Number(process.env.PORT) || 3001;

app.listen(PORT, async () => {
  console.log(`API server running on http://localhost:${PORT}`);
  const directIp = await probeDirectIpv4(true);
  const relayOn = isKiteEgressRelayConfigured();

  console.log(`[kite] localhost dev — orders exit via your Mac's public IP (not 127.0.0.1)`);
  if (isKiteProxyEnabled()) {
    const proxyUrl = getResolvedProxyUrl();
    console.log(`[kite] KITE_PROXY_URL → ${proxyUrl?.replace(/:[^:@/]+@/, ":***@") ?? "proxy"}`);
  }

  if (relayOn) {
    const relayIp = await probeRelayEgressIpv4();
    const relayUrl = getEgressRelayUrl();
    if (relayIp && isIpWhitelistedForKite(relayIp)) {
      console.log(`[kite] Relay ${relayUrl} → egress ${relayIp} (whitelisted)`);
    } else if (!getRelaySecret()) {
      console.log(`[kite] Set KITE_RELAY_SECRET in .env.local (must match Vercel), then restart`);
    } else {
      console.log(`[kite] Relay configured but unreachable — redeploy Vercel with latest code + KITE_RELAY_SECRET`);
    }
  } else if (directIp && !isIpWhitelistedForKite(directIp)) {
    console.log(
      `[kite] Off-whitelist network (${directIp}) — set KITE_PROXY_URL to a proxy on a whitelisted IP, or whitelist this IP in Kite Connect`,
    );
  }

  if (directIp && isIpWhitelistedForKite(directIp)) {
    console.log(`[kite] Kite egress ${directIp} (whitelisted — direct)`);
  }

  if (process.env.KITE_AUTO_LOGIN_ENABLED === "1") {
    console.log("[kite-auto-login] Daily Zerodha token refresh enabled — 07:40 IST");
    startKiteAutoLogin();
  }

  startNineSixteenLiveMonitor();
  startMomentumScalperLiveMonitor();

  startNineSixteenBot();
  console.log("[nine-sixteen-bot] 9:15 and 9:16 trading enabled by default — disable either in the UI if needed");

  // Main loop runs on startup so the live Traps windows can arm/disarm the bot automatically.
  const trapsSchedule = formatMomentumLiveScheduleLabel();
  console.log(`[traps] Weekday schedule ${trapsSchedule} IST · open trades are not cut at window end`);
  startMomentumScalperBot();

  // Zerodha's tradebook is same-day only, so fills are snapshotted through the session rather than
  // waiting for someone to open the Trades page.
  console.log("[broker-trades] Zerodha fill reconcile every 5 min · 09:10–15:45 IST");
  startBrokerReconcileLoop();

  // Deliberately after the bot is up, so warming can never delay its start.
  void warmBacktestCaches();
});
