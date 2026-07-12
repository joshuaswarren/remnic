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

// Serialized: every test mutates the process-global logger backend and the
// module-level projection opener / rate-limit map. concurrency:false keeps
// them from racing each other.
const SERIAL = { concurrency: false } as const;

// The opener seam expects the real opener signature; derive it without
// importing the (unexported) alias.
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
    // The distinguishing guarantee from issue #1829: a MISSING file must stay
    // quiet (no error spam). Only a PRESENT-but-unopenable file logs.
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
    // Build a real projection so the index file genuinely EXISTS on disk;
    // then inject an opener that throws the wrong-ABI error on every open.
    await rebuildMemoryProjection({ memoryDir: dir, dryRun: false });
    assert.ok(getMemoryProjectionPath(dir));
    const throwingOpener: ProjectionOpener = () => {
      throw abiStyleError();
    };
    const restoreOpener = __setProjectionReadonlyOpenerForTest(throwingOpener);

    try {
      // The read path returns null (full-scan fallback trigger preserved),
      // but now emits the DISTINCT real-error warn that was missing before.
      const first = readProjectedMemoryBrowse(dir, { limit: 5, offset: 0 });
      assert.equal(first, null);
      assert.equal(warns.length, 1);
      const msg = warns[0];
      assert.ok(msg, "expected a distinct projection open-failure warn");
      assert.match(msg, /present but could not be opened/);
      assert.match(msg, /wrong Node\.js ABI/);

      // Doctor lens classifies the same failure.
      const probe = probeProjectionHealth(dir);
      assert.equal(probe.state, "unopenable");
      assert.equal(probe.nativeBindingMismatch, true);

      // Rate limit: a second open within the window is suppressed.
      const second = readProjectedMemoryBrowse(dir, { limit: 5, offset: 0 });
      assert.equal(second, null);
      assert.equal(warns.length, 1, "rate limit must suppress the repeat warn");

      // After resetting suppression, the warn fires again.
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
    // Mirrors the production path: loadBetterSqlite3() catches the ABI error
    // and re-throws a sanitized unavailableError WRAPPER whose message drops
    // the ABI markers. The original error survives only on .cause. Before
    // #1848 the classifier inspected only the wrapper's message and MISSED the
    // mismatch, so the warn and doctor check wrongly suggested rebuilding the
    // projection instead of better-sqlite3.
    const throwingOpener: ProjectionOpener = () => {
      throw new Error(
        "better-sqlite3 is unavailable. Remnic attempted to load the native SQLite binding and could not.",
        { cause: abiStyleError() },
      );
    };
    const restoreOpener = __setProjectionReadonlyOpenerForTest(throwingOpener);

    try {
      // Browse warn carries the native-binding ABI hint (not the projection-rebuild hint).
      const first = readProjectedMemoryBrowse(dir, { limit: 5, offset: 0 });
      assert.equal(first, null);
      assert.equal(warns.length, 1);
      assert.match(warns[0], /wrong Node\.js ABI/);
      assert.doesNotMatch(warns[0], /rebuild-memory-projection/);

      // Doctor lens classifies the SAME wrapped failure as a native-binding mismatch.
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

    // Absent projection: the browse returns null (the trigger the access
    // layer keys on to run its full-corpus scan) ...
    assert.equal(readProjectedMemoryBrowse(dir, { limit: 10, offset: 0 }), null);

    // ... and the full-corpus data source the access layer scans still
    // holds every memory (issue #1829: the fallback must keep serving).
    const full = [...(await storage.readAllMemories()), ...(await storage.readArchivedMemories())];
    const ids = new Set(full.map((m) => m.frontmatter.id));
    assert.ok(ids.has(a.id));
    assert.ok(ids.has(b.id));
    assert.equal(full.length, 2);

    // Regression guard for the exact #1829 failure: build the projection,
    // then make it unopenable, and confirm the null trigger STILL fires so
    // the full scan is reached (not a throw, not a stale cached page).
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
    // Doctor lens reports OK for a schema-valid projection (issue #1848 round 2).
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

    // Before #1848 round 2 this reported "openable" → doctor said ok while
    // browse silently fell back to full-corpus scans on every memory list.
    const probe = probeProjectionHealth(dir);
    assert.equal(probe.state, "present-but-invalid");
    assert.equal(probe.nativeBindingMismatch, false);
    assert.ok(probe.detail, "expected a path-free detail for the schema failure");

    // Doctor lens surfaces this as an ERROR with a rebuild hint — NOT ok.
    const check = summarizeProjectionHealth({ memoryDir: dir });
    assert.equal(check.status, "error");
    assert.match(check.summary, /missing or unreadable/i);
    assert.ok(check.remediation);
    assert.match(check.remediation, /rebuild-memory-projection/);

    // Browse still returns null (full-scan fallback trigger) — the projection
    // is unusable, so the access layer must reach the full corpus.
    assert.equal(readProjectedMemoryBrowse(dir, { limit: 5, offset: 0 }), null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
