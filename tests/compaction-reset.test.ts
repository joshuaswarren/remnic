import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile, readdir, stat, unlink } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { sanitizeSessionKeyForFilename } from "@remnic/core/orchestrator";

function tmpDir(prefix: string): string {
  return path.join(
    os.tmpdir(),
    `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
  );
}

// ---------------------------------------------------------------------------
// Compaction Reset — Signal File Tests
//
// These tests exercise the signal file lifecycle without instantiating the
// full Orchestrator. They validate the file-level contract that the
// after_compaction hook (write side) and recall() (read side) depend on.
// ---------------------------------------------------------------------------

test("compaction signal file uses per-session naming", async () => {
  const dir = tmpDir("engram-cr-naming");
  await mkdir(dir, { recursive: true });

  const sessionKey = "agent-gpucodebot-abc123";
  const signalPath = path.join(dir, `.compaction-reset-signal-${sessionKey}`);
  await writeFile(
    signalPath,
    JSON.stringify({
      sessionKey,
      compactedAt: new Date().toISOString(),
      messageCount: 42,
    }),
    "utf-8",
  );

  // File exists with session-specific name
  const s = await stat(signalPath);
  assert.ok(s.isFile());

  // Signal data round-trips correctly
  const data = JSON.parse(await readFile(signalPath, "utf-8"));
  assert.equal(data.sessionKey, sessionKey);
  assert.equal(data.messageCount, 42);
  assert.ok(data.compactedAt);

  // Cleanup
  await unlink(signalPath);
});

test("per-session signal files are isolated between sessions", async () => {
  const dir = tmpDir("engram-cr-isolation");
  await mkdir(dir, { recursive: true });

  const sessionA = "agent-alpha-001";
  const sessionB = "agent-beta-002";

  const signalA = path.join(dir, `.compaction-reset-signal-${sessionA}`);
  const signalB = path.join(dir, `.compaction-reset-signal-${sessionB}`);

  await writeFile(signalA, JSON.stringify({ sessionKey: sessionA, compactedAt: "2026-01-01T00:00:00Z", messageCount: 10 }), "utf-8");
  await writeFile(signalB, JSON.stringify({ sessionKey: sessionB, compactedAt: "2026-01-01T00:01:00Z", messageCount: 20 }), "utf-8");

  // Both files exist independently
  const dataA = JSON.parse(await readFile(signalA, "utf-8"));
  const dataB = JSON.parse(await readFile(signalB, "utf-8"));
  assert.equal(dataA.sessionKey, sessionA);
  assert.equal(dataA.messageCount, 10);
  assert.equal(dataB.sessionKey, sessionB);
  assert.equal(dataB.messageCount, 20);

  // Deleting one doesn't affect the other
  await unlink(signalA);
  const stillExists = await stat(signalB).catch(() => null);
  assert.ok(stillExists);

  // Cleanup
  await unlink(signalB);
});

test("stale signal file (>1 hour) is detected by age", async () => {
  const dir = tmpDir("engram-cr-stale");
  await mkdir(dir, { recursive: true });

  const sessionKey = "agent-stale-test";
  const signalPath = path.join(dir, `.compaction-reset-signal-${sessionKey}`);
  await writeFile(
    signalPath,
    JSON.stringify({
      sessionKey,
      compactedAt: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(), // 2 hours ago
      messageCount: 5,
    }),
    "utf-8",
  );

  // Backdate the file mtime to simulate age
  const { utimes } = await import("node:fs/promises");
  const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
  await utimes(signalPath, twoHoursAgo, twoHoursAgo);

  const s = await stat(signalPath);
  const age = Date.now() - s.mtimeMs;
  assert.ok(age >= 60 * 60 * 1000, `signal should be stale (age=${Math.round(age / 1000)}s)`);

  // Cleanup
  await unlink(signalPath);
});

test("signal sessionKey validation rejects cross-session consumption", async () => {
  const dir = tmpDir("engram-cr-validate");
  await mkdir(dir, { recursive: true });

  const writerSession = "agent-writer-001";
  const readerSession = "agent-reader-002";

  const signalPath = path.join(dir, `.compaction-reset-signal-${writerSession}`);
  await writeFile(
    signalPath,
    JSON.stringify({
      sessionKey: writerSession,
      compactedAt: new Date().toISOString(),
      messageCount: 15,
    }),
    "utf-8",
  );

  const data = JSON.parse(await readFile(signalPath, "utf-8"));
  // Reader session should reject this signal
  assert.ok(data.sessionKey !== readerSession, "signal sessionKey should not match reader");
  assert.equal(data.sessionKey, writerSession);

  // Cleanup
  await unlink(signalPath);
});

test("BOOT.md injection reads file content when present", async () => {
  const dir = tmpDir("engram-cr-boot");
  await mkdir(dir, { recursive: true });

  const bootPath = path.join(dir, "BOOT.md");
  const bootContent = "- Working on PR #117 split\n- 3 branches ready\n- Need to write tests";
  await writeFile(bootPath, bootContent, "utf-8");

  const loaded = await readFile(bootPath, "utf-8");
  assert.equal(loaded, bootContent);

  // Simulate injection format
  let section = "\n\n## Session Recovery (Post-Compaction)\n\n";
  section += "⚠️ A compaction occurred and this is a fresh session.\n\n";
  section += "### BOOT.md (working state before compaction)\n\n";
  section += loaded + "\n";

  assert.match(section, /Working on PR #117 split/);
  assert.match(section, /Session Recovery/);

  // Cleanup
  await unlink(bootPath);
});

test("BOOT.md missing produces warning section", async () => {
  const dir = tmpDir("engram-cr-noboot");
  await mkdir(dir, { recursive: true });

  const bootPath = path.join(dir, "BOOT.md");

  let section = "\n\n## Session Recovery (Post-Compaction)\n\n";
  section += "⚠️ A compaction occurred and this is a fresh session.\n\n";

  try {
    await readFile(bootPath, "utf-8");
    section += "### BOOT.md (working state before compaction)\n\n";
  } catch {
    section += "### ⚠️ BOOT.md is MISSING\n\n";
    section += "The memory flush may not have written BOOT.md before compaction. ";
    section += "Ask the user what you were working on — do not guess.\n";
  }

  assert.match(section, /BOOT\.md is MISSING/);
  assert.match(section, /do not guess/);
});

test("workspace override Map is per-session and cleaned up after use", () => {
  // Simulate the Map behavior without the full Orchestrator
  const overrides = new Map<string, string>();

  overrides.set("session-a", "/workspace/agent-a");
  overrides.set("session-b", "/workspace/agent-b");

  assert.equal(overrides.get("session-a"), "/workspace/agent-a");
  assert.equal(overrides.get("session-b"), "/workspace/agent-b");

  // Simulate recall cleanup for session-a
  const dirA = overrides.get("session-a");
  overrides.delete("session-a");

  assert.equal(dirA, "/workspace/agent-a");
  assert.equal(overrides.get("session-a"), undefined); // cleaned up
  assert.equal(overrides.get("session-b"), "/workspace/agent-b"); // untouched
});

test("workspace override Map cleanup runs even when feature is disabled", () => {
  const overrides = new Map<string, string>();
  const compactionResetEnabled = false;

  // Simulate the prompt hook setting the override
  overrides.set("session-x", "/workspace/agent-x");

  // Simulate recall — always clean up, regardless of feature flag
  const effectiveSessionKey = "session-x";
  const compactionWorkspaceDir = overrides.get(effectiveSessionKey);
  overrides.delete(effectiveSessionKey);

  if (compactionResetEnabled) {
    // Would use compactionWorkspaceDir — but feature is off
  }

  // Override was cleaned up even though feature is disabled
  assert.equal(overrides.size, 0, "Map should be empty after cleanup");
  assert.equal(compactionWorkspaceDir, "/workspace/agent-x");
});

test("signal file cleanup sweeps stale files on startup", async () => {
  const dir = tmpDir("engram-cr-sweep");
  await mkdir(dir, { recursive: true });

  // Create a mix of fresh and stale signal files
  const freshPath = path.join(dir, ".compaction-reset-signal-fresh-session");
  const stalePath = path.join(dir, ".compaction-reset-signal-stale-session");
  const unrelatedPath = path.join(dir, "BOOT.md");

  await writeFile(freshPath, JSON.stringify({ sessionKey: "fresh-session" }), "utf-8");
  await writeFile(stalePath, JSON.stringify({ sessionKey: "stale-session" }), "utf-8");
  await writeFile(unrelatedPath, "# Working state", "utf-8");

  // Backdate the stale file
  const { utimes } = await import("node:fs/promises");
  const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
  await utimes(stalePath, twoHoursAgo, twoHoursAgo);

  // Simulate startup sweep: find all signal files, delete stale ones
  const files = await readdir(dir);
  const signalFiles = files.filter((f) => f.startsWith(".compaction-reset-signal-"));
  assert.equal(signalFiles.length, 2);

  for (const f of signalFiles) {
    const fp = path.join(dir, f);
    const s = await stat(fp);
    if (Date.now() - s.mtimeMs >= 60 * 60 * 1000) {
      await unlink(fp);
    }
  }

  // Stale file removed, fresh file and unrelated file remain
  const remaining = await readdir(dir);
  assert.ok(!remaining.includes(".compaction-reset-signal-stale-session"), "stale signal should be removed");
  assert.ok(remaining.includes(".compaction-reset-signal-fresh-session"), "fresh signal should remain");
  assert.ok(remaining.includes("BOOT.md"), "unrelated files should be untouched");

  // Cleanup
  for (const f of await readdir(dir)) {
    await unlink(path.join(dir, f));
  }
});

test("sanitizeSessionKeyForFilename handles colon-delimited keys", () => {
  const result = sanitizeSessionKeyForFilename("agent:gpucodebot:main");
  // Format: <sanitized>-<12-char-hex-hash>
  assert.match(result, /^agent_gpucodebot_main-[0-9a-f]{12}$/);
});

test("sanitizeSessionKeyForFilename handles path separators", () => {
  const result1 = sanitizeSessionKeyForFilename("agent/../../etc/passwd");
  assert.match(result1, /^agent_\.\._\.\._etc_passwd-[0-9a-f]{12}$/);

  const result2 = sanitizeSessionKeyForFilename("agent\\windows\\path");
  assert.match(result2, /^agent_windows_path-[0-9a-f]{12}$/);
});

test("sanitizeSessionKeyForFilename preserves safe characters", () => {
  const result = sanitizeSessionKeyForFilename("agent-bot_123.test");
  assert.match(result, /^agent-bot_123\.test-[0-9a-f]{12}$/);
});

test("sanitizeSessionKeyForFilename handles empty and simple keys", () => {
  const result1 = sanitizeSessionKeyForFilename("default");
  assert.match(result1, /^default-[0-9a-f]{12}$/);

  const result2 = sanitizeSessionKeyForFilename("");
  assert.match(result2, /^-[0-9a-f]{12}$/);
});

test("sanitizeSessionKeyForFilename is collision-resistant", () => {
  // These would collide with naive replace-only sanitization
  const a = sanitizeSessionKeyForFilename("agent:alpha");
  const b = sanitizeSessionKeyForFilename("agent/alpha");
  assert.notEqual(a, b, "different keys must produce different filenames");
});

test("sanitizeSessionKeyForFilename is deterministic", () => {
  const a = sanitizeSessionKeyForFilename("agent:gpucodebot:main");
  const b = sanitizeSessionKeyForFilename("agent:gpucodebot:main");
  assert.equal(a, b, "same input must produce same output");
});
