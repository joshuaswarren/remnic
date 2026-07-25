/**
 * Corpus-watermark doctor check (issue #2149).
 *
 * Lives beside operator-toolkit.ts (which is at its structural-ratchet ceiling)
 * so the god file only gains the wiring. Reports each namespace's active-memory
 * count, newest write, and a short census-digest prefix. This PR has no peer to
 * compare against, so the check never warns — the follow-up PR that adds peer
 * polling introduces the count/age divergence thresholds.
 *
 * Namespaces are resolved through the shared resolveCorpusNamespaceRoots helper
 * (issue #2156 finding C) so the doctor and the /health surface enumerate the
 * SAME tenant set and cannot drift. The caller supplies `storageFactory` (a
 * `dir -> CorpusStorage`) so this module never imports the storage god-module
 * directly (issue #1533 ratchet).
 */

import {
  type CorpusStorage,
  type CorpusWatermark,
  computeCorpusWatermarks,
  resolveCorpusNamespaceRoots,
} from "./corpus-watermark.js";
import type { OperatorDoctorCheck } from "./operator-toolkit.js";
import type { PluginConfig } from "./types.js";

const DIGEST_PREFIX_LENGTH = 12;

export async function summarizeCorpusWatermark(
  config: PluginConfig,
  storageFactory: (dir: string) => CorpusStorage,
  now?: Date
): Promise<OperatorDoctorCheck> {
  let watermarks: CorpusWatermark[] = [];
  try {
    // The doctor orchestrator has no live namespace catalog, so config-driven
    // enumeration (deduped by root inside the shared helper) is the whole set.
    const rootByNamespace = new Map<string, string>();
    for (const root of await resolveCorpusNamespaceRoots({ config })) {
      rootByNamespace.set(root.namespace, root.rootDir);
    }
    watermarks = await computeCorpusWatermarks(
      [...rootByNamespace.keys()],
      (namespace) => storageFactory(rootByNamespace.get(namespace) ?? config.memoryDir),
      now
    );
  } catch {
    // Enumeration/storage failure — report an empty, non-erroring check.
    watermarks = [];
  }

  const lines = watermarks.map(
    (w) =>
      `${w.namespace}: ${w.activeMemoryCount} active, newest=${w.newestWriteAt ?? "never"}, ` +
      `digest=${w.digest.slice(0, DIGEST_PREFIX_LENGTH)}`
  );

  return {
    key: "corpus_watermark",
    status: "ok",
    summary:
      watermarks.length === 0
        ? "No corpus namespaces resolved yet."
        : `Corpus watermark across ${watermarks.length} namespace(s): ${lines.join("; ")}`,
    details: { corpus: watermarks },
  };
}
