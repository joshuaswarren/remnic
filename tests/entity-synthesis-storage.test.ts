import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import {
  StorageManager,
  compareEntityTimestamps,
  isEntitySynthesisStale,
  normalizeEntityName,
  parseEntityFile,
  serializeEntityFile,
} from "../packages/remnic-core/src/storage.js";
import { parseConfig } from "../packages/remnic-core/src/config.js";

test("writeEntity appends timeline evidence and marks older synthesis as stale", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-entity-synthesis-storage-"));
  try {
    const storage = new StorageManager(dir);
    await storage.ensureDirectories();

    const entityName = "Jane Doe";
    const entityType = "person";
    const canonical = normalizeEntityName(entityName, entityType);

    await storage.writeEntity(entityName, entityType, ["Leads the roadmap."], {
      timestamp: "2026-04-13T10:00:00.000Z",
      source: "extraction",
      sessionKey: "session-1",
      principal: "agent:main",
    });
    await storage.updateEntitySynthesis(canonical, "Jane Doe leads the roadmap.", {
      updatedAt: "2026-04-13T10:05:00.000Z",
    });

    await storage.writeEntity(entityName, entityType, ["Owns release approvals now."], {
      timestamp: "2026-04-13T11:00:00.000Z",
      source: "extraction",
      sessionKey: "session-2",
      principal: "agent:main",
    });

    const raw = await readFile(path.join(dir, "entities", `${canonical}.md`), "utf-8");
    const parsed = parseEntityFile(raw);

    assert.match(raw, /^---\n[\s\S]*synthesis_updated_at:/);
    assert.match(raw, /## Synthesis/);
    assert.match(raw, /## Timeline/);
    assert.equal(parsed.timeline.length, 2);
    assert.equal(parsed.timeline[0]?.text, "Leads the roadmap.");
    assert.equal(parsed.timeline[1]?.text, "Owns release approvals now.");
    assert.equal(parsed.timeline[1]?.sessionKey, "session-2");
    assert.equal(parsed.synthesis, "Jane Doe leads the roadmap.");
    assert.equal(isEntitySynthesisStale(parsed), true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("readEntity rejects names that escape the entities directory", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-entity-read-path-"));
  try {
    const storage = new StorageManager(dir);
    await storage.ensureDirectories();

    await writeFile(path.join(dir, "profile.md"), "outside entities", "utf-8");
    await writeFile(path.join(dir, "entities", "person-jane-doe.md"), "inside entities", "utf-8");

    assert.equal(await storage.readEntity("../profile"), "");
    assert.equal(await storage.readEntity("person-jane-doe"), "inside entities");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("writeEntity preserves structured sections alongside timeline evidence", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-entity-structured-sections-"));
  try {
    const storage = new StorageManager(dir);
    await storage.ensureDirectories();

    const entityName = "Jane Doe";
    const entityType = "person";
    const canonical = normalizeEntityName(entityName, entityType);

    await storage.writeEntity(entityName, entityType, ["Leads the roadmap."], {
      timestamp: "2026-04-13T10:00:00.000Z",
      source: "extraction",
      structuredSections: [
        {
          key: "beliefs",
          title: "Beliefs",
          facts: ["Small teams move faster than committees."],
        },
      ],
    });

    await storage.writeEntity(entityName, entityType, ["Owns release approvals now."], {
      timestamp: "2026-04-13T11:00:00.000Z",
      source: "extraction",
      structuredSections: [
        {
          key: "beliefs",
          title: "Beliefs",
          facts: ["Roadmaps should stay legible to the team."],
        },
      ],
    });

    const parsed = parseEntityFile(
      await readFile(path.join(dir, "entities", `${canonical}.md`), "utf-8"),
    ) as any;

    assert.deepEqual(parsed.structuredSections, [
      {
        key: "beliefs",
        title: "Beliefs",
        facts: [
          "Small teams move faster than committees.",
          "Roadmaps should stay legible to the team.",
        ],
      },
    ]);
    assert.deepEqual(parsed.facts, [
      "Leads the roadmap.",
      "Owns release approvals now.",
      "Small teams move faster than committees.",
      "Roadmaps should stay legible to the team.",
    ]);
    assert.equal(parsed.timeline.length, 2);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("writeEntity merges schema-backed sections even when incoming keys use raw casing", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-entity-structured-sections-schema-key-"));
  try {
    const storage = new StorageManager(dir);
    await storage.ensureDirectories();

    const entityName = "Jane Doe";
    const entityType = "person";
    const canonical = normalizeEntityName(entityName, entityType);

    await storage.writeEntity(entityName, entityType, [], {
      structuredSections: [
        {
          key: "beliefs",
          title: "Beliefs",
          facts: ["Small teams move faster than committees."],
        },
      ],
    });

    await storage.writeEntity(entityName, entityType, [], {
      structuredSections: [
        {
          key: "Beliefs",
          title: "Beliefs",
          facts: ["Roadmaps should stay legible to the team."],
        },
      ],
    });

    const parsed = parseEntityFile(
      await readFile(path.join(dir, "entities", `${canonical}.md`), "utf-8"),
    );
    const raw = await readFile(path.join(dir, "entities", `${canonical}.md`), "utf-8");

    assert.deepEqual(parsed.structuredSections, [
      {
        key: "beliefs",
        title: "Beliefs",
        facts: [
          "Small teams move faster than committees.",
          "Roadmaps should stay legible to the team.",
        ],
      },
    ]);
    assert.deepEqual(parsed.facts, [
      "Small teams move faster than committees.",
      "Roadmaps should stay legible to the team.",
    ]);
    assert.doesNotMatch(raw, /## Facts/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("writeEntity marks section-only evidence updates as stale after synthesis", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-entity-structured-sections-stale-"));
  try {
    const storage = new StorageManager(dir);
    await storage.ensureDirectories();

    const entityName = "Jane Doe";
    const entityType = "person";
    const canonical = normalizeEntityName(entityName, entityType);
    const timestamp = "2026-04-13T10:00:00.000Z";

    await storage.writeEntity(entityName, entityType, ["Initial fact before synthesis."], {
      timestamp,
      source: "extraction",
      structuredSections: [
        {
          key: "beliefs",
          title: "Beliefs",
          facts: ["Small teams move faster than committees."],
        },
      ],
    });
    await storage.updateEntitySynthesis(canonical, "Jane Doe keeps teams small and decisive.", {
      updatedAt: timestamp,
      entityUpdatedAt: timestamp,
      synthesisTimelineCount: 1,
    });

    const afterSynthesis = parseEntityFile(
      await readFile(path.join(dir, "entities", `${canonical}.md`), "utf-8"),
    );
    assert.equal(afterSynthesis.timeline.length, 1);
    assert.equal(afterSynthesis.synthesisTimelineCount, 1);
    assert.equal(isEntitySynthesisStale(afterSynthesis), false);

    await storage.writeEntity(entityName, entityType, [], {
      timestamp,
      source: "extraction",
      structuredSections: [
        {
          key: "beliefs",
          title: "Beliefs",
          facts: ["Roadmaps should stay legible to the team."],
        },
      ],
    });

    const parsed = parseEntityFile(
      await readFile(path.join(dir, "entities", `${canonical}.md`), "utf-8"),
    );
    assert.equal(parsed.timeline.length, 1);
    assert.equal(parsed.synthesisTimelineCount, 1);
    assert.deepEqual(parsed.structuredSections, [
      {
        key: "beliefs",
        title: "Beliefs",
        facts: [
          "Small teams move faster than committees.",
          "Roadmaps should stay legible to the team.",
        ],
      },
    ]);
    assert.equal(isEntitySynthesisStale(parsed), true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("updateEntitySynthesis honors an explicit structured fact snapshot count", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-entity-structured-sections-snapshot-"));
  try {
    const storage = new StorageManager(dir);
    await storage.ensureDirectories();

    const entityName = "Jane Doe";
    const entityType = "person";
    const canonical = normalizeEntityName(entityName, entityType);
    const timestamp = "2026-04-13T10:00:00.000Z";

    await storage.writeEntity(entityName, entityType, ["Initial fact before synthesis."], {
      timestamp,
      source: "extraction",
      structuredSections: [
        {
          key: "beliefs",
          title: "Beliefs",
          facts: ["Small teams move faster than committees."],
        },
      ],
    });
    await storage.updateEntitySynthesis(canonical, "Jane Doe keeps teams small and decisive.", {
      updatedAt: timestamp,
      entityUpdatedAt: timestamp,
      synthesisTimelineCount: 1,
      synthesisStructuredFactCount: 1,
    });

    await storage.writeEntity(entityName, entityType, [], {
      timestamp,
      source: "extraction",
      structuredSections: [
        {
          key: "beliefs",
          title: "Beliefs",
          facts: ["Roadmaps should stay legible to the team."],
        },
      ],
    });
    await storage.updateEntitySynthesis(canonical, "Jane Doe synthesis from the earlier structured snapshot.", {
      updatedAt: timestamp,
      entityUpdatedAt: timestamp,
      synthesisTimelineCount: 1,
      synthesisStructuredFactCount: 1,
    });

    const parsed = parseEntityFile(
      await readFile(path.join(dir, "entities", `${canonical}.md`), "utf-8"),
    );

    assert.equal(parsed.synthesisStructuredFactCount, 1);
    assert.equal(parsed.structuredSections?.[0]?.facts.length, 2);
    assert.equal(isEntitySynthesisStale(parsed), true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("entity synthesis becomes stale when structured fact content changes without changing the count", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-entity-structured-sections-digest-"));
  try {
    const storage = new StorageManager(dir);
    await storage.ensureDirectories();

    const entityName = "Jane Doe";
    const entityType = "person";
    const canonical = normalizeEntityName(entityName, entityType);
    const timestamp = "2026-04-13T10:00:00.000Z";
    const entityPath = path.join(dir, "entities", `${canonical}.md`);

    await storage.writeEntity(entityName, entityType, ["Initial fact before synthesis."], {
      timestamp,
      source: "extraction",
      structuredSections: [
        {
          key: "beliefs",
          title: "Beliefs",
          facts: ["Small teams move faster than committees."],
        },
      ],
    });
    await storage.updateEntitySynthesis(canonical, "Jane Doe keeps teams small and decisive.", {
      updatedAt: timestamp,
      entityUpdatedAt: timestamp,
      synthesisTimelineCount: 1,
      synthesisStructuredFactCount: 1,
    });

    const afterSynthesis = parseEntityFile(await readFile(entityPath, "utf-8"));
    assert.equal(afterSynthesis.synthesisStructuredFactCount, 1);
    assert.ok(afterSynthesis.synthesisStructuredFactDigest);
    assert.equal(isEntitySynthesisStale(afterSynthesis), false);

    const rewritten = {
      ...afterSynthesis,
      structuredSections: [
        {
          key: "beliefs",
          title: "Beliefs",
          facts: ["Roadmaps should stay legible to the team."],
        },
      ],
      facts: [
        "Initial fact before synthesis.",
        "Roadmaps should stay legible to the team.",
      ],
    };
    await writeFile(entityPath, serializeEntityFile(rewritten), "utf-8");

    const reparsed = parseEntityFile(await readFile(entityPath, "utf-8"));
    assert.equal(reparsed.structuredSections?.[0]?.facts.length, 1);
    assert.equal(reparsed.synthesisStructuredFactCount, 1);
    assert.ok(reparsed.synthesisStructuredFactDigest);
    assert.equal(isEntitySynthesisStale(reparsed), true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("isEntitySynthesisStale trims stored structured fact digests before comparing snapshots", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-entity-structured-sections-trimmed-digest-"));
  try {
    const storage = new StorageManager(dir);
    await storage.ensureDirectories();

    const entityName = "Jane Doe";
    const entityType = "person";
    const canonical = normalizeEntityName(entityName, entityType);
    const timestamp = "2026-04-13T10:00:00.000Z";
    const entityPath = path.join(dir, "entities", `${canonical}.md`);

    await storage.writeEntity(entityName, entityType, ["Initial fact before synthesis."], {
      timestamp,
      source: "extraction",
      structuredSections: [
        {
          key: "beliefs",
          title: "Beliefs",
          facts: ["Small teams move faster than committees."],
        },
      ],
    });
    await storage.updateEntitySynthesis(canonical, "Jane Doe keeps teams small and decisive.", {
      updatedAt: timestamp,
      entityUpdatedAt: timestamp,
      synthesisTimelineCount: 1,
      synthesisStructuredFactCount: 1,
    });

    const afterSynthesis = parseEntityFile(await readFile(entityPath, "utf-8"));
    const rewritten = {
      ...afterSynthesis,
      synthesisStructuredFactDigest: `${afterSynthesis.synthesisStructuredFactDigest ?? ""}  `,
    };
    await writeFile(entityPath, serializeEntityFile(rewritten), "utf-8");

    const reparsed = parseEntityFile(await readFile(entityPath, "utf-8"));
    assert.equal(isEntitySynthesisStale(reparsed), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("updateEntitySynthesis preserves an explicit zero structured fact snapshot count", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-entity-structured-sections-zero-snapshot-"));
  try {
    const storage = new StorageManager(dir);
    await storage.ensureDirectories();

    const entityName = "Jane Doe";
    const entityType = "person";
    const canonical = normalizeEntityName(entityName, entityType);
    const timestamp = "2026-04-13T10:00:00.000Z";

    await storage.writeEntity(entityName, entityType, ["Initial fact before synthesis."], {
      timestamp,
      source: "extraction",
    });
    await storage.updateEntitySynthesis(canonical, "Jane Doe keeps teams small and decisive.", {
      updatedAt: timestamp,
      entityUpdatedAt: timestamp,
      synthesisTimelineCount: 1,
      synthesisStructuredFactCount: 0,
    });

    const parsed = parseEntityFile(
      await readFile(path.join(dir, "entities", `${canonical}.md`), "utf-8"),
    );

    assert.equal(parsed.synthesisStructuredFactCount, 0);
    assert.equal(isEntitySynthesisStale(parsed), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("writeEntity marks same-timestamp appended evidence as stale after synthesis", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-entity-synthesis-storage-same-ts-"));
  try {
    const storage = new StorageManager(dir);
    await storage.ensureDirectories();

    const entityName = "Jane Doe";
    const entityType = "person";
    const canonical = normalizeEntityName(entityName, entityType);
    const timestamp = "2026-04-13T10:00:00.000Z";

    await storage.writeEntity(entityName, entityType, ["Initial fact at shared timestamp."], {
      timestamp,
      source: "extraction",
      sessionKey: "session-1",
      principal: "agent:main",
    });
    await storage.updateEntitySynthesis(canonical, "Jane Doe initial synthesis.", {
      updatedAt: timestamp,
      synthesisTimelineCount: 1,
    });

    const afterSynthesisRaw = await readFile(path.join(dir, "entities", `${canonical}.md`), "utf-8");
    const afterSynthesis = parseEntityFile(afterSynthesisRaw);
    assert.equal(afterSynthesis.synthesisTimelineCount, 1);
    assert.equal(isEntitySynthesisStale(afterSynthesis), false);

    await storage.writeEntity(entityName, entityType, ["Second fact at the same shared timestamp."], {
      timestamp,
      source: "extraction",
      sessionKey: "session-2",
      principal: "agent:main",
    });

    const raw = await readFile(path.join(dir, "entities", `${canonical}.md`), "utf-8");
    const parsed = parseEntityFile(raw);

    assert.equal(parsed.timeline.length, 2);
    assert.equal(parsed.synthesisUpdatedAt, timestamp);
    assert.equal(parsed.synthesisTimelineCount, 1);
    assert.equal(isEntitySynthesisStale(parsed), true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("writeEntity marks backfilled older evidence as stale after synthesis", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-entity-synthesis-storage-backfill-"));
  try {
    const storage = new StorageManager(dir);
    await storage.ensureDirectories();

    const entityName = "Jane Doe";
    const entityType = "person";
    const canonical = normalizeEntityName(entityName, entityType);

    await storage.writeEntity(entityName, entityType, ["Newest fact before synthesis."], {
      timestamp: "2026-04-13T11:00:00.000Z",
      source: "extraction",
      sessionKey: "session-1",
      principal: "agent:main",
    });
    await storage.updateEntitySynthesis(canonical, "Jane Doe current synthesis.", {
      updatedAt: "2026-04-13T11:00:00.000Z",
      synthesisTimelineCount: 1,
    });

    const afterSynthesisRaw = await readFile(path.join(dir, "entities", `${canonical}.md`), "utf-8");
    const afterSynthesis = parseEntityFile(afterSynthesisRaw);
    assert.equal(afterSynthesis.synthesisTimelineCount, 1);
    assert.equal(isEntitySynthesisStale(afterSynthesis), false);

    await storage.writeEntity(entityName, entityType, ["Backfilled older fact arrives later."], {
      timestamp: "2026-04-13T10:00:00.000Z",
      source: "extraction",
      sessionKey: "session-2",
      principal: "agent:main",
    });

    const raw = await readFile(path.join(dir, "entities", `${canonical}.md`), "utf-8");
    const parsed = parseEntityFile(raw);

    assert.equal(parsed.timeline.length, 2);
    assert.equal(parsed.synthesisUpdatedAt, "2026-04-13T11:00:00.000Z");
    assert.equal(parsed.synthesisTimelineCount, 1);
    assert.equal(isEntitySynthesisStale(parsed), true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("updateEntitySynthesis preserves the provided evidence snapshot count", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-entity-synthesis-storage-count-"));
  try {
    StorageManager.clearAllStaticCaches();
    const storage = new StorageManager(dir);
    await storage.ensureDirectories();

    const canonical = await storage.writeEntity("Jane Doe", "person", ["Initial synthesis evidence."], {
      timestamp: "2026-04-13T09:00:00.000Z",
      source: "extraction",
    });
    const beforeConcurrentAppend = parseEntityFile(await readFile(
      path.join(dir, "entities", `${canonical}.md`),
      "utf-8",
    ));
    assert.equal(beforeConcurrentAppend.timeline.length, 1);

    await storage.writeEntity("Jane Doe", "person", ["Backfilled older evidence."], {
      timestamp: "2026-04-13T08:00:00.000Z",
      source: "extraction",
    });
    await storage.updateEntitySynthesis(canonical, "Jane Doe synthesis from the original evidence snapshot.", {
      synthesisTimelineCount: beforeConcurrentAppend.timeline.length,
      updatedAt: "2026-04-13T09:00:00.000Z",
    });

    const parsed = parseEntityFile(await readFile(path.join(dir, "entities", `${canonical}.md`), "utf-8"));

    assert.equal(parsed.timeline.length, 2);
    assert.equal(parsed.synthesisTimelineCount, 1);
    assert.equal(parsed.synthesisUpdatedAt, "2026-04-13T09:00:00.000Z");
    assert.equal(isEntitySynthesisStale(parsed), true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("updateEntitySynthesis preserves unknown freshness when updatedAt is omitted", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-entity-synthesis-storage-unknown-updated-at-"));
  try {
    const storage = new StorageManager(dir);
    await storage.ensureDirectories();

    const canonical = await storage.writeEntity("Jane Doe", "person", ["Legacy evidence without a timestamp."]);
    await storage.updateEntitySynthesis(canonical, "Jane Doe synthesis rebuilt from timestampless evidence.");

    const parsed = parseEntityFile(await readFile(path.join(dir, "entities", `${canonical}.md`), "utf-8"));

    assert.equal(parsed.synthesis, "Jane Doe synthesis rebuilt from timestampless evidence.");
    assert.equal(parsed.synthesisUpdatedAt, undefined);
    assert.equal(isEntitySynthesisStale(parsed), true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("updateEntitySummary preserves legacy fresh-summary semantics", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-entity-summary-storage-legacy-freshness-"));
  try {
    const storage = new StorageManager(dir);
    await storage.ensureDirectories();

    const canonical = await storage.writeEntity("Jane Doe", "person", ["Legacy evidence without a timestamp."]);
    await storage.updateEntitySummary(canonical, "Jane Doe legacy summary.");

    const parsed = parseEntityFile(await readFile(path.join(dir, "entities", `${canonical}.md`), "utf-8"));

    assert.equal(parsed.synthesis, "Jane Doe legacy summary.");
    assert.equal(parsed.summary, "Jane Doe legacy summary.");
    assert.ok(parsed.synthesisUpdatedAt);
    assert.equal(parsed.updated, parsed.synthesisUpdatedAt);
    assert.equal(isEntitySynthesisStale(parsed), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("writeEntity skips duplicate timeline entries on repeated extraction writes", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-entity-synthesis-storage-dedupe-"));
  try {
    const storage = new StorageManager(dir);
    await storage.ensureDirectories();

    const options = {
      timestamp: "2026-04-13T10:00:00.000Z",
      source: "extraction",
      sessionKey: "session-1",
      principal: "agent:main",
    } as const;

    await storage.writeEntity("Jane Doe", "person", ["Leads the roadmap."], options);
    await storage.writeEntity("Jane Doe", "person", ["Leads the roadmap."], options);

    const canonical = normalizeEntityName("Jane Doe", "person");
    const raw = await readFile(path.join(dir, "entities", `${canonical}.md`), "utf-8");
    const parsed = parseEntityFile(raw);

    assert.equal(parsed.timeline.length, 1);
    assert.equal(parsed.timeline[0]?.text, "Leads the roadmap.");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("entity migration rewrites legacy summary plus facts files into synthesis plus timeline", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-entity-migration-"));
  try {
    const storage = new StorageManager(dir);
    await storage.ensureDirectories();

    const canonical = "person-jane-doe";
    const legacy = [
      "# Jane Doe",
      "",
      "**Type:** person",
      "**Updated:** 2026-04-12T10:00:00.000Z",
      "",
      "## Summary",
      "",
      "Jane Doe leads roadmap work.",
      "",
      "## Facts",
      "",
      "- Leads roadmap work.",
      "- Prefers short updates.",
      "",
    ].join("\n");
    await writeFile(path.join(dir, "entities", `${canonical}.md`), legacy, "utf-8");

    const result = await storage.migrateEntityFilesToCompiledTruthTimeline();
    const migratedRaw = await readFile(path.join(dir, "entities", `${canonical}.md`), "utf-8");
    const parsed = parseEntityFile(migratedRaw);

    assert.equal(result.total, 1);
    assert.equal(result.migrated, 1);
    assert.match(migratedRaw, /## Synthesis/);
    assert.match(migratedRaw, /## Timeline/);
    assert.equal(parsed.synthesis, "Jane Doe leads roadmap work.");
    assert.equal(parsed.synthesisUpdatedAt, undefined);
    assert.equal(isEntitySynthesisStale(parsed), true);
    assert.equal(parsed.timeline.length, 2);
    assert.deepEqual(
      parsed.timeline.map((entry) => entry.text),
      ["Leads roadmap work.", "Prefers short updates."],
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("entity migration preserves unmodeled user-authored sections", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-entity-migration-extra-sections-"));
  try {
    const storage = new StorageManager(dir);
    await storage.ensureDirectories();

    const canonical = "person-jane-doe";
    const legacy = [
      "# Jane Doe",
      "",
      "**Type:** person",
      "**Updated:** 2026-04-12T10:00:00.000Z",
      "",
      "## Summary",
      "",
      "Jane Doe leads roadmap work.",
      "",
      "## Facts",
      "",
      "- Leads roadmap work.",
      "",
      "## Notes",
      "",
      "Freeform notes that are not part of the compiled timeline yet.",
      "- Keep this checklist item too.",
      "",
    ].join("\n");
    await writeFile(path.join(dir, "entities", `${canonical}.md`), legacy, "utf-8");

    const result = await storage.migrateEntityFilesToCompiledTruthTimeline();
    const migratedRaw = await readFile(path.join(dir, "entities", `${canonical}.md`), "utf-8");
    const parsed = parseEntityFile(migratedRaw);

    assert.equal(result.total, 1);
    assert.equal(result.migrated, 1);
    assert.match(migratedRaw, /## Notes/);
    assert.match(migratedRaw, /Freeform notes that are not part of the compiled timeline yet\./);
    assert.match(migratedRaw, /- Keep this checklist item too\./);
    assert.deepEqual(parsed.extraSections, [
      {
        title: "Notes",
        lines: [
          "",
          "Freeform notes that are not part of the compiled timeline yet.",
          "- Keep this checklist item too.",
          "",
        ],
      },
    ]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("entity migration preserves unknown frontmatter keys and pre-section prose", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-entity-migration-frontmatter-"));
  try {
    const storage = new StorageManager(dir);
    await storage.ensureDirectories();

    const canonical = "person-jane-doe";
    const legacy = [
      "---",
      "created: 2026-04-12T09:00:00.000Z",
      "updated: 2026-04-12T10:00:00.000Z",
      "tags: [roadmap, vip]",
      "provenance: imported",
      "---",
      "",
      "# Jane Doe",
      "",
      "**Type:** person",
      "**Updated:** 2026-04-12T10:00:00.000Z",
      "",
      "Legacy prose before sections must survive migration.",
      "",
      "## Summary",
      "",
      "Jane Doe leads roadmap work.",
      "",
      "## Facts",
      "",
      "- Leads roadmap work.",
      "",
    ].join("\n");
    await writeFile(path.join(dir, "entities", `${canonical}.md`), legacy, "utf-8");

    await storage.migrateEntityFilesToCompiledTruthTimeline();
    const migratedRaw = await readFile(path.join(dir, "entities", `${canonical}.md`), "utf-8");
    const parsed = parseEntityFile(migratedRaw);

    assert.match(migratedRaw, /tags: \[roadmap, vip\]/);
    assert.match(migratedRaw, /provenance: imported/);
    assert.match(migratedRaw, /Legacy prose before sections must survive migration\./);
    assert.deepEqual(parsed.extraFrontmatterLines, [
      "tags: [roadmap, vip]",
      "provenance: imported",
    ]);
    assert.deepEqual(parsed.preSectionLines, [
      "Legacy prose before sections must survive migration.",
      "",
    ]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("entity migration preserves nested frontmatter without treating child keys as managed fields", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-entity-migration-nested-frontmatter-"));
  try {
    const storage = new StorageManager(dir);
    await storage.ensureDirectories();

    const canonical = "person-jane-doe";
    const legacy = [
      "---",
      "created: 2026-04-12T09:00:00.000Z",
      "updated: 2026-04-12T10:00:00.000Z",
      "meta:",
      "  created: nested-created-should-stay-verbatim",
      "  updated: nested-updated-should-stay-verbatim",
      "---",
      "",
      "# Jane Doe",
      "",
      "**Type:** person",
      "**Updated:** 2026-04-12T10:00:00.000Z",
      "",
      "## Summary",
      "",
      "Jane Doe leads roadmap work.",
      "",
      "## Facts",
      "",
      "- Leads roadmap work.",
      "",
    ].join("\n");
    await writeFile(path.join(dir, "entities", `${canonical}.md`), legacy, "utf-8");

    await storage.migrateEntityFilesToCompiledTruthTimeline();
    const migratedRaw = await readFile(path.join(dir, "entities", `${canonical}.md`), "utf-8");
    const parsed = parseEntityFile(migratedRaw);

    assert.match(migratedRaw, /^---\ncreated: 2026-04-12T09:00:00.000Z\nupdated: 2026-04-12T10:00:00.000Z/m);
    assert.match(migratedRaw, /meta:\n  created: nested-created-should-stay-verbatim\n  updated: nested-updated-should-stay-verbatim/);
    assert.deepEqual(parsed.extraFrontmatterLines, [
      "meta:",
      "  created: nested-created-should-stay-verbatim",
      "  updated: nested-updated-should-stay-verbatim",
    ]);
    assert.equal(parsed.created, "2026-04-12T09:00:00.000Z");
    assert.equal(parsed.updated, "2026-04-12T10:00:00.000Z");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("serializeEntityFile persists stable created and updated frontmatter for entity reads", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-entity-frontmatter-stability-"));
  try {
    const storage = new StorageManager(dir);
    await storage.ensureDirectories();

    const canonical = normalizeEntityName("Jane Doe", "person");
    await storage.writeEntity("Jane Doe", "person", ["Leads roadmap work."], {
      timestamp: "2026-04-13T10:00:00.000Z",
      source: "extraction",
    });
    await storage.updateEntitySynthesis(canonical, "Jane Doe leads roadmap work.", {
      updatedAt: "2026-04-13T10:05:00.000Z",
    });

    const raw = await readFile(path.join(dir, "entities", `${canonical}.md`), "utf-8");
    const parsed = parseEntityFile(raw);

    assert.match(raw, /^---\ncreated: 2026-04-13T10:00:00.000Z\nupdated: 2026-04-13T10:05:00.000Z/m);
    assert.equal(parsed.created, "2026-04-13T10:00:00.000Z");
    assert.equal(parsed.updated, "2026-04-13T10:05:00.000Z");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("parseEntityFile preserves bulleted synthesis text across round trips", () => {
  const raw = [
    "---",
    "created: 2026-04-13T10:00:00.000Z",
    "updated: 2026-04-13T10:05:00.000Z",
    'synthesis_updated_at: "2026-04-13T10:05:00.000Z"',
    "synthesis_version: 2",
    "---",
    "",
    "# Jane Doe",
    "",
    "**Type:** person",
    "**Updated:** 2026-04-13T10:05:00.000Z",
    "",
    "## Synthesis",
    "",
    "- Leads roadmap work.",
    "- Owns release approvals.",
    "",
    "## Timeline",
    "",
    "- [2026-04-13T10:00:00.000Z] Leads roadmap work.",
    "",
  ].join("\n");

  const parsed = parseEntityFile(raw);
  const serialized = serializeEntityFile(parsed);

  assert.equal(parsed.synthesis, "- Leads roadmap work.\n- Owns release approvals.");
  assert.match(serialized, /## Synthesis\n\n- Leads roadmap work\.\n- Owns release approvals\./);
});

test("parseEntityFile migrates timeline-style synthesis bullets into the timeline", () => {
  const raw = [
    "---",
    "created: 2026-04-13T10:00:00.000Z",
    "updated: 2026-04-13T10:05:00.000Z",
    'synthesis_updated_at: "2026-04-13T10:05:00.000Z"',
    "synthesis_version: 2",
    "---",
    "",
    "# Jane Doe",
    "",
    "**Type:** person",
    "**Updated:** 2026-04-13T10:05:00.000Z",
    "",
    "## Synthesis",
    "",
    "Jane Doe leads roadmap work.",
    "- [2026-04-13T10:00:00.000Z] [source=extraction] Approved production rollout.",
    "",
  ].join("\n");

  const parsed = parseEntityFile(raw);
  const serialized = serializeEntityFile(parsed);
  const reparsed = parseEntityFile(serialized);

  assert.equal(parsed.synthesis, "Jane Doe leads roadmap work.");
  assert.deepEqual(parsed.timeline, [{
    timestamp: "2026-04-13T10:00:00.000Z",
    text: "Approved production rollout.",
    source: "extraction",
  }]);
  assert.match(serialized, /## Synthesis\n\nJane Doe leads roadmap work\.\n\n## Timeline\n\n- \[2026-04-13T10:00:00.000Z\] \[source=extraction\] Approved production rollout\./);
  assert.equal(reparsed.synthesis, "Jane Doe leads roadmap work.");
  assert.equal(reparsed.timeline[0]?.text, "Approved production rollout.");
});

test("parseEntityFile keeps bracket-led synthesis bullets out of the timeline", () => {
  const raw = [
    "---",
    "created: 2026-04-13T10:00:00.000Z",
    "updated: 2026-04-13T10:05:00.000Z",
    'synthesis_updated_at: "2026-04-13T10:05:00.000Z"',
    "synthesis_version: 2",
    "---",
    "",
    "# Jane Doe",
    "",
    "**Type:** person",
    "**Updated:** 2026-04-13T10:05:00.000Z",
    "",
    "## Synthesis",
    "",
    "- [Q2] launched rollout.",
    "- [phase-2] release checklist is ready.",
    "",
  ].join("\n");

  const parsed = parseEntityFile(raw);
  const serialized = serializeEntityFile(parsed);
  const reparsed = parseEntityFile(serialized);

  assert.equal(
    parsed.synthesis,
    "- [Q2] launched rollout.\n- [phase-2] release checklist is ready.",
  );
  assert.deepEqual(parsed.timeline, []);
  assert.match(serialized, /## Synthesis\n\n- \[Q2\] launched rollout\.\n- \[phase-2\] release checklist is ready\./);
  assert.deepEqual(reparsed.timeline, []);
  assert.equal(
    reparsed.synthesis,
    "- [Q2] launched rollout.\n- [phase-2] release checklist is ready.",
  );
});

test("parseEntityFile keeps metadata-shaped synthesis bullets out of the timeline", () => {
  const raw = [
    "---",
    "created: 2026-04-13T10:00:00.000Z",
    "updated: 2026-04-13T10:05:00.000Z",
    'synthesis_updated_at: "2026-04-13T10:05:00.000Z"',
    "synthesis_version: 2",
    "---",
    "",
    "# Jane Doe",
    "",
    "**Type:** person",
    "**Updated:** 2026-04-13T10:05:00.000Z",
    "",
    "## Synthesis",
    "",
    "- [source=qa] launch complete.",
    "- [session=retro] follow-up drafted.",
    "",
  ].join("\n");

  const parsed = parseEntityFile(raw);
  const serialized = serializeEntityFile(parsed);
  const reparsed = parseEntityFile(serialized);

  assert.equal(
    parsed.synthesis,
    "- [source=qa] launch complete.\n- [session=retro] follow-up drafted.",
  );
  assert.deepEqual(parsed.timeline, []);
  assert.match(
    serialized,
    /## Synthesis\n\n- \[source=qa\] launch complete\.\n- \[session=retro\] follow-up drafted\./,
  );
  assert.deepEqual(reparsed.timeline, []);
  assert.equal(
    reparsed.synthesis,
    "- [source=qa] launch complete.\n- [session=retro] follow-up drafted.",
  );
});

test("parseEntityFile preserves structured person sections across round trips", () => {
  const raw = [
    "---",
    "created: 2026-04-13T10:00:00.000Z",
    "updated: 2026-04-13T10:05:00.000Z",
    'synthesis_updated_at: "2026-04-13T10:05:00.000Z"',
    "synthesis_version: 2",
    "---",
    "",
    "# Jane Doe",
    "",
    "**Type:** person",
    "**Updated:** 2026-04-13T10:05:00.000Z",
    "",
    "## Synthesis",
    "",
    "Jane Doe leads roadmap work.",
    "",
    "## Beliefs",
    "",
    "- Small teams move faster than committees.",
    "",
    "## Building / Working On",
    "",
    "- A retrieval-first memory system.",
    "",
  ].join("\n");

  const parsed = parseEntityFile(raw) as any;
  const serialized = serializeEntityFile(parsed);
  const reparsed = parseEntityFile(serialized) as any;

  assert.deepEqual(parsed.structuredSections, [
    {
      key: "beliefs",
      title: "Beliefs",
      facts: ["Small teams move faster than committees."],
    },
    {
      key: "building",
      title: "Building / Working On",
      facts: ["A retrieval-first memory system."],
    },
  ]);
  assert.match(serialized, /## Beliefs\n\n- Small teams move faster than committees\./);
  assert.match(serialized, /## Building \/ Working On\n\n- A retrieval-first memory system\./);
  assert.deepEqual(reparsed.structuredSections, parsed.structuredSections);
});

test("parseEntityFile honors configured custom entity schemas", () => {
  const config = parseConfig({
    entitySchemas: {
      person: {
        sections: [
          { key: "operating_principles", title: "Operating Principles" },
        ],
      },
    },
  });

  const parsed = parseEntityFile([
    "---",
    "created: 2026-04-13T10:00:00.000Z",
    "updated: 2026-04-13T10:05:00.000Z",
    "---",
    "",
    "# Jane Doe",
    "",
    "**Type:** person",
    "**Updated:** 2026-04-13T10:05:00.000Z",
    "",
    "## Synthesis",
    "",
    "Jane Doe leads roadmap work.",
    "",
    "## Operating Principles",
    "",
    "- Prefer boring infrastructure over clever infra.",
    "",
  ].join("\n"), config.entitySchemas) as any;

  assert.deepEqual(parsed.structuredSections, [
    {
      key: "operating_principles",
      title: "Operating Principles",
      facts: ["Prefer boring infrastructure over clever infra."],
    },
  ]);
});

test("parseEntityFile keeps caller-provided entity schemas isolated per parse", () => {
  const principlesConfig = parseConfig({
    entitySchemas: {
      person: {
        sections: [{ key: "operating_principles", title: "Operating Principles" }],
      },
    },
  });
  const beliefsConfig = parseConfig({
    entitySchemas: {
      person: {
        sections: [{ key: "beliefs", title: "Beliefs" }],
      },
    },
  });

  const parsedPrinciples = parseEntityFile([
    "---",
    "created: 2026-04-13T10:00:00.000Z",
    "updated: 2026-04-13T10:05:00.000Z",
    "---",
    "",
    "# Jane Doe",
    "",
    "**Type:** person",
    "**Updated:** 2026-04-13T10:05:00.000Z",
    "",
    "## Operating Principles",
    "",
    "- Prefer boring infrastructure over clever infra.",
    "",
  ].join("\n"), principlesConfig.entitySchemas) as any;
  const parsedBeliefs = parseEntityFile([
    "---",
    "created: 2026-04-13T10:00:00.000Z",
    "updated: 2026-04-13T10:05:00.000Z",
    "---",
    "",
    "# Jane Doe",
    "",
    "**Type:** person",
    "**Updated:** 2026-04-13T10:05:00.000Z",
    "",
    "## Beliefs",
    "",
    "- Small teams move faster than committees.",
    "",
  ].join("\n"), beliefsConfig.entitySchemas) as any;
  const parsedDefault = parseEntityFile([
    "---",
    "created: 2026-04-13T10:00:00.000Z",
    "updated: 2026-04-13T10:05:00.000Z",
    "---",
    "",
    "# Jane Doe",
    "",
    "**Type:** person",
    "**Updated:** 2026-04-13T10:05:00.000Z",
    "",
    "## Beliefs",
    "",
    "- Default schemas still apply without caller overrides.",
    "",
  ].join("\n")) as any;

  assert.deepEqual(parsedPrinciples.structuredSections, [
    {
      key: "operating_principles",
      title: "Operating Principles",
      facts: ["Prefer boring infrastructure over clever infra."],
    },
  ]);
  assert.deepEqual(parsedBeliefs.structuredSections, [
    {
      key: "beliefs",
      title: "Beliefs",
      facts: ["Small teams move faster than committees."],
    },
  ]);
  assert.deepEqual(parsedDefault.structuredSections, [
    {
      key: "beliefs",
      title: "Beliefs",
      facts: ["Default schemas still apply without caller overrides."],
    },
  ]);
});

test("parseEntityFile preserves non-schema structured sections as structured facts", () => {
  const parsed = parseEntityFile([
    "---",
    "created: 2026-04-13T10:00:00.000Z",
    "updated: 2026-04-13T10:05:00.000Z",
    "---",
    "",
    "# Acme Corp",
    "",
    "**Type:** company",
    "**Updated:** 2026-04-13T10:05:00.000Z",
    "",
    "## Operating Principles",
    "",
    "- Prefer small, durable teams.",
    "",
  ].join("\n")) as any;

  assert.deepEqual(parsed.structuredSections, [
    {
      key: "operating_principles",
      title: "Operating Principles",
      facts: ["Prefer small, durable teams."],
    },
  ]);
  assert.deepEqual(parsed.facts, ["Prefer small, durable teams."]);
});

test("readAllEntityFiles keeps schema-aware cache entries isolated per storage manager", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-entity-schema-cache-"));
  try {
    const bootstrapStorage = new StorageManager(dir);
    await bootstrapStorage.ensureDirectories();
    const raw = [
      "---",
      "created: 2026-04-13T10:00:00.000Z",
      "updated: 2026-04-13T10:05:00.000Z",
      "---",
      "",
      "# Jane Doe",
      "",
      "**Type:** person",
      "**Updated:** 2026-04-13T10:05:00.000Z",
      "",
      "## Operating Principles",
      "",
      "- Prefer boring infrastructure over clever infra.",
      "",
    ].join("\n");
    await writeFile(path.join(dir, "entities", "person-jane-doe.md"), raw, "utf-8");

    const principlesConfig = parseConfig({
      entitySchemas: {
        person: {
          sections: [{ key: "operating_principles", title: "Operating Principles" }],
        },
      },
    });
    const aliasConfig = parseConfig({
      entitySchemas: {
        person: {
          sections: [{ key: "principles", title: "Principles", aliases: ["Operating Principles"] }],
        },
      },
    });

    const firstStorage = new StorageManager(dir, principlesConfig.entitySchemas);
    const secondStorage = new StorageManager(dir, aliasConfig.entitySchemas);
    await firstStorage.ensureDirectories();
    await secondStorage.ensureDirectories();

    const firstEntity = (await firstStorage.readAllEntityFiles())[0] as any;
    const secondEntity = (await secondStorage.readAllEntityFiles())[0] as any;

    assert.equal(firstEntity.structuredSections?.[0]?.key, "operating_principles");
    assert.equal(secondEntity.structuredSections?.[0]?.key, "principles");
    assert.equal(secondEntity.structuredSections?.[0]?.title, "Principles");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("parseEntityFile preserves blank lines in multi-paragraph synthesis", () => {
  const raw = [
    "---",
    "created: 2026-04-13T10:00:00.000Z",
    "updated: 2026-04-13T10:05:00.000Z",
    'synthesis_updated_at: "2026-04-13T10:05:00.000Z"',
    "synthesis_version: 1",
    "---",
    "",
    "# Jane Doe",
    "",
    "**Type:** person",
    "**Updated:** 2026-04-13T10:05:00.000Z",
    "",
    "## Synthesis",
    "",
    "Jane Doe leads roadmap work.",
    "",
    "She also owns release approvals.",
    "",
    "## Timeline",
    "",
    "- [2026-04-13T10:00:00.000Z] Leads roadmap work.",
    "",
  ].join("\n");

  const parsed = parseEntityFile(raw);
  const serialized = serializeEntityFile(parsed);

  assert.equal(parsed.synthesis, "Jane Doe leads roadmap work.\n\nShe also owns release approvals.");
  assert.match(serialized, /Jane Doe leads roadmap work\.\n\nShe also owns release approvals\./);
});

test("parseEntityFile preserves indentation in synthesis content", () => {
  const raw = [
    "---",
    "created: 2026-04-13T10:00:00.000Z",
    "updated: 2026-04-13T10:05:00.000Z",
    'synthesis_updated_at: "2026-04-13T10:05:00.000Z"',
    "synthesis_version: 1",
    "---",
    "",
    "# Jane Doe",
    "",
    "**Type:** person",
    "**Updated:** 2026-04-13T10:05:00.000Z",
    "",
    "## Synthesis",
    "",
    "- Parent point",
    "  - Nested point",
    "    code-ish detail",
    "",
    "## Timeline",
    "",
    "- [2026-04-13T10:00:00.000Z] Leads roadmap work.",
    "",
  ].join("\n");

  const parsed = parseEntityFile(raw);
  const serialized = serializeEntityFile(parsed);

  assert.equal(
    parsed.synthesis,
    "- Parent point\n  - Nested point\n    code-ish detail",
  );
  assert.match(
    serialized,
    /## Synthesis\n\n- Parent point\n  - Nested point\n    code-ish detail/,
  );
});

test("parseEntityFile preserves unmodeled sections across round trips", () => {
  const raw = [
    "---",
    "created: 2026-04-13T10:00:00.000Z",
    "updated: 2026-04-13T10:05:00.000Z",
    'synthesis_updated_at: "2026-04-13T10:05:00.000Z"',
    "synthesis_version: 1",
    "---",
    "",
    "# Jane Doe",
    "",
    "**Type:** person",
    "**Updated:** 2026-04-13T10:05:00.000Z",
    "",
    "## Timeline",
    "",
    "- [2026-04-13T10:00:00.000Z] Leads roadmap work.",
    "",
    "## Notes",
    "",
    "Keep this freeform context.",
    "- Keep this checklist item too.",
    "",
  ].join("\n");

  const parsed = parseEntityFile(raw);
  const serialized = serializeEntityFile(parsed);

  assert.deepEqual(parsed.extraSections, [
    {
      title: "Notes",
      lines: [
        "",
        "Keep this freeform context.",
        "- Keep this checklist item too.",
        "",
      ],
    },
  ]);
  assert.match(serialized, /## Notes\n\nKeep this freeform context\.\n- Keep this checklist item too\./);
});

test("parseEntityFile preserves unknown frontmatter keys and pre-section prose across round trips", () => {
  const raw = [
    "---",
    "created: 2026-04-13T10:00:00.000Z",
    "updated: 2026-04-13T10:05:00.000Z",
    "tags: [roadmap, vip]",
    "provenance: imported",
    'synthesis_updated_at: "2026-04-13T10:05:00.000Z"',
    "synthesis_version: 1",
    "---",
    "",
    "# Jane Doe",
    "",
    "**Type:** person",
    "**Updated:** 2026-04-13T10:05:00.000Z",
    "",
    "Keep this pre-section context.",
    "",
    "## Timeline",
    "",
    "- [2026-04-13T10:00:00.000Z] Leads roadmap work.",
    "",
  ].join("\n");

  const parsed = parseEntityFile(raw);
  const serialized = serializeEntityFile(parsed);

  assert.deepEqual(parsed.extraFrontmatterLines, [
    "tags: [roadmap, vip]",
    "provenance: imported",
  ]);
  assert.deepEqual(parsed.preSectionLines, [
    "Keep this pre-section context.",
    "",
  ]);
  assert.match(serialized, /tags: \[roadmap, vip\]/);
  assert.match(serialized, /provenance: imported/);
  assert.match(serialized, /\*\*Updated:\*\* 2026-04-13T10:05:00.000Z\n\nKeep this pre-section context\./);
});

test("parseEntityFile preserves prose between type and updated headers", () => {
  const raw = [
    "---",
    "created: 2026-04-13T10:00:00.000Z",
    "updated: 2026-04-13T10:05:00.000Z",
    'synthesis_updated_at: "2026-04-13T10:05:00.000Z"',
    "synthesis_version: 1",
    "---",
    "",
    "# Jane Doe",
    "",
    "**Type:** person",
    "",
    "Legacy prose between type and updated must survive round trips.",
    "",
    "**Updated:** 2026-04-13T10:05:00.000Z",
    "",
    "## Timeline",
    "",
    "- [2026-04-13T10:00:00.000Z] Leads roadmap work.",
    "",
  ].join("\n");

  const parsed = parseEntityFile(raw);
  const serialized = serializeEntityFile(parsed);

  assert.deepEqual(parsed.preSectionLines, [
    "Legacy prose between type and updated must survive round trips.",
    "",
    "",
  ]);
  assert.match(serialized, /Legacy prose between type and updated must survive round trips\./);
});

test("parseEntityFile preserves bracket-prefixed timeline facts", () => {
  const raw = [
    "---",
    "created: 2026-04-13T10:00:00.000Z",
    "updated: 2026-04-13T10:05:00.000Z",
    'synthesis_updated_at: "2026-04-13T10:05:00.000Z"',
    "synthesis_version: 1",
    "---",
    "",
    "# Jane Doe",
    "",
    "**Type:** person",
    "**Updated:** 2026-04-13T10:05:00.000Z",
    "",
    "## Synthesis",
    "",
    "Jane Doe leads roadmap work.",
    "",
    "## Timeline",
    "",
    "- [2026-04-13T10:00:00.000Z] [source=extraction] [Q2] launched rollout",
    "",
  ].join("\n");

  const parsed = parseEntityFile(raw);

  assert.equal(parsed.timeline[0]?.text, "[Q2] launched rollout");
  assert.equal(parsed.timeline[0]?.source, "extraction");
});

test("parseEntityFile preserves unknown bracket tokens after known timeline metadata", () => {
  const raw = [
    "---",
    "created: 2026-04-13T10:00:00.000Z",
    "updated: 2026-04-13T10:05:00.000Z",
    'synthesis_updated_at: "2026-04-13T10:05:00.000Z"',
    "synthesis_version: 1",
    "---",
    "",
    "# Jane Doe",
    "",
    "**Type:** person",
    "**Updated:** 2026-04-13T10:05:00.000Z",
    "",
    "## Timeline",
    "",
    "- [2026-04-13T10:00:00.000Z] [source=extraction] [custom=val] launched rollout",
    "",
  ].join("\n");

  const parsed = parseEntityFile(raw);

  assert.equal(parsed.timeline[0]?.source, "extraction");
  assert.equal(parsed.timeline[0]?.text, "[custom=val] launched rollout");
});

test("parseEntityFile treats a single metadata-like token followed by text as literal timeline text", () => {
  const raw = [
    "---",
    "created: 2026-04-13T10:00:00.000Z",
    "updated: 2026-04-13T10:05:00.000Z",
    'synthesis_updated_at: "2026-04-13T10:05:00.000Z"',
    "synthesis_version: 1",
    "---",
    "",
    "# Jane Doe",
    "",
    "**Type:** person",
    "**Updated:** 2026-04-13T10:05:00.000Z",
    "",
    "## Timeline",
    "",
    "- [2026-04-13T10:00:00.000Z] [source=qa] launch complete",
    "",
  ].join("\n");

  const parsed = parseEntityFile(raw);

  assert.equal(parsed.timeline[0]?.source, undefined);
  assert.equal(parsed.timeline[0]?.text, "[source=qa] launch complete");
});

test("serializeEntityFile escapes bracket characters in timeline metadata values", () => {
  const raw = [
    "---",
    "created: 2026-04-13T10:00:00.000Z",
    "updated: 2026-04-13T10:05:00.000Z",
    'synthesis_updated_at: "2026-04-13T10:05:00.000Z"',
    "synthesis_version: 1",
    "---",
    "",
    "# Jane Doe",
    "",
    "**Type:** person",
    "**Updated:** 2026-04-13T10:05:00.000Z",
    "",
    "## Timeline",
    "",
    "- [2026-04-13T10:00:00.000Z] launched rollout",
    "",
  ].join("\n");

  const parsed = parseEntityFile(raw);
  parsed.timeline = [{
    timestamp: "2026-04-13T10:00:00.000Z",
    text: "launched rollout",
    source: "qa]team",
    sessionKey: "session\\]42",
    principal: "agent\\main]ops",
  }];

  const serialized = serializeEntityFile(parsed);
  const reparsed = parseEntityFile(serialized);

  assert.match(serialized, /\[source_meta=qa\\\]team\]/);
  assert.match(serialized, /\[session=session\\\\\\]42\]/);
  assert.match(serialized, /\[principal=agent\\\\main\\\]ops\]/);
  assert.equal(reparsed.timeline[0]?.source, "qa]team");
  assert.equal(reparsed.timeline[0]?.sessionKey, "session\\]42");
  assert.equal(reparsed.timeline[0]?.principal, "agent\\main]ops");
  assert.equal(reparsed.timeline[0]?.text, "launched rollout");
});

test("writeEntity preserves custom timeline source metadata without injecting it into text", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-entity-custom-source-roundtrip-"));
  try {
    const storage = new StorageManager(dir);
    await storage.ensureDirectories();

    await storage.writeEntity("Jane Doe", "person", ["launch complete"], {
      timestamp: "2026-04-13T10:00:00.000Z",
      source: "qa",
    });

    const canonical = normalizeEntityName("Jane Doe", "person");
    const raw = await readFile(path.join(dir, "entities", `${canonical}.md`), "utf-8");
    const parsed = parseEntityFile(raw);

    assert.match(raw, /\[source_meta=qa\] launch complete/);
    assert.equal(parsed.timeline[0]?.source, "qa");
    assert.equal(parsed.timeline[0]?.text, "launch complete");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("serializeEntityFile escapes newline characters in timeline metadata values", () => {
  const raw = [
    "---",
    "created: 2026-04-13T10:00:00.000Z",
    "updated: 2026-04-13T10:05:00.000Z",
    'synthesis_updated_at: "2026-04-13T10:05:00.000Z"',
    "synthesis_version: 1",
    "---",
    "",
    "# Jane Doe",
    "",
    "**Type:** person",
    "**Updated:** 2026-04-13T10:05:00.000Z",
    "",
    "## Timeline",
    "",
    "- [2026-04-13T10:00:00.000Z] launched rollout",
    "",
  ].join("\n");

  const parsed = parseEntityFile(raw);
  parsed.timeline = [{
    timestamp: "2026-04-13T10:00:00.000Z",
    text: "launched rollout",
    source: "qa-team",
    sessionKey: "session-42\nchild",
    principal: "agent\r\nops",
  }];

  const serialized = serializeEntityFile(parsed);
  const reparsed = parseEntityFile(serialized);

  assert.doesNotMatch(serialized, /\[session=[^\]]*\n/);
  assert.doesNotMatch(serialized, /\[principal=[^\]]*\n/);
  assert.match(serialized, /\[session=session-42\\nchild\]/);
  assert.match(serialized, /\[principal=agent\\r\\nops\]/);
  assert.equal(reparsed.timeline[0]?.sessionKey, "session-42\nchild");
  assert.equal(reparsed.timeline[0]?.principal, "agent\r\nops");
  assert.equal(reparsed.timeline[0]?.text, "launched rollout");
});

test("serializeEntityFile avoids double spaces for tokenless timeline entries", () => {
  const serialized = serializeEntityFile({
    name: "Casey Example",
    type: "person",
    created: "2026-04-13T10:00:00.000Z",
    updated: "2026-04-13T10:05:00.000Z",
    facts: ["Owns rollout coordination."],
    summary: "Casey Example keeps rollout coordination on track.",
    synthesis: "Casey Example keeps rollout coordination on track.",
    synthesisUpdatedAt: "2026-04-13T10:05:00.000Z",
    synthesisTimelineCount: 1,
    synthesisVersion: 1,
    timeline: [
      { timestamp: "", text: "Owns rollout coordination." },
    ],
    relationships: [],
    activity: [],
    aliases: [],
  });
  const reparsed = parseEntityFile(serialized);

  assert.match(serialized, /## Timeline\n\n- Owns rollout coordination\./);
  assert.doesNotMatch(serialized, /-  Owns rollout coordination\./);
  assert.equal(reparsed.timeline[0]?.text, "Owns rollout coordination.");
});

test("serializeEntityFile does not append a blank line for empty extra sections", () => {
  const serialized = serializeEntityFile({
    name: "Casey Example",
    type: "person",
    created: "2026-04-13T10:00:00.000Z",
    updated: "2026-04-13T10:05:00.000Z",
    facts: ["Owns rollout coordination."],
    summary: "Casey Example keeps rollout coordination on track.",
    synthesis: "Casey Example keeps rollout coordination on track.",
    synthesisUpdatedAt: "2026-04-13T10:05:00.000Z",
    synthesisTimelineCount: 1,
    synthesisVersion: 1,
    timeline: [{ timestamp: "", text: "Owns rollout coordination." }],
    relationships: [],
    activity: [],
    aliases: [],
    extraSections: [{ title: "Empty Notes", lines: [] }],
  });

  assert.match(serialized, /## Empty Notes$/);
  assert.doesNotMatch(serialized, /## Empty Notes\n$/);
});

test("parseEntityFile merges legacy facts into mixed timeline entities", () => {
  const raw = [
    "---",
    "created: 2026-04-13T10:00:00.000Z",
    "updated: 2026-04-13T10:05:00.000Z",
    'synthesis_updated_at: "2026-04-13T10:05:00.000Z"',
    "synthesis_version: 1",
    "---",
    "",
    "# Jane Doe",
    "",
    "**Type:** person",
    "**Updated:** 2026-04-13T10:05:00.000Z",
    "",
    "## Timeline",
    "",
    "- [2026-04-13T10:00:00.000Z] Leads roadmap work.",
    "",
    "## Facts",
    "",
    "- Prefers short updates.",
    "",
  ].join("\n");

  const parsed = parseEntityFile(raw);
  const serialized = serializeEntityFile(parsed);

  assert.deepEqual(parsed.facts, ["Leads roadmap work.", "Prefers short updates."]);
  assert.match(serialized, /## Timeline/);
  assert.match(serialized, /Leads roadmap work\./);
  assert.match(serialized, /Prefers short updates\./);
});

test("parseEntityFile preserves entity frontmatter from CRLF files", () => {
  const raw = [
    "---",
    "created: 2026-04-13T10:00:00.000Z",
    "updated: 2026-04-13T10:05:00.000Z",
    'synthesis_updated_at: "2026-04-13T10:05:00.000Z"',
    "synthesis_version: 2",
    "---",
    "",
    "# Jane Doe",
    "",
    "**Type:** person",
    "**Updated:** 2026-04-13T10:05:00.000Z",
    "",
    "## Synthesis",
    "",
    "Jane Doe leads roadmap work.",
    "",
    "## Timeline",
    "",
    "- [2026-04-13T10:00:00.000Z] Leads roadmap work.",
    "",
  ].join("\r\n");

  const parsed = parseEntityFile(raw);

  assert.equal(parsed.created, "2026-04-13T10:00:00.000Z");
  assert.equal(parsed.updated, "2026-04-13T10:05:00.000Z");
  assert.equal(parsed.synthesisUpdatedAt, "2026-04-13T10:05:00.000Z");
  assert.equal(parsed.synthesisVersion, 2);
});

test("parseEntityFile normalizes single-quoted managed frontmatter timestamps", () => {
  const raw = [
    "---",
    "created: '2026-04-13T10:00:00.000Z'",
    "updated: '2026-04-13T10:05:00.000Z'",
    "synthesis_updated_at: '2026-04-13T10:05:00.000Z'",
    "synthesis_version: 2",
    "---",
    "",
    "# Jane Doe",
    "",
    "**Type:** person",
    "**Updated:** 2026-04-13T10:05:00.000Z",
    "",
    "## Synthesis",
    "",
    "Jane Doe leads roadmap work.",
    "",
    "## Timeline",
    "",
    "- [2026-04-13T10:00:00.000Z] Leads roadmap work.",
    "",
  ].join("\n");

  const parsed = parseEntityFile(raw);

  assert.equal(parsed.created, "2026-04-13T10:00:00.000Z");
  assert.equal(parsed.updated, "2026-04-13T10:05:00.000Z");
  assert.equal(parsed.synthesisUpdatedAt, "2026-04-13T10:05:00.000Z");
});

test("parseEntityFile strips inline YAML comments from managed frontmatter values", () => {
  const raw = [
    "---",
    'created: "2026-04-13T10:00:00.000Z" # imported',
    "updated: 2026-04-13T10:05:00.000Z # regenerated",
    'synthesis_updated_at: "2026-04-13T10:05:00.000Z" # generated',
    "synthesis_timeline_count: 2 # evidence snapshot",
    "synthesis_version: 3 # schema version",
    "---",
    "",
    "# Jane Doe",
    "",
    "**Type:** person",
    "**Updated:** 2026-04-13T10:05:00.000Z",
    "",
    "## Synthesis",
    "",
    "Jane Doe leads roadmap work.",
    "",
  ].join("\n");

  const parsed = parseEntityFile(raw);

  assert.equal(parsed.created, "2026-04-13T10:00:00.000Z");
  assert.equal(parsed.updated, "2026-04-13T10:05:00.000Z");
  assert.equal(parsed.synthesisUpdatedAt, "2026-04-13T10:05:00.000Z");
  assert.equal(parsed.synthesisTimelineCount, 2);
  assert.equal(parsed.synthesisVersion, 3);
});

test("parseEntityFile leaves legacy summary synthesis timestamp unset without explicit frontmatter", () => {
  const raw = [
    "# Jane Doe",
    "",
    "**Type:** person",
    "**Updated:** 2026-04-13T10:05:00.000Z",
    "",
    "## Summary",
    "",
    "Jane Doe leads roadmap work.",
    "",
    "## Facts",
    "",
    "- Leads roadmap work.",
    "",
  ].join("\n");

  const parsed = parseEntityFile(raw);

  assert.equal(parsed.synthesisUpdatedAt, undefined);
  assert.equal(isEntitySynthesisStale(parsed), true);
});

test("parseEntityFile preserves unknown timestamps for legacy facts without metadata", () => {
  const raw = [
    "# Jane Doe",
    "",
    "**Type:** person",
    "",
    "## Facts",
    "",
    "- Leads roadmap work.",
    "- Prefers short updates.",
    "",
  ].join("\n");

  const parsed = parseEntityFile(raw);

  assert.deepEqual(parsed.timeline.map((entry) => entry.timestamp), ["", ""]);
  assert.equal(isEntitySynthesisStale(parsed), true);
});

test("serializeEntityFile does not invent synthesis timeline count for unsynthesized legacy entities", () => {
  const raw = [
    "# Jane Doe",
    "",
    "**Type:** person",
    "**Updated:** 2026-04-13T10:05:00.000Z",
    "",
    "## Summary",
    "",
    "Jane Doe leads roadmap work.",
    "",
    "## Facts",
    "",
    "- Leads roadmap work.",
    "- Prefers short updates.",
    "",
  ].join("\n");

  const parsed = parseEntityFile(raw);
  const serialized = serializeEntityFile(parsed);
  const reparsed = parseEntityFile(serialized);

  assert.doesNotMatch(serialized, /synthesis_timeline_count:/);
  assert.doesNotMatch(serialized, /\[\]/);
  assert.match(serialized, /\[source=migration\] Leads roadmap work\./);
  assert.deepEqual(reparsed.timeline.map((entry) => entry.source), ["migration", "migration"]);
  assert.equal(reparsed.synthesisTimelineCount, undefined);
  assert.equal(isEntitySynthesisStale(reparsed), true);
});

test("timestamp-less synthesized legacy entities stay fresh when the evidence snapshot count matches", () => {
  const reparsed = parseEntityFile(serializeEntityFile({
    name: "Casey Example",
    type: "person",
    created: "2026-04-13T10:00:00.000Z",
    updated: "2026-04-13T10:05:00.000Z",
    facts: ["Owns rollout coordination.", "Keeps release notes current."],
    summary: "Casey Example keeps rollout coordination on track.",
    synthesis: "Casey Example keeps rollout coordination on track.",
    synthesisUpdatedAt: "2026-04-13T10:05:00.000Z",
    synthesisTimelineCount: 2,
    synthesisVersion: 1,
    timeline: [
      { timestamp: "", text: "Owns rollout coordination.", source: "migration" },
      { timestamp: "", text: "Keeps release notes current.", source: "migration" },
    ],
    relationships: [],
    activity: [],
    aliases: [],
  }));

  assert.deepEqual(reparsed.timeline.map((entry) => entry.timestamp), ["", ""]);
  assert.equal(reparsed.synthesisTimelineCount, 2);
  assert.equal(isEntitySynthesisStale(reparsed), false);
});

test("timestamp-less synthesized legacy entities stay fresh without synthesisUpdatedAt when the evidence snapshot count matches", () => {
  const reparsed = parseEntityFile(serializeEntityFile({
    name: "Casey Example",
    type: "person",
    created: "2026-04-13T10:00:00.000Z",
    updated: "2026-04-13T10:05:00.000Z",
    facts: ["Owns rollout coordination.", "Keeps release notes current."],
    summary: "Casey Example keeps rollout coordination on track.",
    synthesis: "Casey Example keeps rollout coordination on track.",
    synthesisUpdatedAt: undefined,
    synthesisTimelineCount: 2,
    synthesisVersion: 1,
    timeline: [
      { timestamp: "", text: "Owns rollout coordination.", source: "migration" },
      { timestamp: "", text: "Keeps release notes current.", source: "migration" },
    ],
    relationships: [],
    activity: [],
    aliases: [],
  }));

  assert.deepEqual(reparsed.timeline.map((entry) => entry.timestamp), ["", ""]);
  assert.equal(reparsed.synthesisUpdatedAt, undefined);
  assert.equal(reparsed.synthesisTimelineCount, 2);
  assert.equal(isEntitySynthesisStale(reparsed), false);
});

test("serializeEntityFile preserves facts-only entities as legacy facts instead of synthetic timeline entries", () => {
  const serialized = serializeEntityFile({
    name: "Casey Example",
    type: "person",
    created: "2026-04-13T10:00:00.000Z",
    updated: "2026-04-13T10:05:00.000Z",
    facts: ["Owns rollout coordination.", "Owns rollout coordination.", "Keeps release notes current."],
    summary: "Casey Example keeps rollout coordination on track.",
    synthesis: "Casey Example keeps rollout coordination on track.",
    synthesisUpdatedAt: "2026-04-13T10:05:00.000Z",
    synthesisTimelineCount: undefined,
    synthesisVersion: 1,
    timeline: [],
    relationships: [],
    activity: [],
    aliases: [],
  });

  const reparsed = parseEntityFile(serialized);

  assert.match(serialized, /## Facts\n\n- Owns rollout coordination\.\n- Keeps release notes current\./);
  assert.doesNotMatch(serialized, /## Timeline/);
  assert.doesNotMatch(serialized, /\[source=migration\]/);
  assert.deepEqual(reparsed.facts, ["Owns rollout coordination.", "Keeps release notes current."]);
  assert.equal(reparsed.timeline.length, 2);
  assert.equal(reparsed.timeline[0]?.source, "migration");
  assert.equal(isEntitySynthesisStale(reparsed), true);
});

test("compareEntityTimestamps treats equivalent parsed instants as equal", () => {
  assert.equal(compareEntityTimestamps("2026-04-13T15:00:00Z", "2026-04-13T10:00:00-05:00"), 0);
  assert.equal(compareEntityTimestamps("2026-04-13T10:00:00-05:00", "2026-04-13T15:00:00Z"), 0);
});

test("entity synthesis staleness uses parsed timestamps instead of raw string ordering", () => {
  const parsed = parseEntityFile([
    "---",
    "created: 2026-04-13T10:00:00.000Z",
    "updated: 2026-04-13T10:05:00.000Z",
    'synthesis_updated_at: "2026-04-13T14:30:00Z"',
    "synthesis_version: 1",
    "---",
    "",
    "# Jane Doe",
    "",
    "**Type:** person",
    "**Updated:** 2026-04-13T10:05:00.000Z",
    "",
    "## Synthesis",
    "",
    "Jane Doe leads roadmap work.",
    "",
    "## Timeline",
    "",
    "- [2026-04-13T14:45:00Z] Reviewed rollout metrics",
    "- [2026-04-13T10:00:00-05:00] Approved production rollout",
    "",
  ].join("\n"));

  assert.equal(isEntitySynthesisStale(parsed), true);
});

test("mergeFragmentedEntities prefers the freshest synthesis using parsed timestamps", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-entity-merge-synthesis-"));
  try {
    const storage = new StorageManager(dir);
    await storage.ensureDirectories();

    const fragmentA = [
      "---",
      "created: 2026-04-13T10:00:00.000Z",
      "updated: 2026-04-13T14:45:00Z",
      'synthesis_updated_at: "2026-04-13T14:45:00Z"',
      "synthesis_version: 1",
      "---",
      "",
      "# Jane Doe",
      "",
      "**Type:** person",
      "**Updated:** 2026-04-13T14:45:00Z",
      "",
      "## Synthesis",
      "",
      "Older synthesis should lose.",
      "",
      "## Timeline",
      "",
      "- [2026-04-13T14:45:00Z] Older evidence",
      "",
    ].join("\n");
    const fragmentB = [
      "---",
      "created: 2026-04-13T10:00:00.000Z",
      "updated: 2026-04-13T10:00:00-05:00",
      'synthesis_updated_at: "2026-04-13T10:00:00-05:00"',
      "synthesis_version: 2",
      "---",
      "",
      "# Jane Doe",
      "",
      "**Type:** person",
      "**Updated:** 2026-04-13T10:00:00-05:00",
      "",
      "## Synthesis",
      "",
      "Newest offset synthesis should win.",
      "",
      "## Timeline",
      "",
      "- [2026-04-13T10:00:00-05:00] Newer evidence",
      "",
    ].join("\n");

    await writeFile(path.join(dir, "entities", "person-jane doe.md"), fragmentA, "utf-8");
    await writeFile(path.join(dir, "entities", "person-jane_doe.md"), fragmentB, "utf-8");

    const merged = await storage.mergeFragmentedEntities();
    const raw = await readFile(path.join(dir, "entities", "person-jane-doe.md"), "utf-8");
    const parsed = parseEntityFile(raw);

    assert.equal(merged, 2);
    assert.equal(parsed.synthesis, "Newest offset synthesis should win.");
    assert.equal(parsed.synthesisUpdatedAt, "2026-04-13T10:00:00-05:00");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("mergeFragmentedEntities keeps legacy synthesis timestamps unset when freshness is unknown", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-entity-merge-legacy-synthesis-"));
  try {
    const storage = new StorageManager(dir);
    await storage.ensureDirectories();

    const legacySummaryFragment = [
      "---",
      "created: 2026-04-13T10:00:00.000Z",
      "updated: 2026-04-13T10:05:00.000Z",
      "---",
      "",
      "# Jane Doe",
      "",
      "**Type:** person",
      "**Updated:** 2026-04-13T10:05:00.000Z",
      "",
      "## Summary",
      "",
      "Legacy summary should remain stale until refreshed.",
      "",
      "## Facts",
      "",
      "- [2026-04-13T10:05:00.000Z] Older fact",
      "",
    ].join("\n");
    const newerTimelineFragment = [
      "---",
      "created: 2026-04-13T10:00:00.000Z",
      "updated: 2026-04-13T11:05:00.000Z",
      "---",
      "",
      "# Jane Doe",
      "",
      "**Type:** person",
      "**Updated:** 2026-04-13T11:05:00.000Z",
      "",
      "## Timeline",
      "",
      "- [2026-04-13T11:05:00.000Z] Newer evidence",
      "",
    ].join("\n");

    await writeFile(path.join(dir, "entities", "person-jane doe.md"), legacySummaryFragment, "utf-8");
    await writeFile(path.join(dir, "entities", "person-jane_doe.md"), newerTimelineFragment, "utf-8");

    const merged = await storage.mergeFragmentedEntities();
    const raw = await readFile(path.join(dir, "entities", "person-jane-doe.md"), "utf-8");
    const parsed = parseEntityFile(raw);

    assert.equal(merged, 2);
    assert.equal(parsed.synthesis, "Legacy summary should remain stale until refreshed.");
    assert.equal(parsed.synthesisUpdatedAt, undefined);
    assert.equal(isEntitySynthesisStale(parsed), true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("mergeFragmentedEntities preserves custom metadata and freeform sections from fragments", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-entity-merge-metadata-"));
  try {
    const storage = new StorageManager(dir);
    await storage.ensureDirectories();

    const fragmentA = [
      "---",
      "created: 2026-04-13T10:00:00.000Z",
      "updated: 2026-04-13T10:05:00.000Z",
      "tags: [alpha]",
      "---",
      "",
      "# Jane Doe",
      "",
      "**Type:** person",
      "**Updated:** 2026-04-13T10:05:00.000Z",
      "",
      "Fragment A prose.",
      "",
      "## Synthesis",
      "",
      "Fragment A synthesis.",
      "",
      "## Timeline",
      "",
      "- [2026-04-13T10:05:00.000Z] Fragment A evidence",
      "",
      "## Notes",
      "",
      "Fragment A notes.",
      "",
    ].join("\n");
    const fragmentB = [
      "---",
      "created: 2026-04-13T10:00:00.000Z",
      "updated: 2026-04-13T11:05:00.000Z",
      "owner: ops",
      "---",
      "",
      "# Jane Doe",
      "",
      "**Type:** person",
      "**Updated:** 2026-04-13T11:05:00.000Z",
      "",
      "Fragment B prose.",
      "",
      "## Synthesis",
      "",
      "Fragment B synthesis.",
      "",
      "## Timeline",
      "",
      "- [2026-04-13T11:05:00.000Z] Fragment B evidence",
      "",
      "## Runbook",
      "",
      "Fragment B runbook notes.",
      "",
    ].join("\n");

    await writeFile(path.join(dir, "entities", "person-jane doe.md"), fragmentA, "utf-8");
    await writeFile(path.join(dir, "entities", "person-jane_doe.md"), fragmentB, "utf-8");

    await storage.mergeFragmentedEntities();
    const raw = await readFile(path.join(dir, "entities", "person-jane-doe.md"), "utf-8");
    const parsed = parseEntityFile(raw);

    assert.deepEqual(parsed.extraFrontmatterLines, ["tags: [alpha]", "owner: ops"]);
    assert.deepEqual(parsed.preSectionLines, ["Fragment A prose.", "", "Fragment B prose.", ""]);
    assert.deepEqual(parsed.extraSections?.map((section) => section.title), ["Notes", "Runbook"]);
    assert.match(raw, /## Notes/);
    assert.match(raw, /## Runbook/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("mergeFragmentedEntities preserves structured sections from fragments", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-entity-merge-structured-sections-"));
  try {
    const storage = new StorageManager(dir);
    await storage.ensureDirectories();

    const fragmentA = [
      "---",
      "created: 2026-04-13T10:00:00.000Z",
      "updated: 2026-04-13T10:05:00.000Z",
      "---",
      "",
      "# Jane Doe",
      "",
      "**Type:** person",
      "**Updated:** 2026-04-13T10:05:00.000Z",
      "",
      "## Beliefs",
      "",
      "- Small teams move faster than committees.",
      "",
      "## Timeline",
      "",
      "- [2026-04-13T10:05:00.000Z] Fragment A evidence",
      "",
    ].join("\n");
    const fragmentB = [
      "---",
      "created: 2026-04-13T10:00:00.000Z",
      "updated: 2026-04-13T11:05:00.000Z",
      "---",
      "",
      "# Jane Doe",
      "",
      "**Type:** person",
      "**Updated:** 2026-04-13T11:05:00.000Z",
      "",
      "## Beliefs",
      "",
      "- Roadmaps should stay legible to the team.",
      "",
      "## Communication Style",
      "",
      "- Prefers direct feedback without ceremony.",
      "",
      "## Timeline",
      "",
      "- [2026-04-13T11:05:00.000Z] Fragment B evidence",
      "",
    ].join("\n");

    await writeFile(path.join(dir, "entities", "person-jane doe.md"), fragmentA, "utf-8");
    await writeFile(path.join(dir, "entities", "person-jane_doe.md"), fragmentB, "utf-8");

    await storage.mergeFragmentedEntities();
    const raw = await readFile(path.join(dir, "entities", "person-jane-doe.md"), "utf-8");
    const parsed = parseEntityFile(raw) as any;

    assert.deepEqual(parsed.structuredSections, [
      {
        key: "beliefs",
        title: "Beliefs",
        facts: [
          "Small teams move faster than committees.",
          "Roadmaps should stay legible to the team.",
        ],
      },
      {
        key: "communication_style",
        title: "Communication Style",
        facts: ["Prefers direct feedback without ceremony."],
      },
    ]);
    assert.match(raw, /## Beliefs/);
    assert.match(raw, /## Communication Style/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("mergeFragmentedEntities uses a collision-safe timeline dedupe key", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-entity-merge-timeline-key-"));
  try {
    const storage = new StorageManager(dir);
    await storage.ensureDirectories();

    const fragmentA = [
      "---",
      "created: 2026-04-13T10:00:00.000Z",
      "updated: 2026-04-13T10:05:00.000Z",
      "---",
      "",
      "# Jane Doe",
      "",
      "**Type:** person",
      "**Updated:** 2026-04-13T10:05:00.000Z",
      "",
      "## Timeline",
      "",
      "- [2026-04-13T10:05:00.000Z] [source=extraction] [session=foo::bar] preserved rollout evidence",
      "",
    ].join("\n");
    const fragmentB = [
      "---",
      "created: 2026-04-13T10:00:00.000Z",
      "updated: 2026-04-13T10:06:00.000Z",
      "---",
      "",
      "# Jane Doe",
      "",
      "**Type:** person",
      "**Updated:** 2026-04-13T10:06:00.000Z",
      "",
      "## Timeline",
      "",
      "- [2026-04-13T10:05:00.000Z] [source=extraction] [session=foo] [principal=bar::] preserved rollout evidence",
      "",
    ].join("\n");

    await writeFile(path.join(dir, "entities", "person-jane doe.md"), fragmentA, "utf-8");
    await writeFile(path.join(dir, "entities", "person-jane_doe.md"), fragmentB, "utf-8");

    await storage.mergeFragmentedEntities();
    const raw = await readFile(path.join(dir, "entities", "person-jane-doe.md"), "utf-8");
    const parsed = parseEntityFile(raw);

    assert.equal(parsed.timeline.length, 2);
    assert.deepEqual(
      parsed.timeline.map((entry) => ({
        sessionKey: entry.sessionKey,
        principal: entry.principal,
        text: entry.text,
      })),
      [
        {
          sessionKey: "foo::bar",
          principal: undefined,
          text: "preserved rollout evidence",
        },
        {
          sessionKey: "foo",
          principal: "bar::",
          text: "preserved rollout evidence",
        },
      ],
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("mergeFragmentedEntities preserves duplicate lines in preserved metadata blocks", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-entity-merge-duplicate-lines-"));
  try {
    const storage = new StorageManager(dir);
    await storage.ensureDirectories();

    const fragmentA = [
      "---",
      "created: 2026-04-13T10:00:00.000Z",
      "updated: 2026-04-13T10:05:00.000Z",
      "labels:",
      "- foo",
      "---",
      "",
      "# Jane Doe",
      "",
      "**Type:** person",
      "**Updated:** 2026-04-13T10:05:00.000Z",
      "",
      "Repeated line",
      "",
    ].join("\n");
    const fragmentB = [
      "---",
      "created: 2026-04-13T10:00:00.000Z",
      "updated: 2026-04-13T10:06:00.000Z",
      "owners:",
      "- foo",
      "---",
      "",
      "# Jane Doe",
      "",
      "**Type:** person",
      "**Updated:** 2026-04-13T10:06:00.000Z",
      "",
      "Repeated line",
      "",
    ].join("\n");

    await writeFile(path.join(dir, "entities", "person-jane doe.md"), fragmentA, "utf-8");
    await writeFile(path.join(dir, "entities", "person-jane_doe.md"), fragmentB, "utf-8");

    await storage.mergeFragmentedEntities();
    const raw = await readFile(path.join(dir, "entities", "person-jane-doe.md"), "utf-8");
    const parsed = parseEntityFile(raw);

    assert.deepEqual(parsed.extraFrontmatterLines, ["labels:", "- foo", "owners:", "- foo"]);
    assert.deepEqual(parsed.preSectionLines, ["Repeated line", "", "Repeated line", ""]);
    assert.match(raw, /labels:\n- foo\nowners:\n- foo/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("mergeFragmentedEntities prefers parseable created timestamps over malformed values", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-entity-merge-created-validity-"));
  try {
    const storage = new StorageManager(dir);
    await storage.ensureDirectories();

    const fragmentA = [
      "---",
      "created: not-a-date",
      "updated: 2026-04-13T10:05:00.000Z",
      "---",
      "",
      "# Jane Doe",
      "",
      "**Type:** person",
      "**Updated:** 2026-04-13T10:05:00.000Z",
      "",
      "## Timeline",
      "",
      "- [2026-04-13T10:05:00.000Z] Fragment A evidence",
      "",
    ].join("\n");
    const fragmentB = [
      "---",
      "created: 2026-04-13T09:00:00.000Z",
      "updated: 2026-04-13T11:05:00.000Z",
      "---",
      "",
      "# Jane Doe",
      "",
      "**Type:** person",
      "**Updated:** 2026-04-13T11:05:00.000Z",
      "",
      "## Timeline",
      "",
      "- [2026-04-13T11:05:00.000Z] Fragment B evidence",
      "",
    ].join("\n");

    await writeFile(path.join(dir, "entities", "person-jane doe.md"), fragmentA, "utf-8");
    await writeFile(path.join(dir, "entities", "person-jane_doe.md"), fragmentB, "utf-8");

    await storage.mergeFragmentedEntities();
    const raw = await readFile(path.join(dir, "entities", "person-jane-doe.md"), "utf-8");
    const parsed = parseEntityFile(raw);

    assert.equal(parsed.created, "2026-04-13T09:00:00.000Z");
    assert.match(raw, /^---\ncreated: 2026-04-13T09:00:00.000Z/m);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("refreshEntitySynthesisQueue orders stale entities by parsed latest timeline timestamps", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-entity-synthesis-queue-order-"));
  try {
    const storage = new StorageManager(dir);
    await storage.ensureDirectories();

    const newerCanonical = normalizeEntityName("Jane Doe", "person");
    await storage.writeEntity("Jane Doe", "person", ["Newest offset entity should lead the queue."], {
      timestamp: "2026-04-13T10:00:00-05:00",
      source: "extraction",
    });
    await storage.updateEntitySynthesis(newerCanonical, "Jane Doe had an older synthesis.", {
      updatedAt: "2026-04-13T14:30:00Z",
      synthesisTimelineCount: 1,
    });

    const olderCanonical = normalizeEntityName("Project Beta", "project");
    await storage.writeEntity("Project Beta", "project", ["Older UTC entity should come second."], {
      timestamp: "2026-04-13T14:45:00Z",
      source: "extraction",
    });
    await storage.updateEntitySynthesis(olderCanonical, "Project Beta had an older synthesis.", {
      updatedAt: "2026-04-13T14:40:00Z",
      synthesisTimelineCount: 1,
    });

    const queue = await storage.refreshEntitySynthesisQueue();

    assert.deepEqual(queue, [newerCanonical, olderCanonical]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("refreshEntitySynthesisQueue keeps canonical filenames when headings drift", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-entity-synthesis-queue-filename-"));
  try {
    const storage = new StorageManager(dir);
    await storage.ensureDirectories();

    const canonical = normalizeEntityName("Jane Doe", "person");
    await storage.writeEntity("Jane Doe", "person", ["Leads roadmap work."], {
      timestamp: "2026-04-13T10:00:00.000Z",
      source: "extraction",
    });
    await storage.updateEntitySynthesis(canonical, "Jane Doe leads roadmap work.", {
      updatedAt: "2026-04-13T10:01:00.000Z",
      synthesisTimelineCount: 1,
    });
    await storage.writeEntity("Jane Do", "person", ["Newest stale fact."], {
      timestamp: "2026-04-13T10:02:00.000Z",
      source: "extraction",
    });

    const queue = await storage.refreshEntitySynthesisQueue();

    assert.deepEqual(queue, [canonical]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("updateEntitySynthesis removes queue entries that match the parsed canonical heading", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-entity-synthesis-queue-remove-"));
  try {
    const storage = new StorageManager(dir);
    await storage.ensureDirectories();

    const canonicalFilename = normalizeEntityName("Jane Doe", "person");
    const parsedCanonical = normalizeEntityName("Jane Do", "person");
    await storage.writeEntity("Jane Doe", "person", ["Leads roadmap work."], {
      timestamp: "2026-04-13T10:00:00.000Z",
      source: "extraction",
    });

    const entityPath = path.join(dir, "entities", `${canonicalFilename}.md`);
    const raw = await readFile(entityPath, "utf-8");
    await writeFile(entityPath, raw.replace("# Jane Doe", "# Jane Do"), "utf-8");
    await writeFile(
      path.join(dir, "state", "entity-synthesis-queue.json"),
      JSON.stringify({
        updatedAt: "2026-04-13T10:05:00.000Z",
        entityNames: [parsedCanonical],
      }, null, 2) + "\n",
      "utf-8",
    );

    await storage.updateEntitySynthesis(canonicalFilename, "Jane Doe leads roadmap work.", {
      updatedAt: "2026-04-13T10:06:00.000Z",
      synthesisTimelineCount: 1,
    });

    const queue = await storage.readEntitySynthesisQueue();

    assert.deepEqual(queue, []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
