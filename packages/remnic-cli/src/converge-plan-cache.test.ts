import * as assert from "node:assert/strict";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { test } from "node:test";
import { ContentHashIndex, parseConfig } from "@remnic/core";
import type { ReconcilePlan } from "@remnic/core/reconcile/plan.js";
import {
  CONVERGE_PLAN_CACHE_MAX_AGE_MS,
  ConvergePlanCache,
  ConvergePlanCacheBusyError,
  convergePlanCacheRoot,
  convergePlanScopeKey,
} from "./converge-plan-cache.js";
import { computeConvergePlan, type ConvergePlanProgressEvent } from "./converge.js";

/**
 * Issue #2803: resumable streamed manifest planning. A transient failure
 * late in a boot-scale plan must not discard the namespaces that already
 * completed; a retry resumes at the first incomplete namespace and only
 * recomputes what actually changed.
 *
 * Fixtures use a namespaces-enabled memory dir (every namespace under
 * `namespaces/<ns>`, nothing legacy at the memoryDir top level, so the
 * default namespace root migrates under `namespaces/` and the per-namespace
 * census walks are disjoint) plus a mock peer transport, so each scenario
 * exercises the live census + peer fetch paths end to end.
 */

const PEER_URL = "https://peer.example.test";
const PEER_TOKEN = "sekrit-peertoken-do-not-leak";
/** Namespaces a namespaces-enabled config discovers (sorted iteration order). */
const NAMESPACES = ["alpha", "beta", "default", "shared"];
/**
 * "shared" is not a safe route namespace name, so its storage root is the
 * hex-tokenized form the router resolves — the census walk requires that
 * directory to exist even though the corpus is empty.
 */
const SHARED_ROOT_DIR_NAME = `ns-${Buffer.from("shared", "utf8").toString("hex")}`;

function memoryFileBody(body: string): string {
  return [
    "---",
    `id: ${body.replace(/[^a-z0-9]+/gi, "-")}`,
    "category: fact",
    `contentHash: ${ContentHashIndex.computeHash(body)}`,
    "status: active",
    "---",
    body,
  ].join("\n");
}

interface FixtureFile {
  /** Path relative to the namespace root. */
  path: string;
  /** Rendered file content (frontmatter + body). */
  content: string;
}

function fixtureFile(namespace: string, body: string): FixtureFile {
  return {
    path: `facts/2026-08-01/${namespace}-fact.md`,
    content: memoryFileBody(body),
  };
}

/** The same corpus on both sides, keyed by namespace ("shared" stays empty). */
function convergedCorpus(): Map<string, FixtureFile[]> {
  const corpus = new Map<string, FixtureFile[]>(NAMESPACES.map((namespace) => [namespace, []]));
  for (const namespace of ["alpha", "beta", "default"]) {
    corpus.set(namespace, [fixtureFile(namespace, `fact body for ${namespace}`)]);
  }
  return corpus;
}

async function writeLocalCorpus(memoryDir: string, corpus: Map<string, FixtureFile[]>): Promise<void> {
  await fs.mkdir(path.join(memoryDir, "namespaces", SHARED_ROOT_DIR_NAME), { recursive: true });
  for (const [namespace, files] of corpus) {
    for (const file of files) {
      const filePath = path.join(memoryDir, "namespaces", namespace, file.path);
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await fs.writeFile(filePath, file.content);
    }
  }
}

interface PeerMock {
  fetchImpl: typeof fetch;
  /** Namespaces whose manifest-stream was fetched (in order). */
  manifestStreamNamespaces: string[];
  snapshotNamespaces: string[];
  contentPaths: string[];
  /** Paths fetched through the legacy per-file content route (in order). */
  fileContentPaths: string[];
  failManifestFor: Set<string>;
  manifestStream: boolean;
  onSnapshot?: (namespace: string) => void;
}

function createPeerMock(
  filesByNamespace: Map<string, FixtureFile[]>,
  /** Advertised peer manifest revision; `undefined` models an unversioned peer. */
  manifestRevision: string | undefined = "rev-1",
  /** Advertise the streaming manifest route? `false` forces the per-file fallback. */
  manifestStream = true
): PeerMock {
  const mock: PeerMock = {
    fetchImpl: async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/offline-sync/capabilities")) {
        return Response.json({
          version: 1,
          convergenceFinalization: true,
          manifestStream: mock.manifestStream,
          ...(manifestRevision !== undefined ? { manifestRevision } : {}),
        });
      }
      const namespace = url.searchParams.get("namespace") ?? "";
      if (url.pathname.endsWith("/offline-sync/snapshot")) {
        mock.snapshotNamespaces.push(namespace);
        mock.onSnapshot?.(namespace);
        // Real servers include transcript files unless the request pins
        // include_transcripts=false: manifests and transfers always exclude
        // them, so a transcript-inclusive snapshot describes a DIFFERENT
        // file set than the manifest it validates (#2927).
        const includeTranscripts = url.searchParams.get("include_transcripts") !== "false";
        const files = (filesByNamespace.get(namespace) ?? [])
          .filter((file) => includeTranscripts || file.path.split("/")[0] !== "transcripts")
          .map((file) => ({
            path: file.path,
            sha256: createHash("sha256").update(file.content).digest("hex"),
            bytes: Buffer.byteLength(file.content),
            mtimeMs: 2000,
          }));
        return Response.json({ files, tombstones: [] });
      }
      if (url.pathname.endsWith("/offline-sync/manifest-stream")) {
        if (mock.failManifestFor.has(namespace)) {
          return new Response(null, { status: 500 });
        }
        mock.manifestStreamNamespaces.push(namespace);
        const rows = [
          JSON.stringify({ type: "manifest", namespace, format: "remnic-reconcile-manifest", schemaVersion: 1 }),
        ];
        for (const file of (filesByNamespace.get(namespace) ?? []).filter(
          (entry) => entry.path.split("/")[0] !== "transcripts"
        )) {
          const body = file.content.split("---\n")[2] ?? "";
          rows.push(
            JSON.stringify({
              type: "file",
              file: {
                path: file.path,
                sha256: createHash("sha256").update(file.content).digest("hex"),
                bytes: Buffer.byteLength(file.content),
                mtimeMs: 2000,
                memory: {
                  id: path.basename(file.path, ".md"),
                  category: "fact",
                  contentHash: ContentHashIndex.computeHash(body),
                  status: "active",
                },
              },
            })
          );
        }
        return new Response([...rows, ""].join("\n"));
      }
      if (url.pathname.endsWith("/offline-sync/file-content")) {
        const request = JSON.parse(String(init?.body ?? "{}")) as {
          namespace?: string;
          path?: string;
          offset?: number;
          length?: number;
        };
        const fileNamespace = request.namespace ?? "";
        const filePath = request.path ?? "";
        mock.contentPaths.push(`${fileNamespace}:${filePath}`);
        mock.fileContentPaths.push(filePath);
        const file = (filesByNamespace.get(fileNamespace) ?? []).find((row) => row.path === filePath);
        if (!file) return new Response(null, { status: 404 });
        const content = Buffer.from(file.content, "utf8");
        const offset = request.offset ?? 0;
        const length = request.length ?? content.length;
        const chunk = content.subarray(offset, offset + length);
        return new Response(chunk, {
          headers: {
            "x-remnic-file-path": encodeURIComponent(file.path),
            "x-remnic-chunk-offset": String(offset),
            "x-remnic-chunk-bytes": String(chunk.length),
            "x-remnic-file-bytes": String(content.length),
            "x-remnic-file-mtime-ms": "2000",
            "x-remnic-file-sha256": createHash("sha256").update(content).digest("hex"),
          },
        });
      }
      return new Response(null, { status: 404 });
    },
    manifestStreamNamespaces: [],
    snapshotNamespaces: [],
    contentPaths: [],
    fileContentPaths: [],
    failManifestFor: new Set(),
    manifestStream,
  };
  return mock;
}

async function convergedPlan(
  memoryDir: string,
  mock: PeerMock,
  overrides: Partial<Parameters<typeof computeConvergePlan>[0]> = {}
): Promise<ReconcilePlan> {
  return computeConvergePlan({
    config: parseConfig({ memoryDir, namespacesEnabled: true }),
    peerUrl: PEER_URL,
    peerToken: PEER_TOKEN,
    fetchImpl: mock.fetchImpl,
    ...overrides,
  });
}

test("converge plan: a late peer failure preserves earlier namespaces and a retry resumes at the failure (#2803)", async () => {
  const memoryDir = await fs.mkdtemp(path.join(os.tmpdir(), "remnic-converge-resume-"));
  try {
    const corpus = convergedCorpus();
    await writeLocalCorpus(memoryDir, corpus);
    const failing = createPeerMock(corpus);
    failing.failManifestFor.add("default"); // sorted order: alpha, beta, default
    await assert.rejects(convergedPlan(memoryDir, failing), /peer manifest request failed: HTTP 500/);
    // alpha + beta completed BEFORE the failure and must be checkpointed.
    assert.deepEqual(failing.manifestStreamNamespaces, ["alpha", "beta"]);

    const resuming = createPeerMock(corpus);
    const events: ConvergePlanProgressEvent[] = [];
    const plan = await convergedPlan(memoryDir, resuming, { onProgress: (event) => events.push(event) });
    assert.equal(plan.converged, true, JSON.stringify(plan.byNamespace));
    // Only the namespace that never completed refetches its manifest.
    assert.deepEqual(resuming.manifestStreamNamespaces, ["default", "shared"]);
    // Snapshots are always fetched — they ARE the cache-validity check.
    assert.deepEqual(resuming.snapshotNamespaces.sort(), NAMESPACES);
    const reusedPeer = events
      .filter((event) => event.side === "peer" && event.reused > 0)
      .map((event) => event.namespace);
    assert.deepEqual(reusedPeer.sort(), ["alpha", "beta"]);
  } finally {
    await fs.rm(memoryDir, { recursive: true, force: true });
  }
});

test("converge plan: a changed local namespace invalidates only that namespace; peer entries survive local edits (#2803)", async () => {
  const memoryDir = await fs.mkdtemp(path.join(os.tmpdir(), "remnic-converge-invalidate-"));
  try {
    const corpus = convergedCorpus();
    await writeLocalCorpus(memoryDir, corpus);
    await convergedPlan(memoryDir, createPeerMock(corpus));

    // Mutate ONLY alpha's local file (different bytes ⇒ different sha).
    const alphaPath = path.join(memoryDir, "namespaces", "alpha", "facts/2026-08-01/alpha-fact.md");
    await fs.writeFile(alphaPath, memoryFileBody("rewritten alpha body, longer than before"));

    const second = createPeerMock(corpus);
    const events: ConvergePlanProgressEvent[] = [];
    const plan = await convergedPlan(memoryDir, second, { onProgress: (event) => events.push(event) });
    assert.equal(plan.converged, false); // alpha now differs from the peer
    const localByNamespace = new Map(
      events.filter((event) => event.side === "local").map((event) => [event.namespace, event])
    );
    assert.equal(localByNamespace.get("alpha")?.computed, 1, "alpha must recompute its changed file");
    assert.equal(localByNamespace.get("alpha")?.reused, 0);
    assert.equal(localByNamespace.get("beta")?.computed, 0, "beta must fully reuse");
    assert.equal(localByNamespace.get("beta")?.reused, 1);
    // The peer corpora did not change: no peer namespace refetches its manifest.
    assert.deepEqual(second.manifestStreamNamespaces, []);
  } finally {
    await fs.rm(memoryDir, { recursive: true, force: true });
  }
});

test("converge plan: a corrupt cache entry fails open to recompute (#2803)", async () => {
  const memoryDir = await fs.mkdtemp(path.join(os.tmpdir(), "remnic-converge-corrupt-"));
  try {
    const corpus = convergedCorpus();
    await writeLocalCorpus(memoryDir, corpus);
    await convergedPlan(memoryDir, createPeerMock(corpus));

    const config = parseConfig({ memoryDir, namespacesEnabled: true });
    const scopeDir = path.join(
      convergePlanCacheRoot(memoryDir),
      convergePlanScopeKey({ peerUrl: PEER_URL, citationTemplate: config.inlineSourceAttributionFormat })
    );
    const names = (await fs.readdir(scopeDir)).filter((name) => name.startsWith("peer-") && name.endsWith(".json"));
    assert.equal(names.length, NAMESPACES.length);
    await fs.writeFile(path.join(scopeDir, names[0]!), "{not-json");

    const second = createPeerMock(corpus);
    const plan = await convergedPlan(memoryDir, second);
    assert.equal(plan.converged, true);
    // The corrupt entry recomputed rather than failing the plan.
    assert.equal(second.manifestStreamNamespaces.length, 1);
  } finally {
    await fs.rm(memoryDir, { recursive: true, force: true });
  }
});

test("converge plan: cancellation stops the run and leaves completed checkpoints valid (#2803)", async () => {
  const memoryDir = await fs.mkdtemp(path.join(os.tmpdir(), "remnic-converge-cancel-"));
  try {
    const corpus = convergedCorpus();
    await writeLocalCorpus(memoryDir, corpus);
    const controller = new AbortController();
    const mock = createPeerMock(corpus);
    // Abort while beta's snapshot is being served: beta finishes from the
    // already-received response, and the NEXT namespace sees the abort.
    mock.onSnapshot = (namespace) => {
      if (namespace === "beta") controller.abort();
    };
    await assert.rejects(
      convergedPlan(memoryDir, mock, { signal: controller.signal }),
      (error: unknown) => error instanceof Error && /abort/i.test(error.message)
    );

    const resuming = createPeerMock(corpus);
    const plan = await convergedPlan(memoryDir, resuming);
    assert.equal(plan.converged, true);
    // alpha + beta were checkpointed before the abort; only the tail refetches.
    assert.deepEqual(resuming.manifestStreamNamespaces, ["default", "shared"]);
  } finally {
    await fs.rm(memoryDir, { recursive: true, force: true });
  }
});

test("converge plan: progress reports namespace N/M with reused/computed counts (#2803)", async () => {
  const memoryDir = await fs.mkdtemp(path.join(os.tmpdir(), "remnic-converge-progress-"));
  try {
    const corpus = convergedCorpus();
    await writeLocalCorpus(memoryDir, corpus);
    const events: ConvergePlanProgressEvent[] = [];
    const plan = await convergedPlan(memoryDir, createPeerMock(corpus), {
      onProgress: (event) => events.push(event),
    });
    assert.equal(plan.converged, true);

    for (const side of ["local", "peer"] as const) {
      const sideEvents = events.filter((event) => event.side === side);
      assert.equal(sideEvents.length, NAMESPACES.length, `${side} progress must fire per namespace`);
      assert.deepEqual(
        sideEvents.map((event) => event.index),
        sideEvents.map((_event, index) => index + 1),
        `${side} indexes must be 1..N in order`
      );
      assert.equal(sideEvents[0]!.total, NAMESPACES.length);
    }
    // First run computes everything; every FILE-BEARING namespace reports
    // one computed row ("shared" is legitimately empty: 0/0).
    const peerByNamespace = new Map(
      events.filter((event) => event.side === "peer").map((event) => [event.namespace, event]),
    );
    for (const namespace of ["alpha", "beta", "default"]) {
      assert.equal(peerByNamespace.get(namespace)?.computed, 1, `${namespace} computed`);
      assert.equal(peerByNamespace.get(namespace)?.reused, 0);
    }
    assert.equal(peerByNamespace.get("shared")?.computed, 0);
    assert.equal(peerByNamespace.get("shared")?.reused, 0);
  } finally {
    await fs.rm(memoryDir, { recursive: true, force: true });
  }
});

test("converge plan: the cross-process lock rejects a concurrent live writer and steals a stale one (#2803)", async () => {
  const memoryDir = await fs.mkdtemp(path.join(os.tmpdir(), "remnic-converge-lock-"));
  const corpus = convergedCorpus();
  await writeLocalCorpus(memoryDir, corpus);
  // A REAL foreign process holds the lock: spawn one and wait for it to exist.
  const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 120000)"], { stdio: "ignore" });
  await new Promise<void>((resolve) => child.once("spawn", () => resolve()));
  const lockPath = path.join(convergePlanCacheRoot(memoryDir), "lock.json");
  try {
    await fs.mkdir(path.dirname(lockPath), { recursive: true });
    const payload = `${JSON.stringify({ pid: child.pid, savedAt: new Date().toISOString() })}\n`;
    await fs.writeFile(lockPath, payload);
    await assert.rejects(convergedPlan(memoryDir, createPeerMock(corpus)), /already running/);

    // Kill the holder: the same lock file becomes stale and must be stolen.
    child.kill();
    await new Promise<void>((resolve) => child.once("exit", () => resolve()));
    const plan = await convergedPlan(memoryDir, createPeerMock(corpus));
    assert.equal(plan.converged, true);
  } finally {
    child.kill();
    await fs.rm(memoryDir, { recursive: true, force: true });
  }
});

test("converge plan: cache entries never contain the peer token or file bodies (#2803)", async () => {
  const memoryDir = await fs.mkdtemp(path.join(os.tmpdir(), "remnic-converge-privacy-"));
  try {
    const corpus = convergedCorpus();
    const secretBody = "uniquely identifiable body content zqxjv";
    corpus.set("alpha", [fixtureFile("alpha", secretBody)]);
    await writeLocalCorpus(memoryDir, corpus);
    await convergedPlan(memoryDir, createPeerMock(corpus));

    const root = convergePlanCacheRoot(memoryDir);
    const entries: string[] = [];
    const stack = [root];
    while (stack.length > 0) {
      const dir = stack.pop()!;
      for (const name of await fs.readdir(dir)) {
        const entryPath = path.join(dir, name);
        const stat = await fs.stat(entryPath);
        if (stat.isDirectory()) stack.push(entryPath);
        else entries.push(entryPath);
      }
    }
    assert.ok(entries.length > 0, "cache must have been written");
    for (const entryPath of entries) {
      const content = await fs.readFile(entryPath, "utf8");
      assert.equal(content.includes(PEER_TOKEN), false, `token leaked into ${path.basename(entryPath)}`);
      assert.equal(content.includes(secretBody), false, `file body leaked into ${path.basename(entryPath)}`);
    }
  } finally {
    await fs.rm(memoryDir, { recursive: true, force: true });
  }
});

test("converge plan: an unopenable plan-cache root degrades to an uncached plan instead of failing (#2803)", async () => {
  const memoryDir = await fs.mkdtemp(path.join(os.tmpdir(), "remnic-converge-rocache-"));
  try {
    const corpus = convergedCorpus();
    await writeLocalCorpus(memoryDir, corpus);
    // Plant a FILE where the cache root directory must live: open() cannot
    // mkdir through it (ENOTDIR) — the read-only/broken audit deployment.
    const cacheRoot = convergePlanCacheRoot(memoryDir);
    await fs.mkdir(path.dirname(cacheRoot), { recursive: true });
    await fs.writeFile(cacheRoot, "not-a-directory");
    const mock = createPeerMock(corpus);
    const plan = await convergedPlan(memoryDir, mock);
    assert.equal(plan.converged, true);
    // No cache ⇒ no resume: every namespace computes its manifest live.
    assert.deepEqual(mock.manifestStreamNamespaces, NAMESPACES);
  } finally {
    await fs.rm(memoryDir, { recursive: true, force: true });
  }
});

test("converge plan: peer cache entries are keyed by the peer's advertised manifest revision (#2803)", async () => {
  const memoryDir = await fs.mkdtemp(path.join(os.tmpdir(), "remnic-converge-peerrev-"));
  try {
    const corpus = convergedCorpus();
    await writeLocalCorpus(memoryDir, corpus);

    // Warm the cache against a versioned peer.
    await convergedPlan(memoryDir, createPeerMock(corpus, "rev-1"));
    // Same advertised revision: entries are trusted, nothing refetches.
    const same = createPeerMock(corpus, "rev-1");
    await convergedPlan(memoryDir, same);
    assert.deepEqual(same.manifestStreamNamespaces, []);

    // The peer upgrades its manifest implementation without rewriting
    // stored files: identical watermark, different semantics. Every peer
    // entry is untrusted and must be rebuilt from the wire.
    const upgraded = createPeerMock(corpus, "rev-2");
    const plan = await convergedPlan(memoryDir, upgraded);
    assert.equal(plan.converged, true);
    assert.deepEqual(upgraded.manifestStreamNamespaces, NAMESPACES);

    // An unversioned peer never gets streamed-manifest reuse, no matter
    // what ran against this memory dir before it.
    const unversioned = createPeerMock(corpus, undefined);
    await convergedPlan(memoryDir, unversioned);
    assert.deepEqual(unversioned.manifestStreamNamespaces, NAMESPACES);
  } finally {
    await fs.rm(memoryDir, { recursive: true, force: true });
  }
});

test("converge plan: client-built peer rows stay a SHA-keyed warm base for unversioned peers (#2803)", async () => {
  const memoryDir = await fs.mkdtemp(path.join(os.tmpdir(), "remnic-converge-client-built-"));
  try {
    const local = convergedCorpus();
    const peer = new Map<string, FixtureFile[]>();
    for (const [namespace, files] of local) {
      peer.set(
        namespace,
        files.map((file) => ({ ...file, content: memoryFileBody(`peer ${namespace}`) }))
      );
    }
    await writeLocalCorpus(memoryDir, local);
    const first = createPeerMock(peer, undefined);
    first.manifestStream = false;
    await convergedPlan(memoryDir, first);
    assert.deepEqual(first.manifestStreamNamespaces, []);
    assert.ok(first.contentPaths.length >= 3, `expected per-file fetches, got ${first.contentPaths.length}`);

    const retry = createPeerMock(peer, undefined);
    retry.manifestStream = false;
    await convergedPlan(memoryDir, retry);
    assert.deepEqual(retry.manifestStreamNamespaces, []);
    assert.equal(retry.contentPaths.length, 0);
  } finally {
    await fs.rm(memoryDir, { recursive: true, force: true });
  }
});

test("converge plan: streamed remanifest clears client-built provenance so a later revision bump cannot reuse stale identities (#2803)", async () => {
  const memoryDir = await fs.mkdtemp(path.join(os.tmpdir(), "remnic-converge-stream-clear-"));
  try {
    const local = convergedCorpus();
    const peer = new Map<string, FixtureFile[]>();
    for (const [namespace, files] of local) {
      peer.set(
        namespace,
        files.map((file) => ({ ...file, content: memoryFileBody(`peer ${namespace}`) }))
      );
    }
    await writeLocalCorpus(memoryDir, local);

    const fallback = createPeerMock(peer, undefined);
    fallback.manifestStream = false;
    await convergedPlan(memoryDir, fallback);
    assert.ok(fallback.contentPaths.length >= 3, `expected per-file fetches, got ${fallback.contentPaths.length}`);

    for (const [namespace, files] of peer) {
      peer.set(
        namespace,
        files.map((file) => ({ ...file, content: memoryFileBody(`streamed ${namespace}`) }))
      );
    }

    const remanifested = ["alpha", "beta", "default"];
    const streamed = createPeerMock(peer, "rev-1");
    await convergedPlan(memoryDir, streamed);
    assert.deepEqual(streamed.manifestStreamNamespaces, remanifested);

    const sameRevision = createPeerMock(peer, "rev-1");
    await convergedPlan(memoryDir, sameRevision);
    assert.deepEqual(sameRevision.manifestStreamNamespaces, []);

    const upgraded = createPeerMock(peer, "rev-2");
    await convergedPlan(memoryDir, upgraded);
    assert.deepEqual(
      upgraded.manifestStreamNamespaces,
      remanifested,
      "streamed rows must not keep clientBuilt or a revision bump reuses the old peer identities"
    );
  } finally {
    await fs.rm(memoryDir, { recursive: true, force: true });
  }
});

const HEX16 = (value: number): string => value.toString(16).padStart(16, "0");

test("converge plan: a symlinked plan-cache root is rejected and never pruned (#2803)", async () => {
  if (process.platform === "win32") return;
  const memoryDir = await fs.mkdtemp(path.join(os.tmpdir(), "remnic-converge-symlink-root-"));
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), "remnic-converge-symlink-out-"));
  try {
    const canary = path.join(outside, "keep-me.json");
    await fs.writeFile(canary, '{"keep":true}\n');
    const root = convergePlanCacheRoot(memoryDir);
    await fs.mkdir(path.dirname(root), { recursive: true });
    await fs.symlink(outside, root);
    await assert.rejects(ConvergePlanCache.open(memoryDir, HEX16(1)), /symlink/);
    assert.deepEqual(await fs.readdir(outside), ["keep-me.json"]);
    assert.equal(await fs.readFile(canary, "utf8"), '{"keep":true}\n');

    const corpus = convergedCorpus();
    await writeLocalCorpus(memoryDir, corpus);
    const plan = await convergedPlan(memoryDir, createPeerMock(corpus));
    assert.equal(plan.converged, true);
    assert.equal(await fs.readFile(canary, "utf8"), '{"keep":true}\n');
  } finally {
    await fs.rm(memoryDir, { recursive: true, force: true });
    await fs.rm(outside, { recursive: true, force: true });
  }
});

test("converge plan: a symlinked active scope is rejected and never pruned (#2803)", async () => {
  if (process.platform === "win32") return;
  const memoryDir = await fs.mkdtemp(path.join(os.tmpdir(), "remnic-converge-symlink-scope-"));
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), "remnic-converge-symlink-scope-out-"));
  try {
    const canary = path.join(outside, "keep-me.json");
    await fs.writeFile(canary, '{"keep":true}\n');
    const scope = HEX16(2);
    const root = convergePlanCacheRoot(memoryDir);
    await fs.mkdir(root, { recursive: true });
    await fs.symlink(outside, path.join(root, scope));
    await assert.rejects(ConvergePlanCache.open(memoryDir, scope), /symlink/);
    assert.equal(await fs.readFile(canary, "utf8"), '{"keep":true}\n');
  } finally {
    await fs.rm(memoryDir, { recursive: true, force: true });
    await fs.rm(outside, { recursive: true, force: true });
  }
});

test("converge plan: a lock with this PID but a different start identity is stolen (#2803)", async () => {
  const memoryDir = await fs.mkdtemp(path.join(os.tmpdir(), "remnic-converge-pid-reuse-"));
  try {
    const root = convergePlanCacheRoot(memoryDir);
    await fs.mkdir(root, { recursive: true });
    await fs.writeFile(
      path.join(root, "lock.json"),
      `${JSON.stringify({ pid: process.pid, startTicks: -1, savedAt: new Date().toISOString() })}\n`
    );
    const cache = await ConvergePlanCache.open(memoryDir, HEX16(3));
    try {
      const held = JSON.parse(await fs.readFile(path.join(root, "lock.json"), "utf8")) as {
        pid?: unknown;
        startTicks?: unknown;
      };
      assert.equal(held.pid, process.pid);
      assert.notEqual(held.startTicks, -1);
    } finally {
      await cache.close();
    }
  } finally {
    await fs.rm(memoryDir, { recursive: true, force: true });
  }
});

test("converge plan: warm peer reuse requires the snapshot to request the manifest's transcript set (#2927)", async () => {
  const memoryDir = await fs.mkdtemp(path.join(os.tmpdir(), "remnic-converge-transcripts-"));
  try {
    // The local replica and the converged set are transcript-free; the peer
    // ALSO holds a transcript file that only transcript-inclusive snapshots
    // expose. A correct client never sees it.
    const corpus = convergedCorpus();
    await writeLocalCorpus(memoryDir, corpus);
    const peerCorpus = new Map(corpus);
    peerCorpus.set("alpha", [
      ...(corpus.get("alpha") ?? []),
      { path: "transcripts/2026-08-01/alpha-day.md", content: "transcript body never converged" },
    ]);

    const snapshotUrls: string[] = [];
    const recordingMock = () => {
      const delegate = createPeerMock(peerCorpus);
      return {
        ...delegate,
        fetchImpl: (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
          if (new URL(String(input)).pathname.endsWith("/offline-sync/snapshot")) {
            snapshotUrls.push(String(input));
          }
          return delegate.fetchImpl(input, init);
        }) as typeof fetch,
      };
    };

    const cold = recordingMock();
    const coldPlan = await convergedPlan(memoryDir, cold);
    assert.equal(coldPlan.converged, true, JSON.stringify(coldPlan.byNamespace));
    assert.deepEqual(cold.manifestStreamNamespaces, ["alpha", "beta", "default", "shared"]);
    assert.ok(snapshotUrls.length > 0, "cold run must fetch snapshots");

    // Warm run: identical peer set ⇒ every namespace must hit the cache and
    // skip the manifest stream. This is the exact condition that stayed
    // false when the snapshot included transcripts the manifest excludes.
    const warm = recordingMock();
    const warmPlan = await convergedPlan(memoryDir, warm);
    assert.equal(warmPlan.converged, true, JSON.stringify(warmPlan.byNamespace));
    assert.deepEqual(warm.manifestStreamNamespaces, [], "warm run must reuse the cached peer manifests");

    // Every snapshot request must pin the manifest's transcript set.
    for (const url of snapshotUrls) {
      assert.equal(new URL(url).searchParams.get("include_transcripts"), "false", url);
    }
  } finally {
    await fs.rm(memoryDir, { recursive: true, force: true });
  }
});

test("converge plan: a live lock with matching start identity still rejects a second opener (#2803)", async () => {
  const memoryDir = await fs.mkdtemp(path.join(os.tmpdir(), "remnic-converge-live-lock-"));
  try {
    const first = await ConvergePlanCache.open(memoryDir, HEX16(4));
    try {
      await assert.rejects(ConvergePlanCache.open(memoryDir, HEX16(5)), (error: unknown) => {
        assert.ok(error instanceof ConvergePlanCacheBusyError);
        return true;
      });
    } finally {
      await first.close();
    }
  } finally {
    await fs.rm(memoryDir, { recursive: true, force: true });
  }
});

test("converge plan: a lock without start ticks is stolen after the lease (#2803)", async () => {
  const memoryDir = await fs.mkdtemp(path.join(os.tmpdir(), "remnic-converge-lock-lease-"));
  try {
    const root = convergePlanCacheRoot(memoryDir);
    await fs.mkdir(root, { recursive: true });
    await fs.writeFile(
      path.join(root, "lock.json"),
      `${JSON.stringify({ pid: process.pid, savedAt: new Date(0).toISOString() })}\n`
    );
    const cache = await ConvergePlanCache.open(memoryDir, HEX16(6));
    try {
      const held = JSON.parse(await fs.readFile(path.join(root, "lock.json"), "utf8")) as {
        pid?: unknown;
        savedAt?: unknown;
      };
      assert.equal(held.pid, process.pid);
      assert.notEqual(held.savedAt, new Date(0).toISOString());
    } finally {
      await cache.close();
    }
  } finally {
    await fs.rm(memoryDir, { recursive: true, force: true });
  }
});

test("converge plan: a recent lock without start ticks still rejects a second opener (#2803)", async () => {
  const memoryDir = await fs.mkdtemp(path.join(os.tmpdir(), "remnic-converge-lock-nolease-"));
  try {
    const root = convergePlanCacheRoot(memoryDir);
    await fs.mkdir(root, { recursive: true });
    await fs.writeFile(
      path.join(root, "lock.json"),
      `${JSON.stringify({ pid: process.pid, savedAt: new Date().toISOString() })}\n`
    );
    await assert.rejects(ConvergePlanCache.open(memoryDir, HEX16(7)), (error: unknown) => {
      assert.ok(error instanceof ConvergePlanCacheBusyError);
      return true;
    });
  } finally {
    await fs.rm(memoryDir, { recursive: true, force: true });
  }
});

test("converge plan: negative manifest rows keep their version stamps across warm cycles (#2927)", async () => {
  const memoryDir = await fs.mkdtemp(path.join(os.tmpdir(), "remnic-converge-negstamps-"));
  const noIdFile = (name: string): FixtureFile => ({
    path: `facts/2026-08-01/${name}.md`,
    // Memory-shaped but WITHOUT an id: parses as a negative row whose "no
    // identity" verdict is only cacheable while its stamps survive.
    content: ["---", "category: fact", "---", `body for ${name} without an id`].join("\n"),
  });
  const corpus = new Map<string, FixtureFile[]>(NAMESPACES.map((namespace) => [namespace, []]));
  corpus.set("default", [noIdFile("default-noid")]);
  try {
    await writeLocalCorpus(memoryDir, corpus);
    // No streaming route: the fallback manifest build is where cached
    // negative rows pay off, fetched one memory file at a time.
    const cold = createPeerMock(corpus, "rev-1", false);
    const coldPlan = await convergedPlan(memoryDir, cold);
    assert.equal(coldPlan.converged, true, JSON.stringify(coldPlan.byNamespace));
    const addFile = async (slug: string): Promise<string> => {
      const file: FixtureFile = { path: `facts/2026-08-01/${slug}.md`, content: memoryFileBody(`body for ${slug}`) };
      corpus.get("default")!.push(file);
      const localPath = path.join(memoryDir, "namespaces", "default", file.path);
      await fs.mkdir(path.dirname(localPath), { recursive: true });
      await fs.writeFile(localPath, file.content);
      return file.path;
    };

    // A new positive file changes the watermark, forcing a manifest-level
    // rebuild through the cached rows. The UNCHANGED negative row must be
    // reused from the peer cache instead of being reread — the exact
    // regression dropped top-level stamps caused.
    const secondPath = await addFile("second fact with an id");
    const warm = createPeerMock(corpus, "rev-1", false);
    await convergedPlan(memoryDir, warm);
    assert.deepEqual(
      warm.fileContentPaths,
      [secondPath],
      "unchanged negative row must not be reread on a warm cycle"
    );

    // An upgrade reclassifies: stale stamps on the cached negative row force
    // a reread of a byte-identical file (the new file is fetched too; the
    // current-stamped positive row stays reused).
    await mutateCachedPeerRow(memoryDir, "default", (row) => {
      row.normalizerVersion = 999;
      row.identityResolutionVersion = 999;
    });
    const thirdPath = await addFile("third fact with an id");
    const upgraded = createPeerMock(corpus, "rev-1", false);
    await convergedPlan(memoryDir, upgraded);
    assert.deepEqual(upgraded.fileContentPaths, ["facts/2026-08-01/default-noid.md", thirdPath]);

    // A stampless (pre-upgrade) negative row is never reused either.
    await mutateCachedPeerRow(memoryDir, "default", (row) => {
      delete row.normalizerVersion;
      delete row.identityResolutionVersion;
    });
    const fourthPath = await addFile("fourth fact with an id");
    const stampless = createPeerMock(corpus, "rev-1", false);
    await convergedPlan(memoryDir, stampless);
    assert.deepEqual(stampless.fileContentPaths, ["facts/2026-08-01/default-noid.md", fourthPath]);
  } finally {
    await fs.rm(memoryDir, { recursive: true, force: true });
  }
});

test("converge plan: case-differing namespaces keep distinct cache entries (#2803)", async () => {
  const memoryDir = await fs.mkdtemp(path.join(os.tmpdir(), "remnic-converge-ns-case-"));
  try {
    const cache = await ConvergePlanCache.open(memoryDir, HEX16(8));
    try {
      const sha = "a".repeat(64);
      const watermark = "b".repeat(64);
      const base = {
        version: 1 as const,
        scope: cache.scope,
        side: "local" as const,
        watermark,
        fileCount: 1,
        capturedAtMs: 1,
        savedAt: new Date().toISOString(),
        files: [{ path: "facts/a.md", sha256: sha }],
      };
      await cache.writeEntry({ ...base, namespace: "Alpha" });
      await cache.writeEntry({ ...base, namespace: "alpha" });
      const upper = await cache.readEntry("local", "Alpha");
      const lower = await cache.readEntry("local", "alpha");
      assert.equal(upper?.namespace, "Alpha");
      assert.equal(lower?.namespace, "alpha");
    } finally {
      await cache.close();
    }
  } finally {
    await fs.rm(memoryDir, { recursive: true, force: true });
  }
});

test("converge plan: sibling overflow counts only fresh scopes (#2803)", async () => {
  const memoryDir = await fs.mkdtemp(path.join(os.tmpdir(), "remnic-converge-overflow-"));
  try {
    const root = convergePlanCacheRoot(memoryDir);
    const staleAt = new Date(Date.now() - CONVERGE_PLAN_CACHE_MAX_AGE_MS - 60_000);
    const freshNames: string[] = [];
    for (let index = 0; index < 8; index += 1) {
      const name = HEX16(index);
      const dir = path.join(root, name);
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(path.join(dir, "marker.json"), "{}\n");
      await fs.utimes(dir, staleAt, staleAt);
    }
    for (let index = 8; index < 15; index += 1) {
      const name = HEX16(index);
      const dir = path.join(root, name);
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(path.join(dir, "marker.json"), "{}\n");
      freshNames.push(name);
    }
    const active = "f".repeat(16);
    const cache = await ConvergePlanCache.open(memoryDir, active);
    await cache.close();
    const remaining = (await fs.readdir(root))
      .filter((name) => /^[0-9a-f]{16}$/.test(name))
      .sort();
    assert.deepEqual(remaining, [...freshNames, active].sort());
  } finally {
    await fs.rm(memoryDir, { recursive: true, force: true });
  }
});
async function mutateCachedPeerRow(
  memoryDir: string,
  namespace: string,
  mutate: (row: Record<string, unknown>) => void
): Promise<void> {
  const root = convergePlanCacheRoot(memoryDir);
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    for (const name of await fs.readdir(dir)) {
      const entryPath = path.join(dir, name);
      if ((await fs.stat(entryPath)).isDirectory()) {
        stack.push(entryPath);
        continue;
      }
      if (!name.startsWith("peer-")) continue;
      const entry = JSON.parse(await fs.readFile(entryPath, "utf8")) as {
        namespace?: string;
        files?: Array<Record<string, unknown>>;
      };
      if (entry.namespace !== namespace) continue;
      for (const row of entry.files ?? []) {
        if (row.memory === undefined && typeof row.path === "string" && row.path.includes("noid")) mutate(row);
      }
      await fs.writeFile(entryPath, JSON.stringify(entry));
    }
  }
}
