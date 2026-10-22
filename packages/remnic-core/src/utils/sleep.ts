/** Wait without cancellation; keep the timer referenced so awaited polling can finish. */
export function sleep(ms: number): Promise<void> {
  // Constructor form keeps this reachable utility compatible with ES2022 adapter type graphs.
  return new Promise((resolve) => setTimeout(resolve, ms));
}
