import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { resolveSafeStoragePath } from "./storage-paths.js";
import { TranscriptManager } from "./transcript.js";
import type { PluginConfig } from "./types.js";

function makeConfig(memoryDir: string): PluginConfig {
  return {
    memoryDir,
    transcriptSkipChannelTypes: [],
  } as unknown as PluginConfig;
}

async function makeManager(): Promise<{ manager: TranscriptManager; memoryDir: string }> {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-transcript-scanflight-"));
  const manager = new TranscriptManager(makeConfig(memoryDir));
  await manager.initialize();
  return { manager, memoryDir };
}

/** ASCII JSON object line of exactly `width` characters (bytes == chars). */
function paddedLine(sessionKey: string, width: number): string {
  const base = JSON.stringify({ sessionKey, pad: "" });
  const line = JSON.stringify({ sessionKey, pad: "x".repeat(width - base.length) });
  assert.equal(line.length, width);
  return line;
}

function dayFile(): string {
  return `${new Date().toISOString().slice(0, 10)}.jsonl`;
}

// Test seam: the private scan internals are deliberately opaque to callers.
type ScanInternals = {
  directoryOwnershipCache: Map<string, { fileSizes: Map<string, number> }>;
  directoryOwnershipCacheKey(root: string, dir: string, sessionKey: string): string;
  directorySessionStatus(root: string, dir: string, sessionKey?: string): Promise<string>;
  directoryJsonlFileSizes(
    root: string,
    dir: string,
    names: string[],
  ): Promise<Map<string, number> | null>;
  rememberDirectoryOwnership(root: string, dir: string, sessionKey: string): Promise<void>;
};

/**
 * Count full ownership parses (cache-persisting verdicts computed from disk
 * content) of one (dir, sessionKey) pair, via the distinct cache-entry objects
 * persisted by the end of each call: only a real parse persists, a shared or
 * cached verdict does not. `rememberDirectoryOwnership` is patched out because
 * it is best-effort by contract and its post-write refresh would otherwise
 * count as a parse here.
 */
function instrumentScans(
  manager: TranscriptManager,
  memoryDir: string,
  targetDir: string,
  targetSessionKey: string,
): { parses: () => number } {
  const internals = manager as unknown as ScanInternals;
  const cache = internals.directoryOwnershipCache;
  const root = path.join(memoryDir, "transcripts");
  const key = internals.directoryOwnershipCacheKey(root, targetDir, targetSessionKey);
  const persisted = new Set<object>();
  internals.rememberDirectoryOwnership = async () => {};
  const original = internals.directorySessionStatus.bind(manager);
  internals.directorySessionStatus = async (rootArg: string, dir: string, sessionKey?: string) => {
    const status = await original(rootArg, dir, sessionKey);
    if (dir === targetDir && sessionKey === targetSessionKey) {
      const entry = cache.get(key);
      if (entry) persisted.add(entry);
    }
    return status;
  };
  return { parses: () => persisted.size };
}

async function seedDir(
  memoryDir: string,
  dir: string,
  sessionKey: string,
  lineCount: number,
  fileName: string = dayFile(),
): Promise<string> {
  const root = path.join(memoryDir, "transcripts");
  const channelDir = await resolveSafeStoragePath(root, dir);
  await mkdir(channelDir, { recursive: true });
  const lines = Array.from({ length: lineCount }, () => paddedLine(sessionKey, 220));
  const filePath = path.join(channelDir, fileName);
  await writeFile(filePath, lines.map((l) => `${l}\n`).join(""), "utf-8");
  return filePath;
}

test("concurrent same-directory appends for one session perform a single ownership scan", async () => {
  const { manager, memoryDir } = await makeManager();
  const sessionKey = "pi-geek:scanflight-shared";
  const { dir } = manager.getTranscriptPath(sessionKey);
  const seededPath = await seedDir(memoryDir, dir, sessionKey, 18_000);
  const scans = instrumentScans(manager, memoryDir, dir, sessionKey);

  const appends = Array.from({ length: 6 }, (_, i) =>
    manager.append({
      timestamp: new Date(2026, 0, 1, 12, 0, i).toISOString(),
      role: "user",
      content: `turn ${i}`,
      sessionKey,
      turnId: `t${i}`,
    }),
  );
  await Promise.all(appends);

  assert.equal(scans.parses(), 1, "concurrent scans of one directory for one session must deduplicate");
  const raw = await readFile(seededPath, "utf-8");
  const lines = raw.split("\n").filter((l) => l.trim().length > 0);
  assert.equal(lines.length, 18_006);
  for (const line of lines) {
    assert.equal(JSON.parse(line).sessionKey, sessionKey);
  }
});

test("concurrent ownership checks for different session keys on one directory never share verdicts", async () => {
  const { manager, memoryDir } = await makeManager();
  const ownerKey = "pi-geek:scanflight-owner";
  const intruderKey = "pi-geek:scanflight-intruder";
  const { dir } = manager.getTranscriptPath(ownerKey);
  await seedDir(memoryDir, dir, ownerKey, 4);
  const root = path.join(memoryDir, "transcripts");
  const internals = manager as unknown as ScanInternals;

  const verdicts = await Promise.all([
    ...Array.from({ length: 10 }, () => internals.directorySessionStatus(root, dir, ownerKey)),
    ...Array.from({ length: 10 }, () => internals.directorySessionStatus(root, dir, intruderKey)),
  ]);

  const ownerVerdicts = verdicts.slice(0, 10);
  const intruderVerdicts = verdicts.slice(10);
  for (const verdict of ownerVerdicts) assert.equal(verdict, "matches");
  for (const verdict of intruderVerdicts) assert.equal(verdict, "occupied");
});

test("concurrent appends reroute a foreign-seeded primary without touching it while the owner writes its own directory", async () => {
  const { manager, memoryDir } = await makeManager();
  const ownerKey = "pi-geek:scanflight-write-owner";
  const reroutedKey = "pi-geek:scanflight-write-guest";
  const ownerPaths = manager.getTranscriptPath(ownerKey);
  const guestPaths = manager.getTranscriptPath(reroutedKey);
  const guestSeeded = await seedDir(memoryDir, guestPaths.dir, ownerKey, 3);
  const root = path.join(memoryDir, "transcripts");

  const appends = Array.from({ length: 10 }, (_, i) => {
    const key = i % 2 === 0 ? ownerKey : reroutedKey;
    return manager.append({
      timestamp: new Date(2026, 0, 1, 12, 0, i).toISOString(),
      role: "user",
      content: `turn ${i}`,
      sessionKey: key,
      turnId: `t${i}`,
    });
  });
  await Promise.all(appends);

  const ownerFile = await readFile(
    path.join(await resolveSafeStoragePath(root, ownerPaths.dir), dayFile()),
    "utf-8",
  );
  const ownerLines = ownerFile.split("\n").filter((l) => l.trim().length > 0);
  assert.equal(ownerLines.length, 5);
  for (const line of ownerLines) assert.equal(JSON.parse(line).sessionKey, ownerKey);

  const guestPrimaryRaw = await readFile(guestSeeded, "utf-8");
  const guestPrimaryLines = guestPrimaryRaw.split("\n").filter((l) => l.trim().length > 0);
  assert.equal(guestPrimaryLines.length, 3);
  for (const line of guestPrimaryLines) assert.equal(JSON.parse(line).sessionKey, ownerKey);

  const guestAlternateDir = await resolveSafeStoragePath(root, guestPaths.alternateDir);
  const guestAlternateRaw = await readFile(path.join(guestAlternateDir, dayFile()), "utf-8");
  const guestLines = guestAlternateRaw.split("\n").filter((l) => l.trim().length > 0);
  assert.equal(guestLines.length, 5);
  for (const line of guestLines) assert.equal(JSON.parse(line).sessionKey, reroutedKey);
});

test("a foreign line appended mid-scan yields occupied for the scan and any concurrent joiner", async () => {
  const { manager, memoryDir } = await makeManager();
  const sessionKey = "pi-geek:scanflight-midappend";
  const { dir } = manager.getTranscriptPath(sessionKey);
  const seededPath = await seedDir(memoryDir, dir, sessionKey, 18_000);
  const secondPath = await seedDir(memoryDir, dir, sessionKey, 1, "2020-01-01.jsonl");
  const root = path.join(memoryDir, "transcripts");
  const internals = manager as unknown as ScanInternals;

  const scan = internals.directorySessionStatus(root, dir, sessionKey);
  const joiner = internals.directorySessionStatus(root, dir, sessionKey);
  await writeFile(
    secondPath,
    `${paddedLine(sessionKey, 220)}\n${paddedLine("pi-geek:scanflight-foreign", 220)}\n`,
    "utf-8",
  );

  assert.equal(await scan, "occupied");
  assert.equal(await joiner, "occupied");
  const seededRaw = await readFile(seededPath, "utf-8");
  assert.ok(seededRaw.length > 0);
});

test("an owner append mid-scan forces concurrent checks to re-scan instead of sharing", async () => {
  const { manager, memoryDir } = await makeManager();
  const sessionKey = "pi-geek:scanflight-midowner";
  const { dir } = manager.getTranscriptPath(sessionKey);
  await seedDir(memoryDir, dir, sessionKey, 18_000);
  const secondPath = await seedDir(memoryDir, dir, sessionKey, 1, "2020-01-01.jsonl");
  const root = path.join(memoryDir, "transcripts");
  const scans = instrumentScans(manager, memoryDir, dir, sessionKey);
  const internals = manager as unknown as ScanInternals;

  // The scan's size snapshot must be fixed before the owner append lands, so
  // gate the write on the scan's own sizes call instead of a guessed delay.
  const originalSizes = internals.directoryJsonlFileSizes.bind(manager);
  const { promise: sizesObserved, resolve: markSizesObserved } = Promise.withResolvers<void>();
  let sizesMarked = false;
  internals.directoryJsonlFileSizes = async (rootArg, dirArg, names) => {
    const sizes = await originalSizes(rootArg, dirArg, names);
    if (!sizesMarked) {
      sizesMarked = true;
      markSizesObserved();
    }
    return sizes;
  };

  const scan = internals.directorySessionStatus(root, dir, sessionKey);
  await sizesObserved;
  await writeFile(secondPath, `${paddedLine(sessionKey, 220)}\n${paddedLine(sessionKey, 220)}\n`, "utf-8");
  const joiner = internals.directorySessionStatus(root, dir, sessionKey);

  assert.equal(await scan, "matches");
  assert.equal(await joiner, "matches");
  assert.equal(scans.parses(), 2, "size drift between scans must prevent sharing one parse");
});

test("an equal-size foreign rewrite during a scan is detected by content, not size", async () => {
  const { manager, memoryDir } = await makeManager();
  const sessionKey = "pi-geek:scanflight-equalrewrite";
  const { dir } = manager.getTranscriptPath(sessionKey);
  await seedDir(memoryDir, dir, sessionKey, 18_000);
  const secondPath = await seedDir(memoryDir, dir, sessionKey, 1, "2020-01-01.jsonl");
  const root = path.join(memoryDir, "transcripts");
  const internals = manager as unknown as ScanInternals;

  const scan = internals.directorySessionStatus(root, dir, sessionKey);
  const joiner = internals.directorySessionStatus(root, dir, sessionKey);
  await writeFile(secondPath, `${paddedLine("pi-geek:scanflight-rewrite-z", 220)}\n`, "utf-8");

  assert.equal(await scan, "occupied");
  assert.equal(await joiner, "occupied");
  assert.equal(await internals.directorySessionStatus(root, dir, sessionKey), "occupied");
});
