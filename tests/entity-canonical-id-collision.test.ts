import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";

import { StorageManager, normalizeEntityName } from "../packages/remnic-core/src/storage.js";
import { getFingerprint } from "../packages/remnic-core/src/storage/entity-canonical-id-migration.js";

/**
 * A legacy entity file and its canonical successor can both exist with
 * DIFFERENT content — two files describing one entity is an ordinary operator
 * state. The canonical-id migration runs during directory initialization, so
 * throwing on that collision took the whole daemon down at boot, on every
 * restart, with no remediation path (AGENTS.md §37, batch renames with
 * duplicate targets).
 */
async function seedCollidingPair(dir: string): Promise<{ legacy: string; canonical: string }> {
  const storage = new StorageManager(dir);
  await storage.ensureDirectories();
  const name = "Nightly Ingest";
  // The production shape: the file KEEPS its old id as a filename while the
  // `Type:` inside was retyped, so the legacy file now normalizes onto an id
  // that a different file already owns.
  const legacyId = normalizeEntityName(name, "automation");
  const canonicalId = normalizeEntityName(name, "automation-cron-job");
  assert.notEqual(legacyId, canonicalId, "fixture must actually straddle the rename");
  const file = (heading: string, type: string, body: string) =>
    `---\nid: ${heading}\ncreated: 2026-03-01T00:00:00.000Z\nupdated: 2026-03-01T00:00:00.000Z\n---\n\n`
    + `# ${name}\n\n**Type:** ${type}\n\n${body}\n`;
  await writeFile(
    path.join(dir, "entities", `${legacyId}.md`),
    file(legacyId, "automation-cron-job", "Runs at 02:00."),
    "utf8",
  );
  await writeFile(
    path.join(dir, "entities", `${canonicalId}.md`),
    file(canonicalId, "automation-cron-job", "Runs at 02:00. Retries twice."),
    "utf8",
  );
  return { legacy: legacyId, canonical: canonicalId };
}

test("a legacy/canonical entity collision does not abort startup", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-entity-collision-"));
  try {
    const { legacy, canonical } = await seedCollidingPair(dir);
    // The reproduction: this used to reject with
    // "Cannot migrate legacy entity id ...: ... already exists." and exit 1.
    const storage = new StorageManager(dir);
    await storage.ensureDirectories();

    // Neither side is destroyed — the migration must never pick a winner.
    const legacyBody = await readFile(path.join(dir, "entities", `${legacy}.md`), "utf8");
    const canonicalBody = await readFile(path.join(dir, "entities", `${canonical}.md`), "utf8");
    assert.match(legacyBody, /Runs at 02:00\./);
    assert.match(canonicalBody, /Retries twice\./);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a blocked collision does not stall the rest of the migration", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-entity-collision-mixed-"));
  try {
    await seedCollidingPair(dir);
    // A second legacy entity with NO canonical counterpart must still migrate.
    const soloLegacy = normalizeEntityName("Weekly Report", "automation");
    const soloCanonical = normalizeEntityName("Weekly Report", "automation-cron-job");
    await writeFile(
      path.join(dir, "entities", `${soloLegacy}.md`),
      `---\nid: ${soloLegacy}\ncreated: 2026-03-01T00:00:00.000Z\nupdated: 2026-03-01T00:00:00.000Z\n---\n\n`
      + `# Weekly Report\n\n**Type:** automation-cron-job\n\nRuns Mondays.\n`,
      "utf8",
    );

    const storage = new StorageManager(dir);
    await storage.ensureDirectories();

    const migrated = await readFile(path.join(dir, "entities", `${soloCanonical}.md`), "utf8");
    assert.match(migrated, /Runs Mondays\./, "an unblocked pair must still reach its canonical id");
    // A copy that leaves the legacy file behind is not a migration.
    await assert.rejects(() => readFile(path.join(dir, "entities", `${soloLegacy}.md`), "utf8"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("two legacy files claiming one canonical id block each other, deterministically", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-entity-contested-"));
  try {
    const storage = new StorageManager(dir);
    await storage.ensureDirectories();
    const canonicalId = normalizeEntityName("Nightly Ingest", "automation-cron-job");
    const claimants = ["automation-nightly-ingest", "automation-legacy-nightly-ingest"];
    for (const [i, legacyId] of claimants.entries()) {
      await writeFile(
        path.join(dir, "entities", `${legacyId}.md`),
        `---\nid: ${legacyId}\ncreated: 2026-03-01T00:00:00.000Z\nupdated: 2026-03-01T00:00:00.000Z\n---\n\n`
        + `# Nightly Ingest\n\n**Type:** automation-cron-job\n\nClaimant ${i}.\n`,
        "utf8",
      );
    }

    await new StorageManager(dir).ensureDirectories();

    // Neither may win: readdir order is not stable, so letting one claim the
    // canonical id would canonicalize a DIFFERENT side on another host reading
    // identical data (§6). Both stay put until an operator merges them.
    for (const [i, legacyId] of claimants.entries()) {
      assert.match(
        await readFile(path.join(dir, "entities", `${legacyId}.md`), "utf8"),
        new RegExp(`Claimant ${i}\\.`),
      );
    }
    await assert.rejects(() => readFile(path.join(dir, "entities", `${canonicalId}.md`), "utf8"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a mapping persisted by an earlier run cannot outvote a later block", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-entity-stale-mapping-"));
  try {
    const storage = new StorageManager(dir);
    await storage.ensureDirectories();
    const canonicalId = normalizeEntityName("Nightly Ingest", "automation-cron-job");
    const firstLegacy = "automation-nightly-ingest";
    const secondLegacy = "automation-legacy-nightly-ingest";
    const entity = (id: string, body: string) =>
      `---\nid: ${id}\ncreated: 2026-03-01T00:00:00.000Z\nupdated: 2026-03-01T00:00:00.000Z\n---\n\n`
      + `# Nightly Ingest\n\n**Type:** automation-cron-job\n\n${body}\n`;
    await writeFile(path.join(dir, "entities", `${firstLegacy}.md`), entity(firstLegacy, "First."), "utf8");
    await writeFile(path.join(dir, "entities", `${secondLegacy}.md`), entity(secondLegacy, "Second."), "utf8");
    // Journal from a build that had already chosen a winner. Discovery refuses
    // to ADD a contested pair; the persisted entry must be dropped too, or the
    // stale state picks the winner that disk-only discovery declined to pick.
    await writeFile(
      path.join(dir, "state", "entity-canonical-id-migration-v1.json"),
      JSON.stringify({ version: 1, complete: true, mappings: { [firstLegacy]: canonicalId } }),
      "utf8",
    );

    // The damage is not to the entity files - the completed-state path leaves
    // those alone and rewrites REFERENCES, silently pointing memories at the
    // canonical file, i.e. choosing the winner while both files sit preserved.
    const factDir = path.join(dir, "facts", "2026-03-01");
    await mkdir(factDir, { recursive: true });
    await writeFile(
      path.join(factDir, "fact-contested.md"),
      `---\nid: fact-contested\ncategory: fact\nconfidence: 0.9\n`
      + `created: 2026-03-01T00:00:00.000Z\nupdated: 2026-03-01T00:00:00.000Z\n`
      + `entityRef: ${firstLegacy}\nstatus: active\n---\n\nThe ingest runs nightly.\n`,
      "utf8",
    );

    await new StorageManager(dir).ensureDirectories();

    assert.match(await readFile(path.join(dir, "entities", `${firstLegacy}.md`), "utf8"), /First\./);
    assert.match(await readFile(path.join(dir, "entities", `${secondLegacy}.md`), "utf8"), /Second\./);
    await assert.rejects(() => readFile(path.join(dir, "entities", `${canonicalId}.md`), "utf8"));
    assert.equal(
      /^entityRef: (.*)$/m.exec(await readFile(path.join(factDir, "fact-contested.md"), "utf8"))?.[1],
      firstLegacy,
      "a blocked pair must not have its references redirected to the contested canonical id",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("resolving a collision lets the pair migrate, references included", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-entity-unblocked-"));
  try {
    const { legacy, canonical } = await seedCollidingPair(dir);
    const factDir = path.join(dir, "facts", "2026-03-01");
    await mkdir(factDir, { recursive: true });
    const factPath = path.join(factDir, "fact-unblocked.md");
    await writeFile(
      factPath,
      `---\nid: fact-unblocked\ncategory: fact\nconfidence: 0.9\n`
      + `created: 2026-03-01T00:00:00.000Z\nupdated: 2026-03-01T00:00:00.000Z\n`
      + `entityRef: ${legacy}\nstatus: active\n---\n\nThe ingest runs nightly.\n`,
      "utf8",
    );
    await new StorageManager(dir).ensureDirectories();
    assert.equal(
      /^entityRef: (.*)$/m.exec(await readFile(factPath, "utf8"))?.[1], legacy, "blocked while contested",
    );

    // The operator resolves it the documented way: one side goes.
    await rm(path.join(dir, "entities", `${canonical}.md`));
    await new StorageManager(dir).ensureDirectories();

    // A stale block must not survive the resolution: the file moves AND the
    // reference follows it, or memories point at a filename that is gone.
    await assert.rejects(() => readFile(path.join(dir, "entities", `${legacy}.md`), "utf8"));
    assert.match(await readFile(path.join(dir, "entities", `${canonical}.md`), "utf8"), /Runs at 02:00\./);
    assert.equal(/^entityRef: (.*)$/m.exec(await readFile(factPath, "utf8"))?.[1], canonical);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("deleting the legacy side still rewrites references to the canonical id", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-entity-legacy-deleted-"));
  try {
    const { legacy, canonical } = await seedCollidingPair(dir);
    const factDir = path.join(dir, "facts", "2026-03-01");
    await mkdir(factDir, { recursive: true });
    const factPath = path.join(factDir, "fact-legacy-side.md");
    await writeFile(
      factPath,
      `---\nid: fact-legacy-side\ncategory: fact\nconfidence: 0.9\n`
      + `created: 2026-03-01T00:00:00.000Z\nupdated: 2026-03-01T00:00:00.000Z\n`
      + `entityRef: ${legacy}\nstatus: active\n---\n\nThe ingest runs nightly.\n`,
      "utf8",
    );
    await new StorageManager(dir).ensureDirectories();

    // The other documented resolution: keep the canonical file, drop the legacy
    // one. No later scan can rediscover the pair — the legacy filename is gone
    // — so the parked record is the only thing that can still fix references.
    await rm(path.join(dir, "entities", `${legacy}.md`));
    await new StorageManager(dir).ensureDirectories();

    const rewritten = await readFile(factPath, "utf8");
    assert.equal(
      /^entityRef: (.*)$/m.exec(rewritten)?.[1],
      canonical,
      "a reference must not be stranded on a legacy id whose file was removed",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});


test("a re-normalized collision replaces the journal's stale target", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-entity-stale-target-"));
  try {
    const { legacy, canonical } = await seedCollidingPair(dir);
    const stale = "automation-cron-job-obsolete-target";
    // The journal remembers a target from before a normalization change. The
    // pair is contested NOW against `canonical`, so that is the only target
    // that may ever be promoted — the stale one names no file on disk.
    await writeFile(
      path.join(dir, "state", "entity-canonical-id-migration-v1.json"),
      JSON.stringify({ version: 1, complete: false, mappings: {}, blocked: { [legacy]: stale } }),
      "utf8",
    );
    const factDir = path.join(dir, "facts", "2026-03-01");
    await mkdir(factDir, { recursive: true });
    const factPath = path.join(factDir, "fact-stale-target.md");
    await writeFile(
      factPath,
      `---\nid: fact-stale-target\ncategory: fact\nconfidence: 0.9\n`
      + `created: 2026-03-01T00:00:00.000Z\nupdated: 2026-03-01T00:00:00.000Z\n`
      + `entityRef: ${legacy}\nstatus: active\n---\n\nThe ingest runs nightly.\n`,
      "utf8",
    );

    await new StorageManager(dir).ensureDirectories();
    await rm(path.join(dir, "entities", `${legacy}.md`));
    await new StorageManager(dir).ensureDirectories();

    assert.equal(
      /^entityRef: (.*)$/m.exec(await readFile(factPath, "utf8"))?.[1],
      canonical,
      "promotion must use the collision detected on disk, not a stale journal target",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a stale park never outranks a migration this scan discovered", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-entity-stale-vs-active-"));
  try {
    const storage = new StorageManager(dir);
    await storage.ensureDirectories();
    const legacy = normalizeEntityName("Weekly Report", "automation");
    const canonical = normalizeEntityName("Weekly Report", "automation-cron-job");
    const stale = "automation-cron-job-obsolete-report";
    // No collision this time: the pair migrates cleanly. The journal's parked
    // entry is left over from an earlier normalization and must not resurrect
    // once the rename makes the legacy filename disappear.
    await writeFile(
      path.join(dir, "entities", `${legacy}.md`),
      `---\nid: ${legacy}\ncreated: 2026-03-01T00:00:00.000Z\nupdated: 2026-03-01T00:00:00.000Z\n---\n\n`
      + `# Weekly Report\n\n**Type:** automation-cron-job\n\nRuns Mondays.\n`,
      "utf8",
    );
    await writeFile(
      path.join(dir, "state", "entity-canonical-id-migration-v1.json"),
      JSON.stringify({ version: 1, complete: false, mappings: {}, blocked: { [legacy]: stale } }),
      "utf8",
    );
    const factDir = path.join(dir, "facts", "2026-03-01");
    await mkdir(factDir, { recursive: true });
    const factPath = path.join(factDir, "fact-active-wins.md");
    await writeFile(
      factPath,
      `---\nid: fact-active-wins\ncategory: fact\nconfidence: 0.9\n`
      + `created: 2026-03-01T00:00:00.000Z\nupdated: 2026-03-01T00:00:00.000Z\n`
      + `entityRef: ${legacy}\nstatus: active\n---\n\nThe report runs weekly.\n`,
      "utf8",
    );

    await new StorageManager(dir).ensureDirectories();
    await new StorageManager(dir).ensureDirectories();

    assert.match(await readFile(path.join(dir, "entities", `${canonical}.md`), "utf8"), /Runs Mondays\./);
    assert.equal(
      /^entityRef: (.*)$/m.exec(await readFile(factPath, "utf8"))?.[1],
      canonical,
      "the live migration target must win over a leftover parked one",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a park is dropped once its source needs no migration", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-entity-self-canonical-"));
  try {
    const storage = new StorageManager(dir);
    await storage.ensureDirectories();
    const selfCanonical = normalizeEntityName("Nightly Ingest", "automation");
    const stale = "automation-cron-job-nightly-ingest";
    // Under the current normalization this file IS its own canonical id, so the
    // scan reports neither a mapping nor a collision. A park left from an older
    // normalization must not survive that silence.
    await writeFile(
      path.join(dir, "entities", `${selfCanonical}.md`),
      `---\nid: ${selfCanonical}\ncreated: 2026-03-01T00:00:00.000Z\nupdated: 2026-03-01T00:00:00.000Z\n---\n\n`
      + `# Nightly Ingest\n\n**Type:** automation\n\nRuns at 02:00.\n`,
      "utf8",
    );
    await writeFile(
      path.join(dir, "entities", `${stale}.md`),
      `---\nid: ${stale}\ncreated: 2026-03-01T00:00:00.000Z\nupdated: 2026-03-01T00:00:00.000Z\n---\n\n`
      + `# Nightly Ingest\n\n**Type:** automation-cron-job\n\nAn unrelated entity.\n`,
      "utf8",
    );
    await writeFile(
      path.join(dir, "state", "entity-canonical-id-migration-v1.json"),
      JSON.stringify({ version: 1, complete: false, mappings: {}, blocked: { [selfCanonical]: stale } }),
      "utf8",
    );
    const factDir = path.join(dir, "facts", "2026-03-01");
    await mkdir(factDir, { recursive: true });
    const factPath = path.join(factDir, "fact-self-canonical.md");
    await writeFile(
      factPath,
      `---\nid: fact-self-canonical\ncategory: fact\nconfidence: 0.9\n`
      + `created: 2026-03-01T00:00:00.000Z\nupdated: 2026-03-01T00:00:00.000Z\n`
      + `entityRef: ${selfCanonical}\nstatus: active\n---\n\nThe ingest runs nightly.\n`,
      "utf8",
    );

    await new StorageManager(dir).ensureDirectories();
    await rm(path.join(dir, "entities", `${selfCanonical}.md`));
    await new StorageManager(dir).ensureDirectories();

    assert.equal(
      /^entityRef: (.*)$/m.exec(await readFile(factPath, "utf8"))?.[1],
      selfCanonical,
      "deleting a self-canonical entity must not redirect its references to an unrelated one",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a park whose legacy file is already gone still rewrites references", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-entity-rescan-park-"));
  try {
    const storage = new StorageManager(dir);
    await storage.ensureDirectories();
    const legacy = normalizeEntityName("Weekly Report", "automation");
    const canonical = normalizeEntityName("Weekly Report", "automation-cron-job");
    await writeFile(
      path.join(dir, "entities", `${canonical}.md`),
      `---\nid: ${canonical}\ncreated: 2026-03-01T00:00:00.000Z\nupdated: 2026-03-01T00:00:00.000Z\n---\n\n`
      + `# Weekly Report\n\n**Type:** automation-cron-job\n\nRuns Mondays.\n`,
      "utf8",
    );
    // The legacy file is already gone (resolved out of band) while the journal
    // still parks the pair and holds no active mappings - the zero-mapping
    // path. Completing without reconciling would seal the park behind a
    // fingerprint that already covers the deletion, so no later run revisits
    // it. This pins the observable contract; the mid-run race (resolution
    // landing BETWEEN the initial scan and the rescan) is covered by the
    // reconcile call in that branch but is not drivable from a test.
    await writeFile(
      path.join(dir, "state", "entity-canonical-id-migration-v1.json"),
      JSON.stringify({ version: 1, complete: false, mappings: {}, blocked: { [legacy]: canonical } }),
      "utf8",
    );
    const factDir = path.join(dir, "facts", "2026-03-01");
    await mkdir(factDir, { recursive: true });
    const factPath = path.join(factDir, "fact-rescan-park.md");
    await writeFile(
      factPath,
      `---\nid: fact-rescan-park\ncategory: fact\nconfidence: 0.9\n`
      + `created: 2026-03-01T00:00:00.000Z\nupdated: 2026-03-01T00:00:00.000Z\n`
      + `entityRef: ${legacy}\nstatus: active\n---\n\nThe report runs weekly.\n`,
      "utf8",
    );

    await new StorageManager(dir).ensureDirectories();

    assert.equal(
      /^entityRef: (.*)$/m.exec(await readFile(factPath, "utf8"))?.[1],
      canonical,
      "a park resolved before completion must still rewrite its references",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a stable completed journal with retained mappings is a no-op on re-init", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-entity-stable-journal-"));
  try {
    // Reach the steady state every long-lived deployment lands in: a
    // completed migration whose journal retains mappings for read compat
    // (here via the delete-the-legacy-side resolution, as above).
    const { legacy, canonical } = await seedCollidingPair(dir);
    await new StorageManager(dir).ensureDirectories();
    await rm(path.join(dir, "entities", `${legacy}.md`));
    await new StorageManager(dir).ensureDirectories();

    // Re-initializing on that stable journal must be a pure no-op (issue
    // #2213): the old fast path re-ran the full-corpus reference rewrite and
    // bumped memory-status (invalidating every cache) on EVERY
    // ensureDirectories — a hot loop on write-active daemons.
    const storage = new StorageManager(dir);
    const statusBefore = storage.getMemoryStatusVersion();
    await storage.ensureDirectories();
    assert.equal(
      storage.getMemoryStatusVersion(),
      statusBefore,
      "a stable completed journal must not bump memory-status (cache-invalidation churn) on re-init",
    );
    // The retained mapping still serves reads.
    assert.equal(storage.normalizeEntityName("Nightly Ingest", "automation"), canonical);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("plain memory writes do not change the migration fingerprint; entity writes do", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-entity-fingerprint-"));
  try {
    const storage = new StorageManager(dir);
    await storage.ensureDirectories();
    // Same provider the runner AND adapter use: the entity-mutation sentinel,
    // NOT memory-status — a regression bumping it on plain fact writes must
    // fail this test (it would reintroduce the #2213 hot loop).
    const readFp = () =>
      getFingerprint(dir, path.join(dir, "entities"), () => String(storage.getEntityMutationVersion()));

    const before = await readFp();
    const first = await storage.writeMemory("fact", "The ingest runs nightly.");
    const second = await storage.writeMemory("fact", "The ingest runs at 02:00 nightly.");
    assert.equal(
      await readFp(),
      before,
      "a plain fact create must not re-trigger the canonical-id migration (issue #2213)",
    );
    // A REAL supersession bumps memory-status; the migration fingerprint must
    // not move with it.
    assert.equal(await storage.supersedeMemory(first.id, second.id, "test"), true);
    assert.equal(
      await readFp(),
      before,
      "status/lifecycle version bumps must not re-trigger the canonical-id migration",
    );

    await storage.writeEntity("Nightly Ingest", "automation-cron-job", ["Runs at 02:00."]);
    assert.notEqual(await readFp(), before, "an entity mutation must re-trigger the migration");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("an external in-place entity edit reopens a completed migration", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-entity-external-edit-"));
  try {
    const storage = new StorageManager(dir);
    await storage.ensureDirectories();
    const oldCanonical = await storage.writeEntity("Alpha One", "project", ["Tracks the alpha rollout."]);
    const newCanonical = normalizeEntityName("Bravo Two", "project");
    assert.notEqual(oldCanonical, newCanonical);

    const memory = await storage.writeMemory("fact", "Alpha One tracks the rollout.");
    const written = (await storage.readAllMemories()).find(
      (candidate) => candidate.frontmatter.id === memory.id,
    );
    assert.ok(written);
    await storage.writeMemoryFrontmatter(written, { entityRef: oldCanonical });
    await storage.ensureDirectories();

    const entitiesDir = path.join(dir, "entities");
    const oldPath = path.join(entitiesDir, `${oldCanonical}.md`);
    const beforeFingerprint = await getFingerprint(
      dir,
      entitiesDir,
      () => String(storage.getEntityMutationVersion()),
    );
    const beforeMutationVersion = storage.getEntityMutationVersion();
    const beforeDirectory = await stat(entitiesDir);
    const externalContent = (await readFile(oldPath, "utf8")).replace("# Alpha One", "# Bravo Two");
    await writeFile(oldPath, externalContent, "utf8");
    await utimes(oldPath, new Date("2030-01-01T00:00:00.000Z"), new Date("2030-01-01T00:00:00.000Z"));

    const afterDirectory = await stat(entitiesDir);
    assert.deepEqual(
      [afterDirectory.dev, afterDirectory.ino, afterDirectory.mtimeMs, afterDirectory.ctimeMs, afterDirectory.size],
      [beforeDirectory.dev, beforeDirectory.ino, beforeDirectory.mtimeMs, beforeDirectory.ctimeMs, beforeDirectory.size],
      "rewriting an existing entry must not rely on parent-directory metadata changing",
    );
    assert.equal(
      storage.getEntityMutationVersion(),
      beforeMutationVersion,
      "an external editor cannot advance the cooperative entity-mutation sentinel",
    );
    assert.notEqual(
      await getFingerprint(dir, entitiesDir, () => String(storage.getEntityMutationVersion())),
      beforeFingerprint,
      "the migration fingerprint must include metadata for each entity page",
    );

    await storage.ensureDirectories();
    await assert.rejects(() => readFile(oldPath, "utf8"));
    assert.match(await readFile(path.join(entitiesDir, `${newCanonical}.md`), "utf8"), /# Bravo Two/);
    assert.equal(
      /^entityRef: (.*)$/m.exec(await readFile(written.path, "utf8"))?.[1],
      newCanonical,
      "the reopened migration must rewrite references to the changed canonical id",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("addEntityRelationship resolves legacy ids on both ends after migration", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-entity-relationship-canonical-"));
  try {
    // Steady state: completed migration retaining the legacy→canonical mapping.
    const { legacy, canonical } = await seedCollidingPair(dir);
    await new StorageManager(dir).ensureDirectories();
    await rm(path.join(dir, "entities", `${legacy}.md`));
    await new StorageManager(dir).ensureDirectories();

    const storage = new StorageManager(dir);
    await storage.ensureDirectories();
    const other = normalizeEntityName("Backup Sync", "automation-cron-job");
    await storage.writeEntity("Backup Sync", "automation-cron-job", ["Runs at 03:00."]);

    // Legacy id as the entity being written: the legacy file no longer
    // exists, so an unresolved lookup would silently no-op — the edge must
    // land on the canonical file instead.
    await storage.addEntityRelationship(legacy, { target: other, label: "precedes" });
    assert.match(
      await readFile(path.join(dir, "entities", `${canonical}.md`), "utf8"),
      new RegExp(`\\[\\[${other}\\]\\] — precedes`),
    );

    // Legacy id as a relationship target: the stored edge must name the
    // canonical id, never a node the migration renamed away (issue #2213 —
    // extraction persists LLM-supplied relationship endpoints verbatim).
    await storage.addEntityRelationship(other, { target: legacy, label: "follows" });
    const backup = await readFile(path.join(dir, "entities", `${other}.md`), "utf8");
    assert.match(backup, new RegExp(`\\[\\[${canonical}\\]\\] — follows`));
    assert.doesNotMatch(backup, new RegExp(`\\[\\[${legacy}\\]\\]`));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a manager that predates a peer's migration still canonicalizes reference writes", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-entity-stale-manager-"));
  try {
    // Manager A exists BEFORE any migration journal does.
    const a = new StorageManager(dir);
    await a.ensureDirectories();
    const written = await a.writeMemory("fact", "The ingest runs nightly.");

    // A peer manager seeds a collision, resolves it, and completes the
    // migration — A never re-runs ensureDirectories after this.
    const { legacy, canonical } = await seedCollidingPair(dir);
    await new StorageManager(dir).ensureDirectories();
    await rm(path.join(dir, "entities", `${legacy}.md`));
    await new StorageManager(dir).ensureDirectories();

    // A's reference-mutating write must resolve through the CURRENT journal,
    // not a constructor-time snapshot: the mapping table is keyed by the
    // shared memory-status version, which the peer's migration bumped.
    const memory = (await a.readAllMemories()).find((m) => m.frontmatter.id === written.id);
    assert.ok(memory, "fixture must persist the fact");
    await a.writeMemoryFrontmatter(memory, { entityRef: legacy });
    assert.match(await readFile(memory.path, "utf-8"), new RegExp(`entityRef: ${canonical}`));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a park written without any version bump still invalidates peer mapping caches", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-entity-park-invalidation-"));
  try {
    // Completed migration retaining legacy→canonical.
    const { legacy, canonical } = await seedCollidingPair(dir);
    await new StorageManager(dir).ensureDirectories();
    await rm(path.join(dir, "entities", `${legacy}.md`));
    await new StorageManager(dir).ensureDirectories();

    // A long-lived manager loads the mapping and redirects the legacy id.
    const a = new StorageManager(dir);
    await a.ensureDirectories();
    assert.equal(a.normalizeEntityName("Nightly Ingest", "automation"), canonical);

    // The collision re-forms out of band; a peer's migration run parks the
    // mapping — pruneBlocked rewrites the journal WITHOUT bumping any shared
    // version. The stale manager must stop redirecting the contested id.
    await writeFile(
      path.join(dir, "entities", `${legacy}.md`),
      `---\nid: ${legacy}\ncreated: 2026-03-02T00:00:00.000Z\nupdated: 2026-03-02T00:00:00.000Z\n---\n\n`
      + `# Nightly Ingest\n\n**Type:** automation-cron-job\n\nRuns at 04:00 — diverged.\n`,
      "utf8",
    );
    await new StorageManager(dir).ensureDirectories();
    assert.equal(
      a.normalizeEntityName("Nightly Ingest", "automation"),
      legacy,
      "a parked mapping must not keep redirecting through a stale in-memory table",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("an offline-sync raw write triggers one reconcile pass, then quiesces", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-entity-reconcile-marker-"));
  try {
    // Completed migration retaining legacy→canonical.
    const { legacy, canonical } = await seedCollidingPair(dir);
    await new StorageManager(dir).ensureDirectories();
    await rm(path.join(dir, "entities", `${legacy}.md`));
    await new StorageManager(dir).ensureDirectories();

    // Offline sync replicates a memory file with a legacy entityRef — raw
    // bytes the store cannot canonicalize inline. The write must request a
    // reconcile pass (issue #2213).
    const storage = new StorageManager(dir);
    await storage.ensureDirectories();
    const syncedPath = path.join(dir, "facts", "2026-03-01", "fact-synced.md");
    await storage.writeOfflineSyncFile(
      syncedPath,
      Buffer.from(
        `---\nid: fact-synced\ncategory: fact\nconfidence: 0.9\n`
        + `created: 2026-03-01T00:00:00.000Z\nupdated: 2026-03-01T00:00:00.000Z\n`
        + `entityRef: ${legacy}\nstatus: active\n---\n\nSynced from a peer.\n`,
        "utf-8",
      ),
    );
    const marker = path.join(dir, "state", "entity-canonical-id-reconcile.pending");
    assert.match(await readFile(marker, "utf8"), /T/, "raw sync write must request reconciliation");

    // A fresh init honors the marker: the reference is rewritten and the
    // marker consumed.
    await new StorageManager(dir).ensureDirectories();
    assert.equal(/^entityRef: (.*)$/m.exec(await readFile(syncedPath, "utf8"))?.[1], canonical);
    await assert.rejects(() => readFile(marker, "utf8"), "the reconcile marker must be consumed");

    // And the pass does not loop: with the marker gone, a re-init is a no-op.
    const idle = new StorageManager(dir);
    const statusBefore = idle.getMemoryStatusVersion();
    await idle.ensureDirectories();
    assert.equal(idle.getMemoryStatusVersion(), statusBefore);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a .consuming marker left by a crashed run still triggers the reconcile pass", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-entity-reconcile-crash-"));
  try {
    const { legacy, canonical } = await seedCollidingPair(dir);
    await new StorageManager(dir).ensureDirectories();
    await rm(path.join(dir, "entities", `${legacy}.md`));
    await new StorageManager(dir).ensureDirectories();

    // Simulate a crash mid-reconcile: the marker generation was renamed
    // aside but never consumed, and the raw-written file was not rewritten.
    const rawPath = path.join(dir, "facts", "2026-03-01", "fact-crashed.md");
    await mkdir(path.dirname(rawPath), { recursive: true });
    await writeFile(
      rawPath,
      `---\nid: fact-crashed\ncategory: fact\nconfidence: 0.9\n`
      + `created: 2026-03-01T00:00:00.000Z\nupdated: 2026-03-01T00:00:00.000Z\n`
      + `entityRef: ${legacy}\nstatus: active\n---\n\nLanded before the crash.\n`,
      "utf8",
    );
    const consuming = path.join(dir, "state", "entity-canonical-id-reconcile.pending.consuming");
    await writeFile(consuming, "2026-03-01T00:00:00.000Z\n", "utf8");

    await new StorageManager(dir).ensureDirectories();
    assert.equal(/^entityRef: (.*)$/m.exec(await readFile(rawPath, "utf8"))?.[1], canonical);
    await assert.rejects(() => readFile(consuming, "utf8"), "a crashed generation must be consumed");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("addEntityRelationship falls back to the legacy file while its rename is in flight", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-entity-midflight-"));
  try {
    const storage = new StorageManager(dir);
    await storage.ensureDirectories();
    const legacy = normalizeEntityName("Nightly Ingest", "automation");
    const canonical = normalizeEntityName("Nightly Ingest", "automation-cron-job");
    // The mid-migration window: the journal already maps legacy → canonical,
    // but the entity file has not physically moved yet.
    await writeFile(
      path.join(dir, "entities", `${legacy}.md`),
      `---\nid: ${legacy}\ncreated: 2026-03-01T00:00:00.000Z\nupdated: 2026-03-01T00:00:00.000Z\n---\n\n`
      + `# Nightly Ingest\n\n**Type:** automation-cron-job\n\nRuns at 02:00.\n`,
      "utf8",
    );
    await writeFile(
      path.join(dir, "state", "entity-canonical-id-migration-v1.json"),
      JSON.stringify({ version: 1, complete: false, mappings: { [legacy]: canonical } }),
      "utf8",
    );

    // Resolving only the canonical path (whose file does not exist yet) would
    // silently drop the edge; the fallback must land it on the legacy file.
    await storage.addEntityRelationship(legacy, { target: "automation-cron-job-backup-sync", label: "precedes" });
    assert.match(
      await readFile(path.join(dir, "entities", `${legacy}.md`), "utf8"),
      /\[\[automation-cron-job-backup-sync\]\] — precedes/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a persisted mapping whose both entity files are gone does not abort startup", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-entity-both-missing-"));
  try {
    const storage = new StorageManager(dir);
    await storage.ensureDirectories();
    const legacy = "task-inventory-mapping";
    const canonical = normalizeEntityName("Task inventory mapping", "project");
    await writeFile(
      path.join(dir, "state", "entity-canonical-id-migration-v1.json"),
      JSON.stringify({ version: 1, complete: false, mappings: { [legacy]: canonical } }),
      "utf8",
    );

    await new StorageManager(dir).ensureDirectories();

    const journal = JSON.parse(
      await readFile(path.join(dir, "state", "entity-canonical-id-migration-v1.json"), "utf8"),
    ) as { mappings?: Record<string, string>; blocked?: Record<string, string> };
    assert.equal(journal.mappings?.[legacy], undefined);
    assert.equal(journal.blocked?.[legacy], undefined, "a park whose files are gone is dropped, not sealed");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a parked target is promoted through an active move before its park is dropped", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-entity-park-promote-"));
  try {
    const storage = new StorageManager(dir);
    await storage.ensureDirectories();
    const name = "Task inventory mapping";
    const legacy = "task-inventory-mapping";
    const movedTarget = normalizeEntityName(name, "task");
    const live = normalizeEntityName(name, "automation");
    assert.notEqual(movedTarget, live);
    // Only the final canonical file survives on disk; the intermediate
    // target was moved out-of-band. The journal still parks A -> B beside
    // the active B -> C.
    await writeFile(
      path.join(dir, "entities", `${live}.md`),
      `---\nid: ${live}\ncreated: 2026-03-01T00:00:00.000Z\nupdated: 2026-03-01T00:00:00.000Z\n---\n\n`
      + `# ${name}\n\n**Type:** automation\n\nLive target.\n`,
      "utf8",
    );
    await writeFile(
      path.join(dir, "state", "entity-canonical-id-migration-v1.json"),
      JSON.stringify({
        version: 1,
        complete: false,
        mappings: { [movedTarget]: live },
        blocked: { [legacy]: movedTarget },
      }),
      "utf8",
    );
    const factDir = path.join(dir, "facts", "2026-03-01");
    await mkdir(factDir, { recursive: true });
    const factPath = path.join(factDir, "fact-park-promote.md");
    await writeFile(
      factPath,
      `---\nid: fact-park-promote\ncategory: fact\nconfidence: 0.9\n`
      + `created: 2026-03-01T00:00:00.000Z\nupdated: 2026-03-01T00:00:00.000Z\n`
      + `entityRef: ${legacy}\nstatus: active\n---\n\nThe mapping tracks tasks.\n`,
      "utf8",
    );

    await new StorageManager(dir).ensureDirectories();

    assert.equal(
      /^entityRef: (.*)$/m.exec(await readFile(factPath, "utf8"))?.[1],
      live,
      "a park must promote through the active move instead of stranding its references",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a persisted mapping whose Type now normalizes to a new canonical id does not abort startup", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-entity-retarget-"));
  try {
    const storage = new StorageManager(dir);
    await storage.ensureDirectories();
    const name = "Task inventory mapping";
    const legacy = normalizeEntityName(name, "task");
    const staleCanonical = normalizeEntityName(name, "project");
    const liveCanonical = normalizeEntityName(name, "automation");
    assert.notEqual(staleCanonical, liveCanonical);
    await writeFile(
      path.join(dir, "entities", `${legacy}.md`),
      `---\nid: ${legacy}\ncreated: 2026-03-01T00:00:00.000Z\nupdated: 2026-03-01T00:00:00.000Z\n---\n\n`
      + `# ${name}\n\n**Type:** automation\n\nLive type.\n`,
      "utf8",
    );
    await writeFile(
      path.join(dir, "state", "entity-canonical-id-migration-v1.json"),
      JSON.stringify({ version: 1, complete: false, mappings: { [legacy]: staleCanonical } }),
      "utf8",
    );

    await new StorageManager(dir).ensureDirectories();

    const live = await readFile(path.join(dir, "entities", `${liveCanonical}.md`), "utf8").catch(() =>
      readFile(path.join(dir, "entities", `${legacy}.md`), "utf8"),
    );
    assert.match(live, /Live type\./);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

