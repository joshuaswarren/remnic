
import path from "node:path";
import { fileURLToPath } from "node:url";

export const DEFAULT_CREATE_GAP_SEC = 65;

/**
 * Milliseconds to wait before the next `gh pr create`, given the epoch-second
 * stamp of the previous create. 0 when the gap already elapsed, the stamp is
 * absent/garbage, or the clock ran backwards (skew never blocks a create).
 */
export function msToWait(lastEpochSec, nowEpochSec, gapSec = DEFAULT_CREATE_GAP_SEC) {
  if (!Number.isFinite(lastEpochSec) || !Number.isFinite(nowEpochSec)) return 0;
  if (!Number.isFinite(gapSec) || gapSec <= 0) return 0;
  if (lastEpochSec > nowEpochSec) return 0;
  const remainingMs = (lastEpochSec + gapSec - nowEpochSec) * 1000;
  return remainingMs > 0 ? remainingMs : 0;
}

// CLI: `node scripts/pr-create-stagger.mjs --wait-seconds <lastEpochSec>` prints
// whole seconds to sleep (rounded up; 0 when no wait is needed).
const isDirectExecution = Boolean(process.argv[1]) && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectExecution) {
  const argIndex = process.argv.indexOf("--wait-seconds");
  const last = Number.parseInt(process.argv[argIndex + 1] ?? "", 10);
  const gap = Number.parseInt(process.env.REMNIC_PR_CREATE_GAP_SEC ?? "", 10);
  const waitMs = msToWait(last, Date.now() / 1000, Number.isInteger(gap) && gap > 0 ? gap : undefined);
  console.log(Math.ceil(waitMs / 1000));
}
