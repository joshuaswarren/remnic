import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test } from "node:test";
import type { H6TrapId, StrategyPatch, SyntheticFile } from "./types.js";
import { regenerateH6Fixtures } from "../../../fixtures/h6-failure-gate/generator/regenerate.js";
import { H6BenchmarkDatasetSchema, H6_TRAP_IDS } from "./types.js";
import {
  loadCommittedH6BenchmarkDataset,
  resolveCommittedH6FixtureDirectory,
  evaluateTaskState,
  computeH6InventoryHash,
  generateH6BenchmarkDataset,
  materializeTaskRepo,
  validateH6Dataset,
  calculateJaccardSimilarity,
  tokenizeContent,
} from "./index.js";

function applyPatch(files: SyntheticFile[], patch: StrategyPatch): SyntheticFile[] {
  const replacements = new Map(patch.files.map((file) => [file.path, file]));
  const patched = files.map((file) => replacements.get(file.path) ?? file);
  const existingPaths = new Set(files.map((file) => file.path));
  return [...patched, ...patch.files.filter((file) => !existingPaths.has(file.path))];
}

function corruptGoodBehavior(trapId: H6TrapId, content: string): string {
  switch (trapId) {
    case "flaky-looking-test":
      return content.replace(
        "this.#items.push(item.trim().toLowerCase());",
        "Promise.resolve().then(() => " +
          "Promise.resolve().then(() => this.#items.push(item.trim().toLowerCase())));",
      );
    case "misleading-error-message":
      return content.replace(
        "return validateRecord(record);",
        "return { profile: { email: \"reader@example.test\", age: 0 } };",
      );
    case "wrong-layer-fix":
      return content.replace(
        /if \(!validateUserSchema_[^(]+\(input\)\) return false;/,
        "",
      );
    case "hidden-invariant":
      return content.replace(
        "count: state.metrics.count + delta,",
        "count: state.metrics.count - delta,",
      );
    case "stale-cache-illusion":
      return content.replace(
        /const key = `calculation:\$\{value\}`;/,
        "const key = \"calculation\";",
      );
    case "config-shadowing":
      return content.replace(
        "\"./config/default.json\"",
        "\"./config/local-override.json\"",
      );
  }
}

async function generatedTreeInventory(
  root: string,
  current = root,
): Promise<Array<[string, string]>> {
  const inventory: Array<[string, string]> = [];
  const entries = await readdir(current, { withFileTypes: true });
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const entryPath = join(current, entry.name);
    if (entry.isDirectory()) {
      inventory.push(...await generatedTreeInventory(root, entryPath));
    } else if (entry.isFile()) {
      inventory.push([relative(root, entryPath), await readFile(entryPath, "utf8")]);
    } else {
      throw new Error(`Generated fixture tree contains non-file entry: ${entryPath}`);
    }
  }
  return inventory;
}

test("fixture resolution is package-rooted in source and bundled layouts", async () => {
  const sourceFixtureDir = await resolveCommittedH6FixtureDirectory();
  const packageRoot = join(sourceFixtureDir, "..", "..");
  const bundledModuleUrl = pathToFileURL(join(packageRoot, "dist", "index.js")).href;
  assert.equal(await resolveCommittedH6FixtureDirectory(bundledModuleUrl), sourceFixtureDir);
});

test("seed determinism & regeneration parity", async () => {
  const dsA1 = await generateH6BenchmarkDataset(81);
  const dsA2 = await generateH6BenchmarkDataset(81);
  const dsB = await generateH6BenchmarkDataset(82);

  assert.equal(dsA1.inventoryHash, dsA2.inventoryHash);
  assert.deepEqual(dsA1, dsA2);

  assert.notEqual(dsA1.inventoryHash, dsB.inventoryHash);
  assert.notDeepEqual(dsA1, dsB);
});

test("committed fixture tree contains no symlinks", async () => {
  const fixtureRoot = fileURLToPath(
    new URL("../../../fixtures/h6-failure-gate/", import.meta.url),
  );

  await generatedTreeInventory(fixtureRoot);
});

test("regeneration writes all committed fixture artifacts byte-for-byte", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "h6-regeneration-"));
  const fixtureRoot = fileURLToPath(
    new URL("../../../fixtures/h6-failure-gate/", import.meta.url),
  );

  try {
    await regenerateH6Fixtures(tempDir);
    const regenerated = await generatedTreeInventory(tempDir);
    const committed = (await generatedTreeInventory(fixtureRoot)).filter(
      ([path]) => !path.startsWith("generator/"),
    );
    assert.deepEqual(regenerated, committed);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("full dataset validation & split balance", async () => {
  const dataset = await loadCommittedH6BenchmarkDataset();
  const report = await validateH6Dataset(dataset);

  assert.equal(report.valid, true, `Validation failed with issues: ${JSON.stringify(report.issues)}`);
  assert.equal(report.issues.length, 0);
  assert.equal(report.metrics.totalTasks, 30);
  assert.equal(report.metrics.totalVariants, 90);
  assert.equal(report.metrics.devTaskCount, 6);
  assert.equal(report.metrics.pilotTaskCount, 6);
  assert.equal(report.metrics.mainTaskCount, 18);
  assert.ok(report.metrics.maxPairwiseSimilarity <= 0.40);
});

test("each trap class uses independently generated trap-relevant fixtures", async () => {
  const dataset = await loadCommittedH6BenchmarkDataset();
  for (const trapId of H6_TRAP_IDS) {
    const tasks = dataset.tasks.filter((task) => task.trapId === trapId);
    const hashes = tasks.map((task) => {
      const trapFile = task.canonicalBaseFiles.find(
        (file) => file.path === task.fingerprint.file,
      );
      assert.ok(trapFile, `${task.id} lacks its trap-relevant file`);
      return createHash("sha256").update(trapFile.content).digest("hex");
    });
    assert.equal(new Set(hashes).size, tasks.length, trapId);
  }
});

test("registered content tokenizer uses NFKC lowercase alphanumeric unigrams", () => {
  assert.deepEqual(
    [...tokenizeContent("Ｆｏｏ—BAR… café_42!!!")],
    ["foo", "bar", "café", "42"],
  );
  assert.equal(
    calculateJaccardSimilarity("ＦＯＯ, bar bar / café", "foo BAR___café"),
    1,
  );
  assert.equal(calculateJaccardSimilarity("alpha beta", "alpha gamma"), 1 / 3);
});

test("taxonomy, class sizes, canonical bases, and structural distances are frozen", async () => {
  const dataset = await loadCommittedH6BenchmarkDataset();

  assert.deepEqual(
    dataset.taxonomy.map((item) => item.trapId),
    [...H6_TRAP_IDS],
  );
  for (const trapId of H6_TRAP_IDS) {
    assert.equal(
      dataset.tasks.filter((task) => task.trapId === trapId).length,
      5,
      trapId,
    );
  }
  for (const task of dataset.tasks) {
    assert.ok(task.canonicalBaseFiles.length > 0, task.id);
    assert.deepEqual(
      task.variants.map((variant) => variant.distance),
      [1, 2, 3],
      task.id,
    );
    assert.equal(
      new Set([
        JSON.stringify(task.canonicalBaseFiles),
        ...task.variants.map((variant) => JSON.stringify(variant.files)),
      ]).size,
      4,
      task.id,
    );
    const [d1, d2, d3] = task.variants;
    assert.deepEqual(
      d1.files.map((file) => file.path).sort(),
      task.canonicalBaseFiles.map((file) => file.path).sort(),
      task.id,
    );
    assert.match(
      d1.files.find((file) => file.path === "src/helper.ts")?.content ?? "",
      /_revision/,
      task.id,
    );
    assert.notDeepEqual(
      d2.files.map((file) => file.path),
      task.canonicalBaseFiles.map((file) => file.path),
      task.id,
    );
    const distanceTwoHelper =
      d2.files.find((file) => file.path === "src/helper.ts")?.content ?? "";
    assert.ok(
      distanceTwoHelper.indexOf("buildResponseEnvelope_")
        < distanceTwoHelper.indexOf("getDomainHeader_"),
      task.id,
    );
    assert.ok(
      d3.files.some((file) => file.path === "src/helper/core.ts"),
      task.id,
    );
    assert.match(
      d3.files.find((file) => file.path === "src/helper.ts")?.content ?? "",
      /helper\/core\.js/,
      task.id,
    );
  }
});

test("agent-visible text is neutral and successful candidate positions are balanced", async () => {
  const dataset = await loadCommittedH6BenchmarkDataset();
  const leakage =
    /\b(?:trap|prior failure|bad|good|retry[- ]loop|presentation[- ]layer|root[- ]cause)\b/i;
  const successfulPositions = [0, 0];

  for (const task of dataset.tasks) {
    const visibleText = [
      task.title,
      task.description,
      ...task.canonicalBaseFiles
        .filter((file) => file.path === "TASK.md" || file.path === "README.md")
        .map((file) => file.content),
      ...task.variants[0].strategyCandidates.map((candidate) => candidate.description),
    ].join("\n");
    assert.doesNotMatch(visibleText, leakage, task.id);
    assert.deepEqual(
      task.variants[0].strategyCandidates.map((candidate) => candidate.id),
      ["candidate-alpha", "candidate-beta"],
      task.id,
    );
    const position = task.variants[0].strategyCandidates.findIndex(
      (candidate) => candidate.isGood,
    );
    assert.ok(position === 0 || position === 1, task.id);
    successfulPositions[position] += 1;
    assert.equal(task.fingerprint.strategyId, task.variants[0].badStrategyPatch.id);
    assert.notEqual(task.fingerprint.strategyId, task.variants[0].goodStrategyPatch.id);
  }
  assert.deepEqual(successfulPositions, [15, 15]);
});

test("validator rejects leakage, fixed candidate positions, identical variants, and hash drift", async () => {
  const dataset = await loadCommittedH6BenchmarkDataset();
  const corrupted = structuredClone(dataset);
  for (const task of corrupted.tasks) {
    task.variants = task.variants.map((variant) => ({
      ...variant,
      strategyCandidates: [
        variant.goodStrategyPatch,
        variant.badStrategyPatch,
      ],
    })) as typeof task.variants;
  }
  const task = corrupted.tasks[0];
  const taskInstruction = task.canonicalBaseFiles.find((file) => file.path === "TASK.md");
  assert.ok(taskInstruction);
  taskInstruction.content += "\nThe trap answer is candidate-alpha.\n";
  task.variants[0].files = structuredClone(task.canonicalBaseFiles);
  task.variants[0].cleanRevisionSha = "0".repeat(40);
  const { inventoryHash: _inventoryHash, ...hashable } = corrupted;
  corrupted.inventoryHash = computeH6InventoryHash(hashable);

  const report = await validateH6Dataset(corrupted);
  assert.ok(report.issues.some((issue) => issue.code === "AGENT_VISIBLE_LEAKAGE"));
  assert.ok(report.issues.some((issue) => issue.code === "STRATEGY_POSITION_IMBALANCE"));
  assert.ok(report.issues.some((issue) => issue.code === "DISTANCE_VARIANT_CONTENT_DUPLICATE"));
  assert.ok(report.issues.some((issue) => issue.code === "REVISION_SHA_MISMATCH"));
});

test("schema rejects a task without its canonical base files", async () => {
  const dataset = await loadCommittedH6BenchmarkDataset();
  const corrupted = structuredClone(dataset);
  corrupted.tasks[0].canonicalBaseFiles = [];
  assert.equal(H6BenchmarkDatasetSchema.safeParse(corrupted).success, false);
});

test("all trap classes transition UNFIXED -> TRAPPED -> FIXED -> no-trap", async () => {
  const dataset = await loadCommittedH6BenchmarkDataset();
  const firstTaskByTrap = new Map<H6TrapId, (typeof dataset.tasks)[number]>();
  for (const task of dataset.tasks) {
    if (!firstTaskByTrap.has(task.trapId)) firstTaskByTrap.set(task.trapId, task);
  }

  assert.equal(firstTaskByTrap.size, 6);
  for (const task of firstTaskByTrap.values()) {
    const variant = task.variants[0];
    const unfixed = await evaluateTaskState(task, variant, variant.files);
    assert.equal(unfixed.state, "UNFIXED", task.trapId);
    assert.equal(unfixed.gateStatus, "MATCH_WARN", task.trapId);
    assert.equal(unfixed.testPassed, false, task.trapId);

    const trapped = await evaluateTaskState(
      task,
      variant,
      applyPatch(variant.files, variant.badStrategyPatch),
    );
    assert.equal(trapped.state, "TRAPPED", task.trapId);
    assert.equal(trapped.gateStatus, "MATCH_WARN", task.trapId);
    assert.equal(trapped.testPassed, false, task.trapId);

    const fixed = await evaluateTaskState(
      task,
      variant,
      applyPatch(variant.files, variant.goodStrategyPatch),
    );
    assert.equal(fixed.state, "FIXED", task.trapId);
    assert.equal(fixed.gateStatus, "NO_MATCH", task.trapId);
    assert.equal(fixed.testPassed, true, task.trapId);

    const control = await evaluateTaskState(
      task,
      variant,
      variant.noTrapControlFiles,
      { isNoTrapControl: true },
    );
    assert.equal(control.state, "no-trap", task.trapId);
    assert.equal(control.gateStatus, "NO_MATCH", task.trapId);
    assert.equal(control.testPassed, true, task.trapId);
  }
});

test("good strategies fail when their observable behavior is corrupted", async () => {
  const dataset = await loadCommittedH6BenchmarkDataset();
  const seen = new Set<H6TrapId>();

  for (const task of dataset.tasks) {
    if (seen.has(task.trapId)) continue;
    seen.add(task.trapId);
    const variant = task.variants[0];
    const goodFiles = applyPatch(variant.files, variant.goodStrategyPatch);
    const mutatedFiles = goodFiles.map((file) => {
      if (file.path !== task.fingerprint.file) return file;
      const content = corruptGoodBehavior(task.trapId, file.content);
      assert.notEqual(content, file.content, `mutation did not change ${task.trapId}`);
      return { ...file, content };
    });

    const result = await evaluateTaskState(task, variant, mutatedFiles);
    assert.notEqual(result.state, "FIXED", task.trapId);
    assert.equal(result.testPassed, false, task.trapId);
  }

  assert.equal(seen.size, 6);
});

test("inserting success markers cannot make a broken implementation fixed", async () => {
  const dataset = await loadCommittedH6BenchmarkDataset();
  const seen = new Set<H6TrapId>();

  for (const task of dataset.tasks) {
    if (seen.has(task.trapId)) continue;
    seen.add(task.trapId);
    const variant = task.variants[0];
    const markedFiles = variant.files.map((file) =>
      file.path === task.fingerprint.file
        ? { ...file, content: `${file.content}\n// FIXED GOOD SUCCESS\n` }
        : file,
    );

    const result = await evaluateTaskState(task, variant, markedFiles);
    assert.notEqual(result.state, "FIXED", task.trapId);
    assert.equal(result.testPassed, false, task.trapId);
  }

  assert.equal(seen.size, 6);
});

test("malformed package failures stay silent and return bounded diagnostics", async () => {
  const dataset = await loadCommittedH6BenchmarkDataset();
  const task = dataset.tasks[0];
  const variant = task.variants[0];
  const malformedFiles = variant.files.map((file) =>
    file.path === "package.json" ? { ...file, content: "{" } : file,
  );

  const result = await evaluateTaskState(task, variant, malformedFiles);

  assert.equal(result.state, "UNFIXED");
  assert.equal(result.testPassed, false);
  assert.ok(result.reason.length <= 640);
  assert.doesNotMatch(
    result.reason,
    /ERR_INVALID_PACKAGE_CONFIG|node:internal|SyntaxError/,
  );
});

test("git materialization ignores inherited Git config and pins SHA-1 revisions", async () => {
  const injectedEnvironment = {
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "commit.gpgSign",
    GIT_CONFIG_VALUE_0: "true",
    GIT_DEFAULT_HASH: "sha256",
  };
  const previousEnvironment = new Map(
    Object.keys(injectedEnvironment).map((key) => [key, process.env[key]]),
  );
  let repo: Awaited<ReturnType<typeof materializeTaskRepo>> | undefined;
  try {
    Object.assign(process.env, injectedEnvironment);
    const dataset = await loadCommittedH6BenchmarkDataset();
    const variant = dataset.tasks[0].variants[0];
    repo = await materializeTaskRepo(variant.files);
    assert.ok(repo.dir.length > 0);
    assert.match(repo.commitSha, /^[0-9a-f]{40}$/);
    assert.equal(variant.cleanRevisionSha, repo.commitSha);
  } finally {
    for (const [key, value] of previousEnvironment) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await repo?.cleanup();
  }
});

test("materializer rejects traversal, duplicate paths, and nested Git metadata", async () => {
  await assert.rejects(
    materializeTaskRepo([{ path: "../outside.mjs", content: "" }]),
    /escapes repository/,
  );
  await assert.rejects(
    materializeTaskRepo([
      { path: "src/service.mjs", content: "one" },
      { path: "src/service.mjs", content: "two" },
    ]),
    /Duplicate synthetic file path/,
  );
  await assert.rejects(
    materializeTaskRepo([{ path: "nested/.git/config", content: "" }]),
    /escapes repository/,
  );
});

test("corrupted manifest and inventory hash are rejected", async () => {
  const dataset = await loadCommittedH6BenchmarkDataset();
  const corrupted = JSON.parse(JSON.stringify(dataset));
  corrupted.splits.dev[0] = corrupted.splits.dev[1];

  const report = await validateH6Dataset(corrupted);

  assert.equal(report.valid, false);
  assert.ok(report.issues.some((issue) => issue.code === "UNBALANCED_SPLITS"));
  assert.ok(report.issues.some((issue) => issue.code === "INVENTORY_HASH_MISMATCH"));
});

test("balanced split swaps and task split drift fail the frozen membership contract", async () => {
  const dataset = await loadCommittedH6BenchmarkDataset();
  const swapped = JSON.parse(JSON.stringify(dataset));
  const devTaskId = swapped.splits.dev[0];
  const pilotTaskId = swapped.splits.pilot[0];
  swapped.splits.dev[0] = pilotTaskId;
  swapped.splits.pilot[0] = devTaskId;
  swapped.tasks.find((task: { id: string }) => task.id === devTaskId).split = "pilot";
  swapped.tasks.find((task: { id: string }) => task.id === pilotTaskId).split = "dev";
  const { inventoryHash: _swappedHash, ...swappedContents } = swapped;
  swapped.inventoryHash = computeH6InventoryHash(swappedContents);

  const swappedReport = await validateH6Dataset(swapped);
  assert.equal(swappedReport.valid, false);
  assert.ok(swappedReport.issues.some((issue) => issue.code === "FROZEN_SPLIT_MISMATCH"));
  assert.ok(swappedReport.issues.some((issue) => issue.code === "NON_FROZEN_INVENTORY"));
  assert.ok(
    !swappedReport.issues.some((issue) => issue.code === "TASK_SPLIT_MEMBERSHIP_MISMATCH"),
  );

  const mismatchedTask = JSON.parse(JSON.stringify(dataset));
  mismatchedTask.tasks[0].split = "pilot";
  const { inventoryHash: _taskHash, ...taskContents } = mismatchedTask;
  mismatchedTask.inventoryHash = computeH6InventoryHash(taskContents);
  const taskReport = await validateH6Dataset(mismatchedTask);
  assert.ok(
    taskReport.issues.some((issue) => issue.code === "TASK_SPLIT_MEMBERSHIP_MISMATCH"),
  );
});

test("valid but regenerated inventories are rejected as non-frozen", async () => {
  const regenerated = await generateH6BenchmarkDataset(82);
  const report = await validateH6Dataset(regenerated);
  assert.equal(report.valid, false);
  assert.ok(report.issues.some((issue) => issue.code === "NON_FROZEN_INVENTORY"));
});

test("support artifact hashes are independently verified", async () => {
  const dataset = await loadCommittedH6BenchmarkDataset();
  const corrupted = JSON.parse(JSON.stringify(dataset));
  corrupted.supportArtifactHashes["decision-rule.json"] = "0".repeat(64);
  const { inventoryHash: _oldHash, ...hashableDataset } = corrupted;
  corrupted.inventoryHash = computeH6InventoryHash(hashableDataset);

  const report = await validateH6Dataset(corrupted);

  assert.equal(report.valid, false);
  assert.ok(
    report.issues.some(
      (issue) => issue.code === "SUPPORT_ARTIFACT_HASH_MISMATCH",
    ),
  );
  assert.ok(
    !report.issues.some((issue) => issue.code === "INVENTORY_HASH_MISMATCH"),
  );
});

test("corrupted patch paths are rejected", async () => {
  const dataset = await loadCommittedH6BenchmarkDataset();
  const corrupted = JSON.parse(JSON.stringify(dataset));
  corrupted.tasks[0].variants[0].goodStrategyPatch.files[0].path =
    "../outside.mjs";

  const report = await validateH6Dataset(corrupted);

  assert.equal(report.valid, false);
  assert.ok(report.issues.some((issue) => issue.code === "PATH_CONTAINMENT_FAIL"));
});

test("network use and counterfactual import lint check", async () => {
  const dataset = await loadCommittedH6BenchmarkDataset();
  const corrupted = JSON.parse(JSON.stringify(dataset));

  corrupted.tasks[0].variants[0].files[0].content += '\nconst res = fetch("https://api.example.com");';

  const report = await validateH6Dataset(corrupted);
  assert.equal(report.valid, false);
  assert.ok(report.issues.some((i) => i.code === "NETWORK_LINT_FAIL"));
});

test("path containment check detects illegal traversal", async () => {
  const dataset = await loadCommittedH6BenchmarkDataset();
  const corrupted = JSON.parse(JSON.stringify(dataset));

  corrupted.tasks[0].variants[0].files.push({
    path: "../outside.ts",
    content: "export const bad = true;",
  });

  const report = await validateH6Dataset(corrupted);
  assert.equal(report.valid, false);
  assert.ok(report.issues.some((i) => i.code === "PATH_CONTAINMENT_FAIL"));
});

test("validator rejects unresolved generated utility imports", async () => {
  const dataset = await loadCommittedH6BenchmarkDataset();
  const corrupted = JSON.parse(JSON.stringify(dataset));
  const helper = corrupted.tasks[0].variants[0].files.find(
    (file: { path: string }) => file.path === "src/helper.ts",
  );
  assert.ok(helper);
  helper.content = helper.content.replace(
    "generateTraceId_quillboard_inventory_sync",
    "missingUtility_quillboard_inventory_sync",
  );

  const report = await validateH6Dataset(corrupted);

  assert.equal(report.valid, false);
  assert.ok(report.issues.some((issue) => issue.code === "UNRESOLVED_LOCAL_IMPORT"));
});
