/**
 * Integration tests for the episodic-context recall section (issue #2331).
 *
 * Seeds a real Orchestrator with an LCM archive and one fact whose
 * `sources` provenance carries a resolvable turn fingerprint, then asserts:
 *  - flag off: no `## Source Episodes` section and ZERO archive reads
 *  - flag on: grouped episode injected, within the recall budget
 *  - facts without structured sources are skipped
 *  - foreign-session provenance (cross-namespace) is skipped
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { parseConfig } from "./config.js";
import { Orchestrator } from "./orchestrator.js";
import type { ProvenanceSource } from "./types.js";

const SEP = String.fromCharCode(1);

const SESSION_KEY = "session-atlas-7";

function fingerprint(turnIndex: number): string {
  return `user${SEP}we settled the storage question${SEP}thread-1${SEP}${turnIndex}`;
}

function provenance(turnIndex: number): ProvenanceSource {
  return {
    sessionKey: SESSION_KEY,
    turnId: fingerprint(turnIndex),
    observedAt: "2026-08-16T00:00:00.000Z",
    quote: "we settled the storage question",
  };
}

async function seedArchive(orchestrator: Orchestrator): Promise<void> {
  const engine = orchestrator.lcmEngine!;
  await engine.observeMessages(SESSION_KEY, [
    { role: "user", content: "turn zero greeting" },
    { role: "user", content: "we settled the storage question: postgres for the atlas cluster" },
    { role: "assistant", content: "understood, postgres it is" },
    { role: "user", content: "also note the replica lives in frankfurt" },
    { role: "assistant", content: "replica noted" },
  ]);
  await engine.waitForObserveQueueIdle();
}

/** Wrap the engine's read surfaces with call counters. */
function countArchiveReads(orchestrator: Orchestrator): { reads: () => number } {
  const engine = orchestrator.lcmEngine as unknown as {
    getTurnRange: (...args: unknown[]) => Promise<unknown[]>;
    searchContextFull: (...args: unknown[]) => Promise<unknown[]>;
  };
  let reads = 0;
  const originalGetTurnRange = engine.getTurnRange.bind(engine);
  const originalSearch = engine.searchContextFull.bind(engine);
  engine.getTurnRange = async (...args: unknown[]) => {
    reads += 1;
    return originalGetTurnRange(...args);
  };
  engine.searchContextFull = async (...args: unknown[]) => {
    reads += 1;
    return originalSearch(...args);
  };
  return { reads: () => reads };
}

async function buildOrchestrator(
  memoryDir: string,
  episodicContextEnabled: boolean,
): Promise<Orchestrator> {
  const config = parseConfig({
    memoryDir,
    qmdEnabled: false,
    lcmEnabled: true,
    episodicContextEnabled,
    transcriptEnabled: false,
    injectQuestions: false,
    sharedContextEnabled: false,
  });
  return new Orchestrator(config);
}

test("episodic context: flag off = no section and zero archive reads", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-episodic-off-"));
  try {
    const orchestrator = await buildOrchestrator(memoryDir, false);
    await seedArchive(orchestrator);
    const storage = await orchestrator.getStorage("default");
    await storage.ensureDirectories();
    await storage.writeMemory("fact", "The atlas cluster stores its graph in postgres.", {
      source: "test",
      sources: [provenance(1)],
    });
    const counter = countArchiveReads(orchestrator);
    const context = await orchestrator.recall("where does the atlas cluster store data?", SESSION_KEY);
    assert.ok(!context.includes("## Source Episodes"), "flag off must not inject the section");
    assert.equal(counter.reads(), 0, "flag off must issue zero archive reads");
    await orchestrator.destroy();
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("episodic context: flag on injects grouped episodes within budget", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-episodic-on-"));
  try {
    const orchestrator = await buildOrchestrator(memoryDir, true);
    await seedArchive(orchestrator);
    const storage = await orchestrator.getStorage("default");
    await storage.ensureDirectories();
    // Two facts whose windows overlap around turn 1: one merged episode.
    await storage.writeMemory("fact", "The atlas cluster stores its graph in postgres.", {
      source: "test",
      sources: [provenance(1)],
    });
    await storage.writeMemory("fact", "The atlas replica lives in frankfurt.", {
      source: "test",
      sources: [provenance(3)],
    });
    // A fact with NO structured sources: silently skipped.
    await storage.writeMemory("fact", "Legacy fact without provenance sources.", {
      source: "test",
    });
    const context = await orchestrator.recall("where does the atlas cluster store data?", SESSION_KEY);
    const sectionStart = context.indexOf("## Source Episodes");
    assert.ok(sectionStart >= 0, `section must be injected, got: ${context.slice(0, 400)}`);
    const section = context.slice(sectionStart);
    assert.ok(section.includes("### Episode: session-"), "episode header uses shortened session key");
    assert.ok(section.includes("supports ["), "episode cites supporting memory ids");
    assert.ok(section.includes("postgres for the atlas cluster"), "raw source turn is injected");
    assert.ok(section.includes("replica lives in frankfurt"), "merged window covers turn 3");
    assert.ok(!section.includes("Legacy fact"), "fact without sources contributes nothing");
    assert.ok(context.length <= orchestrator.config.recallBudgetChars + 2000, "context stays within budget envelope");
    await orchestrator.destroy();
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("episodic context: foreign-session provenance is skipped under namespace framing", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-episodic-ns-"));
  try {
    const orchestrator = await buildOrchestrator(memoryDir, true);
    await seedArchive(orchestrator);
    // The fact's provenance points at a session whose rows live under a
    // DIFFERENT namespace frame than this single-store recall resolves.
    // Candidate keys never match, so no episode is injected.
    const foreign: ProvenanceSource = {
      sessionKey: "\u001fsome-other-tenant\u001fsession-atlas-7",
      turnId: fingerprint(1),
      observedAt: "2026-08-16T00:00:00.000Z",
      quote: "we settled the storage question",
    };
    const storage = await orchestrator.getStorage("default");
    await storage.ensureDirectories();
    await storage.writeMemory("fact", "The atlas cluster stores its graph in postgres.", {
      source: "test",
      sources: [foreign],
    });
    const context = await orchestrator.recall("where does the atlas cluster store data?", SESSION_KEY);
    assert.ok(!context.includes("## Source Episodes"), "foreign-session episode must be skipped");
    await orchestrator.destroy();
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});
