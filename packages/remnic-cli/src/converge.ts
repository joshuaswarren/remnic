import * as fs from "node:fs";
import * as path from "node:path";
import {
  type PluginConfig,
  parseConfig,
  type ResolveSecretRefFn,
  buildOfflineSyncSnapshotFromBase,
} from "@remnic/core";
import { resolveCorpusNamespaceRoots } from "@remnic/core/corpus-watermark.js";
import { listNamespaces } from "@remnic/core/namespaces/migrate.js";
import {
  planReconciliation,
  type ReconcileFileState,
  type ReconcileNamespaceInput,
  type ReconcilePlan,
} from "@remnic/core/reconcile/plan.js";
import { resolveAgentAccessAuthToken } from "@remnic/core/resolve-auth-token.js";

export interface ConvergePlanOptions {
  config?: PluginConfig;
  peerUrl?: string;
  peerToken?: string;
  fetchImpl?: typeof fetch;
  resolveSecretRef?: ResolveSecretRefFn;
  localFilesByNamespace?: Map<string, ReconcileFileState[]>;
  localTombstonesByNamespace?: Map<string, Iterable<string>>;
  peerFilesByNamespace?: Map<string, ReconcileFileState[]>;
  peerTombstonesByNamespace?: Map<string, Iterable<string>>;
}

async function readLocalTombstones(rootDir: string): Promise<Set<string>> {
  const shaSet = new Set<string>();
  const candidates = [
    path.join(rootDir, "state", "tombstones.jsonl"),
    path.join(rootDir, "tombstones.jsonl"),
  ];
  for (const tombPath of candidates) {
    try {
      const content = await fs.promises.readFile(tombPath, "utf-8");
      for (const line of content.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const record = JSON.parse(trimmed) as { contentHash?: unknown; fileSha256?: unknown };
          if (typeof record.contentHash === "string" && /^[0-9a-f]{64}$/i.test(record.contentHash)) {
            shaSet.add(record.contentHash.toLowerCase());
          }
          if (typeof record.fileSha256 === "string" && /^[0-9a-f]{64}$/i.test(record.fileSha256)) {
            shaSet.add(record.fileSha256.toLowerCase());
          }
        } catch {
          // ignore unparseable line
        }
      }
    } catch {
      // file does not exist
    }
  }
  return shaSet;
}

async function fetchPeerSnapshot(
  peerUrl: string,
  namespace: string,
  token?: string,
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<{ files: ReconcileFileState[]; tombstones: Set<string> }> {
  const base = peerUrl.replace(/\/+$/, "");
  const routes = [
    `/remnic/v1/offline-sync/snapshot?namespace=${encodeURIComponent(namespace)}&content=false`,
    `/engram/v1/offline-sync/snapshot?namespace=${encodeURIComponent(namespace)}&content=false`,
  ];
  const headers: Record<string, string> = token ? { authorization: `Bearer ${token}` } : {};

  for (const route of routes) {
    try {
      const res = await fetchImpl(`${base}${route}`, { headers });
      if (!res.ok) continue;
      const data = (await res.json()) as {
        files?: Array<{ path?: string; sha256?: string; mtimeMs?: number; bytes?: number }>;
        tombstones?: string[];
      };
      const files: ReconcileFileState[] = [];
      if (Array.isArray(data.files)) {
        for (const item of data.files) {
          if (item && typeof item.path === "string" && typeof item.sha256 === "string") {
            files.push({
              path: item.path,
              sha256: item.sha256,
              mtimeMs: typeof item.mtimeMs === "number" ? item.mtimeMs : undefined,
              bytes: typeof item.bytes === "number" ? item.bytes : undefined,
            });
          }
        }
      }
      const tombstones = new Set<string>();
      if (Array.isArray(data.tombstones)) {
        for (const tomb of data.tombstones) {
          if (typeof tomb === "string" && /^[0-9a-f]{64}$/i.test(tomb)) {
            tombstones.add(tomb.toLowerCase());
          }
        }
      }
      return { files, tombstones };
    } catch {
      // try next route on network failure or 404
    }
  }
  return { files: [], tombstones: new Set() };
}

export async function computeConvergePlan(options: ConvergePlanOptions = {}): Promise<ReconcilePlan> {
  const namespacesToPlan = new Set<string>();
  const localMap = new Map<string, ReconcileFileState[]>();
  const localTombstones = new Map<string, Set<string>>();
  const peerMap = new Map<string, ReconcileFileState[]>();
  const peerTombstones = new Map<string, Set<string>>();

  if (options.localFilesByNamespace) {
    for (const [ns, files] of options.localFilesByNamespace) {
      namespacesToPlan.add(ns);
      localMap.set(ns, files);
    }
  }
  if (options.localTombstonesByNamespace) {
    for (const [ns, tombstones] of options.localTombstonesByNamespace) {
      localTombstones.set(ns, new Set(tombstones));
    }
  }
  if (options.peerFilesByNamespace) {
    for (const [ns, files] of options.peerFilesByNamespace) {
      namespacesToPlan.add(ns);
      peerMap.set(ns, files);
    }
  }
  if (options.peerTombstonesByNamespace) {
    for (const [ns, tombstones] of options.peerTombstonesByNamespace) {
      peerTombstones.set(ns, new Set(tombstones));
    }
  }
  let config = options.config;
  if (!config) {
    try {
      config = parseConfig({});
    } catch {
      // ignore missing/invalid config in fallback mode
    }
  }

  if (!options.localFilesByNamespace && config) {
    const roots = await resolveCorpusNamespaceRoots({ config });
    const discovered = await listNamespaces({ config });
    for (const entry of discovered) {
      namespacesToPlan.add(entry.namespace);
    }
    for (const rootInfo of roots) {
      const ns = rootInfo.namespace;
      namespacesToPlan.add(ns);
      try {
        const snapshot = await buildOfflineSyncSnapshotFromBase({
          root: rootInfo.rootDir,
          sourceId: "local",
          includeContent: false,
        });
        const files: ReconcileFileState[] = snapshot.files.map((record) => ({
          path: record.path,
          sha256: record.sha256,
          mtimeMs: record.mtimeMs,
          bytes: record.bytes,
        }));
        localMap.set(ns, files);
        const tombstones = await readLocalTombstones(rootInfo.rootDir);
        localTombstones.set(ns, tombstones);
      } catch {
        localMap.set(ns, []);
      }
    }
  }

  if (!options.peerFilesByNamespace && options.peerUrl) {
    let resolvedToken: string | undefined;
    if (options.peerToken) {
      try {
        resolvedToken = await resolveAgentAccessAuthToken(options.peerToken, {
          resolveSecretRef: options.resolveSecretRef,
        });
      } catch {
        resolvedToken = options.peerToken;
      }
    }
    const fetchFn = options.fetchImpl ?? globalThis.fetch;
    for (const ns of namespacesToPlan) {
      const peerData = await fetchPeerSnapshot(options.peerUrl, ns, resolvedToken, fetchFn);
      peerMap.set(ns, peerData.files);
      peerTombstones.set(ns, peerData.tombstones);
    }
  }

  const inputs: ReconcileNamespaceInput[] = [];
  for (const ns of [...namespacesToPlan].sort()) {
    inputs.push({
      namespace: ns,
      local: localMap.get(ns) ?? [],
      peer: peerMap.get(ns) ?? [],
      tombstonedFileSha256: localTombstones.get(ns) ?? [],
      peerTombstonedFileSha256: peerTombstones.get(ns) ?? [],
    });
  }

  return planReconciliation(inputs);
}


export function formatConvergeReport(plan: ReconcilePlan): string {
  const lines: string[] = [];
  lines.push(`Convergence Status: ${plan.converged ? "CONVERGED" : "DIVERGED"}`);
  lines.push("");
  lines.push("Per-Namespace Summary:");
  if (plan.byNamespace.length === 0) {
    lines.push("  (no namespaces evaluated)");
  } else {
    for (const report of plan.byNamespace) {
      lines.push(`  [${report.namespace}]`);
      lines.push(`    identical:  ${report.identical}`);
      lines.push(`    pull:       ${report.pull}`);
      lines.push(`    push:       ${report.push}`);
      lines.push(`    conflict:   ${report.conflict}`);
      lines.push(`    suppress:   ${report.suppress}`);
      lines.push(`    unresolved: ${report.unresolved}`);
    }
  }
  return lines.join("\n");
}

export async function cmdConverge(action: string, rest: string[], json: boolean): Promise<void> {
  if (action === "help" || action === "--help" || action === "-h" || rest.includes("--help") || rest.includes("-h")) {
    console.log(`Usage: remnic converge plan [--peer <url>] [--token <token>] [--json]

Options:
  --peer <url>      Peer server URL (or --remote-url / --remote)
  --token <token>   Bearer token or SecretRef for peer authentication
  --json            Output detailed JSON plan report
`);
    return;
  }

  if (action !== "plan") {
    process.stderr.write(`converge: unknown action "${action}". Use: plan [options].\n`);
    process.exitCode = 2;
    return;
  }

  let peerUrl: string | undefined;
  let peerToken: string | undefined;

  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    if ((arg === "--peer" || arg === "--remote-url" || arg === "--remote") && rest[i + 1]) {
      peerUrl = rest[i + 1];
      i += 1;
    } else if (arg === "--token" && rest[i + 1]) {
      peerToken = rest[i + 1];
      i += 1;
    }
  }

  const plan = await computeConvergePlan({ peerUrl, peerToken });

  if (json) {
    console.log(JSON.stringify(plan, null, 2));
  } else {
    console.log(formatConvergeReport(plan));
  }
}
