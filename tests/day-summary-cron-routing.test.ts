import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { validateRequest } from "@remnic/core/access-schema";
import { parseConfig } from "@remnic/core/config";
import { Orchestrator } from "@remnic/core/orchestrator";

function resetGlobals(): void {
  const globals = globalThis as Record<string, unknown>;
  for (const key of [
    "__openclawEngramOrchestrator",
    "__openclawEngramCliRegistered",
    "__openclawEngramCliActiveServiceCount",
    "__openclawEngramSessionCommandsRegistered",
    "__openclawEngramMigrationPromise",
  ]) {
    delete globals[key];
  }
}

test.afterEach(() => {
  resetGlobals();
});

async function withHome<T>(prefix: string, fn: (homeDir: string) => Promise<T>): Promise<T> {
  const previousHome = process.env.HOME;
  const homeDir = await mkdtemp(path.join(os.tmpdir(), prefix));
  try {
    process.env.HOME = homeDir;
    return await fn(homeDir);
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    await rm(homeDir, { recursive: true, force: true });
  }
}

async function writeFact(
  memoryDir: string,
  utcDate: string,
  id: string,
  created: string,
  content: string
): Promise<void> {
  const dir = path.join(memoryDir, "facts", utcDate);
  await mkdir(dir, { recursive: true });
  await writeFile(
    path.join(dir, `${id}.md`),
    [
      "---",
      `id: ${id}`,
      "category: fact",
      `created: ${created}`,
      `updated: ${created}`,
      "source: test",
      "confidence: 0.9",
      "---",
      content,
      "",
    ].join("\n"),
    "utf-8"
  );
}

async function writeHourlySummary(
  memoryDir: string,
  sessionKey: string,
  utcDate: string,
  sections: Array<{ hour: string; text: string }>,
): Promise<void> {
  const dir = path.join(memoryDir, "summaries", "hourly", sessionKey);
  await mkdir(dir, { recursive: true });
  await writeFile(
    path.join(dir, `${utcDate}.md`),
    [
      `# Hourly Summaries — ${utcDate}`,
      "",
      `*Session: ${sessionKey}*`,
      "",
      ...sections.flatMap((section) => [
        `## ${section.hour}:00`,
        "",
        `- ${section.text}`,
        "",
      ]),
    ].join("\n"),
    "utf-8",
  );
}

test("day-summary cron omits direct plugin summary models from OpenClaw routing", async () => {
  await withHome("remnic-day-summary-home-", async (homeDir) => {
    const cronDir = path.join(homeDir, ".openclaw", "cron");
    const jobsPath = path.join(cronDir, "jobs.json");
    await mkdir(cronDir, { recursive: true });
    await writeFile(jobsPath, JSON.stringify({ version: 1, jobs: [] }, null, 2) + "\n", "utf-8");

    const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-day-summary-memory-"));
    try {
      const config = parseConfig({
        openaiApiKey: "sk-test",
        memoryDir,
        workspaceDir: path.join(memoryDir, "workspace"),
        modelSource: "plugin",
        summaryModel: "gpt-4.1",
        daySummaryTimezone: "America/Chicago",
      });
      const orchestrator = new Orchestrator(config);

      // The day-summary cron registration moved to MaintenanceScheduler (#1526 PR1);
      // the orchestrator delegates through its public maintenanceScheduler field.
      await orchestrator.maintenanceScheduler.autoRegisterDaySummaryCron();

      const parsed = JSON.parse(await readFile(jobsPath, "utf-8")) as {
        jobs: Array<{
          id: string;
          model?: string;
          schedule: { tz: string };
          payload: { message: string; model?: string };
        }>;
      };
      const job = parsed.jobs.find((candidate) => candidate.id === "engram-day-summary");
      assert.ok(job);
      assert.equal(job.model, undefined);
      assert.equal(job.payload.model, undefined);
      assert.equal(job.schedule.tz, "America/Chicago");
      assert.match(job.payload.message, /"timeZone":"America\/Chicago"/);
    } finally {
      await rm(memoryDir, { recursive: true, force: true });
    }
  });
});

test("day-summary request rejects invalid timeZone values", () => {
  const result = validateRequest("daySummary", {
    timeZone: "Mars/Olympus",
  });

  assert.equal(result.success, false);
  if (result.success) assert.fail("invalid timeZone should not validate");
  assert.deepEqual(result.error.details, [{ field: "timeZone", message: "must be a valid IANA timezone" }]);
});

test("parseConfig rejects invalid daySummaryTimezone values", () => {
  assert.throws(
    () => parseConfig({ openaiApiKey: "sk-test", daySummaryTimezone: "Mars/Olympus" }),
    /daySummaryTimezone must be a valid IANA timezone: Mars\/Olympus/,
  );
});

test("day-summary auto-gather filters facts by configured local day", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-day-summary-gather-"));
  try {
    await writeFact(
      memoryDir,
      "2026-06-23",
      "same-local-day-afternoon",
      "2026-06-23T19:00:00Z",
      "Afternoon Chicago fact"
    );
    await writeFact(memoryDir, "2026-06-24", "same-local-day-late", "2026-06-24T04:20:00Z", "Late Chicago fact");
    await writeFact(memoryDir, "2026-06-24", "next-local-day", "2026-06-24T05:20:00Z", "Next Chicago day fact");

    const config = parseConfig({
      openaiApiKey: "sk-test",
      memoryDir,
      workspaceDir: path.join(memoryDir, "workspace"),
      daySummaryTimezone: "America/Chicago",
    });
    const orchestrator = new Orchestrator(config);

    const gathered = await orchestrator.gatherTodayFacts(undefined, {
      now: new Date("2026-06-24T04:30:00Z"),
    });

    assert.match(gathered, /Afternoon Chicago fact/);
    assert.match(gathered, /Late Chicago fact/);
    assert.doesNotMatch(gathered, /Next Chicago day fact/);
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("day-summary auto-gather filters hourly summary sections by configured local day", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-day-summary-hourly-gather-"));
  try {
    await writeHourlySummary(memoryDir, "session-a", "2026-06-23", [
      { hour: "03", text: "Previous Chicago day hourly" },
      { hour: "19", text: "Target Chicago afternoon hourly" },
    ]);
    await writeHourlySummary(memoryDir, "session-a", "2026-06-24", [
      { hour: "04", text: "Target Chicago late hourly" },
      { hour: "05", text: "Next Chicago day hourly" },
    ]);

    const config = parseConfig({
      openaiApiKey: "sk-test",
      memoryDir,
      workspaceDir: path.join(memoryDir, "workspace"),
      daySummaryTimezone: "America/Chicago",
    });
    const orchestrator = new Orchestrator(config);

    const gathered = await orchestrator.gatherTodayFacts(undefined, {
      now: new Date("2026-06-24T04:30:00Z"),
    });

    assert.match(gathered, /Target Chicago afternoon hourly/);
    assert.match(gathered, /Target Chicago late hourly/);
    assert.doesNotMatch(gathered, /Previous Chicago day hourly/);
    assert.doesNotMatch(gathered, /Next Chicago day hourly/);
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("gatherTodayFacts includes a decision-category memory routed to decisions/ (issue #1546)", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-day-summary-decision-"));
  try {
    // A day whose only memory is a decision routed into decisions/<utc-date>/
    // must still produce a non-empty day summary that includes it — the scan
    // now iterates every recall category dir, not just facts/.
    const utcDate = "2026-06-24";
    const created = "2026-06-24T12:00:00.000Z";
    const dir = path.join(memoryDir, "decisions", utcDate);
    await mkdir(dir, { recursive: true });
    await writeFile(
      path.join(dir, "decision-1.md"),
      [
        "---",
        "id: decision-1",
        "category: decision",
        `created: ${created}`,
        `updated: ${created}`,
        "source: test",
        "confidence: 0.9",
        "---",
        "We chose blue-green deploys for the ingestion worker.",
        "",
      ].join("\n"),
      "utf-8",
    );

    const config = parseConfig({
      openaiApiKey: "sk-test",
      memoryDir,
      workspaceDir: path.join(memoryDir, "workspace"),
      daySummaryTimezone: "UTC",
    });
    const orchestrator = new Orchestrator(config);

    const gathered = await orchestrator.gatherTodayFacts(undefined, {
      now: new Date("2026-06-24T18:00:00Z"),
    });

    assert.notEqual(gathered.trim(), "", "day summary must not be empty for a decision-only day");
    assert.match(gathered, /blue-green deploys for the ingestion worker/);
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

// Security regression (codex P2): gatherTodayFacts feeds file contents into the
// day-summary LLM input. A category dir symlinked outside memoryDir must NOT be
// followed, or an external file would leak into the summary.
test("gatherTodayFacts does not follow a category dir symlinked outside memoryDir", async (t) => {
  if (process.platform === "win32") {
    t.skip("directory symlink setup is platform-specific");
    return;
  }

  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-day-summary-escape-"));
  const outsideDir = await mkdtemp(path.join(os.tmpdir(), "remnic-day-summary-outside-"));
  try {
    const utcDate = "2026-06-24";
    const created = "2026-06-24T12:00:00.000Z";

    // External file under <outside>/<date>/, reachable only via a symlink.
    const outsideDated = path.join(outsideDir, utcDate);
    await mkdir(outsideDated, { recursive: true });
    await writeFile(
      path.join(outsideDated, "decision-external.md"),
      [
        "---",
        "id: decision-external",
        "category: decision",
        `created: ${created}`,
        `updated: ${created}`,
        "source: test",
        "confidence: 0.9",
        "---",
        "EXTERNAL SECRET — must not leak into the day summary.",
        "",
      ].join("\n"),
      "utf-8",
    );
    // decisions/ → external dir.
    await symlink(outsideDir, path.join(memoryDir, "decisions"), "dir");

    // A genuine in-store fact for the same day (regression: real scan works).
    const realDated = path.join(memoryDir, "facts", utcDate);
    await mkdir(realDated, { recursive: true });
    await writeFile(
      path.join(realDated, "fact-real.md"),
      [
        "---",
        "id: fact-real",
        "category: fact",
        `created: ${created}`,
        `updated: ${created}`,
        "source: test",
        "confidence: 0.9",
        "---",
        "A genuine in-store fact for the day.",
        "",
      ].join("\n"),
      "utf-8",
    );

    const config = parseConfig({
      openaiApiKey: "sk-test",
      memoryDir,
      workspaceDir: path.join(memoryDir, "workspace"),
      daySummaryTimezone: "UTC",
    });
    const orchestrator = new Orchestrator(config);

    const gathered = await orchestrator.gatherTodayFacts(undefined, {
      now: new Date("2026-06-24T18:00:00Z"),
    });

    assert.doesNotMatch(gathered, /EXTERNAL SECRET/, "external file must not leak via the symlinked category dir");
    assert.match(gathered, /genuine in-store fact/, "the real in-store fact is still included");
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
    await rm(outsideDir, { recursive: true, force: true });
  }
});
