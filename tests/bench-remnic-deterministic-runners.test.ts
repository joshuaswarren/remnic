import test from "node:test";
import assert from "node:assert/strict";
import type {
  BenchMemoryAdapter,
  BenchRecallOptions,
  Message,
  SearchResult,
} from "../packages/bench/src/index.js";
import { runBenchmark } from "../packages/bench/src/index.js";
import {
  RETRIEVAL_TEMPORAL_FIXTURE,
  type RetrievalTemporalCase,
} from "../packages/bench/src/benchmarks/remnic/retrieval-temporal/fixture.js";

class NoopMemoryAdapter implements BenchMemoryAdapter {
  async store(_sessionId: string, _messages: Message[]): Promise<void> {}

  async recall(
    _sessionId: string,
    _query: string,
    _budgetChars?: number,
    _options?: BenchRecallOptions,
  ): Promise<string> {
    return "";
  }

  async search(
    _query: string,
    _limit: number,
    _sessionId?: string,
  ): Promise<SearchResult[]> {
    return [];
  }

  async reset(_sessionId?: string): Promise<void> {}

  async getStats() {
    return {
      totalMessages: 0,
      totalSummaryNodes: 0,
      maxDepth: 0,
    };
  }

  async destroy(): Promise<void> {}
}

const adapter = new NoopMemoryAdapter();

class RetrievalTemporalFixtureAdapter extends NoopMemoryAdapter {
  constructor(
    private readonly pageIdsForCase: (sample: RetrievalTemporalCase) => string[],
  ) {
    super();
  }

  override async recall(
    sessionId: string,
    query: string,
    budgetChars?: number,
    options?: BenchRecallOptions,
  ): Promise<string> {
    const sample = retrievalTemporalCaseForSession(sessionId);
    assert.equal(query, sample.query);
    assert.equal(budgetChars, 12_000);
    assert.equal(options?.asOf, sample.window.end);

    return this.pageIdsForCase(sample)
      .map((pageId) => `page_id: ${pageId}`)
      .join("\n");
  }
}

function cleanTemporalHitsOnly(): RetrievalTemporalFixtureAdapter {
  return new RetrievalTemporalFixtureAdapter((sample) =>
    sample.tier === "clean" ? sample.expectedPageIds : [],
  );
}

function expectedTemporalHits(): RetrievalTemporalFixtureAdapter {
  return new RetrievalTemporalFixtureAdapter((sample) => sample.expectedPageIds);
}

function retrievalTemporalCaseForSession(sessionId: string): RetrievalTemporalCase {
  const sampleId = sessionId.replace(/^retrieval-temporal:/, "");
  const sample = RETRIEVAL_TEMPORAL_FIXTURE.find((entry) => entry.id === sampleId);
  assert.ok(sample, `unexpected retrieval-temporal session ${sessionId}`);
  return sample;
}

test("runBenchmark executes taxonomy-accuracy in quick mode", async () => {
  const result = await runBenchmark("taxonomy-accuracy", {
    mode: "quick",
    system: adapter,
  });

  assert.equal(result.meta.benchmark, "taxonomy-accuracy");
  assert.equal(result.meta.benchmarkTier, "remnic");
  assert.equal(result.results.tasks.length, 7);
  assert.equal(result.results.aggregates.exact_match.mean, 1);
});

test("runBenchmark keeps generic office facts in the fallback taxonomy bucket", async () => {
  const result = await runBenchmark("taxonomy-accuracy", {
    mode: "full",
    system: adapter,
  });

  const task = result.results.tasks.find((entry) => entry.taskId === "general-fact");
  assert.ok(task);
  assert.equal(task.actual, "general-facts");
  assert.equal(result.results.aggregates.exact_match.mean, 1);
});

test("runBenchmark executes extraction-judge-calibration in quick mode", async () => {
  const result = await runBenchmark("extraction-judge-calibration", {
    mode: "quick",
    system: adapter,
  });

  assert.equal(result.meta.benchmark, "extraction-judge-calibration");
  assert.equal(result.meta.benchmarkTier, "remnic");
  assert.equal(result.results.tasks.length, 5);
  assert.ok(result.results.aggregates.exact_match.mean >= 0.8);
  assert.equal(typeof result.results.aggregates.sensitivity.mean, "number");
  assert.equal(typeof result.results.aggregates.specificity.mean, "number");
});

test("runBenchmark executes enrichment-fidelity in quick mode", async () => {
  const result = await runBenchmark("enrichment-fidelity", {
    mode: "quick",
    system: adapter,
  });

  assert.equal(result.meta.benchmark, "enrichment-fidelity");
  assert.equal(result.meta.benchmarkTier, "remnic");
  assert.equal(result.results.tasks.length, 3);
  assert.ok(result.results.aggregates.accepted_precision.mean >= 0.66);
  assert.equal(result.results.aggregates.exact_count_match.mean, 1);
});

test("runBenchmark executes retrieval-personalization in quick mode", async () => {
  const result = await runBenchmark("retrieval-personalization", {
    mode: "quick",
    system: expectedPersonalizationHits(),
  });

  assert.equal(result.meta.benchmark, "retrieval-personalization");
  assert.equal(result.meta.benchmarkTier, "remnic");
  assert.equal(result.results.tasks.length, 6);
  assert.equal(result.results.aggregates["clean.p_at_1"].mean, 1);
  assert.equal(result.results.aggregates["dirty.p_at_1"].mean, 1);
  assert.equal(result.results.aggregates["dirty_penalty.p_at_1"].mean, 0);
});

test("runBenchmark applies retrieval-personalization limit as a clean/dirty pair cap", async () => {
  const result = await runBenchmark("retrieval-personalization", {
    mode: "quick",
    limit: 1,
    system: adapter,
  });

  assert.equal(result.results.tasks.length, 2);
  assert.equal(result.results.tasks[0]?.taskId, "clean:alex-scope-q3-launch");
  assert.equal(result.results.tasks[1]?.taskId, "dirty:alex-scope-q3-launch");
  assert.equal(result.results.aggregates["dirty_penalty.p_at_1"].mean, 0);
});

test("runBenchmark treats retrospective decision questions as non-initiating procedural recall", async () => {
  const result = await runBenchmark("procedural-recall", {
    mode: "full",
    system: adapter,
  });

  const task = result.results.tasks.find((entry) => entry.taskId === "intent:memory-question");
  assert.ok(task);
  assert.equal(task.actual, "false");
  assert.equal(result.results.aggregates.task_initiation_gate.mean, 1);
});

test("runBenchmark executes retrieval-temporal in quick mode", async () => {
  const result = await runBenchmark("retrieval-temporal", {
    mode: "quick",
    system: cleanTemporalHitsOnly(),
  });

  assert.equal(result.meta.benchmark, "retrieval-temporal");
  assert.equal(result.meta.benchmarkTier, "remnic");
  assert.equal(result.results.tasks.length, 2);
  assert.equal(result.results.aggregates["clean.qrel_at_1"].mean, 1);
  assert.equal(result.results.aggregates["dirty.qrel_at_1"].mean, 0);
  assert.equal(result.results.aggregates["dirty_penalty.qrel_at_1"].mean, 1);
});

test("runBenchmark applies retrieval-temporal limit as an exact task cap", async () => {
  const result = await runBenchmark("retrieval-temporal", {
    mode: "quick",
    limit: 1,
    system: cleanTemporalHitsOnly(),
  });

  assert.equal(result.results.tasks.length, 1);
  assert.equal(result.results.tasks[0]?.taskId, "clean:alex-last-tuesday-meeting");
  assert.equal(result.results.aggregates["dirty_penalty.qrel_at_1"], undefined);
});

test("runBenchmark records adapter-returned page order for full retrieval-temporal cases", async () => {
  const result = await runBenchmark("retrieval-temporal", {
    mode: "full",
    system: new RetrievalTemporalFixtureAdapter((sample) =>
      sample.id === "clean:morgan-q3-commitments"
        ? ["morgan-q3-training-plan", "morgan-coffee-preferences"]
        : sample.expectedPageIds,
    ),
  });

  const task = result.results.tasks.find((entry) => entry.taskId === "clean:morgan-q3-commitments");
  assert.ok(task);
  assert.equal(task.scores.qrel_at_1, 1);
  assert.deepEqual(
    task.details?.retrievedPageIds?.slice(0, 2),
    ["morgan-q3-training-plan", "morgan-coffee-preferences"],
  );
});

class RetrievalPersonalizationFixtureAdapter extends NoopMemoryAdapter {
  override async recall(
    sessionId: string,
    query: string,
    budgetChars?: number,
    options?: BenchRecallOptions,
  ): Promise<string> {
    const { RETRIEVAL_PERSONALIZATION_FIXTURE } = await import(
      "../packages/bench/src/benchmarks/remnic/retrieval-personalization/fixture.js"
    );
    const sampleId = sessionId.replace(/^retrieval-personalization:/, "");
    const sample = RETRIEVAL_PERSONALIZATION_FIXTURE.find(
      (entry) => entry.id === sampleId,
    );
    assert.ok(sample, `unexpected retrieval-personalization session ${sessionId}`);
    assert.equal(query, sample.query);
    assert.equal(budgetChars, 12_000);
    assert.equal(options, undefined);

    return sample.expectedPageIds.map((pageId) => `page_id: ${pageId}`).join("\n");
  }
}

function expectedPersonalizationHits(): RetrievalPersonalizationFixtureAdapter {
  return new RetrievalPersonalizationFixtureAdapter();
}

test("runBenchmark rejects overflowed timeline dates in retrieval-temporal evidence", async () => {
  const temporalCase = RETRIEVAL_TEMPORAL_FIXTURE.find((entry) => entry.id === "clean:morgan-q3-commitments");
  assert.ok(temporalCase);

  const targetPage = temporalCase.pages.find((page) => page.id === "morgan-q3-training-plan");
  assert.ok(targetPage);

  const originalCreatedAt = targetPage.createdAt;
  const originalCreated = targetPage.frontmatter.created;
  const originalTimeline = targetPage.frontmatter.timeline ? [...targetPage.frontmatter.timeline] : undefined;
  const originalTopLevelTimeline = [...targetPage.timeline];

  try {
    targetPage.createdAt = "2026-06-30T23:59:59.000Z";
    targetPage.frontmatter.created = undefined;
    targetPage.frontmatter.timeline = ["2026-08-32 impossible training block"];
    targetPage.timeline = ["2026-08-32 impossible training block"];

    const result = await runBenchmark("retrieval-temporal", {
      mode: "full",
      system: expectedTemporalHits(),
    });

    const task = result.results.tasks.find((entry) => entry.taskId === "clean:morgan-q3-commitments");
    assert.ok(task);
    assert.equal(task.scores.qrel_at_1, 0);
  } finally {
    targetPage.createdAt = originalCreatedAt;
    targetPage.frontmatter.created = originalCreated;
    targetPage.frontmatter.timeline = originalTimeline;
    targetPage.timeline = originalTopLevelTimeline;
  }
});

test("runBenchmark rejects overflowed window timestamps in retrieval-temporal cases", async () => {
  const temporalCase = RETRIEVAL_TEMPORAL_FIXTURE.find((entry) => entry.id === "clean:alex-last-tuesday-meeting");
  assert.ok(temporalCase);

  const originalWindow = { ...temporalCase.window };

  try {
    temporalCase.window.start = "2026-06-31T00:00:00.000Z";

    await assert.rejects(
      () => runBenchmark("retrieval-temporal", {
        mode: "full",
        system: adapter,
      }),
      /retrieval-temporal window must use valid half-open ISO timestamps/,
    );
  } finally {
    temporalCase.window = originalWindow;
  }
});

test("runBenchmark rejects overflowed window timestamps even without expected temporal pages", async () => {
  const temporalCase = RETRIEVAL_TEMPORAL_FIXTURE.find((entry) => entry.id === "clean:alex-last-tuesday-meeting");
  assert.ok(temporalCase);

  const originalWindow = { ...temporalCase.window };
  const originalExpectedPageIds = [...temporalCase.expectedPageIds];

  try {
    temporalCase.window.start = "2026-06-31T00:00:00.000Z";
    temporalCase.expectedPageIds = [];

    await assert.rejects(
      () => runBenchmark("retrieval-temporal", {
        mode: "full",
        system: adapter,
      }),
      /retrieval-temporal window must use valid half-open ISO timestamps/,
    );
  } finally {
    temporalCase.window = originalWindow;
    temporalCase.expectedPageIds = originalExpectedPageIds;
  }
});

test("runBenchmark rejects retrieval-temporal cases whose expectedPageIds do not exist in fixture pages", async () => {
  const temporalCase = RETRIEVAL_TEMPORAL_FIXTURE.find((entry) => entry.id === "clean:alex-last-tuesday-meeting");
  assert.ok(temporalCase);

  const originalExpectedPageIds = [...temporalCase.expectedPageIds];

  try {
    temporalCase.expectedPageIds = ["missing-page-id"];

    await assert.rejects(
      () => runBenchmark("retrieval-temporal", {
        mode: "full",
        system: adapter,
      }),
      /retrieval-temporal expectedPageIds must reference pages present in the fixture/,
    );
  } finally {
    temporalCase.expectedPageIds = originalExpectedPageIds;
  }
});

test("runBenchmark rejects overflowed created timestamps in retrieval-temporal evidence", async () => {
  const temporalCase = RETRIEVAL_TEMPORAL_FIXTURE.find((entry) => entry.id === "clean:morgan-q3-commitments");
  assert.ok(temporalCase);

  const targetPage = temporalCase.pages.find((page) => page.id === "morgan-q3-training-plan");
  assert.ok(targetPage);

  const originalCreatedAt = targetPage.createdAt;
  const originalCreated = targetPage.frontmatter.created;
  const originalTimeline = targetPage.frontmatter.timeline ? [...targetPage.frontmatter.timeline] : undefined;
  const originalTopLevelTimeline = [...targetPage.timeline];

  try {
    targetPage.createdAt = "2026-06-31T07:00:00.000Z";
    targetPage.frontmatter.created = "2026-06-31T07:00:00.000Z";
    targetPage.frontmatter.timeline = [];
    targetPage.timeline = [];

    const result = await runBenchmark("retrieval-temporal", {
      mode: "full",
      system: expectedTemporalHits(),
    });

    const task = result.results.tasks.find((entry) => entry.taskId === "clean:morgan-q3-commitments");
    assert.ok(task);
    assert.equal(task.scores.qrel_at_1, 0);
  } finally {
    targetPage.createdAt = originalCreatedAt;
    targetPage.frontmatter.created = originalCreated;
    targetPage.frontmatter.timeline = originalTimeline;
    targetPage.timeline = originalTopLevelTimeline;
  }
});

test("runBenchmark rejects timeline entries with extra day digits in retrieval-temporal evidence", async () => {
  const temporalCase = RETRIEVAL_TEMPORAL_FIXTURE.find((entry) => entry.id === "clean:morgan-q3-commitments");
  assert.ok(temporalCase);

  const targetPage = temporalCase.pages.find((page) => page.id === "morgan-q3-training-plan");
  assert.ok(targetPage);

  const originalCreatedAt = targetPage.createdAt;
  const originalCreated = targetPage.frontmatter.created;
  const originalTimeline = targetPage.frontmatter.timeline ? [...targetPage.frontmatter.timeline] : undefined;
  const originalTopLevelTimeline = [...targetPage.timeline];

  try {
    targetPage.createdAt = "2026-06-30T23:59:59.000Z";
    targetPage.frontmatter.created = undefined;
    targetPage.frontmatter.timeline = ["2026-08-032 malformed day"];
    targetPage.timeline = ["2026-08-032 malformed day"];

    const result = await runBenchmark("retrieval-temporal", {
      mode: "full",
      system: expectedTemporalHits(),
    });

    const task = result.results.tasks.find((entry) => entry.taskId === "clean:morgan-q3-commitments");
    assert.ok(task);
    assert.equal(task.scores.qrel_at_1, 0);
  } finally {
    targetPage.createdAt = originalCreatedAt;
    targetPage.frontmatter.created = originalCreated;
    targetPage.frontmatter.timeline = originalTimeline;
    targetPage.timeline = originalTopLevelTimeline;
  }
});

test("runBenchmark rejects timeline entries with trailing alpha suffixes in retrieval-temporal evidence", async () => {
  const temporalCase = RETRIEVAL_TEMPORAL_FIXTURE.find((entry) => entry.id === "clean:morgan-q3-commitments");
  assert.ok(temporalCase);

  const targetPage = temporalCase.pages.find((page) => page.id === "morgan-q3-training-plan");
  assert.ok(targetPage);

  const originalCreatedAt = targetPage.createdAt;
  const originalCreated = targetPage.frontmatter.created;
  const originalTimeline = targetPage.frontmatter.timeline ? [...targetPage.frontmatter.timeline] : undefined;
  const originalTopLevelTimeline = [...targetPage.timeline];

  try {
    targetPage.createdAt = "2026-06-30T23:59:59.000Z";
    targetPage.frontmatter.created = undefined;
    targetPage.frontmatter.timeline = ["2026-08-03x malformed day token"];
    targetPage.timeline = ["2026-08-03x malformed day token"];

    const result = await runBenchmark("retrieval-temporal", {
      mode: "full",
      system: expectedTemporalHits(),
    });

    const task = result.results.tasks.find((entry) => entry.taskId === "clean:morgan-q3-commitments");
    assert.ok(task);
    assert.equal(task.scores.qrel_at_1, 0);
  } finally {
    targetPage.createdAt = originalCreatedAt;
    targetPage.frontmatter.created = originalCreated;
    targetPage.frontmatter.timeline = originalTimeline;
    targetPage.timeline = originalTopLevelTimeline;
  }
});
