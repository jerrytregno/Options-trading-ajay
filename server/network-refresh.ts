import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const REFRESH_COOLDOWN_MS = 5 * 60_000;
let lastNetworkRefreshAt = 0;

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function getMacWifiDevice(): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("networksetup", ["-listallhardwareports"]);
    const blocks = stdout.split("\n\n");
    for (const block of blocks) {
      if (!/Hardware Port: Wi-Fi/i.test(block)) continue;
      const match = block.match(/Device: (en\d+)/i);
      if (match?.[1]) return match[1];
    }
  } catch {
    /* ignore — may need permissions */
  }
  return null;
}

/**
 * Toggle Wi-Fi off/on on macOS to request a new ISP session (may change public IP).
 * Rate-limited; no-op when KITE_AUTO_NETWORK_REFRESH=0 or not on darwin.
 */
export async function tryAutoNetworkRefresh(force = false): Promise<boolean> {
  if (process.env.KITE_AUTO_NETWORK_REFRESH === "0") return false;
  if (process.platform !== "darwin") return false;
  if (!force && Date.now() - lastNetworkRefreshAt < REFRESH_COOLDOWN_MS) {
    return false;
  }

  const device = await getMacWifiDevice();
  if (!device) return false;

  try {
    lastNetworkRefreshAt = Date.now();
    await execFileAsync("dscacheutil", ["-flushcache"]).catch(() => undefined);
    await execFileAsync("networksetup", ["-setairportpower", device, "off"]);
    await sleep(2500);
    await execFileAsync("networksetup", ["-setairportpower", device, "on"]);
    await sleep(6000);
    return true;
  } catch {
    return false;
  }
}

export function resetNetworkRefreshCooldown() {
  lastNetworkRefreshAt = 0;
}
