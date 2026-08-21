/**
 * Preference drift detection (issue #2371).
 *
 * Covers the acceptance matrix:
 *   1. Fixture namespace with a preference restated last week, one untouched
 *      for six months, and one with recent opposing evidence: shadow reports
 *      corroborated / stale / drifted respectively and writes NOTHING; apply
 *      stamps the first two and opens exactly one review item for the third.
 *   2. Resolving that review item with `supersede` writes a superseding
 *      memory through the real storage path, and the replacement is what a
 *      later read returns.
 *   3. `recallDamping: true` sinks a stale preference below an otherwise-equal
 *      fresh memory; with the flag off — including the string `"false"` — the
 *      ordering is byte-identical to the input.
 *   4. A failing evidence lookup marks the preference
 *      `skipped: backend_unavailable`, never `stale`.
 *   5. Window bounds are half-open `[start, end)`; runs are deterministic.
 *   6. Every non-active status is excluded from candidacy.
 */
import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";

import { StorageManager } from "../storage.js";
import { parseConfig } from "../config.js";
import type { MemoryFile, PluginConfig, QmdSearchResult } from "../types.js";
import type { SemanticDedupHit, SemanticDedupLookup } from "../dedup/semantic.js";
import { listPairs, readPair } from "../contradiction/contradiction-review.js";
import { executeResolution } from "../contradiction/resolution.js";
import {
  runPreferenceDriftScan,
  readPreferenceDriftMarker,
  type PreferenceDriftFinding,
} from "./preference-drift.js";
import { applyPreferenceDriftRanking, isPreferenceDriftStageActive, driftAgeNote } from "./drift-recall.js";
import { parseDriftDetectionConfig, DRIFT_DETECTION_DEFAULTS } from "./drift-config.js";

const NOW = new Date("2026-08-18T12:00:00.000Z");
const DAY_MS = 24 * 60 * 60 * 1000;

function driftConfig(overrides: Record<string, unknown> = {}): PluginConfig {
  return parseConfig({
    openaiApiKey: "sk-test",
    driftDetection: { enabled: true, ...overrides },
  });
}

/**
 * Raw memory file with full frontmatter control, mirroring the memory-worth /
 * procedural test pattern so the parser and serializer under test are the real
 * ones rather than a fixture shape.
 */
async function writeMemory(
  storage: StorageManager,
  id: string,
  category: string,
  content: string,
  extraFrontmatter: string[] = [],
): Promise<string> {
  const dir = path.join(storage.dir, "facts", "2026-01-01");
  await mkdir(dir, { recursive: true });
  const lines = [
    "---",
    `id: ${id}`,
    `category: ${category}`,
    `created: ${new Date(NOW.getTime() - 200 * DAY_MS).toISOString()}`,
    `updated: ${new Date(NOW.getTime() - 200 * DAY_MS).toISOString()}`,
    "confidence: 0.8",
    "tags: []",
    ...extraFrontmatter,
    "---",
  ];
  const filePath = path.join(dir, `${id}.md`);
  await writeFile(filePath, `${lines.join("\n")}\n\n${content}\n`, "utf-8");
  return filePath;
}

/**
 * Deterministic evidence lookup keyed on the querying preference's own text,
 * so each fixture preference gets exactly the neighbors the scenario needs.
 */
function lookupFor(map: Record<string, SemanticDedupHit[]>): SemanticDedupLookup {
  return async (content: string) => {
    for (const [needle, hits] of Object.entries(map)) {
      if (content.includes(needle)) return hits;
    }
    return [];
  };
}

/**
 * LLM stub shaped like `LocalLlmClient.chatCompletion`. The judge builds its
 * own `pairKey` (sorted memory ids) and echoes it in the prompt, so the stub
 * reads the keys back out rather than guessing their order, then answers each
 * one from the evidence id it contains. Anything unlisted is `independent`,
 * which is the "evidence about something else" case.
 */
function judgeStub(verdictByEvidenceId: Record<string, string>) {
  return {
    chatCompletion: async (messages: Array<{ role: string; content: string }>) => {
      const prompt = messages.map((m) => m.content).join("\n");
      const keys = [...prompt.matchAll(/pairKey: "([^"]+)"/g)].map((m) => m[1]!);
      const entries = keys.map((pairKey) => {
        const hit = Object.entries(verdictByEvidenceId).find(([evidenceId]) =>
          pairKey.includes(evidenceId),
        );
        const verdict = hit?.[1] ?? "independent";
        return { pairKey, verdict, rationale: `stub verdict ${verdict}`, confidence: 0.9 };
      });
      return { content: JSON.stringify(entries) };
    },
  };
}

const PREF_IDS = {
  corroborated: "pref-corroborated",
  stale: "pref-stale",
  drifted: "pref-drifted",
};

/** The acceptance fixture: three aging preferences plus their evidence. */
async function seedFixture(storage: StorageManager): Promise<void> {
  await writeMemory(
    storage,
    PREF_IDS.corroborated,
    "preference",
    "User prefers dark mode in every editor.",
  );
  await writeMemory(storage, PREF_IDS.stale, "preference", "User prefers tabs over spaces.");
  await writeMemory(storage, PREF_IDS.drifted, "preference", "User prefers pnpm for package installs.");

  // Recent restatement, 7 days old — inside the 45-day lookback window.
  await writeMemory(storage, "ev-restates", "fact", "User said again they want dark mode everywhere.", [
    `updated: ${new Date(NOW.getTime() - 7 * DAY_MS).toISOString()}`,
  ]);
  // Recent opposing behavioral evidence, 3 days old.
  await writeMemory(storage, "ev-opposes", "fact", "User ran bun install for every project this week.", [
    `updated: ${new Date(NOW.getTime() - 3 * DAY_MS).toISOString()}`,
  ]);
}

async function scan(
  storage: StorageManager,
  memoryDir: string,
  config: PluginConfig,
  options: { apply?: boolean; lookup?: SemanticDedupLookup; localLlm?: unknown } = {},
) {
  return runPreferenceDriftScan({
    storage,
    config,
    memoryDir,
    storageForNamespace: () => storage,
    embeddingLookup:
      options.lookup ??
      lookupFor({
        "dark mode": [{ id: "ev-restates", score: 0.9 }],
        "tabs over spaces": [],
        pnpm: [{ id: "ev-opposes", score: 0.88 }],
      }),
    localLlm: (options.localLlm
      ?? judgeStub({
        "ev-restates": "duplicates",
        "ev-at-start": "duplicates",
        "ev-opposes": "contradicts",
      })) as never,
    fallbackLlm: null,
    apply: options.apply,
    now: NOW,
  });
}

function findingFor(findings: PreferenceDriftFinding[], id: string): PreferenceDriftFinding {
  const found = findings.find((f) => f.memoryId === id);
  assert.ok(found, `expected a finding for ${id}`);
  return found;
}

// ════════════════════════════════════════════════════════════════════════════
// 1. Classification + shadow/apply
// ════════════════════════════════════════════════════════════════════════════

test("shadow scan classifies corroborated / stale / drifted and writes nothing", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-drift-shadow-"));
  try {
    const storage = new StorageManager(dir);
    await seedFixture(storage);

    const report = await scan(storage, dir, driftConfig());

    assert.equal(report.mode, "shadow");
    assert.equal(report.scanned, 3, "all three aging preferences are candidates");
    assert.equal(findingFor(report.findings, PREF_IDS.corroborated).classification, "corroborated");
    assert.equal(findingFor(report.findings, PREF_IDS.stale).classification, "stale");
    assert.equal(findingFor(report.findings, PREF_IDS.drifted).classification, "drifted");
    assert.equal(report.appliedCount, 0);
    assert.equal(report.reviewItemsOpened, 0);

    // Shadow writes NOTHING — not the stamps, not the review queue, not even
    // the run marker.
    const after = await storage.getMemoryById(PREF_IDS.stale);
    assert.equal(after?.frontmatter.driftState, undefined);
    assert.equal(listPairs(dir).total, 0);
    assert.equal(await readPreferenceDriftMarker(dir), null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("apply stamps corroborated + stale and opens exactly one review item for drifted", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-drift-apply-"));
  try {
    const storage = new StorageManager(dir);
    await seedFixture(storage);

    const report = await scan(storage, dir, driftConfig(), { apply: true });

    assert.equal(report.mode, "apply");
    assert.equal(report.reviewItemsOpened, 1, "exactly one review item for the drifted preference");

    const corroborated = await storage.getMemoryById(PREF_IDS.corroborated);
    assert.equal(corroborated?.frontmatter.lastCorroborated, NOW.toISOString());
    assert.equal(corroborated?.frontmatter.driftState, undefined, "corroboration clears any stale mark");

    const stale = await storage.getMemoryById(PREF_IDS.stale);
    assert.equal(stale?.frontmatter.driftState, "stale");
    assert.equal(stale?.frontmatter.lastCorroborated, undefined);
    assert.equal(stale?.frontmatter.status ?? "active", "active", "stale is never a lifecycle change");

    const drifted = await storage.getMemoryById(PREF_IDS.drifted);
    assert.equal(drifted?.frontmatter.status ?? "active", "active", "drift never auto-supersedes");

    const queued = listPairs(dir, { filter: "all" });
    assert.equal(queued.total, 1);
    const item = queued.pairs[0]!;
    assert.equal(item.kind, "preference-drift");
    assert.deepEqual(item.memoryIds, [PREF_IDS.drifted, "ev-opposes"]);
    assert.equal(item.verdict, "contradicts");
    assert.equal(item.resolution, undefined, "a fresh drift item is unresolved");

    const marker = await readPreferenceDriftMarker(dir);
    assert.equal(marker?.lastApplyAt, NOW.toISOString());
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("re-running apply on identical fixtures is deterministic", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-drift-determinism-"));
  try {
    const storage = new StorageManager(dir);
    await seedFixture(storage);

    const first = await scan(storage, dir, driftConfig());
    const second = await scan(storage, dir, driftConfig());

    assert.deepEqual(
      first.findings.map((f) => [f.memoryId, f.classification]),
      second.findings.map((f) => [f.memoryId, f.classification]),
      "classification order and verdicts must be stable across runs",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ════════════════════════════════════════════════════════════════════════════
// 2. Review resolution
// ════════════════════════════════════════════════════════════════════════════

test("resolving a drift item with supersede retires the old preference for the new one", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-drift-supersede-"));
  try {
    const storage = new StorageManager(dir);
    await seedFixture(storage);
    await scan(storage, dir, driftConfig(), { apply: true });

    const pairId = listPairs(dir, { filter: "all" }).pairs[0]!.pairId;
    const outcome = await executeResolution(dir, storage, pairId, "supersede", {
      mergedContent: "User prefers bun for package installs.",
    });

    assert.ok(outcome.affectedIds.includes(PREF_IDS.drifted), outcome.message);
    const replacementId = outcome.affectedIds.find((id) => id !== PREF_IDS.drifted);
    assert.ok(replacementId, `expected a replacement id in ${JSON.stringify(outcome.affectedIds)}`);

    const old = await storage.getMemoryById(PREF_IDS.drifted);
    assert.equal(old?.frontmatter.status, "superseded");
    assert.equal(old?.frontmatter.supersededBy, replacementId);

    const replacement = await storage.getMemoryById(replacementId!);
    assert.equal(replacement?.frontmatter.category, "preference");
    assert.match(replacement!.content, /bun for package installs/);
    assert.equal(replacement?.frontmatter.status ?? "active", "active");

    // The item is terminally resolved and leaves the actionable queue.
    assert.equal(readPair(dir, pairId)?.resolution, "supersede");
    assert.equal(listPairs(dir, { filter: "unresolved" }).total, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("keep confirms the preference and archive demotes it", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-drift-keep-"));
  try {
    const storage = new StorageManager(dir);
    await seedFixture(storage);
    await scan(storage, dir, driftConfig(), { apply: true });
    const pairId = listPairs(dir, { filter: "all" }).pairs[0]!.pairId;

    const kept = await executeResolution(dir, storage, pairId, "keep", {});
    assert.deepEqual(kept.affectedIds, [PREF_IDS.drifted], kept.message);
    const confirmed = await storage.getMemoryById(PREF_IDS.drifted);
    assert.ok(confirmed?.frontmatter.lastCorroborated, "keep stamps lastCorroborated");
    assert.equal(confirmed?.frontmatter.status ?? "active", "active");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a contradiction verb is refused on a drift item and vice versa", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-drift-verbs-"));
  try {
    const storage = new StorageManager(dir);
    await seedFixture(storage);
    await scan(storage, dir, driftConfig(), { apply: true });
    const pairId = listPairs(dir, { filter: "all" }).pairs[0]!.pairId;

    const refused = await executeResolution(dir, storage, pairId, "keep-a", {});
    assert.deepEqual(refused.affectedIds, []);
    assert.match(refused.message, /not valid for a preference-drift item/);
    assert.equal(readPair(dir, pairId)?.resolution, undefined, "a refusal must not resolve the item");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ════════════════════════════════════════════════════════════════════════════
// 3. Recall damping + annotation
// ════════════════════════════════════════════════════════════════════════════

const stalePreferenceFm = { category: "preference", driftState: "stale" as const };
const freshFactFm = { category: "fact" };

test("recallDamping sinks a stale preference below an otherwise-equal fresh memory", () => {
  const config = parseDriftDetectionConfig({ enabled: true, recallDamping: true });
  const ordered = applyPreferenceDriftRanking(
    [
      { key: "stale.md", rank: 2, frontmatter: stalePreferenceFm },
      { key: "fresh.md", rank: 2, frontmatter: freshFactFm },
    ],
    { config, now: NOW },
  );
  assert.deepEqual(
    ordered.map((o) => o.key),
    ["fresh.md", "stale.md"],
  );
  assert.equal(ordered.find((o) => o.key === "stale.md")?.multiplier, 0.8);
  assert.equal(ordered.find((o) => o.key === "fresh.md")?.multiplier, 1);
});

test("damping off — including the string \"false\" — leaves order and multipliers untouched", () => {
  for (const raw of [undefined, false, "false", "0", "no", "off"]) {
    const config = parseDriftDetectionConfig(
      raw === undefined ? { enabled: true } : { enabled: true, recallDamping: raw },
    );
    const ordered = applyPreferenceDriftRanking(
      [
        { key: "stale.md", rank: 2, frontmatter: stalePreferenceFm },
        { key: "fresh.md", rank: 1, frontmatter: freshFactFm },
      ],
      { config, now: NOW },
    );
    assert.deepEqual(
      ordered.map((o) => o.key),
      ["stale.md", "fresh.md"],
      `recallDamping=${JSON.stringify(raw)} must not reorder`,
    );
    assert.ok(
      ordered.every((o) => o.multiplier === 1),
      `recallDamping=${JSON.stringify(raw)} must leave every multiplier at 1`,
    );
    assert.equal(isPreferenceDriftStageActive(config), false);
  }
});

test("stalePenalty 1 is a documented no-op that keeps the stage inert", () => {
  const config = parseDriftDetectionConfig({ enabled: true, recallDamping: true, stalePenalty: 1 });
  assert.equal(config.stalePenalty, 1);
  assert.equal(isPreferenceDriftStageActive(config), false);
  const ordered = applyPreferenceDriftRanking(
    [
      { key: "stale.md", rank: 2, frontmatter: stalePreferenceFm },
      { key: "fresh.md", rank: 1, frontmatter: freshFactFm },
    ],
    { config, now: NOW },
  );
  assert.deepEqual(
    ordered.map((o) => o.key),
    ["stale.md", "fresh.md"],
  );
});

test("annotateAfterDays emits an age note only past the window, and never mutates state", () => {
  const off = parseDriftDetectionConfig({ enabled: true });
  assert.equal(driftAgeNote({ category: "preference", created: "2026-01-05T00:00:00.000Z" }, off, NOW), undefined);

  const on = parseDriftDetectionConfig({ enabled: true, annotateAfterDays: 90 });
  assert.equal(
    driftAgeNote({ category: "preference", created: "2026-01-05T00:00:00.000Z" }, on, NOW),
    "(stated 2026-01; not corroborated since)",
  );
  // Inside the window → no note.
  assert.equal(
    driftAgeNote(
      { category: "preference", created: new Date(NOW.getTime() - 10 * DAY_MS).toISOString() },
      on,
      NOW,
    ),
    undefined,
  );
  // A non-preference is never annotated.
  assert.equal(driftAgeNote({ category: "fact", created: "2026-01-05T00:00:00.000Z" }, on, NOW), undefined);
  // lastCorroborated wins over created as the age anchor.
  assert.equal(
    driftAgeNote(
      { category: "preference", created: "2020-01-01T00:00:00.000Z", lastCorroborated: "2026-02-01T00:00:00.000Z" },
      on,
      NOW,
    ),
    "(corroborated 2026-02; not since)",
  );
});

test("ranking is a total comparator — equal damped scores preserve input order", () => {
  const config = parseDriftDetectionConfig({ enabled: true, recallDamping: true });
  const inputs = [
    { key: "b.md", rank: 5, frontmatter: freshFactFm },
    { key: "a.md", rank: 5, frontmatter: freshFactFm },
  ];
  const first = applyPreferenceDriftRanking(inputs, { config, now: NOW });
  const second = applyPreferenceDriftRanking(inputs, { config, now: NOW });
  assert.deepEqual(first.map((o) => o.key), ["b.md", "a.md"]);
  assert.deepEqual(first, second);
});

// ════════════════════════════════════════════════════════════════════════════
// 4. Backend failure is not staleness
// ════════════════════════════════════════════════════════════════════════════

test("a failing evidence lookup reports skipped: backend_unavailable, never stale", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-drift-backend-"));
  try {
    const storage = new StorageManager(dir);
    await seedFixture(storage);

    const report = await scan(storage, dir, driftConfig(), {
      apply: true,
      lookup: async () => {
        throw new Error("embedding backend unreachable");
      },
    });

    for (const finding of report.findings) {
      assert.equal(finding.classification, "skipped", `${finding.memoryId} must not be classified`);
      assert.equal(finding.skipped, "backend_unavailable");
    }
    assert.equal(report.counts.stale, 0, "a failed lookup is never counted as no-evidence");
    assert.equal(report.appliedCount, 0, "nothing is stamped when classification failed");
    const stale = await storage.getMemoryById(PREF_IDS.stale);
    assert.equal(stale?.frontmatter.driftState, undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("evidence with no judge verdict reports verification_unavailable, not corroborated", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-drift-nojudge-"));
  try {
    const storage = new StorageManager(dir);
    await seedFixture(storage);

    // No LLM at all: the judge returns `needs-user` for every pair.
    const report = await runPreferenceDriftScan({
      storage,
      config: driftConfig(),
      memoryDir: dir,
      storageForNamespace: () => storage,
      embeddingLookup: lookupFor({ "dark mode": [{ id: "ev-restates", score: 0.9 }] }),
      localLlm: null,
      fallbackLlm: null,
      apply: true,
      now: NOW,
    });

    const corroborated = findingFor(report.findings, PREF_IDS.corroborated);
    assert.equal(corroborated.classification, "skipped");
    assert.equal(corroborated.skipped, "verification_unavailable");
    const memory = await storage.getMemoryById(PREF_IDS.corroborated);
    assert.equal(
      memory?.frontmatter.lastCorroborated,
      undefined,
      "an unverified preference must never be stamped as corroborated",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ════════════════════════════════════════════════════════════════════════════
// 5. Window bounds + candidate gating
// ════════════════════════════════════════════════════════════════════════════

test("evidence exactly at the window start counts; at the run instant it does not", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-drift-window-"));
  try {
    const storage = new StorageManager(dir);
    await writeMemory(storage, PREF_IDS.stale, "preference", "User prefers tabs over spaces.");
    // Exactly at the inclusive lower bound of a 45-day lookback.
    await writeMemory(storage, "ev-at-start", "fact", "Tabs again, confirmed.", [
      `updated: ${new Date(NOW.getTime() - 45 * DAY_MS).toISOString()}`,
    ]);
    // Exactly at the exclusive upper bound.
    await writeMemory(storage, "ev-at-now", "fact", "Tabs again, confirmed.", [
      `updated: ${NOW.toISOString()}`,
    ]);

    const atStart = await scan(storage, dir, driftConfig(), {
      lookup: lookupFor({ "tabs over spaces": [{ id: "ev-at-start", score: 0.9 }] }),
    });
    assert.equal(findingFor(atStart.findings, PREF_IDS.stale).evidence.length, 1, "[start is inclusive");

    const atNow = await scan(storage, dir, driftConfig(), {
      lookup: lookupFor({ "tabs over spaces": [{ id: "ev-at-now", score: 0.9 }] }),
    });
    const finding = findingFor(atNow.findings, PREF_IDS.stale);
    assert.equal(finding.evidence.length, 0, "end) is exclusive");
    assert.equal(finding.classification, "stale");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("only active preferences past minAgeDays are candidates", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-drift-gating-"));
  try {
    const storage = new StorageManager(dir);
    // Every non-active status, plus a too-young preference and a non-preference.
    for (const status of ["pending_review", "rejected", "quarantined", "superseded", "archived"]) {
      await writeMemory(storage, `pref-${status}`, "preference", `Aging preference in ${status}.`, [
        `status: ${status}`,
      ]);
    }
    await writeMemory(storage, "pref-young", "preference", "Brand new preference.", [
      `created: ${new Date(NOW.getTime() - 5 * DAY_MS).toISOString()}`,
    ]);
    await writeMemory(storage, "fact-old", "fact", "An old plain fact.");
    await writeMemory(storage, PREF_IDS.stale, "preference", "User prefers tabs over spaces.");

    const report = await scan(storage, dir, driftConfig(), { lookup: async () => [] });

    assert.deepEqual(
      report.findings.map((f) => f.memoryId),
      [PREF_IDS.stale],
      "non-active statuses, young preferences, and non-preferences are all excluded",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("maxCandidatesPerRun caps the run and 0 disables the scan entirely", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-drift-cap-"));
  try {
    const storage = new StorageManager(dir);
    await seedFixture(storage);

    const capped = await scan(storage, dir, driftConfig({ maxCandidatesPerRun: 1 }));
    assert.equal(capped.scanned, 1);
    assert.equal(capped.eligible, 3, "eligible reports the pre-cap population");

    const disabled = await scan(storage, dir, driftConfig({ maxCandidatesPerRun: 0 }));
    assert.equal(disabled.skippedReason, "scan_disabled");
    assert.equal(disabled.findings.length, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("the scan is a no-op with driftDetection.enabled off", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-drift-off-"));
  try {
    const storage = new StorageManager(dir);
    await seedFixture(storage);
    const report = await scan(storage, dir, parseConfig({ openaiApiKey: "sk-test" }), { apply: true });
    assert.equal(report.skippedReason, "drift_disabled");
    assert.equal(report.appliedCount, 0);
    assert.equal(await readPreferenceDriftMarker(dir), null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ════════════════════════════════════════════════════════════════════════════
// 6. Config parsing + frontmatter round-trip
// ════════════════════════════════════════════════════════════════════════════

test("driftDetection defaults are off and parse from string-typed values", () => {
  assert.deepEqual(parseConfig({ openaiApiKey: "sk-test" }).driftDetection, DRIFT_DETECTION_DEFAULTS);
  const coerced = parseDriftDetectionConfig({
    enabled: "true",
    recallDamping: "1",
    minAgeDays: "30",
    lookbackDays: "10",
    maxCandidatesPerRun: "5",
    stalePenalty: "0.5",
    annotateAfterDays: "120",
  });
  assert.deepEqual(coerced, {
    enabled: true,
    minAgeDays: 30,
    lookbackDays: 10,
    maxCandidatesPerRun: 5,
    recallDamping: true,
    stalePenalty: 0.5,
    annotateAfterDays: 120,
  });
});

test("invalid driftDetection values are rejected loudly, never silently defaulted", () => {
  assert.throws(() => parseDriftDetectionConfig([]), /must be an object/);
  assert.throws(() => parseDriftDetectionConfig({ enabled: "maybe" }), /driftDetection\.enabled/);
  assert.throws(() => parseDriftDetectionConfig({ minAgeDays: 1.5 }), /must be an integer/);
  assert.throws(() => parseDriftDetectionConfig({ minAgeDays: -1 }), /between 0 and 36500/);
  assert.throws(() => parseDriftDetectionConfig({ maxCandidatesPerRun: -1 }), /integer >= 0/);
  assert.throws(() => parseDriftDetectionConfig({ stalePenalty: 0 }), /in \(0, 1\]/);
  assert.throws(() => parseDriftDetectionConfig({ stalePenalty: 1.5 }), /in \(0, 1\]/);
});

test("driftState and lastCorroborated round-trip through storage; corrupt values drop", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-drift-roundtrip-"));
  try {
    const storage = new StorageManager(dir);
    await writeMemory(storage, "pref-rt", "preference", "Round-trip me.", [
      "driftState: stale",
      "lastCorroborated: 2026-05-01T00:00:00.000Z",
    ]);
    await writeMemory(storage, "pref-corrupt", "preference", "Hand-edited verdict.", [
      "driftState: probably",
    ]);

    const ok = await storage.getMemoryById("pref-rt");
    assert.equal(ok?.frontmatter.driftState, "stale");
    assert.equal(ok?.frontmatter.lastCorroborated, "2026-05-01T00:00:00.000Z");

    const corrupt = await storage.getMemoryById("pref-corrupt");
    assert.equal(corrupt?.frontmatter.driftState, undefined, "an unrecognized verdict must not survive");

    // An unrecognized verdict is a caller bug on write, so the serializer throws.
    await assert.rejects(
      storage.writeMemoryFrontmatter(ok as MemoryFile, {
        driftState: "probably" as never,
      }),
      /invalid driftState/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("the recall stage annotates results without mutating the input array", () => {
  const config = parseDriftDetectionConfig({ enabled: true, annotateAfterDays: 30 });
  const results: QmdSearchResult[] = [
    { docid: "1", path: "a.md", snippet: "s", score: 1 },
  ];
  const ordered = applyPreferenceDriftRanking(
    [
      {
        key: "a.md",
        rank: 1,
        frontmatter: { category: "preference", created: "2026-01-01T00:00:00.000Z" },
      },
    ],
    { config, now: NOW },
  );
  assert.ok(ordered[0]!.note, "note is produced for an uncorroborated preference");
  assert.equal(results[0]!.driftNote, undefined, "the pure ranker never touches result objects");
});
