import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { generateSuiteVariants } from "./generator.js";
import {
  planInjectionSuiteRows,
  runInjectionSuiteCliCommand,
} from "./runner.js";
import { InjectionSuiteRowStore } from "./store.js";
import { HOST_FAULT_RETRY_LIMIT } from "./types.js";

test("generator emits four families with CANARY-e2e tokens", () => {
  const variants = generateSuiteVariants(2, 1);
  assert.equal(variants.length, 8);
  assert.deepEqual([...new Set(variants.map((variant) => variant.family))].sort(), [
    "cross-session",
    "minja",
    "sleeper",
    "tool-hijack",
  ]);
  for (const variant of variants) {
    assert.match(variant.canary, /^CANARY-e2e-[0-9a-f]{12}$/);
    assert.match(variant.payload, new RegExp(variant.canary));
  }
});

test("plan respects --limit", () => {
  const rows = planInjectionSuiteRows({
    seeds: 1,
    variantsPerFamily: 2,
    modelProfileId: "local-dry",
    limit: 3,
  });
  assert.equal(rows.length, 3);
});

test("resume skips terminal rows and refuses a drifted contract", async () => {
  const outputDir = await mkdtemp(path.join(tmpdir(), "h5-suite-"));
  try {
    const first = await runInjectionSuiteCliCommand({
      seeds: 1,
      variantsPerFamily: 1,
      modelProfileId: "local-dry",
      outputDir,
      limit: 2,
    });
    assert.equal(first.exitCode, 0);
    assert.equal(first.completed, 2);

    await assert.rejects(
      () =>
        runInjectionSuiteCliCommand({
          seeds: 1,
          variantsPerFamily: 1,
          modelProfileId: "local-dry",
          outputDir,
          limit: 2,
        }),
      /pass --resume/,
    );

    const resumed = await runInjectionSuiteCliCommand({
      seeds: 1,
      variantsPerFamily: 1,
      modelProfileId: "local-dry",
      outputDir,
      limit: 3,
      resume: true,
    });
    assert.equal(resumed.exitCode, 0);
    assert.equal(resumed.resumed, 2);
    assert.equal(resumed.completed, 1);

    const episodes = (await readFile(path.join(outputDir, "episodes.jsonl"), "utf8"))
      .trim()
      .split("\n");
    assert.equal(episodes.length, 3);

    const metadata = JSON.parse(await readFile(path.join(outputDir, "run.json"), "utf8")) as {
      resumeContractHash: string;
    };
    metadata.resumeContractHash = "0".repeat(64);
    await writeFile(path.join(outputDir, "run.json"), `${JSON.stringify(metadata, null, 2)}\n`);
    await assert.rejects(
      () =>
        runInjectionSuiteCliCommand({
          seeds: 1,
          variantsPerFamily: 1,
          modelProfileId: "local-dry",
          outputDir,
          limit: 3,
          resume: true,
        }),
      /resume contract hash drifted/,
    );
  } finally {
    await rm(outputDir, { recursive: true, force: true });
  }
});

test("host-fault exhaustion pauses instead of cutting the row", async () => {
  const outputDir = await mkdtemp(path.join(tmpdir(), "h5-pause-"));
  try {
    const paused = await runInjectionSuiteCliCommand({
      seeds: 1,
      variantsPerFamily: 1,
      modelProfileId: "local-dry",
      outputDir,
      limit: 1,
      faultFirstAttempts: HOST_FAULT_RETRY_LIMIT,
    });
    assert.equal(paused.exitCode, 2);
    assert.equal(paused.paused, true);
    assert.match(paused.output, /PAUSED/);
    assert.equal(paused.completed, 0);

    const recovered = await runInjectionSuiteCliCommand({
      seeds: 1,
      variantsPerFamily: 1,
      modelProfileId: "local-dry",
      outputDir,
      limit: 1,
      resume: true,
    });
    assert.equal(recovered.exitCode, 0);
    assert.equal(recovered.completed, 1);

    const store = new InjectionSuiteRowStore(outputDir);
    const identity = planInjectionSuiteRows({
      seeds: 1,
      variantsPerFamily: 1,
      modelProfileId: "local-dry",
      limit: 1,
    })[0]!;
    const loaded = await store.load(identity);
    assert.equal(loaded.kind, "VALID");
    if (loaded.kind === "VALID") {
      assert.equal(loaded.checkpoint.tries.length, HOST_FAULT_RETRY_LIMIT + 1);
      assert.ok(loaded.checkpoint.terminal);
    }
  } finally {
    await rm(outputDir, { recursive: true, force: true });
  }
});

test("terminal rows are immutable", async () => {
  const outputDir = await mkdtemp(path.join(tmpdir(), "h5-term-"));
  try {
    await runInjectionSuiteCliCommand({
      seeds: 1,
      variantsPerFamily: 1,
      modelProfileId: "local-dry",
      outputDir,
      limit: 1,
    });
    const identity = planInjectionSuiteRows({
      seeds: 1,
      variantsPerFamily: 1,
      modelProfileId: "local-dry",
      limit: 1,
    })[0]!;
    const store = new InjectionSuiteRowStore(outputDir);
    await assert.rejects(
      () =>
        store.commitTry(identity, {
          attempt: 99,
          durationMs: 1,
          outcome: { kind: "HOST_API_FAULT", message: "nope" },
        }),
      /terminal and immutable/,
    );
  } finally {
    await rm(outputDir, { recursive: true, force: true });
  }
});
