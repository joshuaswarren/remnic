import assert from "node:assert/strict";
import { unlinkSync } from "node:fs";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  parseFrontmatter,
  runAttributeCliCommand,
  scanMemoryDir,
} from "./attribute-cli.js";
import {
  attributeRun,
  attributeTask,
  type AttributionEnvironment,
  type AttributionMemory,
} from "./attribution.js";
import type { BenchmarkResult } from "./types.js";

const GOLD_STATEMENTS = [
  "Avery Quill prefers Earl Grey tea with lemon",
  "Avery Quill reads historical fiction on weekends",
  "Avery Quill cycles five miles every morning",
  "Avery Quill paints watercolor landscapes of mountains",
  "Avery Quill collects vintage mechanical wristwatches",
  "Avery Quill bakes sourdough bread on Sundays",
  "Avery Quill learns classical guitar in the evening",
  "Avery Quill plants heirloom tomatoes in spring",
  "Avery Quill studies celestial navigation at night",
  "Avery Quill adopts rescue greyhounds from shelters",
  "Avery Quill writes poetry using fountain pens",
  "Avery Quill brews dark roast espresso daily",
  "Avery Quill plays chess with grandmaster algorithms",
  "Avery Quill constructs wooden model sailing ships",
  "Avery Quill explores ancient ruins during summer",
  "Avery Quill listens to vinyl jazz records",
  "Avery Quill writes open source software tools",
  "Avery Quill bakes French apple tarts",
  "Avery Quill harvests organic lavender flowers",
  "Avery Quill observes distant stellar galaxies",
];

test("acceptance scenario: 20-fact seeded corpus failure attribution (>= 90% accuracy)", async () => {
  const tmpDir = await mkdtemp(path.join(tmpdir(), "bench-attr-test-"));
  const storeDir = path.join(tmpDir, "memories");
  await mkdir(storeDir, { recursive: true });

  // Facts 6..20 are written to disk store (Facts 1..5 never written -> extraction_miss)
  const writtenMemories: AttributionMemory[] = [];
  for (let i = 5; i < 20; i++) {
    const memId = `mem-${i + 1}`;
    const content = GOLD_STATEMENTS[i];
    const fileContent = `---\nid: "${memId}"\n---\n${content}\n`;
    await writeFile(path.join(storeDir, `${memId}.md`), fileContent, "utf8");
    writtenMemories.push({ id: memId, content });
  }

  // Facts 11..20 are indexed (Facts 6..10 written but not indexed -> index_miss)
  const indexedMemIds = new Set(Array.from({ length: 10 }, (_, k) => `mem-${k + 11}`));

  const distractorMem: AttributionMemory = {
    id: "mem-distractor-1",
    content: "Avery Quill enjoys hiking in local nature reserves",
  };

  // Environment setup
  const env: AttributionEnvironment = {
    listMemories: async () => writtenMemories,
    oracleSearch: async (query, limit) => {
      // Returns matching indexed memories
      const results: { id: string }[] = [];
      for (const mem of writtenMemories) {
        if (indexedMemIds.has(mem.id) && query.includes(mem.content.split(" ")[2] || "")) {
          results.push({ id: mem.id });
        }
      }
      // If query matched an indexed fact directly
      const foundIdx = GOLD_STATEMENTS.findIndex((g) => g === query);
      if (foundIdx >= 10 && foundIdx < 20) {
        return [{ id: `mem-${foundIdx + 1}` }].slice(0, limit);
      }
      return results.slice(0, limit);
    },
    recall: async (query, limit) => {
      // Find which task question this is
      const taskMatch = query.match(/fact (\d+)/);
      if (!taskMatch) return [];
      const factNum = parseInt(taskMatch[1], 10); // 1..20

      // Tasks 11..15: distractor at rank 1, gold at rank 2 (limit=1 misses gold -> retrieval_miss cap)
      if (factNum >= 11 && factNum <= 15) {
        const goldMem = writtenMemories.find((m) => m.id === `mem-${factNum}`);
        if (limit === 1) {
          return [distractorMem];
        }
        return [distractorMem, goldMem!];
      }

      // Tasks 16..20: gold at rank 1 (recalled into context)
      if (factNum >= 16 && factNum <= 20) {
        const goldMem = writtenMemories.find((m) => m.id === `mem-${factNum}`);
        return [goldMem!].slice(0, limit);
      }

      return [distractorMem].slice(0, limit);
    },
    recallLimit: 1,
    replayLimit: 10,
  };

  // Build 20 tasks
  const tasks = GOLD_STATEMENTS.map((gold, idx) => {
    const factNum = idx + 1;
    const recalledText = factNum >= 16 ? gold : undefined;
    return {
      taskId: `task-${String(factNum).padStart(2, "0")}`,
      question: `What is the preference for fact ${factNum}?`,
      scores: { overall: 0 },
      goldMemories: [gold],
      details: recalledText ? { recalledText } : undefined,
    };
  });

  const runResult = {
    meta: { id: "acceptance-run-20" },
    results: { tasks },
  };

  const report = await attributeRun(runResult, env, { threshold: 0.6 });

  // Evaluate confusion matrix
  const expectedClasses: Record<string, string> = {};
  for (let i = 1; i <= 5; i++) expectedClasses[`task-${String(i).padStart(2, "0")}`] = "extraction_miss";
  for (let i = 6; i <= 10; i++) expectedClasses[`task-${String(i).padStart(2, "0")}`] = "index_miss";
  for (let i = 11; i <= 15; i++) expectedClasses[`task-${String(i).padStart(2, "0")}`] = "retrieval_miss";
  for (let i = 16; i <= 20; i++) expectedClasses[`task-${String(i).padStart(2, "0")}`] = "use_miss";

  let correctCount = 0;
  const confusion: Record<string, { expected: string; actual: string }> = {};

  for (const item of report.items) {
    const expected = expectedClasses[item.taskId];
    const actual = item.overall.class;
    if (actual === expected) {
      correctCount++;
    } else {
      confusion[item.taskId] = { expected, actual };
    }
  }

  const accuracy = correctCount / 20;
  const confusionMsg = `Acceptance accuracy: ${(accuracy * 100).toFixed(1)}% (${correctCount}/20). Confusion: ${JSON.stringify(confusion)}`;
  console.log(confusionMsg);

  assert.ok(accuracy >= 0.9, confusionMsg);

  await rm(tmpDir, { recursive: true, force: true });
});

test("runAttributeCliCommand handles store run reference and options", async () => {
  const tmpDir = await mkdtemp(path.join(tmpdir(), "bench-cli-test-"));
  const resultsDir = path.join(tmpDir, "results");
  const memoryDir = path.join(tmpDir, "memories");
  await mkdir(resultsDir, { recursive: true });
  await mkdir(memoryDir, { recursive: true });

  // Write a memory file
  await writeFile(
    path.join(memoryDir, "fact1.md"),
    '---\nid: "mem-1"\n---\nAvery Quill prefers Earl Grey tea with lemon\n',
    "utf8"
  );

  // Write a benchmark result JSON
  const fakeResult: BenchmarkResult = {
    meta: {
      id: "run-abc-123",
      benchmark: "locomo",
      benchmarkTier: "remnic",
      version: "1.0.0",
      remnicVersion: "9.35.3",
      gitSha: "abc1234",
      timestamp: "2026-07-28T12:00:00Z",
      mode: "full",
      runCount: 1,
      seeds: [42],
    },
    config: {
      systemProvider: null,
      judgeProvider: null,
      adapterMode: "real",
      remnicConfig: { recallLimit: 5 },
    },
    cost: {
      totalTokens: 100,
      inputTokens: 80,
      outputTokens: 20,
      estimatedCostUsd: 0.001,
      totalLatencyMs: 500,
      meanQueryLatencyMs: 50,
    },
    results: {
      tasks: [
        {
          taskId: "task-01",
          question: "What tea does Avery prefer?",
          expected: "Earl Grey",
          actual: "Green tea",
          scores: { overall: 0 },
          latencyMs: 50,
          tokens: { input: 10, output: 5 },
          goldMemories: ["Avery Quill prefers Earl Grey tea with lemon"],
          details: { recalledText: "Avery Quill prefers Earl Grey tea with lemon" },
        },
      ],
      aggregates: {},
    },
    environment: {
      os: "linux",
      nodeVersion: "v22.0.0",
    },
  };

  const resultPath = path.join(resultsDir, "run-abc-123.json");
  await writeFile(resultPath, JSON.stringify(fakeResult, null, 2), "utf8");

  // Test 1: CLI table output with memoryDir
  const cliResTable = await runAttributeCliCommand({
    runRef: "run-abc-123",
    resultsDir,
    memoryDir,
  });

  assert.strictEqual(cliResTable.exitCode, 0);
  assert.match(cliResTable.output, /Attribution Report \(Run: run-abc-123\)/);
  assert.match(cliResTable.output, /use_miss/);

  // Test 2: CLI JSON output
  const cliResJson = await runAttributeCliCommand({
    runRef: "run-abc-123",
    resultsDir,
    memoryDir,
    json: true,
  });

  assert.strictEqual(cliResJson.exitCode, 0);
  const parsed = JSON.parse(cliResJson.output);
  assert.strictEqual(parsed.runId, "run-abc-123");
  assert.strictEqual(parsed.totals.use_miss, 1);

  // Test 3: Determinism across invocations
  const cliResTable2 = await runAttributeCliCommand({
    runRef: "run-abc-123",
    resultsDir,
    memoryDir,
  });
  assert.strictEqual(cliResTable.output, cliResTable2.output);

  // Test 4: Unknown runRef
  const cliResErr = await runAttributeCliCommand({
    runRef: "nonexistent-run",
    resultsDir,
  });
  assert.strictEqual(cliResErr.exitCode, 1);
  assert.match(cliResErr.output, /not found/);

  // Test 5: Honest unavailable output when memoryDir is omitted and no recallText
  const fakeResultNoRecalled: BenchmarkResult = {
    ...fakeResult,
    meta: { ...fakeResult.meta, id: "run-no-recalled" },
    results: {
      ...fakeResult.results,
      tasks: [
        {
          ...fakeResult.results.tasks[0],
          taskId: "task-02",
          details: undefined,
        },
      ],
    },
  };
  await writeFile(
    path.join(resultsDir, "run-no-recalled.json"),
    JSON.stringify(fakeResultNoRecalled, null, 2),
    "utf8"
  );

  const cliResUnavailable = await runAttributeCliCommand({
    runRef: "run-no-recalled",
    resultsDir,
    json: true,
  });
  assert.strictEqual(cliResUnavailable.exitCode, 0);
  const parsedUnavail = JSON.parse(cliResUnavailable.output);
  assert.strictEqual(parsedUnavail.totals.unattributed, 1);

  await rm(tmpDir, { recursive: true, force: true });
});
test("runAttributeCliCommand returns exitCode 1 for invalid or unreadable memoryDir", async () => {
  const tmpDir = await mkdtemp(path.join(tmpdir(), "bench-cli-badmem-"));
  try {
    const resultsDir = path.join(tmpDir, "results");
    await mkdir(resultsDir, { recursive: true });

    const fakeResult: BenchmarkResult = {
      meta: {
        id: "run-badmem-123",
        benchmark: "locomo",
        benchmarkTier: "remnic",
        version: "1.0.0",
        remnicVersion: "9.35.3",
        gitSha: "abc1234",
        timestamp: "2026-07-28T12:00:00Z",
        mode: "full",
        runCount: 1,
        seeds: [42],
      },
      config: {
        systemProvider: null,
        judgeProvider: null,
        adapterMode: "real",
        remnicConfig: { recallLimit: 5 },
      },
      cost: {
        totalTokens: 100,
        inputTokens: 80,
        outputTokens: 20,
        estimatedCostUsd: 0.001,
        totalLatencyMs: 500,
        meanQueryLatencyMs: 50,
      },
      results: { tasks: [], aggregates: {} },
      environment: { os: "linux", nodeVersion: "v22.0.0" },
    };

    await writeFile(
      path.join(resultsDir, "run-badmem-123.json"),
      JSON.stringify(fakeResult, null, 2),
      "utf8"
    );

    const badMemPath = path.join(tmpDir, "nonexistent-memories");
    const res = await runAttributeCliCommand({
      runRef: "run-badmem-123",
      resultsDir,
      memoryDir: badMemPath,
    });

    assert.strictEqual(res.exitCode, 1);
    assert.match(res.output, /memory-dir ".*" is not a readable directory/);
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

// The result-reference resolver validates files before resolving, so a
// corrupt result surfaces as a stable not-found error; raw parse errors never
// reach CLI output. (The separate load-failure catch guards only the
// resolve-then-load race window and stays untestable without mocking.)
test("runAttributeCliCommand reports corrupt result files with a stable not-found error", async () => {
  const tmpDir = await mkdtemp(path.join(tmpdir(), "bench-cli-badfile-"));
  try {
    const resultsDir = path.join(tmpDir, "results");
    await mkdir(resultsDir, { recursive: true });

    const resultPath = path.join(resultsDir, "run-corrupt-123.json");
    await writeFile(resultPath, "{ invalid json", "utf8");

    const res = await runAttributeCliCommand({
      runRef: resultPath,
      resultsDir,
    });

    assert.strictEqual(res.exitCode, 1);
    assert.match(res.output, /was not found in/);
    assert.doesNotMatch(res.output, /invalid json/);
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});
test("parseFrontmatter handles empty frontmatter block without leaking delimiters", () => {
  const input = "---\n---\nHere is the actual memory body text";
  const { id, body } = parseFrontmatter(input);
  assert.strictEqual(id, undefined);
  assert.strictEqual(body, "Here is the actual memory body text");
});

test("scanMemoryDir skips system directories: state, wearables, activity, meetings", async () => {
  const tmpDir = await mkdtemp(path.join(tmpdir(), "bench-cli-sysdirs-"));
  try {
    const sysDirs = ["state", "wearables", "activity", "meetings"];
    for (const sysDir of sysDirs) {
      const dir = path.join(tmpDir, sysDir);
      await mkdir(dir, { recursive: true });
      await writeFile(path.join(dir, "fact.md"), "System fact content", "utf8");
    }

    const normalDir = path.join(tmpDir, "normal");
    await mkdir(normalDir, { recursive: true });
    await writeFile(path.join(normalDir, "fact.md"), "Normal memory content", "utf8");

    const memories = await scanMemoryDir(tmpDir);
    assert.strictEqual(memories.length, 1);
    assert.strictEqual(memories[0].content, "Normal memory content");
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});
test("scan with an unreadable file => extraction unavailable", async () => {
  if (process.getuid?.() === 0) {
    return;
  }
  const tmpDir = await mkdtemp(path.join(tmpdir(), "remnic-scan-err-"));
  try {
    await writeFile(path.join(tmpDir, "fact1.md"), "--- \nid: mem-1\n---\nFact 1 content", "utf8");
    const unreadableFile = path.join(tmpDir, "unreadable.md");
    await writeFile(unreadableFile, "--- \nid: mem-2\n---\nUnreadable content", { mode: 0, encoding: "utf8" });

    await assert.rejects(
      async () => {
        await scanMemoryDir(tmpDir);
      },
      (err: Error) => {
        return err.message.includes("memory scan incomplete: 1 unreadable entries");
      }
    );
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

test("symlinked root accepted", async () => {
  const tmpDir = await mkdtemp(path.join(tmpdir(), "remnic-symlink-root-"));
  try {
    const realDir = path.join(tmpDir, "real-store");
    await mkdir(realDir, { recursive: true });
    await writeFile(path.join(realDir, "fact.md"), "--- \nid: mem-1\n---\nAvery Quill prefers Earl Grey tea with lemon", "utf8");

    const symlinkPath = path.join(tmpDir, "store-link");
    await symlink(realDir, symlinkPath, "dir");

    const memories = await scanMemoryDir(symlinkPath);
    assert.strictEqual(memories.length, 1);
    assert.strictEqual(memories[0].content, "Avery Quill prefers Earl Grey tea with lemon");
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

test("nested dir named meetings under a namespace is scanned while root-level meetings is skipped", async () => {
  const tmpDir = await mkdtemp(path.join(tmpdir(), "remnic-nested-meetings-"));
  try {
    const rootMeetings = path.join(tmpDir, "meetings");
    await mkdir(rootMeetings, { recursive: true });
    await writeFile(path.join(rootMeetings, "root.md"), "Root meeting content", "utf8");

    const nestedMeetings = path.join(tmpDir, "namespaces", "meetings");
    await mkdir(nestedMeetings, { recursive: true });
    await writeFile(path.join(nestedMeetings, "nested.md"), "--- \nid: mem-nested\n---\nNested meeting memory content", "utf8");

    const memories = await scanMemoryDir(tmpDir);
    assert.strictEqual(memories.length, 1);
    assert.strictEqual(memories[0].id, "mem-nested");
    assert.strictEqual(memories[0].content, "Nested meeting memory content");
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});
