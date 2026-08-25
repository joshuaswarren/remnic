import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { makeTempDir as managedTempDir } from "./helpers/tmp-dir.mjs";
import { StorageManager, serializeEntityFile } from "@remnic/core/storage";
import {
  buildBriefing,
  focusMatchesEntity,
  parseBriefingWindow,
  parseBriefingFocus,
} from "@remnic/core/briefing";
import type {
  BriefingFollowup,
  EntityFile,
  CalendarSource,
  CalendarEvent,
  PluginConfig,
} from "@remnic/core/types";

// Fixed "now" so facts written into a particular YYYY-MM-DD directory land
// inside the briefing's lookback window deterministically.
const NOW = new Date("2026-04-11T12:00:00.000Z");

// Helper: write a minimal memory file directly to disk so tests can control
// created/updated timestamps (StorageManager.writeMemory would override them).
async function writeMemoryFixture(
  baseDir: string,
  params: {
    id: string;
    category: "fact" | "commitment" | "correction" | "decision";
    createdIso: string;
    updatedIso?: string;
    tags?: string[];
    entityRef?: string;
    content: string;
    source?: string;
  },
): Promise<void> {
  const updated = params.updatedIso ?? params.createdIso;
  const day = params.createdIso.slice(0, 10);
  const factsDayDir = path.join(baseDir, "facts", day);
  await mkdir(factsDayDir, { recursive: true });
  const tags = (params.tags ?? []).map((t) => `"${t}"`).join(", ");
  const lines = [
    "---",
    `id: ${params.id}`,
    `category: ${params.category}`,
    `created: ${params.createdIso}`,
    `updated: ${updated}`,
    `source: ${params.source ?? "test"}`,
    `confidence: 0.9`,
    `confidenceTier: implied`,
    `tags: [${tags}]`,
  ];
  if (params.entityRef) lines.push(`entityRef: ${params.entityRef}`);
  lines.push("---", "", params.content, "");
  await writeFile(path.join(factsDayDir, `${params.id}.md`), lines.join("\n"), "utf-8");
}

async function writeEntityFixture(
  baseDir: string,
  entity: EntityFile,
  entitySchemas?: PluginConfig["entitySchemas"],
): Promise<void> {
  const entitiesDir = path.join(baseDir, "entities");
  await mkdir(entitiesDir, { recursive: true });
  const filename = `${entity.name}.md`;
  await writeFile(path.join(entitiesDir, filename), serializeEntityFile(entity, entitySchemas), "utf-8");
}

const makeTempDir = (): Promise<string> => managedTempDir("remnic-briefing-builder-");

// ──────────────────────────────────────────────────────────────────────────

test("focusMatchesEntity falls back to summary when synthesis is empty", () => {
  const entity: EntityFile = {
    name: "Casey Example",
    type: "person",
    created: "2026-04-10T00:00:00.000Z",
    updated: "2026-04-10T00:00:00.000Z",
    facts: [],
    summary: "Casey Example owns rollout coordination.",
    synthesis: "",
    synthesisUpdatedAt: undefined,
    synthesisVersion: undefined,
    timeline: [],
    relationships: [],
    activity: [],
    aliases: [],
  };

  assert.equal(focusMatchesEntity(entity, { type: "person", value: "rollout coordination" }), true);
});

test("buildBriefing produces the five sections with deterministic fixtures", async () => {
  const dir = await makeTempDir();
  try {
    StorageManager.clearAllStaticCaches();
    const storage = new StorageManager(dir);
    await storage.ensureDirectories();

    // Window: yesterday (2026-04-10 00:00 → 2026-04-11 00:00)
    const window = parseBriefingWindow("yesterday", NOW)!;

    // Inside-window memories.
    await writeMemoryFixture(dir, {
      id: "fact-alpha-1",
      category: "fact",
      createdIso: "2026-04-10T09:00:00.000Z",
      entityRef: "project-alpha",
      tags: ["topic:retrieval"],
      content: "Alpha team decided to tune the recall reranker.",
    });
    await writeMemoryFixture(dir, {
      id: "fact-alpha-2",
      category: "commitment",
      createdIso: "2026-04-10T15:30:00.000Z",
      entityRef: "project-alpha",
      tags: ["pending"],
      content: "Follow up with ops about the deploy window.",
    });
    await writeMemoryFixture(dir, {
      id: "fact-open-question",
      category: "fact",
      createdIso: "2026-04-10T18:45:00.000Z",
      tags: ["topic:meta"],
      content: "Do we need to rotate the signing key?",
    });

    // Outside-window memory (should NOT appear).
    await writeMemoryFixture(dir, {
      id: "fact-too-old",
      category: "fact",
      createdIso: "2026-04-01T09:00:00.000Z",
      tags: ["topic:ancient"],
      content: "Ancient fact that predates the window.",
    });

    // Entities: one inside-window, one outside-window.
    await writeEntityFixture(dir, {
      name: "project-alpha",
      type: "project",
      updated: "2026-04-10T16:00:00.000Z",
      summary: "Shipping the retrieval overhaul",
      facts: ["Owned by alpha team"],
      timeline: [],
      relationships: [],
      activity: [],
      aliases: [],
    });
    await writeEntityFixture(dir, {
      name: "project-stale",
      type: "project",
      updated: "2026-03-01T00:00:00.000Z",
      facts: [],
      timeline: [],
      relationships: [],
      activity: [],
      aliases: [],
    });

    // Inject a deterministic follow-up generator so we don't touch OpenAI.
    const injectedFollowups: BriefingFollowup[] = [
      { text: "Confirm deploy window with ops", rationale: "pending commitment" },
      { text: "Decide on signing key rotation", rationale: "open question" },
    ];

    const result = await buildBriefing({
      storage,
      window,
      maxFollowups: 5,
      allowLlm: true,
      followupGenerator: async () => injectedFollowups,
      now: NOW,
    });

    // Active threads: 2 distinct buckets (project-alpha + meta topic).
    assert.equal(result.sections.activeThreads.length, 2);
    const threadIds = result.sections.activeThreads.map((t) => t.id).sort();
    assert.deepEqual(threadIds, ["entity:project-alpha", "topic:meta"]);

    // Recent entities: project-alpha only (project-stale is outside window).
    assert.equal(result.sections.recentEntities.length, 1);
    assert.equal(result.sections.recentEntities[0].name, "project-alpha");
    assert.equal(result.sections.recentEntities[0].type, "project");

    // Open commitments: the "pending" commitment + the open question.
    const commitmentKinds = result.sections.openCommitments.map((c) => c.kind).sort();
    assert.deepEqual(commitmentKinds, ["commitment", "question"]);

    // Suggested follow-ups came from our injected generator.
    assert.equal(result.sections.suggestedFollowups.length, 2);
    assert.equal(result.sections.suggestedFollowups[0].text, "Confirm deploy window with ops");
    assert.equal(result.followupsUnavailableReason, undefined);

    // Window echo in the result matches our parsed window.
    assert.equal(result.window.from, "2026-04-10T00:00:00.000Z");
    assert.equal(result.window.to, "2026-04-11T00:00:00.000Z");

    // Markdown should contain all section headings.
    assert.match(result.markdown, /## Active threads/);
    assert.match(result.markdown, /## Recent entities/);
    assert.match(result.markdown, /## Open commitments/);
    assert.match(result.markdown, /## Suggested follow-ups/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("buildBriefing honours a focus filter by excluding unrelated memories", async () => {
  const dir = await makeTempDir();
  try {
    StorageManager.clearAllStaticCaches();
    const storage = new StorageManager(dir);
    await storage.ensureDirectories();

    await writeMemoryFixture(dir, {
      id: "fact-alpha",
      category: "fact",
      createdIso: "2026-04-10T10:00:00.000Z",
      tags: ["topic:retrieval"],
      entityRef: "project-alpha",
      content: "Alpha retrieval change",
    });
    await writeMemoryFixture(dir, {
      id: "fact-beta",
      category: "fact",
      createdIso: "2026-04-10T11:00:00.000Z",
      tags: ["topic:unrelated"],
      entityRef: "project-beta",
      content: "Beta team worked on unrelated thing",
    });

    await writeEntityFixture(dir, {
      name: "project-alpha",
      type: "project",
      updated: "2026-04-10T11:00:00.000Z",
      summary: "Retrieval work",
      facts: [],
      timeline: [],
      relationships: [],
      activity: [],
      aliases: [],
    });
    await writeEntityFixture(dir, {
      name: "project-beta",
      type: "project",
      updated: "2026-04-10T11:00:00.000Z",
      summary: "Something else",
      facts: [],
      timeline: [],
      relationships: [],
      activity: [],
      aliases: [],
    });

    const window = parseBriefingWindow("yesterday", NOW)!;
    const focus = parseBriefingFocus("project:alpha");

    const result = await buildBriefing({
      storage,
      window,
      focus,
      maxFollowups: 0, // disable follow-ups cleanly
      now: NOW,
    });

    // Active threads should only contain alpha.
    const threadIds = result.sections.activeThreads.map((t) => t.id);
    assert.ok(threadIds.includes("entity:project-alpha"));
    assert.ok(!threadIds.includes("entity:project-beta"));

    // Recent entities filtered by focus.
    assert.equal(result.sections.recentEntities.length, 1);
    assert.equal(result.sections.recentEntities[0].name, "project-alpha");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("buildBriefing populates today's calendar when a CalendarSource is provided", async () => {
  const dir = await makeTempDir();
  try {
    StorageManager.clearAllStaticCaches();
    const storage = new StorageManager(dir);
    await storage.ensureDirectories();

    const stubEvents: CalendarEvent[] = [
      {
        id: "evt-1",
        title: "Design review",
        start: "2026-04-11T15:00:00.000Z",
        end: "2026-04-11T16:00:00.000Z",
      },
    ];
    const calendarSource: CalendarSource = {
      async eventsForDate(dateIso: string) {
        assert.equal(dateIso, "2026-04-11");
        return stubEvents;
      },
    };

    const window = parseBriefingWindow("yesterday", NOW)!;
    const result = await buildBriefing({
      storage,
      window,
      maxFollowups: 0,
      calendarSource,
      now: NOW,
    });

    assert.deepEqual(result.sections.todayCalendar, stubEvents);
    assert.match(result.markdown, /## Today's calendar/);
    assert.match(result.markdown, /Design review/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("buildBriefing never throws when the follow-up generator errors", async () => {
  const dir = await makeTempDir();
  try {
    StorageManager.clearAllStaticCaches();
    const storage = new StorageManager(dir);
    await storage.ensureDirectories();

    const window = parseBriefingWindow("yesterday", NOW)!;
    const result = await buildBriefing({
      storage,
      window,
      maxFollowups: 5,
      allowLlm: true,
      followupGenerator: async () => {
        throw new Error("simulated LLM failure");
      },
      now: NOW,
    });

    assert.equal(result.sections.suggestedFollowups.length, 0);
    assert.ok(result.followupsUnavailableReason);
    assert.match(result.followupsUnavailableReason!, /simulated LLM failure/);
    assert.match(result.markdown, /_Unavailable: .*simulated LLM failure/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
