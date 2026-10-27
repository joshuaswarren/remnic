import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse, type Server as HttpServer } from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { z } from "zod";

import { startServer, type ServerResult } from "./index.js";

/**
 * Regression for #3253: the standalone readiness warm-up must search the
 * default namespace's real QMD collection (namespace-aware routing: suffixed
 * collection for a migrated default namespace, legacy flat-root base
 * collection for a flat store) instead of passing the namespace name as a
 * collection. The boot tests exercise the production wiring through
 * startServer, with a recording remote search backend as the only seam.
 */

interface RecordedSearch {
  query: string;
  collection: string | undefined;
  maxResults: number | undefined;
}

const searchRequest = z.object({
  query: z.string(),
  collection: z.string().optional(),
  maxResults: z.number().optional(),
});

interface FakeSearchService {
  baseUrl: string;
  searches: RecordedSearch[];
  /** Resolves when the readiness warm-up query is first recorded. */
  firstReadinessSearch: Promise<void>;
  close: () => Promise<void>;
}

async function startFakeSearchService(): Promise<FakeSearchService> {
  const searches: RecordedSearch[] = [];
  const { promise: firstReadinessSearch, resolve: resolveFirstReadinessSearch } =
    Promise.withResolvers<void>();
  const handle = (req: IncomingMessage, res: ServerResponse): void => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (req.method === "GET" && url.pathname === "/health") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
      return;
    }
    if (req.method === "POST" && url.pathname.startsWith("/search/")) {
      let body = "";
      req.on("data", (chunk: Buffer) => {
        body += chunk.toString();
      });
      req.on("end", () => {
        try {
          const parsed = searchRequest.parse(JSON.parse(body));
          searches.push({
            query: parsed.query,
            collection: parsed.collection,
            maxResults: parsed.maxResults,
          });
          if (parsed.query === "remnic startup readiness") resolveFirstReadinessSearch();
          res.writeHead(200, { "content-type": "application/json" });
          res.end("[]");
        } catch {
          res.writeHead(400);
          res.end();
        }
      });
      return;
    }
    res.writeHead(404);
    res.end();
  };
  const httpServer: HttpServer = createServer(handle);
  const { promise: listening, resolve: resolveListening, reject: rejectListening } =
    Promise.withResolvers<number>();
  httpServer.once("error", rejectListening);
  httpServer.listen(0, "127.0.0.1", () => {
    const address = z.object({ port: z.number().int().positive() }).safeParse(httpServer.address());
    if (address.success) resolveListening(address.data.port);
    else rejectListening(new Error("no TCP address"));
  });
  const port = await listening;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    searches,
    firstReadinessSearch,
    close: () =>
      new Promise<void>((resolve, reject) => {
        // close() is callback-only by API; executor form is required here.
        httpServer.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}

async function withTestDeadline<T>(promise: Promise<T>, timeoutMs = 30_000): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("test deadline exceeded")), timeoutMs);
    timer.unref?.();
  });
  try {
    return await Promise.race([promise, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

async function waitForState(
  condition: () => boolean | Promise<boolean>,
  description: string,
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await condition())) {
    if (Date.now() > deadline) {
      throw new Error(`condition not met: ${description}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function bootServerWithFakeSearch(options: {
  fake: FakeSearchService;
  namespacesEnabled: boolean;
  migrateDefaultNamespace?: boolean;
}): Promise<{ result: ServerResult; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-readiness-3253-"));
  const memoryDir = path.join(dir, "memory");
  if (options.migrateDefaultNamespace) {
    // A content marker under namespaces/<default> with no legacy root data
    // migrates the default namespace's storage off the flat root
    // (resolveDefaultNamespaceRoot), so its collection becomes suffixed.
    await mkdir(path.join(memoryDir, "namespaces", "main", "entities"), { recursive: true });
  }
  const configPath = path.join(dir, "config.json");
  await writeFile(
    configPath,
    JSON.stringify({
      remnic: {
        memoryDir,
        qmdEnabled: false,
        searchBackend: "remote",
        remoteSearchBaseUrl: options.fake.baseUrl,
        qmdCollection: "engram",
        namespacesEnabled: options.namespacesEnabled,
        defaultNamespace: "main",
        namespaceCatalogEnabled: true,
        embeddingFallbackEnabled: false,
        localLlmEnabled: false,
        identityContinuityEnabled: false,
        transcriptEnabled: false,
        hourlySummariesEnabled: false,
        compoundingEnabled: false,
        knowledgeIndexEnabled: false,
      },
      server: {
        host: "127.0.0.1",
        authToken: "test-token",
      },
    }),
    "utf8",
  );
  const result = await withTestDeadline(
    startServer({ configPath, authToken: "test-token", allowEphemeralPort: true }),
  );
  return {
    result,
    cleanup: async () => {
      await result.stop().catch(() => {});
      await rm(dir, { recursive: true, force: true });
    },
  };
}

async function testReadinessWarmupUsesResolvedCollection(options: {
  namespacesEnabled: boolean;
  migrateDefaultNamespace?: boolean;
  expectedCollection: (collection: string | undefined) => boolean;
  expectedLabel: string;
}): Promise<void> {
  const fake = await startFakeSearchService();
  let boot: { result: ServerResult; cleanup: () => Promise<void> } | undefined;
  try {
    boot = await withTestDeadline(
      bootServerWithFakeSearch({
        fake,
        namespacesEnabled: options.namespacesEnabled,
        migrateDefaultNamespace: options.migrateDefaultNamespace,
      }),
    );
    await withTestDeadline(fake.firstReadinessSearch, 20_000);
    const readinessSearches = fake.searches.filter(
      (entry) => entry.query === "remnic startup readiness",
    );
    assert.ok(
      readinessSearches.every((entry) => options.expectedCollection(entry.collection)),
      `readiness warm-up searched the wrong collection (${options.expectedLabel}): ` +
        `${JSON.stringify(readinessSearches)}`,
    );
    // Flat-root routing overfetches candidates before filtering nested namespaces.
    assert.ok(
      readinessSearches.every((entry) => entry.maxResults === (entry.collection === "engram" ? 50 : 1)),
      `readiness warm-up must retain the native candidate budget: ${JSON.stringify(readinessSearches)}`,
    );
    // A legitimately empty corpus warms cleanly: the gate opened (health serves
    // 200 instead of the 503 not_ready) after the successful empty search.
    await waitForState(async () => {
      const health = await fetch(`http://127.0.0.1:${boot!.result.port}/engram/v1/health`, {
        headers: { authorization: "Bearer test-token" },
        signal: AbortSignal.timeout(2_000),
      });
      await health.text();
      return health.status === 200;
    }, "health to report ready after warm-up");
  } finally {
    await boot?.cleanup();
    await fake.close();
  }
}

test("readiness warm-up searches the migrated default namespace's suffixed collection (#3253)", async () => {
  await testReadinessWarmupUsesResolvedCollection({
    namespacesEnabled: true,
    migrateDefaultNamespace: true,
    expectedLabel: "namespaced default",
    expectedCollection: (collection) => collection === "engram--ns-6d61696e",
  });
});

test("readiness warm-up keeps the legacy flat-root base collection for a flat default namespace (#3253)", async () => {
  await testReadinessWarmupUsesResolvedCollection({
    namespacesEnabled: true,
    expectedLabel: "legacy flat default",
    expectedCollection: (collection) => collection === "engram",
  });
});

test("readiness warm-up uses the backend default collection when namespaces are disabled (#3253)", async () => {
  await testReadinessWarmupUsesResolvedCollection({
    namespacesEnabled: false,
    expectedLabel: "namespaces disabled",
    expectedCollection: (collection) => collection === undefined,
  });
});

