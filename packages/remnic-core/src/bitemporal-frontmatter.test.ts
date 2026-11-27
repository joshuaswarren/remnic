import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, readFile, rm } from "node:fs/promises";

import { StorageManager } from "./storage.js";
import { isValidityExpiredNow } from "./temporal-validity.js";


const OBSERVED = "2026-06-20T14:02:11.000Z";
const VALID_FROM = "2026-03-01T00:00:00.000Z";
const VALID_UNTIL = "2026-06-15T00:00:00.000Z";

test("round-trip: observedAt + eventTimeSource + valid_at survive write → readAllMemories", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-bitemporal-rt-"));
  try {
    const storage = new StorageManager(dir);
    await storage.ensureDirectories();

    const { id: id } = await storage.writeMemory("fact", "We moved offices in March.", {
      observedAt: OBSERVED,
      eventTimeSource: "extracted",
      validAt: VALID_FROM,
    });

    const memories = await storage.readAllMemories();
    const written = memories.find((m) => m.frontmatter.id === id);
    assert.ok(written, "fact must be discoverable after write");
    assert.equal(written!.frontmatter.observedAt, OBSERVED);
    assert.equal(written!.frontmatter.eventTimeSource, "extracted");
    assert.equal(written!.frontmatter.valid_at, VALID_FROM);
    assert.ok(typeof written!.frontmatter.created === "string" && written!.frontmatter.created!.length > 0);
    assert.ok(typeof written!.frontmatter.updated === "string" && written!.frontmatter.updated!.length > 0);
    assert.equal(written!.frontmatter.source, "extraction");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test("writeMemory normalizes arbitrary origin strings to unknown", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-origin-normalize-"));
  try {
    const storage = new StorageManager(dir);
    await storage.ensureDirectories();

    const { id } = await storage.writeMemory("fact", "Origin boundary test.", {
      origin: "weird\nvalue",
    });
    const written = (await storage.readAllMemories()).find((memory) => memory.frontmatter.id === id);
    assert.ok(written);
    const raw = await readFile(written!.path, "utf8");
    assert.match(raw, /^origin: unknown$/m);
    assert.doesNotMatch(raw, /weird/);
    assert.equal(written!.frontmatter.origin, "unknown");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("round-trip: invalid_at + forgottenAt coexist with observedAt/eventTimeSource (parser not corrupted)", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-bitemporal-coexist-"));
  try {
    const storage = new StorageManager(dir);
    await storage.ensureDirectories();

    const { id: id } = await storage.writeMemory("fact", "Old stack was Node 18.", {
      observedAt: OBSERVED,
      eventTimeSource: "assumed",
      validAt: VALID_FROM,
    });

    const before = await storage.readAllMemories();
    const memory = before.find((m) => m.frontmatter.id === id);
    assert.ok(memory);

    const ok = await storage.writeMemoryFrontmatter(memory!, {
      invalid_at: VALID_UNTIL,
      forgottenAt: "2026-07-01T00:00:00.000Z",
    });
    assert.equal(ok, true);

    const after = await storage.readAllMemories();
    const patched = after.find((m) => m.frontmatter.id === id);
    assert.ok(patched, "patched fact must be readable");
    const fm = patched!.frontmatter;
    assert.equal(fm.observedAt, OBSERVED);
    assert.equal(fm.eventTimeSource, "assumed");
    assert.equal(fm.valid_at, VALID_FROM);
    assert.equal(fm.invalid_at, VALID_UNTIL);
    assert.equal(fm.forgottenAt, "2026-07-01T00:00:00.000Z");
    assert.ok(typeof fm.created === "string" && fm.created!.length > 0);
    assert.ok(typeof fm.source === "string" && fm.source!.length > 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("legacy memory without bi-temporal fields reads cleanly — observedAt/eventTimeSource undefined", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-bitemporal-legacy-"));
  try {
    const storage = new StorageManager(dir);
    await storage.ensureDirectories();

    const { id: id } = await storage.writeMemory("fact", "Legacy fact pre-dating #1578.");

    const memories = await storage.readAllMemories();
    const written = memories.find((m) => m.frontmatter.id === id);
    assert.ok(written);
    assert.equal(written!.frontmatter.observedAt, undefined);
    assert.equal(written!.frontmatter.eventTimeSource, undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("garbage observedAt is rejected on write — corrupt timestamps cannot leak to disk", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-bitemporal-reject-"));
  try {
    const storage = new StorageManager(dir);
    await storage.ensureDirectories();

    await assert.rejects(
      () => storage.writeMemory("fact", "Bad observedAt.", { observedAt: "not-a-timestamp" }),
      /observedAt must be a valid ISO timestamp/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("isValidityExpiredNow: absent invalid_at → never expired (still valid)", () => {
  assert.equal(isValidityExpiredNow({ invalid_at: undefined }, Date.now()), false);
  assert.equal(isValidityExpiredNow({ invalid_at: "" }, Date.now()), false);
});

test("isValidityExpiredNow: invalid_at in the past → expired (interval ended)", () => {
  const now = Date.parse("2026-06-20T00:00:00.000Z");
  assert.equal(
    isValidityExpiredNow({ invalid_at: "2026-06-15T00:00:00.000Z" }, now),
    true,
  );
});

test("isValidityExpiredNow: invalid_at in the future → not expired (still within window)", () => {
  const now = Date.parse("2026-06-20T00:00:00.000Z");
  assert.equal(
    isValidityExpiredNow({ invalid_at: "2026-12-31T00:00:00.000Z" }, now),
    false,
  );
});

test("isValidityExpiredNow: exclusive end — invalid_at == now is EXPIRED ([from, until) ended)", () => {
  const boundary = Date.parse("2026-06-15T00:00:00.000Z");
  assert.equal(
    isValidityExpiredNow({ invalid_at: "2026-06-15T00:00:00.000Z" }, boundary),
    true,
  );
});

test("isValidityExpiredNow: status-orthogonal — considers invalid_at only, ignores status", () => {
  const now = Date.parse("2026-06-20T00:00:00.000Z");
  assert.equal(
    isValidityExpiredNow({ invalid_at: "2026-06-15T00:00:00.000Z" }, now),
    true,
  );
});
