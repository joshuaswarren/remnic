/**
 * Helper for probing QMD availability from runtime surfaces.
 *
 * `orchestrator.qmd.isAvailable()` returns a cached boolean derived from prior
 * probes. On a fresh process it can be `false` simply because nothing has
 * exercised the CLI/daemon yet — not because QMD is genuinely unavailable.
 * Runtime probe surfaces should fall back to an actual `qmd.probe()` before
 * reporting the backend as down, so consumers like `openclaw status` don't
 * see false negatives.
 *
 * Credit: behavior reported by https://github.com/earlvanze (2026-04-24 patch
 * bundle) — see fix bundle README for details.
 */
export interface QmdProbeTarget {
  isAvailable?: () => boolean;
  probe?: () => Promise<boolean>;
}

export interface QmdProbeHost {
  qmd?: QmdProbeTarget;
}

export async function probeQmdAvailability(host: QmdProbeHost): Promise<boolean> {
  const qmd = host?.qmd;
  let available =
    typeof qmd?.isAvailable === "function" ? Boolean(qmd.isAvailable()) : false;
  if (!available && typeof qmd?.probe === "function") {
    try {
      available = Boolean(await qmd.probe());
    } catch {
      available = false;
    }
  }
  return available;
}
