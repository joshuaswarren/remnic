import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { initLogger } from "./logger.js";
import { rebuildMemoryProjection } from "./maintenance/rebuild-memory-projection.js";
import {
  __resetProjectionOpenFailureSuppressionForTest,
  __setProjectionReadonlyOpenerForTest,
  getMemoryProjectionPath,
  probeProjectionHealth,
  readProjectedMemoryBrowse,
} from "./memory-projection-store.js";
import { summarizeProjectionHealth } from "./operator-toolkit.js";
import { openBetterSqlite3 } from "./runtime/better-sqlite.js";
import { StorageManager } from "./storage.js";

const SERIAL = { concurrency: false } as const;

type ProjectionOpener = NonNullable<Parameters<typeof __setProjectionReadonlyOpenerForTest>[0]>;

function abiStyleError(): Error {
  // Mirrors the real native-binding mismatch better-sqlite3 throws when its
  // addon was compiled for a different Node.js ABI (issue #1829 root cause).
  // Classified as a native mismatch by isLikelyBetterSqlite3NativeBindingError.
  return new Error(
    "The module was compiled against a different Node.js version using NODE_MODULE_VERSION 127. " +
      "This version of Node.js requires NODE_MODULE_VERSION 137."
  );
}

function captureLogs(): { warns: string[]; errors: string[]; restore: () => void } {
  const warns: string[] = [];
  const errors: string[] = [];
  initLogger({
    info() {},
    warn(msg) {
      warns.push(msg);
    },
    error(msg) {
      errors.push(msg);
    },
    debug() {},
  });
  return { warns, errors, restore: () => initLogger() };
}

test("absent projection index → quiet fallback, no error log, probe reports absent", SERIAL, async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-proj-absent-"));
  const { warns, restore } = captureLogs();
  try {
    // No projection file exists — the normal cold-install / never-built case.
    assert.equal(probeProjectionHealth(dir).state, "absent");
    assert.equal(readProjectedMemoryBrowse(dir, { limit: 5, offset: 0 }), null);
    assert.equal(warns.length, 0);
  } finally {
    restore();
    await rm(dir, { recursive: true, force: true });
  }
});

test("present index + ABI-style open failure → distinct rate-limited warn + null + doctor signal", SERIAL, async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-proj-abi-"));
  const { warns, restore } = captureLogs();
  __resetProjectionOpenFailureSuppressionForTest();
  try {
    await rebuildMemoryProjection({ memoryDir: dir, dryRun: false });
    assert.ok(getMemoryProjectionPath(dir));
    const throwingOpener: ProjectionOpener = () => {
      throw abiStyleError();
    };
    const restoreOpener = __setProjectionReadonlyOpenerForTest(throwingOpener);

    try {
      const first = readProjectedMemoryBrowse(dir, { limit: 5, offset: 0 });
      assert.equal(first, null);
      assert.equal(warns.length, 1);
      const msg = warns[0];
      assert.ok(msg, "expected a distinct projection open-failure warn");
      assert.match(msg, /present but could not be opened/);
      assert.match(msg, /wrong Node\.js ABI/);

      const probe = probeProjectionHealth(dir);
      assert.equal(probe.state, "unopenable");
      assert.equal(probe.nativeBindingMismatch, true);

      const second = readProjectedMemoryBrowse(dir, { limit: 5, offset: 0 });
      assert.equal(second, null);
      assert.equal(warns.length, 1, "rate limit must suppress the repeat warn");

      __resetProjectionOpenFailureSuppressionForTest();
      readProjectedMemoryBrowse(dir, { limit: 5, offset: 0 });
      assert.equal(warns.length, 2, "warn fires again after suppression reset");
    } finally {
      restoreOpener();
    }
  } finally {
    restore();
    await rm(dir, { recursive: true, force: true });
  }
});

test("present index + WRAPPED ABI open failure (cause = native-binding error) → still reports the native-binding hint", SERIAL, async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-proj-wrapped-abi-"));
  const { warns, restore } = captureLogs();
  __resetProjectionOpenFailureSuppressionForTest();
  try {
    await rebuildMemoryProjection({ memoryDir: dir, dryRun: false });
    const throwingOpener: ProjectionOpener = () => {
      throw new Error(
        "better-sqlite3 is unavailable. Remnic attempted to load the native SQLite binding and could not.",
        { cause: abiStyleError() },
      );
    };
    const restoreOpener = __setProjectionReadonlyOpenerForTest(throwingOpener);

    try {
      const first = readProjectedMemoryBrowse(dir, { limit: 5, offset: 0 });
      assert.equal(first, null);
      assert.equal(warns.length, 1);
      assert.match(warns[0], /wrong Node\.js ABI/);
      assert.doesNotMatch(warns[0], /rebuild-memory-projection/);

      const probe = probeProjectionHealth(dir);
      assert.equal(probe.state, "unopenable");
      assert.equal(probe.nativeBindingMismatch, true);
    } finally {
      restoreOpener();
    }
  } finally {
    restore();
    await rm(dir, { recursive: true, force: true });
  }
});

test("present index + non-ABI open failure → distinct warn without the native-binding hint", SERIAL, async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-proj-cantopen-"));
  const { warns, restore } = captureLogs();
  __resetProjectionOpenFailureSuppressionForTest();
  try {
    await rebuildMemoryProjection({ memoryDir: dir, dryRun: false });
    // A corrupt-file / permission style failure: carries a stable SQLite
    // code but is NOT a native-binding mismatch. Tests the failure CLASS,
    // not just the reported ABI instance (hardening playbook).
    const cantOpen = Object.assign(new Error("unable to open database file"), {
      code: "SQLITE_CANTOPEN",
    });
    const restoreOpener = __setProjectionReadonlyOpenerForTest((() => {
      throw cantOpen;
    }) as ProjectionOpener);
    try {
      assert.equal(readProjectedMemoryBrowse(dir, { limit: 5, offset: 0 }), null);
      assert.equal(warns.length, 1);
      const msg = warns[0];
      assert.ok(msg, "expected a distinct projection open-failure warn");
      assert.match(msg, /present but could not be opened/);
      assert.match(msg, /SQLITE_CANTOPEN/);
      assert.doesNotMatch(msg, /native binding/);
      const probe = probeProjectionHealth(dir);
      assert.equal(probe.state, "unopenable");
      assert.equal(probe.nativeBindingMismatch, false);
    } finally {
      restoreOpener();
    }
  } finally {
    restore();
    await rm(dir, { recursive: true, force: true });
  }
});

test("full-scan fallback still returns results when the projection cannot serve", SERIAL, async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-proj-fullscan-"));
  const { restore } = captureLogs();
  try {
    const storage = new StorageManager(dir);
    const a = await storage.writeMemory("fact", "alpha synthetic fact", { source: "test" });
    const b = await storage.writeMemory("fact", "beta synthetic fact", { source: "test" });

    assert.equal(readProjectedMemoryBrowse(dir, { limit: 10, offset: 0 }), null);

    const full = [...(await storage.readAllMemories()), ...(await storage.readArchivedMemories())];
    const ids = new Set(full.map((m) => m.frontmatter.id));
    assert.ok(ids.has(a.id));
    assert.ok(ids.has(b.id));
    assert.equal(full.length, 2);

    await rebuildMemoryProjection({ memoryDir: dir, dryRun: false });
    const restoreOpener = __setProjectionReadonlyOpenerForTest((() => {
      throw abiStyleError();
    }) as ProjectionOpener);
    try {
      assert.equal(
        readProjectedMemoryBrowse(dir, { limit: 10, offset: 0 }),
        null,
        "unopenable projection must return null so the full scan runs"
      );
    } finally {
      restoreOpener();
    }
  } finally {
    restore();
    await rm(dir, { recursive: true, force: true });
  }
});

test("present + valid projection → probe openable + doctor ok (schema validation passes)", SERIAL, async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-proj-healthy-"));
  try {
    await rebuildMemoryProjection({ memoryDir: dir, dryRun: false });
    const probe = probeProjectionHealth(dir);
    assert.equal(probe.state, "openable");
    assert.equal(probe.nativeBindingMismatch, false);
    const check = summarizeProjectionHealth({ memoryDir: dir });
    assert.equal(check.status, "ok");
    assert.match(check.summary, /opens cleanly/i);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("present projection with MISSING schema tables → probe present-but-invalid (doctor non-ok, rebuild hint)", SERIAL, async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-proj-no-tables-"));
  try {
    // Create a sqlite file that OPENS cleanly but has NO projection tables
    // (mirrors a half-built / stale / externally-created .sqlite that opens
    // but cannot serve any browse query — issue #1848 round 2 root cause).
    const dbPath = getMemoryProjectionPath(dir);
    await mkdir(path.dirname(dbPath), { recursive: true });
    const empty = openBetterSqlite3(dbPath); // creates a valid empty db
    empty.close();

    const probe = probeProjectionHealth(dir);
    assert.equal(probe.state, "present-but-invalid");
    assert.equal(probe.nativeBindingMismatch, false);
    assert.ok(probe.detail, "expected a path-free detail for the schema failure");

    const check = summarizeProjectionHealth({ memoryDir: dir });
    assert.equal(check.status, "error");
    assert.match(check.summary, /missing or unreadable/i);
    assert.ok(check.remediation);
    assert.match(check.remediation, /rebuild-memory-projection/);

    assert.equal(readProjectedMemoryBrowse(dir, { limit: 5, offset: 0 }), null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("present projection with memory_current MISSING required columns → probe present-but-invalid (doctor non-ok, rebuild hint)", SERIAL, async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-proj-no-cols-"));
  try {
    const dbPath = getMemoryProjectionPath(dir);
    await mkdir(path.dirname(dbPath), { recursive: true });
    const stale = openBetterSqlite3(dbPath); // creates a valid db
    stale.exec("CREATE TABLE memory_current (x INTEGER)");
    stale.close();

    const probe = probeProjectionHealth(dir);
    assert.equal(probe.state, "present-but-invalid");
    assert.equal(probe.nativeBindingMismatch, false);
    assert.ok(probe.detail, "expected a path-free detail for the missing-column schema failure");

    const check = summarizeProjectionHealth({ memoryDir: dir });
    assert.equal(check.status, "error");
    assert.match(check.summary, /missing or unreadable/i);
    assert.ok(check.remediation);
    assert.match(check.remediation, /rebuild-memory-projection/);

    assert.equal(readProjectedMemoryBrowse(dir, { limit: 5, offset: 0 }), null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
