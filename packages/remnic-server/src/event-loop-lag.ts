import { monitorEventLoopDelay } from "node:perf_hooks";
import { log } from "@remnic/core";

export interface LagSample {
  p99Ms: number;
  maxMs: number;
}

export interface EventLoopLagOptions {
  intervalMs?: number;
  warnP99Ms?: number;
  warnMaxMs?: number;
  /** Returns the window's lag and resets it. Injectable for tests. */
  sample?: () => LagSample;
  warn?: (message: string) => void;
  /** Returns a disarm function. Injectable for tests. */
  schedule?: (fn: () => void, intervalMs: number) => () => void;
}

/**
 * Daemon.log had no signal for a starved event loop, so MCP timeouts (COS-666)
 * could not be split into "loop blocked" vs "downstream slow". Warns once per
 * window when lag crosses a threshold; silent otherwise.
 */
export function startEventLoopLagMonitor(options: EventLoopLagOptions = {}): () => void {
  const intervalMs = options.intervalMs ?? 30_000;
  const warnP99Ms = options.warnP99Ms ?? 250;
  const warnMaxMs = options.warnMaxMs ?? 1_000;
  const warn = options.warn ?? ((m: string) => log.warn(m));
  let sample = options.sample;
  let stopHistogram = () => {};
  if (!sample) {
    const histogram = monitorEventLoopDelay({ resolution: 20 });
    histogram.enable();
    stopHistogram = () => histogram.disable();
    sample = () => {
      const lag = { p99Ms: histogram.percentile(99) / 1e6, maxMs: histogram.max / 1e6 };
      histogram.reset();
      return lag;
    };
  }
  const schedule =
    options.schedule ??
    ((fn, ms) => {
      const timer = setInterval(fn, ms);
      timer.unref();
      return () => clearInterval(timer);
    });
  const disarm = schedule(() => {
    const { p99Ms, maxMs } = sample();
    if (p99Ms >= warnP99Ms || maxMs >= warnMaxMs) {
      warn(`event loop lag: p99=${Math.round(p99Ms)}ms max=${Math.round(maxMs)}ms over last ${intervalMs / 1000}s`);
    }
  }, intervalMs);
  return () => {
    disarm();
    stopHistogram();
  };
}
