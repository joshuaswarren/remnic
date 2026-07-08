import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { parseConfig } from "../packages/remnic-core/src/config.js";
import { Orchestrator } from "../packages/remnic-core/src/orchestrator.js";
import { dedupeEntitySynthesisEvidenceEntries } from "../packages/remnic-core/src/orchestration/entity-synthesis-coordinator.js";
import {
  isEntitySynthesisStale,
  normalizeEntityName,
  parseEntityFile,
  serializeEntityFile,
} from "../packages/remnic-core/src/storage.js";

test("processEntitySynthesisQueue refreshes stale entities in bounded batches", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-entity-synthesis-orch-memory-"));
  const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "remnic-entity-synthesis-orch-workspace-"));
  try {
    const orchestrator = new Orchestrator(parseConfig({
      openaiApiKey: "sk-test",
      memoryDir,
      workspaceDir,
      qmdEnabled: false,
      sharedContextEnabled: false,
      hourlySummariesEnabled: false,
      entitySummaryEnabled: true,
      entitySynthesisMaxTokens: 120,
    })) as any;
    const storage = await orchestrator.getStorage("default");
    await storage.ensureDirectories();

    const primaryName = "Jane Doe";
    const primaryCanonical = normalizeEntityName(primaryName, "person");
    await storage.writeEntity(primaryName, "person", ["Led the roadmap."], {
      timestamp: "2026-04-13T09:00:00.000Z",
      sessionKey: "session-1",
      principal: "agent:main",
      source: "extraction",
    });
    await storage.updateEntitySynthesis(primaryCanonical, "Jane Doe led the roadmap.", {
      updatedAt: "2026-04-13T09:30:00.000Z",
      synthesisTimelineCount: 1,
    });
    await storage.writeEntity(primaryName, "person", ["Now owns release approvals."], {
      timestamp: "2026-04-13T11:00:00.000Z",
      sessionKey: "session-2",
      principal: "agent:main",
      source: "extraction",
    });

    const secondaryName = "Project Beta";
    const secondaryCanonical = normalizeEntityName(secondaryName, "project");
    await storage.writeEntity(secondaryName, "project", ["Tracks a cleanup stream."], {
      timestamp: "2026-04-13T10:00:00.000Z",
      source: "extraction",
    });

    let capturedPrompt = "";
    orchestrator.fastChatCompletion = async (messages: Array<{ role: string; content: string }>) => {
      capturedPrompt = messages.map((message) => message.content).join("\n\n");
      return { content: "Jane Doe now owns release approvals and still leads roadmap work." };
    };

    const refreshStartedAt = Date.now();
    const processed = await orchestrator.processEntitySynthesisQueue("default", 1);
    const refreshFinishedAt = Date.now();

    const rawPrimary = await readFile(path.join(memoryDir, "entities", `${primaryCanonical}.md`), "utf-8");
    const primary = parseEntityFile(rawPrimary);
    const queue = await storage.readEntitySynthesisQueue();

    assert.equal(processed, 1);
    assert.equal(primary.synthesis, "Jane Doe now owns release approvals and still leads roadmap work.");
    assert.equal(primary.synthesisVersion, 2);
    assert.equal(primary.synthesisUpdatedAt, "2026-04-13T11:00:00.000Z");
    assert.ok(primary.updated);
    assert.ok(Date.parse(primary.updated) >= refreshStartedAt);
    assert.ok(Date.parse(primary.updated) <= refreshFinishedAt);
    assert.match(capturedPrompt, /Previous synthesis:\nJane Doe led the roadmap\./);
    assert.match(capturedPrompt, /Now owns release approvals\./);
    assert.doesNotMatch(capturedPrompt, /Led the roadmap\.\n- timestamp=/);
    assert.deepEqual(queue, [secondaryCanonical]);
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
    await rm(workspaceDir, { recursive: true, force: true });
  }
});

test("processEntitySynthesisQueue sorts freshest evidence before truncating", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-entity-synthesis-orch-sort-memory-"));
  const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "remnic-entity-synthesis-orch-sort-workspace-"));
  try {
    const orchestrator = new Orchestrator(parseConfig({
      openaiApiKey: "sk-test",
      memoryDir,
      workspaceDir,
      qmdEnabled: false,
      sharedContextEnabled: false,
      hourlySummariesEnabled: false,
      entitySummaryEnabled: true,
      entitySynthesisMaxTokens: 120,
    })) as any;
    const storage = await orchestrator.getStorage("default");
    await storage.ensureDirectories();

    const canonical = normalizeEntityName("Jane Doe", "person");
    await storage.writeEntity("Jane Doe", "person", ["Newest event should survive truncation."], {
      timestamp: "2026-04-13T18:00:00.000Z",
      source: "extraction",
    });
    for (let hour = 10; hour <= 17; hour += 1) {
      await storage.writeEntity("Jane Doe", "person", [`Older event ${hour}.`], {
        timestamp: `2026-04-13T${String(hour).padStart(2, "0")}:00:00.000Z`,
        source: "extraction",
      });
    }
    await storage.updateEntitySynthesis(canonical, "Jane Doe had an earlier synthesis.", {
      updatedAt: "2026-04-13T09:00:00.000Z",
      synthesisTimelineCount: 1,
    });

    let capturedPrompt = "";
    orchestrator.fastChatCompletion = async (messages: Array<{ role: string; content: string }>) => {
      capturedPrompt = messages.map((message) => message.content).join("\n\n");
      return { content: "Jane Doe has refreshed synthesis." };
    };

    const processed = await orchestrator.processEntitySynthesisQueue("default", 1);

    assert.equal(processed, 1);
    assert.match(capturedPrompt, /Newest event should survive truncation\./);
    assert.doesNotMatch(capturedPrompt, /Older event 10\./);
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
    await rm(workspaceDir, { recursive: true, force: true });
  }
});

test("processEntitySynthesisQueue batches overflow evidence before advancing freshness", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-entity-synthesis-orch-batch-memory-"));
  const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "remnic-entity-synthesis-orch-batch-workspace-"));
  try {
    const orchestrator = new Orchestrator(parseConfig({
      openaiApiKey: "sk-test",
      memoryDir,
      workspaceDir,
      qmdEnabled: false,
      sharedContextEnabled: false,
      hourlySummariesEnabled: false,
      entitySummaryEnabled: true,
      entitySynthesisMaxTokens: 120,
    })) as any;
    const storage = await orchestrator.getStorage("default");
    await storage.ensureDirectories();

    const canonical = normalizeEntityName("Jane Doe", "person");
    await storage.updateEntitySynthesis(canonical, "Jane Doe had an earlier synthesis.", {
      updatedAt: "2026-04-13T09:00:00.000Z",
      synthesisTimelineCount: 1,
    });
    for (let hour = 10; hour <= 18; hour += 1) {
      const label = hour === 18 ? "Newest event should still be included." : `Overflow event ${hour}.`;
      await storage.writeEntity("Jane Doe", "person", [label], {
        timestamp: `2026-04-13T${String(hour).padStart(2, "0")}:00:00.000Z`,
        source: "extraction",
      });
    }

    const prompts: string[] = [];
    orchestrator.fastChatCompletion = async (messages: Array<{ role: string; content: string }>) => {
      const prompt = messages.map((message) => message.content).join("\n\n");
      prompts.push(prompt);
      return { content: `Jane Doe synthesis batch ${prompts.length}.` };
    };

    const processed = await orchestrator.processEntitySynthesisQueue("default", 1);
    const rawEntity = await readFile(path.join(memoryDir, "entities", `${canonical}.md`), "utf-8");
    const parsed = parseEntityFile(rawEntity);

    assert.equal(processed, 1);
    assert.equal(prompts.length, 2);
    assert.ok(prompts.some((prompt) => prompt.includes("Overflow event 10.")));
    assert.ok(prompts.some((prompt) => prompt.includes("Newest event should still be included.")));
    assert.equal(parsed.synthesis, "Jane Doe synthesis batch 2.");
    assert.equal(parsed.synthesisUpdatedAt, "2026-04-13T18:00:00.000Z");
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
    await rm(workspaceDir, { recursive: true, force: true });
  }
});

test("processEntitySynthesisQueue skips failed targets and continues through the stale queue within the attempt budget", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-entity-synthesis-orch-skip-fail-memory-"));
  const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "remnic-entity-synthesis-orch-skip-fail-workspace-"));
  try {
    const orchestrator = new Orchestrator(parseConfig({
      openaiApiKey: "sk-test",
      memoryDir,
      workspaceDir,
      qmdEnabled: false,
      sharedContextEnabled: false,
      hourlySummariesEnabled: false,
      entitySummaryEnabled: true,
      entitySynthesisMaxTokens: 120,
    })) as any;
    const storage = await orchestrator.getStorage("default");
    await storage.ensureDirectories();

    const failingName = "Alice Failure";
    const failingCanonical = normalizeEntityName(failingName, "person");
    await storage.writeEntity(failingName, "person", ["Newest entity keeps failing synthesis."], {
      timestamp: "2026-04-13T18:00:00.000Z",
      source: "extraction",
    });

    const succeedingName = "Project Success";
    const succeedingCanonical = normalizeEntityName(succeedingName, "project");
    await storage.writeEntity(succeedingName, "project", ["Second stale entity should still refresh."], {
      timestamp: "2026-04-13T17:00:00.000Z",
      source: "extraction",
    });

    let completionCalls = 0;
    orchestrator.fastChatCompletion = async (messages: Array<{ role: string; content: string }>) => {
      completionCalls += 1;
      const prompt = messages.map((message) => message.content).join("\n\n");
      if (prompt.includes("Alice Failure")) {
        throw new Error("simulated synthesis failure");
      }
      return { content: "Project Success has refreshed synthesis." };
    };

    const processed = await orchestrator.processEntitySynthesisQueue("default", 2);
    const rawSuccess = await readFile(
      path.join(memoryDir, "entities", `${succeedingCanonical}.md`),
      "utf-8",
    );
    const success = parseEntityFile(rawSuccess);
    const queue = await storage.readEntitySynthesisQueue();

    assert.equal(processed, 1);
    assert.equal(completionCalls, 2);
    assert.equal(success.synthesis, "Project Success has refreshed synthesis.");
    assert.deepEqual(queue, [failingCanonical]);
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
    await rm(workspaceDir, { recursive: true, force: true });
  }
});

test("processEntitySynthesisQueue counts failed entities against the maxEntities budget", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-entity-synthesis-orch-budget-memory-"));
  const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "remnic-entity-synthesis-orch-budget-workspace-"));
  try {
    const orchestrator = new Orchestrator(parseConfig({
      openaiApiKey: "sk-test",
      memoryDir,
      workspaceDir,
      qmdEnabled: false,
      sharedContextEnabled: false,
      hourlySummariesEnabled: false,
      entitySummaryEnabled: true,
      entitySynthesisMaxTokens: 120,
    })) as any;
    const storage = await orchestrator.getStorage("default");
    await storage.ensureDirectories();

    await storage.writeEntity("Alice Failure", "person", ["Newest entity keeps failing synthesis."], {
      timestamp: "2026-04-13T18:00:00.000Z",
      source: "extraction",
    });

    const succeedingName = "Project Success";
    const succeedingCanonical = normalizeEntityName(succeedingName, "project");
    await storage.writeEntity(succeedingName, "project", ["Second stale entity should wait for the next pass."], {
      timestamp: "2026-04-13T17:00:00.000Z",
      source: "extraction",
    });

    let completionCalls = 0;
    orchestrator.fastChatCompletion = async (messages: Array<{ role: string; content: string }>) => {
      completionCalls += 1;
      const prompt = messages.map((message) => message.content).join("\n\n");
      if (prompt.includes("Alice Failure")) {
        throw new Error("simulated synthesis failure");
      }
      return { content: "Project Success has refreshed synthesis." };
    };

    const processed = await orchestrator.processEntitySynthesisQueue("default", 1);
    const rawSuccess = await readFile(
      path.join(memoryDir, "entities", `${succeedingCanonical}.md`),
      "utf-8",
    );
    const success = parseEntityFile(rawSuccess);
    const queue = await storage.readEntitySynthesisQueue();

    assert.equal(processed, 0);
    assert.equal(completionCalls, 1);
    assert.equal(success.synthesis, undefined);
    assert.deepEqual(queue, [
      normalizeEntityName("Alice Failure", "person"),
      succeedingCanonical,
    ]);
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
    await rm(workspaceDir, { recursive: true, force: true });
  }
});

test("processEntitySynthesisQueue keeps the newest and oldest repeated facts before truncating evidence", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-entity-synthesis-orch-dedupe-memory-"));
  const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "remnic-entity-synthesis-orch-dedupe-workspace-"));
  try {
    const orchestrator = new Orchestrator(parseConfig({
      openaiApiKey: "sk-test",
      memoryDir,
      workspaceDir,
      qmdEnabled: false,
      sharedContextEnabled: false,
      hourlySummariesEnabled: false,
      entitySummaryEnabled: true,
      entitySynthesisMaxTokens: 120,
    })) as any;
    const storage = await orchestrator.getStorage("default");
    await storage.ensureDirectories();

    const canonical = normalizeEntityName("Jane Doe", "person");
    await storage.writeEntity("Jane Doe", "person", ["Seed fact before synthesis."], {
      timestamp: "2026-04-13T08:00:00.000Z",
      source: "extraction",
    });
    await storage.updateEntitySynthesis(canonical, "Jane Doe had an earlier synthesis.", {
      updatedAt: "2026-04-13T09:00:00.000Z",
      synthesisTimelineCount: 1,
    });
    for (let hour = 20; hour >= 13; hour -= 1) {
      await storage.writeEntity("Jane Doe", "person", ["Repeated recent fact."], {
        timestamp: `2026-04-13T${String(hour).padStart(2, "0")}:00:00.000Z`,
        source: "extraction",
      });
    }
    await storage.writeEntity("Jane Doe", "person", ["Unique older fact should still be included."], {
      timestamp: "2026-04-13T12:00:00.000Z",
      source: "extraction",
    });

    let capturedPrompt = "";
    orchestrator.fastChatCompletion = async (messages: Array<{ role: string; content: string }>) => {
      capturedPrompt = messages.map((message) => message.content).join("\n\n");
      return { content: "Jane Doe has refreshed synthesis." };
    };

    const processed = await orchestrator.processEntitySynthesisQueue("default", 1);

    assert.equal(processed, 1);
    assert.match(capturedPrompt, /Repeated recent fact\./);
    assert.match(capturedPrompt, /Unique older fact should still be included\./);
    assert.doesNotMatch(capturedPrompt, /Seed fact before synthesis\./);
    assert.match(capturedPrompt, /timestamp=2026-04-13T13:00:00.000Z, source=extraction: Repeated recent fact\./);
    assert.match(capturedPrompt, /timestamp=2026-04-13T20:00:00.000Z, source=extraction: Repeated recent fact\./);
    assert.equal((capturedPrompt.match(/Repeated recent fact\./g) ?? []).length, 2);
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
    await rm(workspaceDir, { recursive: true, force: true });
  }
});

test("dedupeEntitySynthesisEvidenceEntries updates the newest duplicate even when input order drifts", () => {
  const deduped = dedupeEntitySynthesisEvidenceEntries([
    {
      text: "Repeated recent fact.",
      timestamp: "2026-04-13T14:00:00.000Z",
      source: "extraction",
    },
    {
      text: "Repeated recent fact.",
      timestamp: "2026-04-13T12:00:00.000Z",
      source: "extraction",
    },
    {
      text: "Repeated recent fact.",
      timestamp: "2026-04-13T15:00:00.000Z",
      source: "extraction",
    },
  ]);

  assert.deepEqual(deduped.map((entry) => entry.timestamp), [
    "2026-04-13T15:00:00.000Z",
    "2026-04-13T12:00:00.000Z",
  ]);
});

test("processEntitySynthesisQueue treats offset timestamps as newer when filtering evidence", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-entity-synthesis-orch-offset-memory-"));
  const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "remnic-entity-synthesis-orch-offset-workspace-"));
  try {
    const orchestrator = new Orchestrator(parseConfig({
      openaiApiKey: "sk-test",
      memoryDir,
      workspaceDir,
      qmdEnabled: false,
      sharedContextEnabled: false,
      hourlySummariesEnabled: false,
      entitySummaryEnabled: true,
      entitySynthesisMaxTokens: 120,
    })) as any;
    const storage = await orchestrator.getStorage("default");
    await storage.ensureDirectories();

    const canonical = normalizeEntityName("Jane Doe", "person");
    await storage.writeEntity("Jane Doe", "person", ["Older event should stay filtered out."], {
      timestamp: "2026-04-13T14:15:00Z",
      source: "extraction",
    });
    await storage.updateEntitySynthesis(canonical, "Jane Doe had an earlier synthesis.", {
      updatedAt: "2026-04-13T14:30:00Z",
      synthesisTimelineCount: 1,
    });
    await storage.writeEntity("Jane Doe", "person", ["Offset timestamp should count as new evidence."], {
      timestamp: "2026-04-13T10:00:00-05:00",
      source: "extraction",
    });

    let capturedPrompt = "";
    orchestrator.fastChatCompletion = async (messages: Array<{ role: string; content: string }>) => {
      capturedPrompt = messages.map((message) => message.content).join("\n\n");
      return { content: "Jane Doe has refreshed synthesis." };
    };

    const processed = await orchestrator.processEntitySynthesisQueue("default", 1);

    assert.equal(processed, 1);
    assert.match(capturedPrompt, /Offset timestamp should count as new evidence\./);
    assert.doesNotMatch(capturedPrompt, /Older event should stay filtered out\./);
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
    await rm(workspaceDir, { recursive: true, force: true });
  }
});

test("processEntitySynthesisQueue includes backfilled appended entries alongside newer evidence", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-entity-synthesis-orch-backfill-memory-"));
  const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "remnic-entity-synthesis-orch-backfill-workspace-"));
  try {
    const orchestrator = new Orchestrator(parseConfig({
      openaiApiKey: "sk-test",
      memoryDir,
      workspaceDir,
      qmdEnabled: false,
      sharedContextEnabled: false,
      hourlySummariesEnabled: false,
      entitySummaryEnabled: true,
      entitySynthesisMaxTokens: 160,
    })) as any;
    const storage = await orchestrator.getStorage("default");
    await storage.ensureDirectories();

    const canonical = normalizeEntityName("Jane Doe", "person");
    await storage.writeEntity("Jane Doe", "person", ["Initial synthesis evidence."], {
      timestamp: "2026-04-13T09:00:00.000Z",
      source: "extraction",
    });
    await storage.updateEntitySynthesis(canonical, "Jane Doe had an earlier synthesis.", {
      updatedAt: "2026-04-13T10:00:00.000Z",
      synthesisTimelineCount: 1,
    });
    await storage.writeEntity("Jane Doe", "person", ["Newer post-synthesis evidence."], {
      timestamp: "2026-04-13T11:00:00.000Z",
      source: "extraction",
    });
    await storage.writeEntity("Jane Doe", "person", ["Backfilled older evidence."], {
      timestamp: "2026-04-13T08:00:00.000Z",
      source: "extraction",
    });

    let capturedPrompt = "";
    orchestrator.fastChatCompletion = async (messages: Array<{ role: string; content: string }>) => {
      capturedPrompt = messages.map((message) => message.content).join("\n\n");
      return { content: "Jane Doe synthesis with backfilled evidence." };
    };

    const processed = await orchestrator.processEntitySynthesisQueue("default", 1);
    const rawEntity = await readFile(path.join(memoryDir, "entities", `${canonical}.md`), "utf-8");
    const parsed = parseEntityFile(rawEntity);

    assert.equal(processed, 1);
    assert.match(capturedPrompt, /Newer post-synthesis evidence\./);
    assert.match(capturedPrompt, /Backfilled older evidence\./);
    assert.equal(parsed.synthesis, "Jane Doe synthesis with backfilled evidence.");
    assert.equal(parsed.synthesisTimelineCount, parsed.timeline.length);
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
    await rm(workspaceDir, { recursive: true, force: true });
  }
});

test("processEntitySynthesisQueue does not regress synthesisUpdatedAt for backfilled-only evidence", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-entity-synthesis-orch-backfill-freshness-memory-"));
  const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "remnic-entity-synthesis-orch-backfill-freshness-workspace-"));
  try {
    const orchestrator = new Orchestrator(parseConfig({
      openaiApiKey: "sk-test",
      memoryDir,
      workspaceDir,
      qmdEnabled: false,
      sharedContextEnabled: false,
      hourlySummariesEnabled: false,
      entitySummaryEnabled: true,
      entitySynthesisMaxTokens: 160,
    })) as any;
    const storage = await orchestrator.getStorage("default");
    await storage.ensureDirectories();

    const canonical = normalizeEntityName("Jane Doe", "person");
    await storage.writeEntity("Jane Doe", "person", ["Initial synthesis evidence."], {
      timestamp: "2026-04-13T09:00:00.000Z",
      source: "extraction",
    });
    await storage.updateEntitySynthesis(canonical, "Jane Doe had an earlier synthesis.", {
      updatedAt: "2026-04-13T10:00:00.000Z",
      synthesisTimelineCount: 1,
    });
    await storage.writeEntity("Jane Doe", "person", ["Backfilled older evidence."], {
      timestamp: "2026-04-13T08:00:00.000Z",
      source: "extraction",
    });

    let refreshCalls = 0;
    orchestrator.fastChatCompletion = async () => {
      refreshCalls += 1;
      return { content: "Jane Doe synthesis with backfilled evidence." };
    };

    const firstProcessed = await orchestrator.processEntitySynthesisQueue("default", 1);
    const secondProcessed = await orchestrator.processEntitySynthesisQueue("default", 1);
    const rawEntity = await readFile(path.join(memoryDir, "entities", `${canonical}.md`), "utf-8");
    const parsed = parseEntityFile(rawEntity);

    assert.equal(firstProcessed, 1);
    assert.equal(secondProcessed, 0);
    assert.equal(refreshCalls, 1);
    assert.equal(parsed.synthesis, "Jane Doe synthesis with backfilled evidence.");
    assert.equal(parsed.synthesisUpdatedAt, "2026-04-13T10:00:00.000Z");
    assert.equal(parsed.synthesisTimelineCount, parsed.timeline.length);
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
    await rm(workspaceDir, { recursive: true, force: true });
  }
});

test("processEntitySynthesisQueue skips writing synthesis from a stale timeline snapshot", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-entity-synthesis-orch-concurrent-memory-"));
  const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "remnic-entity-synthesis-orch-concurrent-workspace-"));
  try {
    const orchestrator = new Orchestrator(parseConfig({
      openaiApiKey: "sk-test",
      memoryDir,
      workspaceDir,
      qmdEnabled: false,
      sharedContextEnabled: false,
      hourlySummariesEnabled: false,
      entitySummaryEnabled: true,
      entitySynthesisMaxTokens: 160,
    })) as any;
    const storage = await orchestrator.getStorage("default");
    await storage.ensureDirectories();

    const canonical = normalizeEntityName("Jane Doe", "person");
    await storage.writeEntity("Jane Doe", "person", ["Initial synthesis evidence."], {
      timestamp: "2026-04-13T09:00:00.000Z",
      source: "extraction",
    });
    await storage.updateEntitySynthesis(canonical, "Jane Doe had an earlier synthesis.", {
      updatedAt: "2026-04-13T10:00:00.000Z",
      synthesisTimelineCount: 1,
    });
    await storage.writeEntity("Jane Doe", "person", ["Fresh evidence before synthesis."], {
      timestamp: "2026-04-13T11:00:00.000Z",
      source: "extraction",
    });

    let concurrentWriteDone = false;
    let capturedPrompt = "";
    orchestrator.fastChatCompletion = async (messages: Array<{ role: string; content: string }>) => {
      capturedPrompt = messages.map((message) => message.content).join("\n\n");
      if (!concurrentWriteDone) {
        concurrentWriteDone = true;
        await storage.writeEntity("Jane Doe", "person", ["Concurrent write during synthesis."], {
          timestamp: "2026-04-13T08:00:00.000Z",
          source: "extraction",
        });
      }
      return { content: "Jane Doe synthesis built from a stale snapshot." };
    };

    const firstProcessed = await orchestrator.processEntitySynthesisQueue("default", 1);
    const afterFirstRaw = await readFile(path.join(memoryDir, "entities", `${canonical}.md`), "utf-8");
    const afterFirst = parseEntityFile(afterFirstRaw);

    assert.equal(firstProcessed, 0);
    assert.match(capturedPrompt, /Fresh evidence before synthesis\./);
    assert.doesNotMatch(capturedPrompt, /Concurrent write during synthesis\./);
    assert.equal(afterFirst.synthesis, "Jane Doe had an earlier synthesis.");
    assert.equal(afterFirst.synthesisTimelineCount, 1);

    orchestrator.fastChatCompletion = async (messages: Array<{ role: string; content: string }>) => {
      capturedPrompt = messages.map((message) => message.content).join("\n\n");
      return { content: "Jane Doe synthesis after re-reading current evidence." };
    };

    const secondProcessed = await orchestrator.processEntitySynthesisQueue("default", 1);
    const afterSecondRaw = await readFile(path.join(memoryDir, "entities", `${canonical}.md`), "utf-8");
    const afterSecond = parseEntityFile(afterSecondRaw);

    assert.equal(secondProcessed, 1);
    assert.match(capturedPrompt, /Concurrent write during synthesis\./);
    assert.equal(afterSecond.synthesis, "Jane Doe synthesis after re-reading current evidence.");
    assert.equal(afterSecond.synthesisTimelineCount, afterSecond.timeline.length);
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
    await rm(workspaceDir, { recursive: true, force: true });
  }
});

test("processEntitySynthesisQueue skips writing synthesis when structured sections drift during refresh", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-entity-synthesis-orch-structured-memory-"));
  const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "remnic-entity-synthesis-orch-structured-workspace-"));
  try {
    const orchestrator = new Orchestrator(parseConfig({
      openaiApiKey: "sk-test",
      memoryDir,
      workspaceDir,
      qmdEnabled: false,
      sharedContextEnabled: false,
      hourlySummariesEnabled: false,
      entitySummaryEnabled: true,
      entitySynthesisMaxTokens: 160,
    })) as any;
    const storage = await orchestrator.getStorage("default");
    await storage.ensureDirectories();

    const canonical = normalizeEntityName("Jane Doe", "person");
    await storage.writeEntity("Jane Doe", "person", ["Initial synthesis evidence."], {
      timestamp: "2026-04-13T09:00:00.000Z",
      source: "extraction",
      structuredSections: [
        {
          key: "beliefs",
          title: "Beliefs",
          facts: ["Small teams move faster than committees."],
        },
      ],
    });
    await storage.updateEntitySynthesis(canonical, "Jane Doe had an earlier synthesis.", {
      updatedAt: "2026-04-13T10:00:00.000Z",
      synthesisTimelineCount: 1,
      synthesisStructuredFactCount: 1,
    });
    await storage.writeEntity("Jane Doe", "person", ["Fresh evidence before synthesis."], {
      timestamp: "2026-04-13T11:00:00.000Z",
      source: "extraction",
    });

    let concurrentWriteDone = false;
    let capturedPrompt = "";
    orchestrator.fastChatCompletion = async (messages: Array<{ role: string; content: string }>) => {
      capturedPrompt = messages.map((message) => message.content).join("\n\n");
      if (!concurrentWriteDone) {
        concurrentWriteDone = true;
        await storage.writeEntity("Jane Doe", "person", [], {
          timestamp: "2026-04-13T09:00:00.000Z",
          source: "extraction",
          structuredSections: [
            {
              key: "beliefs",
              title: "Beliefs",
              facts: ["Roadmaps should stay legible to the team."],
            },
          ],
        });
      }
      return { content: "Jane Doe synthesis built from a stale structured snapshot." };
    };

    const firstProcessed = await orchestrator.processEntitySynthesisQueue("default", 1);
    const afterFirstRaw = await readFile(path.join(memoryDir, "entities", `${canonical}.md`), "utf-8");
    const afterFirst = parseEntityFile(afterFirstRaw);

    assert.equal(firstProcessed, 0);
    assert.match(capturedPrompt, /Fresh evidence before synthesis\./);
    assert.doesNotMatch(capturedPrompt, /Roadmaps should stay legible to the team\./);
    assert.equal(afterFirst.synthesis, "Jane Doe had an earlier synthesis.");
    assert.equal(afterFirst.synthesisStructuredFactCount, 1);
    assert.equal(isEntitySynthesisStale(afterFirst), true);

    orchestrator.fastChatCompletion = async (messages: Array<{ role: string; content: string }>) => {
      capturedPrompt = messages.map((message) => message.content).join("\n\n");
      return { content: "Jane Doe synthesis after re-reading structured evidence." };
    };

    const secondProcessed = await orchestrator.processEntitySynthesisQueue("default", 1);
    const afterSecondRaw = await readFile(path.join(memoryDir, "entities", `${canonical}.md`), "utf-8");
    const afterSecond = parseEntityFile(afterSecondRaw);

    assert.equal(secondProcessed, 1);
    assert.match(capturedPrompt, /Fresh evidence before synthesis\./);
    assert.equal(afterSecond.synthesis, "Jane Doe synthesis after re-reading structured evidence.");
    assert.equal(afterSecond.synthesisStructuredFactCount, 2);
    assert.equal(isEntitySynthesisStale(afterSecond), false);
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
    await rm(workspaceDir, { recursive: true, force: true });
  }
});

test("processEntitySynthesisQueue synthesizes section-only entities", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-entity-synthesis-orch-section-only-memory-"));
  const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "remnic-entity-synthesis-orch-section-only-workspace-"));
  try {
    const orchestrator = new Orchestrator(parseConfig({
      openaiApiKey: "sk-test",
      memoryDir,
      workspaceDir,
      qmdEnabled: false,
      sharedContextEnabled: false,
      hourlySummariesEnabled: false,
      entitySummaryEnabled: true,
      entitySynthesisMaxTokens: 160,
    })) as any;
    const storage = await orchestrator.getStorage("default");
    await storage.ensureDirectories();

    const canonical = normalizeEntityName("Acme Corp", "company");
    await storage.writeEntity("Acme Corp", "company", [], {
      timestamp: "2026-04-13T09:00:00.000Z",
      source: "extraction",
      structuredSections: [
        {
          key: "operating_principles",
          title: "Operating Principles",
          facts: ["Prefer durable teams over frequent reorganizations."],
        },
      ],
    });

    let capturedPrompt = "";
    orchestrator.fastChatCompletion = async (messages: Array<{ role: string; content: string }>) => {
      capturedPrompt = messages.map((message) => message.content).join("\n\n");
      return { content: "Acme Corp favors durable teams over frequent reorganizations." };
    };

    const processed = await orchestrator.processEntitySynthesisQueue("default", 1);
    const parsed = parseEntityFile(await readFile(path.join(memoryDir, "entities", `${canonical}.md`), "utf-8"));

    assert.equal(processed, 1);
    assert.match(capturedPrompt, /section=Operating Principles/);
    assert.match(capturedPrompt, /Prefer durable teams over frequent reorganizations\./);
    assert.equal(parsed.synthesis, "Acme Corp favors durable teams over frequent reorganizations.");
    assert.equal(parsed.synthesisTimelineCount, 0);
    assert.equal(parsed.synthesisStructuredFactCount, 1);
    assert.equal(isEntitySynthesisStale(parsed), false);
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
    await rm(workspaceDir, { recursive: true, force: true });
  }
});

test("processEntitySynthesisQueue includes changed same-count structured evidence when other evidence also changed", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-entity-synthesis-orch-structured-digest-memory-"));
  const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "remnic-entity-synthesis-orch-structured-digest-workspace-"));
  try {
    const orchestrator = new Orchestrator(parseConfig({
      openaiApiKey: "sk-test",
      memoryDir,
      workspaceDir,
      qmdEnabled: false,
      sharedContextEnabled: false,
      hourlySummariesEnabled: false,
      entitySummaryEnabled: true,
      entitySynthesisMaxTokens: 160,
    })) as any;
    const storage = await orchestrator.getStorage("default");
    await storage.ensureDirectories();

    const canonical = normalizeEntityName("Jane Doe", "person");
    const entityPath = path.join(memoryDir, "entities", `${canonical}.md`);
    await storage.writeEntity("Jane Doe", "person", ["Initial synthesis evidence."], {
      timestamp: "2026-04-13T09:00:00.000Z",
      source: "extraction",
      structuredSections: [
        {
          key: "beliefs",
          title: "Beliefs",
          facts: ["Small teams move faster than committees."],
        },
      ],
    });
    await storage.updateEntitySynthesis(canonical, "Jane Doe had an earlier synthesis.", {
      updatedAt: "2026-04-13T10:00:00.000Z",
      synthesisTimelineCount: 1,
      synthesisStructuredFactCount: 1,
    });
    await storage.writeEntity("Jane Doe", "person", ["Fresh evidence before synthesis."], {
      timestamp: "2026-04-13T11:00:00.000Z",
      source: "extraction",
    });

    const changedStructuredRaw = await readFile(entityPath, "utf-8");
    const changedStructuredEntity = parseEntityFile(changedStructuredRaw);
    changedStructuredEntity.structuredSections = [
      {
        key: "beliefs",
        title: "Beliefs",
        facts: ["Roadmaps should stay legible to the team."],
      },
    ];
    changedStructuredEntity.facts = [
      "Initial synthesis evidence.",
      "Fresh evidence before synthesis.",
      "Roadmaps should stay legible to the team.",
    ];
    await writeFile(entityPath, serializeEntityFile(changedStructuredEntity), "utf-8");

    let capturedPrompt = "";
    orchestrator.fastChatCompletion = async (messages: Array<{ role: string; content: string }>) => {
      capturedPrompt = messages.map((message) => message.content).join("\n\n");
      return { content: "Jane Doe synthesis rebuilt with the changed belief and fresh timeline evidence." };
    };

    const processed = await orchestrator.processEntitySynthesisQueue("default", 1);
    const reparsed = parseEntityFile(await readFile(entityPath, "utf-8"));

    assert.equal(processed, 1);
    assert.match(capturedPrompt, /Fresh evidence before synthesis\./);
    assert.match(capturedPrompt, /Roadmaps should stay legible to the team\./);
    assert.equal(reparsed.synthesis, "Jane Doe synthesis rebuilt with the changed belief and fresh timeline evidence.");
    assert.equal(reparsed.synthesisStructuredFactCount, 1);
    assert.ok(reparsed.synthesisStructuredFactDigest);
    assert.equal(isEntitySynthesisStale(reparsed), false);
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
    await rm(workspaceDir, { recursive: true, force: true });
  }
});

test("processEntitySynthesisQueue does not resynthesize timestampless evidence once the snapshot count matches", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-entity-synthesis-orch-missing-ts-memory-"));
  const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "remnic-entity-synthesis-orch-missing-ts-workspace-"));
  try {
    const orchestrator = new Orchestrator(parseConfig({
      openaiApiKey: "sk-test",
      memoryDir,
      workspaceDir,
      qmdEnabled: false,
      sharedContextEnabled: false,
      hourlySummariesEnabled: false,
      entitySummaryEnabled: true,
      entitySynthesisMaxTokens: 160,
    })) as any;
    const storage = await orchestrator.getStorage("default");
    await storage.ensureDirectories();

    const canonical = normalizeEntityName("Jane Doe", "person");
    const legacyEntity = [
      "# Jane Doe",
      "",
      "**Type:** person",
      "",
      "## Facts",
      "",
      "- Legacy evidence without a timestamp.",
      "",
    ].join("\n");
    await writeFile(path.join(memoryDir, "entities", `${canonical}.md`), legacyEntity, "utf-8");

    let refreshCalls = 0;
    orchestrator.fastChatCompletion = async () => {
      refreshCalls += 1;
      return { content: "Jane Doe synthesis rebuilt from timestampless evidence." };
    };

    const firstProcessed = await orchestrator.processEntitySynthesisQueue("default", 1);
    const firstRawEntity = await readFile(path.join(memoryDir, "entities", `${canonical}.md`), "utf-8");
    const firstParsed = parseEntityFile(firstRawEntity);

    assert.equal(firstProcessed, 1);
    assert.equal(refreshCalls, 1);
    assert.equal(firstParsed.synthesis, "Jane Doe synthesis rebuilt from timestampless evidence.");
    assert.equal(firstParsed.synthesisUpdatedAt, undefined);
    assert.equal(firstParsed.synthesisTimelineCount, firstParsed.timeline.length);
    assert.equal(isEntitySynthesisStale(firstParsed), false);

    const secondProcessed = await orchestrator.processEntitySynthesisQueue("default", 1);
    const secondRawEntity = await readFile(path.join(memoryDir, "entities", `${canonical}.md`), "utf-8");
    const secondParsed = parseEntityFile(secondRawEntity);

    assert.equal(secondProcessed, 0);
    assert.equal(refreshCalls, 1);
    assert.equal(secondParsed.synthesis, "Jane Doe synthesis rebuilt from timestampless evidence.");
    assert.equal(isEntitySynthesisStale(secondParsed), false);
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
    await rm(workspaceDir, { recursive: true, force: true });
  }
});

test("processEntitySynthesisQueue advances freshness using the newest non-empty evidence timestamp", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-entity-synthesis-orch-mixed-ts-memory-"));
  const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "remnic-entity-synthesis-orch-mixed-ts-workspace-"));
  try {
    const orchestrator = new Orchestrator(parseConfig({
      openaiApiKey: "sk-test",
      memoryDir,
      workspaceDir,
      qmdEnabled: false,
      sharedContextEnabled: false,
      hourlySummariesEnabled: false,
      entitySummaryEnabled: true,
      entitySynthesisMaxTokens: 160,
    })) as any;
    const storage = await orchestrator.getStorage("default");
    await storage.ensureDirectories();

    const canonical = normalizeEntityName("Jane Doe", "person");
    const rawEntity = [
      "---",
      'created: 2026-04-13T09:00:00.000Z',
      'updated: 2026-04-13T09:00:00.000Z',
      'synthesis_updated_at: "2026-04-13T09:30:00.000Z"',
      'synthesis_timeline_count: 1',
      "---",
      "",
      "# Jane Doe",
      "",
      "**Type:** person",
      "**Updated:** 2026-04-13T09:00:00.000Z",
      "",
      "## Synthesis",
      "",
      "Jane Doe had an earlier synthesis.",
      "",
      "## Timeline",
      "",
      "- Legacy evidence without a timestamp.",
      "- [2026-04-13T10:00:00.000Z] Newer timestamped evidence.",
      "",
    ].join("\n");
    await writeFile(path.join(memoryDir, "entities", `${canonical}.md`), rawEntity, "utf-8");

    orchestrator.fastChatCompletion = async () => ({ content: "Jane Doe synthesis after mixed evidence." });

    const processed = await orchestrator.processEntitySynthesisQueue("default", 1);
    const parsed = parseEntityFile(await readFile(path.join(memoryDir, "entities", `${canonical}.md`), "utf-8"));

    assert.equal(processed, 1);
    assert.equal(parsed.synthesis, "Jane Doe synthesis after mixed evidence.");
    assert.equal(parsed.synthesisUpdatedAt, "2026-04-13T10:00:00.000Z");
    assert.equal(parsed.synthesisTimelineCount, 2);
    assert.equal(isEntitySynthesisStale(parsed), false);
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
    await rm(workspaceDir, { recursive: true, force: true });
  }
});

test("processEntitySynthesisQueue treats zero max tokens as disabled", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-entity-synthesis-orch-zero-memory-"));
  const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "remnic-entity-synthesis-orch-zero-workspace-"));
  try {
    const orchestrator = new Orchestrator(parseConfig({
      openaiApiKey: "sk-test",
      memoryDir,
      workspaceDir,
      qmdEnabled: false,
      sharedContextEnabled: false,
      hourlySummariesEnabled: false,
      entitySummaryEnabled: true,
      entitySynthesisMaxTokens: 0,
    })) as any;
    const storage = await orchestrator.getStorage("default");
    await storage.ensureDirectories();

    await storage.writeEntity("Jane Doe", "person", ["Leads roadmap work."], {
      timestamp: "2026-04-13T10:00:00.000Z",
      source: "extraction",
    });

    let completionCalls = 0;
    orchestrator.fastChatCompletion = async () => {
      completionCalls += 1;
      return { content: "should not be called" };
    };

    const processed = await orchestrator.processEntitySynthesisQueue("default", 1);

    assert.equal(processed, 0);
    assert.equal(completionCalls, 0);
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
    await rm(workspaceDir, { recursive: true, force: true });
  }
});

test("processEntitySynthesisQueue accepts long synthesis responses within the configured token budget", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-entity-synthesis-orch-long-memory-"));
  const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "remnic-entity-synthesis-orch-long-workspace-"));
  try {
    const orchestrator = new Orchestrator(parseConfig({
      openaiApiKey: "sk-test",
      memoryDir,
      workspaceDir,
      qmdEnabled: false,
      sharedContextEnabled: false,
      hourlySummariesEnabled: false,
      entitySummaryEnabled: true,
      entitySynthesisMaxTokens: 500,
    })) as any;
    const storage = await orchestrator.getStorage("default");
    await storage.ensureDirectories();

    const canonical = normalizeEntityName("Jane Doe", "person");
    await storage.writeEntity("Jane Doe", "person", ["Leads roadmap work."], {
      timestamp: "2026-04-13T10:00:00.000Z",
      source: "extraction",
    });

    const longSynthesis = "Jane Doe leads roadmap work. ".repeat(90).trim();
    assert.ok(longSynthesis.length > 2_000);

    orchestrator.fastChatCompletion = async () => ({ content: longSynthesis });

    const processed = await orchestrator.processEntitySynthesisQueue("default", 1);
    const raw = await readFile(path.join(memoryDir, "entities", `${canonical}.md`), "utf-8");
    const parsed = parseEntityFile(raw);

    assert.equal(processed, 1);
    assert.equal(parsed.synthesis, longSynthesis);
    assert.equal(parsed.synthesisTimelineCount, parsed.timeline.length);
    assert.equal(isEntitySynthesisStale(parsed), false);
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
    await rm(workspaceDir, { recursive: true, force: true });
  }
});
