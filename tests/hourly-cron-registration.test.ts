import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  loadHourlySummaryCronJobsData,
  parseHourlySummaryCronJobsData,
} from "../src/index.js";

test("hourly cron jobs loader preserves malformed existing jobs files", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-hourly-cron-"));
  try {
    const jobsPath = path.join(dir, "jobs.json");
    const malformed = "{ not valid jobs json\n";
    await writeFile(jobsPath, malformed, "utf8");

    const result = await loadHourlySummaryCronJobsData(jobsPath);

    assert.equal(result.status, "invalid");
    assert.equal(await readFile(jobsPath, "utf8"), malformed);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("hourly cron jobs parser rejects invalid jobs shape", () => {
  assert.throws(
    () => parseHourlySummaryCronJobsData(JSON.stringify({ version: 1, jobs: {} })),
    /jobs array/,
  );
  assert.throws(
    () => parseHourlySummaryCronJobsData(JSON.stringify({ version: 1, jobs: [null] })),
    /jobs entries/,
  );
});
