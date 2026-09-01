import { spawn } from "child_process";
import path from "path";
import { fileURLToPath } from "url";

/**
 * Ceiling for the build child's V8 heap. Left uncapped, V8 sizes the heap off total RAM and
 * happily grows into swap before it collects; a hard cap makes it collect instead. Slower builds
 * are the trade, which is the right way round on a host that also runs a live trading bot.
 */
const DEFAULT_HEAP_MB = 1024;
/** Build work always yields to the API and the live bot. */
const NICENESS = "10";

const HERE = fileURLToPath(import.meta.url);
/** ".ts" under tsx in production, ".js" if this is ever run from compiled output. */
const WORKER = path.join(path.dirname(HERE), `backtest-build-worker${path.extname(HERE)}`);

function heapMb(): number {
  const raw = Number(process.env.BACKTEST_BUILD_HEAP_MB);
  return Number.isFinite(raw) && raw >= 256 ? Math.round(raw) : DEFAULT_HEAP_MB;
}

/** Our explicit cap has to be the only one, so drop any inherited copies first. */
function withoutHeapCap(values: string[]): string[] {
  return values.filter((value) => !value.startsWith("--max-old-space-size"));
}

/** Runs one index build to completion in its own process. */
export function spawnBacktestBuild(
  indexId: string,
  accessToken: string,
  days: number,
): Promise<void> {
  const nodeArgs = [
    ...withoutHeapCap(process.execArgv),
    `--max-old-space-size=${heapMb()}`,
    WORKER,
    indexId,
    String(days),
  ];
  const useNice = process.platform !== "win32";
  const command = useNice ? "nice" : process.execPath;
  const args = useNice ? ["-n", NICENESS, process.execPath, ...nodeArgs] : nodeArgs;

  const env = {
    ...process.env,
    NODE_OPTIONS: withoutHeapCap((process.env.NODE_OPTIONS ?? "").split(/\s+/).filter(Boolean)).join(" "),
    KITE_BUILD_ACCESS_TOKEN: accessToken,
  };

  return new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: process.cwd(),
      env,
      // stdout/stderr straight through so pm2 logs show build progress and failures.
      stdio: ["ignore", "inherit", "inherit"],
    });

    child.on("error", (error) => {
      reject(new Error(`Could not start backtest build worker: ${error.message}`));
    });

    child.on("close", (code, signal) => {
      if (code === 0) return resolve();
      if (signal) {
        return reject(new Error(`Backtest build for ${indexId} was killed by ${signal}`));
      }
      reject(new Error(`Backtest build for ${indexId} exited with code ${code}`));
    });
  });
}
