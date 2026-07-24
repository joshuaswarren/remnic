/**
 * Corpus-watermark doctor check (issue #2149).
 *
 * Lives beside operator-toolkit.ts (which is at its structural-ratchet ceiling)
 * so the god file only gains the wiring. Reports each namespace's active-memory
 * count, newest write, and a short census-digest prefix. This PR has no peer to
 * compare against, so the check never warns — the follow-up PR that adds peer
 * polling introduces the count/age divergence thresholds.
 *
 * The caller supplies `storageFactory` (a `dir -> CorpusStorage`) so this
 * module never imports the storage god-module directly (issue #1533 ratchet).
 */

import { resolveNamespaceCapabilities } from "./capabilities.js";
import { type CorpusStorage, type CorpusWatermark, computeCorpusWatermarks } from "./corpus-watermark.js";
import { listNamespaces } from "./namespaces/migrate.js";
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
    const rootByNamespace = await resolveCorpusRoots(config);
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

/**
 * Namespace -> memory root, deduped by root so a namespaces-disabled or
 * flat-root deployment reports its single shared corpus exactly once. Mirrors
 * runOperatorInventory's config-driven enumeration (the doctor orchestrator has
 * no live namespace catalog).
 */
async function resolveCorpusRoots(config: PluginConfig): Promise<Map<string, string>> {
  const rootByNamespace = new Map<string, string>();
  if (resolveNamespaceCapabilities(config).namespaces !== true) {
    rootByNamespace.set(config.defaultNamespace, config.memoryDir);
    return rootByNamespace;
  }
  const seenRoots = new Set<string>();
  for (const entry of await listNamespaces({ config })) {
    if (seenRoots.has(entry.rootDir)) continue;
    seenRoots.add(entry.rootDir);
    rootByNamespace.set(entry.namespace, entry.rootDir);
  }
  if (rootByNamespace.size === 0) {
    rootByNamespace.set(config.defaultNamespace, config.memoryDir);
  }
  return rootByNamespace;
}
