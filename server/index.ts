import "./load-env.js";
import app from "./app.js";
import { startNineSixteenBot } from "./nine-sixteen-bot.js";
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

  if (process.env.NINE_SIXTEEN_BOT_ENABLED === "1") {
    console.log("[nine-sixteen-bot] Server auto trade enabled — no browser tab required");
    startNineSixteenBot();
  }
});
