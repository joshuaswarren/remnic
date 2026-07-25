/**
 * Corpus-watermark doctor check (issue #2149).
 *
 * Lives beside operator-toolkit.ts (which is at its structural-ratchet ceiling)
 * so the god file only gains the wiring. Reports each namespace's memory-file
 * count, newest write, and a short census-digest prefix, and WARNS when a
 * namespace could not be scanned (unreadable/churning) or enumeration failed —
 * a scan failure omits a namespace, so an unconditional "ok" would certify a
 * partial fleet or conflate an unreadable corpus with an empty deployment
 * (issue #2156 round-7). Peer comparison (count/age divergence thresholds) is a
 * follow-up.
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
  let resolved: string[] = [];
  let watermarks: CorpusWatermark[] = [];
  let enumerationFailed = false;
  try {
    // The doctor orchestrator has no live namespace catalog, so config-driven
    // enumeration (deduped by root inside the shared helper) is the whole set.
    const rootByNamespace = new Map<string, string>();
    for (const root of await resolveCorpusNamespaceRoots({ config })) {
      rootByNamespace.set(root.namespace, root.rootDir);
    }
    resolved = [...rootByNamespace.keys()];
    watermarks = await computeCorpusWatermarks(
      resolved,
      (namespace) => storageFactory(rootByNamespace.get(namespace) ?? config.memoryDir),
      now
    );
  } catch {
    // Namespace ENUMERATION itself failed (distinct from a per-namespace scan).
    enumerationFailed = true;
  }

  const computed = new Set(watermarks.map((w) => w.namespace));
  const failed = resolved.filter((namespace) => !computed.has(namespace));
  const lines = watermarks.map(
    (w) =>
      `${w.namespace}: ${w.memoryFileCount} files, newest=${w.newestWriteAt ?? "never"}, ` +
      `digest=${w.digest.slice(0, DIGEST_PREFIX_LENGTH)}`
  );

  if (enumerationFailed) {
    return {
      key: "corpus_watermark",
      status: "warn",
      summary: "Could not resolve corpus namespaces (enumeration failed).",
      remediation: "Ensure the memory directory and namespace catalog are readable, then rerun `remnic doctor`.",
      details: { corpus: watermarks, resolved: resolved.length, failed: failed.length },
    };
  }
  if (failed.length > 0) {
    return {
      key: "corpus_watermark",
      status: "warn",
      summary:
        `Corpus watermark unavailable for ${failed.length} of ${resolved.length} namespace(s) ` +
        `(unreadable or churning): ${failed.join(", ")}.` +
        (lines.length > 0 ? ` Reporting ${lines.length}: ${lines.join("; ")}` : ""),
      remediation: "Inspect the omitted namespace roots for permission/backend errors, then rerun `remnic doctor`.",
      details: { corpus: watermarks, resolved: resolved.length, failed },
    };
  }
  return {
    key: "corpus_watermark",
    status: "ok",
    summary:
      resolved.length === 0
        ? "No corpus namespaces resolved yet."
        : `Corpus watermark across ${watermarks.length} namespace(s): ${lines.join("; ")}`,
    details: { corpus: watermarks },
  };
}
