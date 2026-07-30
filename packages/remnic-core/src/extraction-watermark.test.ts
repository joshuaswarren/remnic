import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { TOKEN_CAPABILITIES_VERSION } from "./access-token-capabilities.js";
import { parseConfig } from "./config.js";
import { CorpusWatermarkCache } from "./corpus-watermark.js";
import { readAggregateExtractionWatermark } from "./orchestration/extraction-watermark.js";
import type { PluginConfig } from "./types.js";

interface FakeWatermarkStorage {
  readonly dir: string;
  loadMeta(): Promise<{ lastExtractionAt: string | null }>;
}

function storage(dir: string, read: () => Promise<string | null>): FakeWatermarkStorage {
  return {
    dir,
    loadMeta: async () => ({ lastExtractionAt: await read() }),
  };
}

async function namespacedFixture(): Promise<{
  memoryDir: string;
  config: PluginConfig;
  namespaceDirs: Record<string, string>;
}> {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-extraction-watermark-"));
  const namespaceDirs = {
    "team-a": path.join(memoryDir, "namespaces", "team-a"),
    "team-b": path.join(memoryDir, "namespaces", "team-b"),
  };
  await Promise.all(Object.values(namespaceDirs).map((dir) => mkdir(dir, { recursive: true })));
  return {
    memoryDir,
    config: parseConfig({ memoryDir, namespacesEnabled: true, defaultNamespace: "default" }),
    namespaceDirs,
  };
}

test("aggregate watermark selects the most recent extraction across distinct namespace stores", async () => {
  const fixture = await namespacedFixture();
  try {
    const timestamps = {
      default: "2026-07-20T12:00:00.000Z",
      "team-a": "2026-07-21T12:00:00.000Z",
      "team-b": "2026-07-22T12:00:00.000Z",
    };
    const result = await readAggregateExtractionWatermark({
      config: fixture.config,
      rootStorage: storage(fixture.memoryDir, async () => timestamps.default),
      storageForNamespace: async (namespace) =>
        storage(fixture.namespaceDirs[namespace], async () => timestamps[namespace as keyof typeof timestamps]),
    });

    assert.deepEqual(result, {
      lastExtractionAt: timestamps["team-b"],
      readFailed: false,
    });
  } finally {
    await rm(fixture.memoryDir, { recursive: true, force: true });
  }
});

test("a namespace-isolated extraction advances the daemon aggregate watermark", async () => {
  const fixture = await namespacedFixture();
  try {
    const rootTimestamp = "2026-07-20T12:00:00.000Z";
    let teamTimestamp = "2026-07-19T12:00:00.000Z";
    const options = {
      config: fixture.config,
      rootStorage: storage(fixture.memoryDir, async () => rootTimestamp),
      storageForNamespace: async (namespace: string) =>
        storage(fixture.namespaceDirs[namespace], async () => (namespace === "team-a" ? teamTimestamp : null)),
    };

    assert.equal((await readAggregateExtractionWatermark(options)).lastExtractionAt, rootTimestamp);
    teamTimestamp = "2026-07-23T12:00:00.000Z";
    assert.equal((await readAggregateExtractionWatermark(options)).lastExtractionAt, teamTimestamp);
  } finally {
    await rm(fixture.memoryDir, { recursive: true, force: true });
  }
});

test("a partial namespace read returns readFailed instead of a survivor's fresh watermark", async () => {
  const fixture = await namespacedFixture();
  try {
    const result = await readAggregateExtractionWatermark({
      config: fixture.config,
      rootStorage: storage(fixture.memoryDir, async () => "2026-07-23T12:00:00.000Z"),
      storageForNamespace: async (namespace) =>
        storage(fixture.namespaceDirs[namespace], async () => {
          if (namespace === "team-b") throw new Error("meta store unavailable");
          return "2026-07-22T12:00:00.000Z";
        }),
    });

    assert.equal(result.lastExtractionAt, null, "a surviving timestamp must not be reported as complete");
    assert.equal(result.readFailed, true);
    assert.match(result.readError ?? "", /namespace watermark unreadable/);
    assert.match(result.readError ?? "", /meta store unavailable/);
  } finally {
    await rm(fixture.memoryDir, { recursive: true, force: true });
  }
});
test("scoped capabilities filter candidate namespaces during aggregate read", async () => {
  const fixture = await namespacedFixture();
  try {
    let scannedTeamB = false;
    const result = await readAggregateExtractionWatermark({
      config: fixture.config,
      rootStorage: storage(fixture.memoryDir, async () => "2026-07-20T12:00:00.000Z"),
      storageForNamespace: async (namespace) => {
        if (namespace === "team-b") scannedTeamB = true;
        return storage(fixture.namespaceDirs[namespace], async () => "2026-07-25T12:00:00.000Z");
      },
      caps: { version: TOKEN_CAPABILITIES_VERSION, namespaces: ["team-a"] },
    });

    assert.equal(scannedTeamB, false, "team-b should be skipped when token is restricted to team-a");
    assert.equal(result.readFailed, false);
  } finally {
    await rm(fixture.memoryDir, { recursive: true, force: true });
  }
});

test("namespace discovery I/O failure is an explicit incomplete read", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-extraction-watermark-enumeration-"));
  try {
    await writeFile(path.join(memoryDir, "namespaces"), "not a directory", "utf8");
    const config = parseConfig({ memoryDir, namespacesEnabled: true });
    const result = await readAggregateExtractionWatermark({
      config,
      rootStorage: storage(memoryDir, async () => "2026-07-23T12:00:00.000Z"),
      storageForNamespace: async (_namespace, rootDir) => storage(rootDir, async () => null),
    });

    assert.equal(result.lastExtractionAt, null);
    assert.equal(result.readFailed, true);
    assert.match(result.readError ?? "", /namespace watermark enumeration failed/);
    assert.match(result.readError ?? "", /ENOTDIR/);
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("a failed stale-cache refresh makes later reads incomplete", async () => {
  const fixture = await namespacedFixture();
  try {
    let now = 1;
    const cache = new CorpusWatermarkCache({ ttlMs: 1, clock: () => now });
    const options = {
      config: fixture.config,
      rootStorage: storage(fixture.memoryDir, async () => "2026-07-20T12:00:00.000Z"),
      storageForNamespace: async (namespace: string) =>
        storage(fixture.namespaceDirs[namespace], async () => "2026-07-21T12:00:00.000Z"),
      rootsCache: cache,
    };

    assert.equal((await readAggregateExtractionWatermark(options)).readFailed, true);
    await cache.whenIdle();
    assert.equal((await readAggregateExtractionWatermark(options)).readFailed, false);

    await rm(path.join(fixture.memoryDir, "namespaces"), { recursive: true, force: true });
    await writeFile(path.join(fixture.memoryDir, "namespaces"), "not a directory", "utf8");
    now += 2;
    assert.equal(
      (await readAggregateExtractionWatermark(options)).readFailed,
      false,
      "the stale value may be served while refresh is still in flight",
    );
    await cache.whenIdle();
    const failedRefresh = await readAggregateExtractionWatermark(options);
    assert.equal(failedRefresh.lastExtractionAt, null);
    assert.equal(failedRefresh.readFailed, true);
    assert.match(failedRefresh.readError ?? "", /namespace watermark enumeration failed/);
  } finally {
    await rm(fixture.memoryDir, { recursive: true, force: true });
  }
});

test("a cold namespace-root cache is an explicit incomplete read", async () => {
  const fixture = await namespacedFixture();
  try {
    let rootReads = 0;
    const result = await readAggregateExtractionWatermark({
      config: fixture.config,
      rootStorage: storage(fixture.memoryDir, async () => {
        rootReads += 1;
        return "2026-07-23T12:00:00.000Z";
      }),
      storageForNamespace: async (namespace) => storage(fixture.namespaceDirs[namespace], async () => null),
      rootsCache: {
        getResolvedRootsStatus: () => ({ roots: undefined, refreshError: undefined }),
      },
    });

    assert.equal(result.lastExtractionAt, null);
    assert.equal(result.readFailed, true);
    assert.match(result.readError ?? "", /namespace root cache is warming/);
    assert.equal(rootReads, 0, "a root survivor is not read or published before enumeration completes");
  } finally {
    await rm(fixture.memoryDir, { recursive: true, force: true });
  }
});

test("namespaces disabled performs exactly one root metadata read", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-extraction-watermark-single-"));
  try {
    const config = parseConfig({ memoryDir, namespacesEnabled: false });
    let rootReads = 0;
    let namespaceResolutions = 0;
    const timestamp = "2026-07-23T12:00:00.000Z";
    const result = await readAggregateExtractionWatermark({
      config,
      rootStorage: {
        dir: memoryDir,
        loadMeta: async () => {
          rootReads += 1;
          return {
            lastExtractionAt: timestamp,
            extractionCount: 9,
            lastConsolidationAt: null,
          };
        },
      },
      storageForNamespace: async () => {
        namespaceResolutions += 1;
        throw new Error("disabled path must not resolve namespace storage");
      },
    });

    assert.deepEqual(result, {
      lastExtractionAt: timestamp,
      readFailed: false,
      rootStats: { extractionCount: 9, lastConsolidationAt: null },
    });
    assert.equal(rootReads, 1);
    assert.equal(namespaceResolutions, 0);
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});
