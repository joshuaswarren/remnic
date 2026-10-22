import * as assert from "node:assert/strict";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { MessageChannel } from "node:worker_threads";
import { parseConfig } from "@remnic/core";
import { defaultConvergeCursorPath, readConvergeCursor, writeConvergeCursor } from "@remnic/core/reconcile/cursor.js";
import type { ReconcileFileState } from "@remnic/core/reconcile/plan.js";
import {
  isPeerTransportCensusFailure,
  recordNamespaceCensusFailure,
  throwIfEveryNamespaceCensusFailed,
} from "./converge-namespace-exclusions.js";
import { formatConvergeExclusionLine, formatConvergeReport, formatConvergeWatchCycleLine } from "./converge-report.js";
import { convergeWatch } from "./converge-watch.js";
import { computeConvergePlan, executeConvergeApply } from "./converge.js";

const sha = (text: string): string => createHash("sha256").update(text).digest("hex");

/** Plan-cache locks are per memory dir. Parallel tests must not share the default dir. */
async function withPlanCursor<T>(run: (cursorDir: string) => Promise<T>): Promise<T> {
  const cursorDir = await fs.mkdtemp(path.join(os.tmpdir(), "remnic-converge-isolate-"));
  try {
    return await run(cursorDir);
  } finally {
    await fs.rm(cursorDir, { recursive: true, force: true });
  }
}

test("converge watch: a partial cycle counts as progress and keeps the exclusion", async () => {
  const outcome = await convergeWatch({
    intervalMs: 1,
    maxCycles: 1,
    apply: async () => ({
      converged: false,
      status: "partial",
      plan: { converged: true, byNamespace: [], entries: [], excludedNamespaces: [] },
      transfers: { pulled: 0, pushed: 0, conflictsResolved: 0, suppressed: 0, failed: 0 },
      cursorUpdated: true,
      excludedNamespaces: [{ namespace: "blocked", side: "peer", error: "HTTP 400 namespace is not readable" }],
    }),
  });
  assert.equal(outcome.failedCycles, 0);
  assert.equal(outcome.appliedCycles, 1);
  assert.equal(outcome.convergedCycles, 0);
  assert.equal(outcome.lastStatus, "partial");
  assert.equal(outcome.lastExcludedNamespaces[0]?.namespace, "blocked");
  assert.equal(
    formatConvergeWatchCycleLine(1, {
      converged: false,
      status: "partial",
      plan: { converged: true, byNamespace: [], entries: [] },
      transfers: { pulled: 0, pushed: 1, conflictsResolved: 0, suppressed: 0, failed: 0 },
      excludedNamespaces: outcome.lastExcludedNamespaces,
    }),
    "converge watch: cycle 1 status=partial pulled=0 pushed=1 conflicts=0 failed=0 excluded=1"
  );
  const exclusion = outcome.lastExcludedNamespaces[0];
  assert.ok(exclusion);
  assert.match(
    formatConvergeExclusionLine(1, exclusion),
    /cycle 1 excluded namespace=blocked side=peer: HTTP 400 namespace is not readable/
  );
  const forged = formatConvergeExclusionLine(1, {
    namespace: "blocked",
    side: "peer",
    error: "namespace is not readable: \u001b[31mblocked\u0007",
  });
  assert.equal(forged.includes("\u001b"), false);
  assert.equal(forged.includes("\u0007"), false);
  assert.match(forged, /namespace is not readable: \[31mblocked/);
});

test("converge plan: one peer snapshot refusal is excluded and the other namespace still plans a push", async () => {
  const healthyBody = Buffer.from("healthy local fact");
  const blockedBody = Buffer.from("blocked local fact");
  const healthySha = sha("healthy local fact");
  const blockedSha = sha("blocked local fact");
  const healthy: ReconcileFileState = {
    path: "facts/healthy.md",
    sha256: healthySha,
    bytes: healthyBody.length,
    mtimeMs: 1000,
  };
  const blocked: ReconcileFileState = {
    path: "facts/blocked.md",
    sha256: blockedSha,
    bytes: blockedBody.length,
    mtimeMs: 1000,
  };
  const requested: string[] = [];
  const plan = await withPlanCursor((cursorDir) =>
    computeConvergePlan({
      cursorDir,
      peerUrl: "https://peer.example.test",
      localFilesByNamespace: new Map([
        ["healthy", [healthy]],
        ["blocked", [blocked]],
      ]),
      baseFilesByNamespace: new Map([["blocked", [blocked]]]),
      fetchImpl: async (input) => {
        const url = new URL(String(input));
        if (url.pathname.endsWith("/offline-sync/capabilities")) return new Response(null, { status: 404 });
        if (!url.pathname.endsWith("/offline-sync/snapshot")) return new Response(null, { status: 404 });
        const namespace = url.searchParams.get("namespace") ?? "";
        requested.push(namespace);
        if (namespace === "blocked") {
          return Response.json({ error: "namespace is not readable: blocked", code: "input_error" }, { status: 400 });
        }
        return Response.json({ files: [], tombstones: [] });
      },
    })
  );

  // Both snapshot routes are tried before the namespace is excluded.
  assert.ok(requested.includes("healthy"));
  assert.ok(requested.includes("blocked"));
  assert.equal(
    plan.entries.some((entry) => entry.namespace === "blocked"),
    false
  );
  const healthyPush = plan.entries.find((entry) => entry.namespace === "healthy" && entry.path === "facts/healthy.md");
  assert.equal(healthyPush?.action, "push");
  assert.equal(healthyPush?.reason, "local_only");
  assert.equal(plan.excludedNamespaces?.length, 1);
  assert.equal(plan.excludedNamespaces?.[0]?.namespace, "blocked");
  assert.equal(plan.excludedNamespaces?.[0]?.side, "peer");
  assert.match(plan.excludedNamespaces?.[0]?.error ?? "", /HTTP 400/);
  assert.match(plan.excludedNamespaces?.[0]?.error ?? "", /namespace is not readable: blocked/);
  const report = formatConvergeReport(plan);
  assert.equal(plan.converged, false);
  assert.match(report, /Convergence Status: PARTIAL/);
  assert.match(report, /Excluded namespaces/);
  assert.match(report, /\[blocked\] side=peer/);
});

test("converge apply: a refused namespace gets no push and no delete while the other namespace replicates", async () => {
  const healthyBody = Buffer.from("healthy local fact");
  const blockedBody = Buffer.from("blocked local fact");
  const healthySha = sha("healthy local fact");
  const blockedSha = sha("blocked local fact");
  const peerUrl = "https://peer.example.test";
  const cursorDir = await fs.mkdtemp(path.join(os.tmpdir(), "remnic-converge-exclude-"));
  const priorCursor = {
    version: 1 as const,
    peerUrl,
    namespace: "blocked",
    lastConvergedAt: "2020-01-01T00:00:00.000Z",
    baseFiles: [{ path: "facts/blocked.md", sha256: blockedSha }],
  };
  const mutations: string[] = [];
  try {
    await writeConvergeCursor(defaultConvergeCursorPath(cursorDir, peerUrl, "blocked"), priorCursor);
    const result = await executeConvergeApply({
      peerUrl,
      cursorDir,
      localFilesByNamespace: new Map([
        ["healthy", [{ path: "facts/healthy.md", sha256: healthySha, bytes: healthyBody.length, mtimeMs: 1000 }]],
        ["blocked", [{ path: "facts/blocked.md", sha256: blockedSha, bytes: blockedBody.length, mtimeMs: 1000 }]],
      ]),
      baseFilesByNamespace: new Map([["blocked", [{ path: "facts/blocked.md", sha256: blockedSha }]]]),
      localFileBuffers: new Map([["healthy", new Map([["facts/healthy.md", healthyBody]])]]),
      fetchImpl: async (input) => {
        const url = new URL(String(input));
        const namespace = url.searchParams.get("namespace") ?? "";
        if (url.pathname.endsWith("/offline-sync/capabilities")) return new Response(null, { status: 404 });
        if (url.pathname.endsWith("/offline-sync/snapshot")) {
          if (namespace === "blocked") {
            return Response.json({ error: "namespace is not readable: blocked" }, { status: 400 });
          }
          return Response.json({ files: [], tombstones: [] });
        }
        if (namespace === "blocked") {
          mutations.push(url.pathname);
          return new Response(null, { status: 500 });
        }
        if (url.pathname.endsWith("/offline-sync/convergence-complete")) {
          return Response.json({ namespaces: ["healthy"], refreshed: true });
        }
        return Response.json({ done: true, applied: true, skipped: false });
      },
    });

    assert.deepEqual(mutations, []);
    assert.equal(result.status, "partial");
    assert.equal(result.converged, false);
    assert.equal(result.transfers.pushed, 1);
    assert.equal(result.transfers.failed, 0);
    assert.equal(
      result.plan.entries.some((entry) => entry.namespace === "blocked"),
      false
    );
    assert.equal(result.excludedNamespaces?.[0]?.namespace, "blocked");
    assert.equal(result.excludedNamespaces?.[0]?.side, "peer");
    const blockedCursor = await readConvergeCursor(defaultConvergeCursorPath(cursorDir, peerUrl, "blocked"));
    assert.equal(blockedCursor?.lastConvergedAt, "2020-01-01T00:00:00.000Z");
    const healthyCursor = await readConvergeCursor(defaultConvergeCursorPath(cursorDir, peerUrl, "healthy"));
    assert.ok(healthyCursor, "the namespace that converged must update its cursor");
    assert.notEqual(healthyCursor?.lastConvergedAt, "2020-01-01T00:00:00.000Z");
  } finally {
    await fs.rm(cursorDir, { recursive: true, force: true });
  }
});

test("converge plan: every namespace snapshot failing still rejects the cycle", async () => {
  await withPlanCursor((cursorDir) =>
    assert.rejects(
      computeConvergePlan({
        cursorDir,
        peerUrl: "https://peer.example.test",
        localFilesByNamespace: new Map<string, ReconcileFileState[]>([
          ["alpha", []],
          ["beta", []],
        ]),
        fetchImpl: async (input) => {
          const url = new URL(String(input));
          if (url.pathname.endsWith("/offline-sync/capabilities")) return new Response(null, { status: 404 });
          return Response.json({ error: "namespace is not readable" }, { status: 400 });
        },
      }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /every namespace census failed/);
        assert.match(error.message, /alpha \(peer\)/);
        assert.match(error.message, /beta \(peer\)/);
        return true;
      }
    )
  );
});

test("converge plan: a peer transport timeout fails the cycle instead of waiting out every namespace", async () => {
  const requested: string[] = [];
  const keepAlive = new MessageChannel();
  keepAlive.port1.ref();
  keepAlive.port2.ref();
  const fetchImpl: typeof fetch = (input, init) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith("/offline-sync/capabilities")) {
      return Promise.resolve(new Response(null, { status: 404 }));
    }
    const namespace = url.searchParams.get("namespace") ?? "";
    requested.push(namespace);
    if (namespace !== "alpha") {
      return Promise.resolve(Response.json({ files: [], tombstones: [] }));
    }
    return new Promise((_resolve, reject) => {
      const signal = init?.signal;
      if (!signal) {
        reject(new Error("missing signal"));
        return;
      }
      const fail = () => reject(signal.reason);
      if (signal.aborted) {
        fail();
        return;
      }
      signal.addEventListener("abort", fail, { once: true });
    });
  };
  try {
    await withPlanCursor((cursorDir) =>
      assert.rejects(
        computeConvergePlan({
          cursorDir,
          peerUrl: "https://peer.example.test",
          peerRequestTimeoutMs: 30,
          localFilesByNamespace: new Map<string, ReconcileFileState[]>([
            ["alpha", []],
            ["beta", []],
          ]),
          fetchImpl,
        }),
        /timeout|aborted/i
      )
    );
    assert.ok(requested.includes("alpha"));
    assert.equal(requested.includes("beta"), false);
  } finally {
    keepAlive.port1.close();
    keepAlive.port2.close();
  }
});

test("converge plan: a snapshot timeout is not erased by the fallback route's HTTP 404", async () => {
  const requested: string[] = [];
  const keepAlive = new MessageChannel();
  keepAlive.port1.ref();
  keepAlive.port2.ref();
  const fetchImpl: typeof fetch = (input, init) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith("/offline-sync/capabilities")) {
      return Promise.resolve(new Response(null, { status: 404 }));
    }
    const namespace = url.searchParams.get("namespace") ?? "";
    requested.push(namespace);
    if (namespace !== "alpha") return Promise.resolve(Response.json({ files: [], tombstones: [] }));
    if (url.pathname.includes("/engram/")) return Promise.resolve(new Response(null, { status: 404 }));
    return new Promise((_resolve, reject) => {
      const signal = init?.signal;
      if (!signal) {
        reject(new Error("missing signal"));
        return;
      }
      const fail = () => reject(signal.reason);
      if (signal.aborted) {
        fail();
        return;
      }
      signal.addEventListener("abort", fail, { once: true });
    });
  };
  try {
    await withPlanCursor((cursorDir) =>
      assert.rejects(
        computeConvergePlan({
          cursorDir,
          peerUrl: "https://peer.example.test",
          peerRequestTimeoutMs: 30,
          localFilesByNamespace: new Map<string, ReconcileFileState[]>([
            ["alpha", []],
            ["beta", []],
          ]),
          fetchImpl,
        }),
        (error: unknown) => {
          assert.ok(error instanceof Error);
          assert.match(error.message, /timeout|aborted/i);
          assert.equal(error.message.includes("HTTP"), false);
          return true;
        }
      )
    );
    assert.ok(requested.includes("alpha"));
    assert.equal(requested.includes("beta"), false);
  } finally {
    keepAlive.port1.close();
    keepAlive.port2.close();
  }
});

test("converge plan: a snapshot timeout is not erased by a non-JSON fallback", async () => {
  const requested: string[] = [];
  const keepAlive = new MessageChannel();
  keepAlive.port1.ref();
  keepAlive.port2.ref();
  const fetchImpl: typeof fetch = (input, init) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith("/offline-sync/capabilities")) {
      return Promise.resolve(new Response(null, { status: 404 }));
    }
    const namespace = url.searchParams.get("namespace") ?? "";
    requested.push(namespace);
    if (namespace !== "alpha") return Promise.resolve(Response.json({ files: [], tombstones: [] }));
    if (url.pathname.includes("/engram/")) {
      return Promise.resolve(
        new Response("not-json", { status: 200, headers: { "content-type": "application/json" } })
      );
    }
    return new Promise((_resolve, reject) => {
      const signal = init?.signal;
      if (!signal) {
        reject(new Error("missing signal"));
        return;
      }
      const fail = () => reject(signal.reason);
      if (signal.aborted) {
        fail();
        return;
      }
      signal.addEventListener("abort", fail, { once: true });
    });
  };
  try {
    await withPlanCursor((cursorDir) =>
      assert.rejects(
        computeConvergePlan({
          cursorDir,
          peerUrl: "https://peer.example.test",
          peerRequestTimeoutMs: 30,
          localFilesByNamespace: new Map<string, ReconcileFileState[]>([
            ["alpha", []],
            ["beta", []],
          ]),
          fetchImpl,
        }),
        (error: unknown) => {
          assert.ok(error instanceof Error);
          assert.match(error.message, /timeout|aborted/i);
          assert.equal(error.message.includes("not JSON"), false);
          assert.equal(error.message.includes("HTTP"), false);
          return true;
        }
      )
    );
    assert.ok(requested.includes("alpha"));
    assert.equal(requested.includes("beta"), false);
  } finally {
    keepAlive.port1.close();
    keepAlive.port2.close();
  }
});

test("converge plan: a snapshot error-body timeout is not recorded as an HTTP refusal", async () => {
  const requested: string[] = [];
  const fetchImpl: typeof fetch = (input) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith("/offline-sync/capabilities")) {
      return Promise.resolve(new Response(null, { status: 404 }));
    }
    const namespace = url.searchParams.get("namespace") ?? "";
    requested.push(namespace);
    if (namespace !== "alpha") return Promise.resolve(Response.json({ files: [], tombstones: [] }));
    if (url.pathname.includes("/engram/")) return Promise.resolve(new Response(null, { status: 404 }));
    const body = new ReadableStream({
      pull(controller) {
        controller.error(new DOMException("The operation was aborted due to timeout", "TimeoutError"));
      },
    });
    return Promise.resolve(new Response(body, { status: 400 }));
  };
  await withPlanCursor((cursorDir) =>
    assert.rejects(
      computeConvergePlan({
        cursorDir,
        peerUrl: "https://peer.example.test",
        peerRequestTimeoutMs: 30,
        localFilesByNamespace: new Map<string, ReconcileFileState[]>([
          ["alpha", []],
          ["beta", []],
        ]),
        fetchImpl,
      }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /timeout|aborted/i);
        assert.equal(error.message.includes("HTTP"), false);
        return true;
      }
    )
  );
  assert.ok(requested.includes("alpha"));
  assert.equal(requested.includes("beta"), false);
});

test("converge plan: an agreed namespace plus a refusal is not reported as converged", async () => {
  const plan = await withPlanCursor((cursorDir) =>
    computeConvergePlan({
      cursorDir,
      peerUrl: "https://peer.example.test",
      localFilesByNamespace: new Map<string, ReconcileFileState[]>([
        ["healthy", []],
        ["blocked", []],
      ]),
      fetchImpl: async (input) => {
        const url = new URL(String(input));
        if (url.pathname.endsWith("/offline-sync/capabilities")) return new Response(null, { status: 404 });
        const namespace = url.searchParams.get("namespace") ?? "";
        if (namespace === "blocked") {
          return Response.json({ error: "namespace is not readable: blocked" }, { status: 400 });
        }
        return Response.json({ files: [], tombstones: [] });
      },
    })
  );
  assert.equal(plan.converged, false);
  assert.equal(plan.entries.length, 0);
  assert.equal(
    plan.excludedNamespaces?.some((entry) => entry.namespace === "blocked"),
    true
  );
  assert.match(formatConvergeReport(plan), /Convergence Status: PARTIAL/);
});

test("converge plan: a file-content timeout fails the cycle instead of excluding every namespace", async () => {
  const requested: string[] = [];
  const keepAlive = new MessageChannel();
  keepAlive.port1.ref();
  keepAlive.port2.ref();
  const fetchImpl: typeof fetch = (input, init) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith("/offline-sync/capabilities")) {
      return Promise.resolve(new Response(null, { status: 404 }));
    }
    if (url.pathname.endsWith("/offline-sync/snapshot")) {
      const namespace = url.searchParams.get("namespace") ?? "";
      requested.push(`snapshot:${namespace}`);
      return Promise.resolve(
        Response.json({
          files:
            namespace === "alpha" ? [{ path: "facts/alpha.md", sha256: "ab".repeat(32), bytes: 1, mtimeMs: 1 }] : [],
          tombstones: [],
        })
      );
    }
    requested.push(url.pathname);
    return new Promise((_resolve, reject) => {
      const signal = init?.signal;
      if (!signal) {
        reject(new Error("missing signal"));
        return;
      }
      const fail = () => reject(signal.reason);
      if (signal.aborted) {
        fail();
        return;
      }
      signal.addEventListener("abort", fail, { once: true });
    });
  };
  try {
    await withPlanCursor((cursorDir) =>
      assert.rejects(
        computeConvergePlan({
          cursorDir,
          peerUrl: "https://peer.example.test",
          peerRequestTimeoutMs: 30,
          localFilesByNamespace: new Map<string, ReconcileFileState[]>([
            ["alpha", []],
            ["beta", []],
          ]),
          fetchImpl,
        }),
        /timeout|aborted/i
      )
    );
    assert.ok(requested.includes("snapshot:alpha"));
    assert.equal(requested.includes("snapshot:beta"), false);
  } finally {
    keepAlive.port1.close();
    keepAlive.port2.close();
  }
});

test("peer transport failures are not namespace exclusions; HTTP refusals are", () => {
  const timeout = new Error("The operation was aborted due to timeout");
  timeout.name = "TimeoutError";
  assert.equal(isPeerTransportCensusFailure(timeout), true);
  assert.equal(
    isPeerTransportCensusFailure(
      new Error("failed to fetch peer snapshot for namespace alpha: The operation was aborted due to timeout")
    ),
    true
  );
  assert.equal(
    isPeerTransportCensusFailure(new Error("failed to fetch peer snapshot for namespace alpha: fetch failed")),
    true
  );
  assert.equal(
    isPeerTransportCensusFailure(
      new Error("failed to fetch peer snapshot for namespace blocked: HTTP 400 namespace is not readable: blocked")
    ),
    false
  );
  assert.equal(isPeerTransportCensusFailure(new Error("peer manifest request failed: HTTP 500")), false);
  assert.equal(
    isPeerTransportCensusFailure(new Error("failed to read peer reconciliation manifest file: facts/fetch failed.md")),
    false
  );
  assert.equal(
    isPeerTransportCensusFailure(
      new Error("failed to read peer tombstone evidence: state/fetch failed.jsonl", { cause: timeout })
    ),
    true
  );
  const excluded = new Map();
  assert.throws(() => recordNamespaceCensusFailure(excluded, "alpha", "peer", timeout, undefined), /timeout/i);
  assert.equal(excluded.size, 0);
  recordNamespaceCensusFailure(
    excluded,
    "blocked",
    "peer",
    new Error("failed to fetch peer snapshot for namespace blocked: HTTP 400 namespace is not readable"),
    undefined
  );
  assert.equal(excluded.size, 1);
  recordNamespaceCensusFailure(excluded, "local-ns", "local", timeout, undefined);
  assert.equal(excluded.get("local-ns")?.side, "local");
});

test("converge plan: a missed file named fetch failed excludes only that namespace", async () => {
  const sha = "ab".repeat(32);
  const plan = await withPlanCursor((cursorDir) =>
    computeConvergePlan({
      cursorDir,
      peerUrl: "https://peer.example.test",
      localFilesByNamespace: new Map<string, ReconcileFileState[]>([
        ["alpha", []],
        ["beta", []],
      ]),
      fetchImpl: async (input) => {
        const url = new URL(String(input));
        if (url.pathname.endsWith("/offline-sync/capabilities")) return new Response(null, { status: 404 });
        if (url.pathname.endsWith("/offline-sync/file-content")) return new Response(null, { status: 404 });
        const namespace = url.searchParams.get("namespace") ?? "";
        if (namespace === "alpha") {
          return Response.json({ files: [{ path: "facts/fetch failed.md", sha256: sha }], tombstones: [] });
        }
        return Response.json({ files: [], tombstones: [] });
      },
    })
  );
  assert.equal(
    plan.excludedNamespaces?.some((item) => item.namespace === "alpha" && item.side === "peer"),
    true
  );
  assert.equal(
    plan.excludedNamespaces?.some((item) => item.namespace === "beta"),
    false
  );
  assert.equal(plan.converged, false);
});

test("converge plan: abort during one snapshot still rejects the whole plan", async () => {
  const controller = new AbortController();
  await withPlanCursor((cursorDir) =>
    assert.rejects(
      computeConvergePlan({
        cursorDir,
        peerUrl: "https://peer.example.test",
        signal: controller.signal,
        localFilesByNamespace: new Map<string, ReconcileFileState[]>([
          ["alpha", []],
          ["beta", []],
        ]),
        fetchImpl: async (input) => {
          const url = new URL(String(input));
          if (url.pathname.endsWith("/offline-sync/capabilities")) return new Response(null, { status: 404 });
          if (url.searchParams.get("namespace") === "beta") {
            controller.abort();
            const aborted = new Error("The operation was aborted");
            aborted.name = "AbortError";
            throw aborted;
          }
          return Response.json({ files: [], tombstones: [] });
        },
      }),
      (error: unknown) => error instanceof Error && error.name === "AbortError"
    )
  );
});

test("converge plan: a local census failure excludes that namespace on both sides", async () => {
  const memoryDir = await fs.mkdtemp(path.join(os.tmpdir(), "remnic-converge-local-exclude-"));
  const sharedRoot = `ns-${Buffer.from("shared", "utf8").toString("hex")}`;
  const requested: string[] = [];
  try {
    await fs.mkdir(path.join(memoryDir, "namespaces", "alpha", "facts"), { recursive: true });
    await fs.mkdir(path.join(memoryDir, "namespaces", "default", "facts"), { recursive: true });
    await fs.mkdir(path.join(memoryDir, "namespaces", sharedRoot), { recursive: true });
    await fs.writeFile(path.join(memoryDir, "namespaces", "alpha", "facts", "alpha.md"), "alpha fact\n");
    await fs.writeFile(path.join(memoryDir, "namespaces", "default", "facts", "default.md"), "default fact\n");
    // The policy names "blocked", but its storage root is never created, so the
    // local census throws instead of planning an empty corpus.
    const plan = await computeConvergePlan({
      config: parseConfig({
        memoryDir,
        namespacesEnabled: true,
        namespacePolicies: [{ name: "blocked", readPrincipals: [], writePrincipals: [] }],
      }),
      peerUrl: "https://peer.example.test",
      fetchImpl: async (input) => {
        const url = new URL(String(input));
        if (url.pathname.endsWith("/offline-sync/capabilities")) return new Response(null, { status: 404 });
        if (url.pathname.endsWith("/offline-sync/snapshot")) {
          requested.push(url.searchParams.get("namespace") ?? "");
          return Response.json({ files: [], tombstones: [] });
        }
        return new Response(null, { status: 404 });
      },
    });
    assert.equal(requested.includes("blocked"), false);
    assert.equal(
      plan.entries.some((entry) => entry.namespace === "blocked"),
      false
    );
    assert.ok(plan.entries.some((entry) => entry.namespace === "alpha" && entry.action === "push"));
    const exclusion = plan.excludedNamespaces?.find((entry) => entry.namespace === "blocked");
    assert.ok(exclusion);
    assert.equal(exclusion?.side, "local");
    assert.match(exclusion?.error ?? "", /directory/i);
  } finally {
    await fs.rm(memoryDir, { recursive: true, force: true });
  }
});

test("converge plan: a shared-root local census failure excludes every alias", async () => {
  const memoryDir = path.join(os.tmpdir(), `remnic-converge-alias-${Date.now()}-${process.pid}`);
  const requested: string[] = [];
  await assert.rejects(
    computeConvergePlan({
      config: parseConfig({
        memoryDir,
        namespacesEnabled: false,
        defaultNamespace: "default",
        sharedNamespace: "shared",
      }),
      peerUrl: "https://peer.example.test",
      fetchImpl: async (input) => {
        const url = new URL(String(input));
        if (url.pathname.endsWith("/offline-sync/capabilities")) return new Response(null, { status: 404 });
        if (!url.pathname.endsWith("/offline-sync/snapshot")) return new Response(null, { status: 404 });
        requested.push(url.searchParams.get("namespace") ?? "");
        return Response.json({
          files: [{ path: "facts/peer.md", sha256: "ab".repeat(32), bytes: 1, mtimeMs: 1 }],
          tombstones: [],
        });
      },
    }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /every namespace census failed/);
      assert.match(error.message, /default \(local\)/);
      assert.match(error.message, /shared \(local\)/);
      return true;
    }
  );
  assert.equal(requested.includes("shared"), false);
  assert.equal(requested.includes("default"), false);
});

test("converge plan: a peer refusal drops every alias of a shared root", async () => {
  const memoryDir = await fs.mkdtemp(path.join(os.tmpdir(), "remnic-converge-peer-alias-"));
  const requested: string[] = [];
  try {
    await fs.mkdir(path.join(memoryDir, "facts"), { recursive: true });
    await fs.writeFile(path.join(memoryDir, "facts/local.md"), "local fact\n");
    await assert.rejects(
      computeConvergePlan({
        config: parseConfig({
          memoryDir,
          namespacesEnabled: false,
          defaultNamespace: "default",
          sharedNamespace: "shared",
        }),
        peerUrl: "https://peer.example.test",
        fetchImpl: async (input) => {
          const url = new URL(String(input));
          if (url.pathname.endsWith("/offline-sync/capabilities")) return new Response(null, { status: 404 });
          if (!url.pathname.endsWith("/offline-sync/snapshot")) return new Response(null, { status: 404 });
          const namespace = url.searchParams.get("namespace") ?? "";
          requested.push(namespace);
          if (namespace === "default") {
            return Response.json({ error: "namespace is not readable: default" }, { status: 400 });
          }
          return Response.json({
            files: [{ path: "facts/peer.md", sha256: "ab".repeat(32), bytes: 1, mtimeMs: 1 }],
            tombstones: [],
          });
        },
      }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /every namespace census failed/);
        assert.match(error.message, /default \(peer\)/);
        assert.match(error.message, /shared \(peer\)/);
        return true;
      }
    );
    assert.equal(requested.includes("default"), true);
    assert.equal(requested.includes("shared"), false);
  } finally {
    await fs.rm(memoryDir, { recursive: true, force: true });
  }
});

test("converge plan: a later alias refusal drops the shared root that already succeeded", async () => {
  const memoryDir = await fs.mkdtemp(path.join(os.tmpdir(), "remnic-converge-peer-alias-later-"));
  const requested: string[] = [];
  try {
    await fs.mkdir(path.join(memoryDir, "facts"), { recursive: true });
    await fs.writeFile(path.join(memoryDir, "facts/local.md"), "local fact\n");
    await assert.rejects(
      computeConvergePlan({
        config: parseConfig({
          memoryDir,
          namespacesEnabled: false,
          defaultNamespace: "default",
          sharedNamespace: "shared",
        }),
        peerUrl: "https://peer.example.test",
        fetchImpl: async (input) => {
          const url = new URL(String(input));
          if (url.pathname.endsWith("/offline-sync/capabilities")) return new Response(null, { status: 404 });
          if (!url.pathname.endsWith("/offline-sync/snapshot")) return new Response(null, { status: 404 });
          const namespace = url.searchParams.get("namespace") ?? "";
          requested.push(namespace);
          if (namespace === "shared") {
            return Response.json({ error: "namespace is not readable: shared" }, { status: 400 });
          }
          return Response.json({ files: [], tombstones: [] });
        },
      }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /every namespace census failed/);
        assert.match(error.message, /default \(peer\)/);
        assert.match(error.message, /shared \(peer\)/);
        return true;
      }
    );
    assert.equal(requested.includes("default"), true);
    assert.equal(requested.includes("shared"), true);
  } finally {
    await fs.rm(memoryDir, { recursive: true, force: true });
  }
});

test("every-namespace census failure strips terminal controls and keeps the cause", () => {
  const cause = new Error("failed to fetch peer snapshot for namespace alpha: \u001b[31mblocked\u0007");
  const excluded = new Map([["alpha", { namespace: "alpha", side: "peer" as const, error: cause.message, cause }]]);
  assert.throws(
    () => throwIfEveryNamespaceCensusFailed(0, excluded),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(error.message.includes("\u001b"), false);
      assert.equal(error.message.includes("\u0007"), false);
      assert.match(error.message, /failed to fetch peer snapshot for namespace alpha: \[31mblocked/);
      assert.equal(error.cause, cause);
      return true;
    }
  );
});

test("joined census failures strip terminal controls from every namespace", () => {
  const alpha = new Error("namespace is not readable: \u001b[31malpha\u0007");
  const beta = new Error("namespace is not readable: beta");
  const excluded = new Map([
    ["beta", { namespace: "beta", side: "peer" as const, error: beta.message, cause: beta }],
    ["alpha", { namespace: "alpha", side: "peer" as const, error: alpha.message, cause: alpha }],
  ]);
  assert.throws(
    () => throwIfEveryNamespaceCensusFailed(0, excluded),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /every namespace census failed/);
      assert.equal(error.message.includes("\u001b"), false);
      assert.equal(error.message.includes("\u0007"), false);
      assert.match(error.message, /alpha \(peer\): namespace is not readable: \[31malpha/);
      assert.match(error.message, /beta \(peer\): namespace is not readable: beta/);
      return true;
    }
  );
});
