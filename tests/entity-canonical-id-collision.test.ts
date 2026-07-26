import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";

import { StorageManager, normalizeEntityName } from "../packages/remnic-core/src/storage.js";

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
