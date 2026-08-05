import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test } from "node:test";
import { compareCodePoints } from "../../codepoint-order.js";
import { runOfflineCheck } from "../repeated-failure-suite-shared.js";
import type { H6TrapId, StrategyPatch, SyntheticFile } from "./types.js";
import { regenerateH6Fixtures } from "../../../fixtures/h6-failure-gate/generator/regenerate.js";
import { H6BenchmarkDatasetSchema, H6_TRAP_IDS } from "./types.js";
import {
  H6_TASK_JSON_SCHEMA,
  loadCommittedH6BenchmarkDataset,
  resolveCommittedH6FixtureDirectory,
  evaluateTaskState,
  computeH6InventoryHash,
  generateH6BenchmarkDataset,
  materializeTaskRepo,
  validateH6Dataset,
  validateH6FixtureBundle,
  validateH6StateDefiningIndependence,
  calculateJaccardSimilarity,
  tokenizeContent,
  writeH6FixtureBundle,
  unresolvedHelperImports,
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
        /return (?:validateRecord|inspect)\(record\);/,
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
  for (const entry of entries.sort((a, b) => compareCodePoints(a.name, b.name))) {
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

test("regeneration rejects symlinked roots and owned components", async () => {
  const container = await mkdtemp(join(tmpdir(), "h6-regeneration-symlink-"));
  const outside = await mkdtemp(join(tmpdir(), "h6-regeneration-outside-"));
  const linkedRoot = join(container, "linked-root");
  const componentRoot = join(container, "component-root");
  const dataset = await loadCommittedH6BenchmarkDataset();

  try {
    await symlink(outside, linkedRoot, "dir");
    await assert.rejects(writeH6FixtureBundle(linkedRoot, dataset), /symlink/i);

    await mkdir(componentRoot);
    await symlink(outside, join(componentRoot, "schema"), "dir");
    await assert.rejects(writeH6FixtureBundle(componentRoot, dataset), /symlink/i);
  } finally {
    await rm(container, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("regeneration removes stale files from every owned output subtree", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "h6-regeneration-stale-"));
  const dataset = await loadCommittedH6BenchmarkDataset();

  try {
    await writeH6FixtureBundle(tempDir, dataset);
    const expected = await generatedTreeInventory(tempDir);
    await writeFile(join(tempDir, "stale-output.json"), "{}\n", "utf8");
    await writeFile(join(tempDir, "arms", "stale.json"), "{}\n", "utf8");
    await writeFile(join(tempDir, "schema", "stale.json"), "{}\n", "utf8");
    await mkdir(join(tempDir, "tasks", "stale-task"), { recursive: true });
    await writeFile(join(tempDir, "tasks", "stale-task", "task.json"), "{}\n", "utf8");

    await writeH6FixtureBundle(tempDir, dataset);

    assert.deepEqual(await generatedTreeInventory(tempDir), expected);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("generated action intent names every file changed by the failed strategy", async () => {
  const dataset = await generateH6BenchmarkDataset(81);

  for (const task of dataset.tasks) {
    for (const variant of task.variants) {
      assert.deepEqual(
        [...new Set(variant.badStrategyPatch.files.map((file) => file.path))],
        [task.normalizedActionIntent.filePath],
        task.id,
      );
    }
  }
});

test("generated strategy descriptions are opaque neutral labels", async () => {
  const dataset = await generateH6BenchmarkDataset(81);

  for (const task of dataset.tasks) {
    for (const variant of task.variants) {
      assert.deepEqual(
        variant.strategyCandidates.map(({ id, description }) => ({ id, description })),
        [
          { id: "candidate-alpha", description: "Candidate alpha." },
          { id: "candidate-beta", description: "Candidate beta." },
        ],
        variant.variantId,
      );
      assert.ok(
        variant.strategyCandidates.every((candidate) => !Object.hasOwn(candidate, "isGood")),
        variant.variantId,
      );
    }
  }
});

test("strategy patch schema omits model-visible correctness labels", () => {
  assert.deepEqual(
    H6_TASK_JSON_SCHEMA.definitions.strategyPatch.required,
    ["id", "description", "files"],
  );
  assert.equal(
    Object.hasOwn(H6_TASK_JSON_SCHEMA.definitions.strategyPatch.properties, "isGood"),
    false,
  );
});

test("validator rejects action intent that names a file absent from the failed strategy", async () => {
  const dataset = await generateH6BenchmarkDataset(81);
  dataset.tasks[0].normalizedActionIntent.filePath = "src/not-in-candidate.ts";

  const report = await validateH6Dataset(dataset);

  assert.ok(
    report.issues.some((issue) => issue.code === "ACTION_INTENT_PATCH_MISMATCH"),
  );
});

test("validator rejects a candidate patch that leaves its variant byte-identical", async () => {
  const dataset = await generateH6BenchmarkDataset(81);
  const variant = dataset.tasks[0].variants[0];
  const candidateFile = variant.badStrategyPatch.files[0];
  const baseFile = variant.files.find((file) => file.path === candidateFile.path);
  assert.ok(baseFile);
  candidateFile.content = baseFile.content;

  const report = await validateH6Dataset(dataset);

  assert.ok(
    report.issues.some((issue) => issue.code === "CANDIDATE_PATCH_NO_OP"),
  );
});


test("full dataset validation & split balance", async () => {
  const dataset = await loadCommittedH6BenchmarkDataset();
  const report = await validateH6Dataset(dataset);

  assert.equal(report.valid, true, `Validation failed with issues: ${JSON.stringify(report.issues)}`);
  assert.equal(report.issues.length, 0);
  assert.equal(report.metrics.totalTasks, 30);
  assert.equal(report.metrics.totalVariants, 90);
  assert.equal(report.metrics.devTaskCount, 0);
  assert.equal(report.metrics.pilotTaskCount, 12);
  assert.equal(report.metrics.mainTaskCount, 18);
  assert.ok(report.metrics.maxPairwiseSimilarity <= 0.40);
  assert.ok(report.metrics.maxStateDefiningSimilarity <= 0.40);
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

test("validator rejects duplicated state-defining files within a trap class", async () => {
  const dataset = structuredClone(await loadCommittedH6BenchmarkDataset());
  const [source, duplicate] = dataset.tasks.filter(
    (task) => task.trapId === dataset.tasks[0].trapId,
  );
  assert.ok(source);
  assert.ok(duplicate);
  for (const filePath of [source.fingerprint.file, "test/check.js"]) {
    const sourceFile = source.variants[0].files.find((file) => file.path === filePath);
    const duplicateFile = duplicate.variants[0].files.find((file) => file.path === filePath);
    assert.ok(sourceFile);
    assert.ok(duplicateFile);
    duplicateFile.content = sourceFile.content;
  }

  const report = await validateH6Dataset(dataset);
  assert.ok(
    report.issues.some((issue) => issue.code === "STATE_DEFINING_SIMILARITY_EXCEEDED"),
  );
});

test("state-defining gate uses normalized unigram Jaccard instead of trigram order", async () => {
  const dataset = await generateH6BenchmarkDataset(81);
  const tasks = structuredClone(
    dataset.tasks.filter((task) => task.trapId === dataset.tasks[0].trapId).slice(0, 2),
  );
  const setStateContents = (contents: readonly [string, string]) => {
    for (const [index, task] of tasks.entries()) {
      for (const filePath of [task.fingerprint.file, "test/check.js"]) {
        const file = task.variants[0].files.find((candidate) => candidate.path === filePath);
        assert.ok(file);
        file.content = contents[index];
      }
    }
  };
  setStateContents([
    "alpha beta gamma",
    "alpha beta delta epsilon",
  ]);
  const boundary = validateH6StateDefiningIndependence({ ...dataset, tasks });
  assert.equal(boundary.maxSimilarity, 0.40);
  assert.equal(boundary.issues.length, 0);

  setStateContents([
    "alpha beta gamma delta epsilon",
    "alpha gamma epsilon beta delta",
  ]);
  const report = validateH6StateDefiningIndependence({ ...dataset, tasks });

  assert.equal(report.maxSimilarity, 1);
  assert.deepEqual(
    report.issues.map((issue) => issue.path),
    [tasks[0].fingerprint.file, "test/check.js"],
  );
});

test("generated state-defining source and check files satisfy the registered threshold", async () => {
  const dataset = await generateH6BenchmarkDataset(81);
  const report = validateH6StateDefiningIndependence(dataset);

  assert.equal(report.issues.length, 0);
  assert.ok(report.maxSimilarity > 0);
  assert.ok(report.maxSimilarity <= 0.40);
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
      (candidate) => candidate.id === task.variants[0].goodStrategyPatch.id,
    );
    assert.ok(position === 0 || position === 1, task.id);
    successfulPositions[position] += 1;
    assert.equal(task.fingerprint.strategyId, task.variants[0].badStrategyPatch.id);
    assert.notEqual(task.fingerprint.strategyId, task.variants[0].goodStrategyPatch.id);
    assert.ok(
      task.variants[0].strategyCandidates.every(
        (candidate) => !Object.hasOwn(candidate, "isGood"),
      ),
      task.id,
    );
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
  const dataset = await generateH6BenchmarkDataset(81);
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

test("offline checker strips inherited secrets and denies host filesystem, processes, and network", async () => {
  const dataset = await loadCommittedH6BenchmarkDataset();
  const task = dataset.tasks[0];
  const variant = task.variants[0];
  const sandboxCheck = `
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
const failures = [];
if (process.env.H6_SANDBOX_SECRET) failures.push("environment");
try { readFileSync("/etc/passwd", "utf8"); failures.push("filesystem"); } catch (error) {
  if (error.code !== "ERR_ACCESS_DENIED") failures.push("filesystem-code");
}
try { spawnSync(process.execPath, ["--version"]); failures.push("process"); } catch (error) {
  if (error.code !== "ERR_ACCESS_DENIED") failures.push("process-code");
}
try {
  await fetch("http://1.1.1.1", { signal: AbortSignal.timeout(1000) });
  failures.push("network");
} catch (error) {
  if (error.cause?.code !== "ENETUNREACH") failures.push("network-code");
}
process.exit(failures.length === 0 ? 0 : 1);
`;
  const files = variant.files.map((file) =>
    file.path === "test/check.js" ? { ...file, content: sandboxCheck } : file
  );
  const previous = process.env.H6_SANDBOX_SECRET;
  process.env.H6_SANDBOX_SECRET = "must-not-cross";
  const repo = await materializeTaskRepo(files);
  try {
    const result = await runOfflineCheck(repo.dir, task);
    assert.equal(result.state, "FIXED");
    assert.equal(result.exitCode, 0);
  } finally {
    if (previous === undefined) delete process.env.H6_SANDBOX_SECRET;
    else process.env.H6_SANDBOX_SECRET = previous;
    await repo.cleanup();
  }
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
  // dev is empty in the frozen 0/12/18 layout, so corrupt pilot to actually
  // produce a duplicate membership.
  corrupted.splits.pilot[0] = corrupted.splits.pilot[1];

  const report = await validateH6Dataset(corrupted);

  assert.equal(report.valid, false);
  assert.ok(report.issues.some((issue) => issue.code === "UNBALANCED_SPLITS"));
  assert.ok(report.issues.some((issue) => issue.code === "INVENTORY_HASH_MISMATCH"));
});

test("balanced split swaps and task split drift fail the frozen membership contract", async () => {
  const dataset = await loadCommittedH6BenchmarkDataset();
  const swapped = JSON.parse(JSON.stringify(dataset));
  // Swap across the two populated splits: dev is empty under 0/12/18.
  const pilotTaskId = swapped.splits.pilot[0];
  const mainTaskId = swapped.splits.main[0];
  swapped.splits.pilot[0] = mainTaskId;
  swapped.splits.main[0] = pilotTaskId;
  swapped.tasks.find((task: { id: string }) => task.id === pilotTaskId).split = "main";
  swapped.tasks.find((task: { id: string }) => task.id === mainTaskId).split = "pilot";
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
  // tasks[0] is a pilot member under 0/12/18, so claim "main" to create real
  // drift between the task record and its frozen split membership.
  mismatchedTask.tasks[0].split = "main";
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
  corrupted.supportArtifactHashes["arms/arms.json"] = "0".repeat(64);
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

test("fixture validation never reads bundle artifacts for an invalid dataset", async () => {
  const directory = await mkdtemp(join(tmpdir(), "h6-invalid-fixture-"));
  const dataset = await loadCommittedH6BenchmarkDataset();
  const corrupted = JSON.parse(JSON.stringify(dataset));
  corrupted.tasks[0].canonicalBaseFiles[0].path = "../../../../outside.ts";
  await writeFile(join(directory, "dataset.json"), JSON.stringify(corrupted), "utf8");

  try {
    const report = await validateH6FixtureBundle(directory);
    assert.equal(report.valid, false);
    assert.ok(report.issues.some((issue) => issue.code === "PATH_CONTAINMENT_FAIL"));
    assert.ok(!report.issues.some((issue) => issue.code === "FIXTURE_BUNDLE_MISMATCH"));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
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
test("validator keeps unresolved helper results stable for adversarial import text", async () => {
  const dataset = await loadCommittedH6BenchmarkDataset();
  const unresolvedNames = (
    prefix: string,
    transform: (content: string) => string,
  ): string[] => {
    const task = dataset.tasks[0];
    const variant = task?.variants[0];
    assert.ok(variant);
    const files = structuredClone(variant.files);
    const helper = files.find((file) => file.path === "src/helper.ts");
    assert.ok(helper);
    helper.content = prefix + transform(helper.content);
    return unresolvedHelperImports(files);
  };

  const malformedPrefix = [
    "import{{|".repeat(10_000),
    "} from './other.js'\n",
  ].join("");
  const malformedNames = unresolvedNames(malformedPrefix, (content) => content);
  const aliasNames = unresolvedNames("", (content) => content.replace(
    "formatDomainName_quillboard_inventory_sync",
    `formatDomainName_quillboard_inventory_sync${" ".repeat(10_000)}as alias_quillboard_inventory_sync`,
  ));
  const noAliasNames = unresolvedNames("", (content) => content.replace(
    "formatDomainName_quillboard_inventory_sync",
    `formatDomainName_quillboard_inventory_sync${" ".repeat(10_000)}generateTraceId_quillboard_inventory_sync`,
  ));

  assert.deepEqual(malformedNames, []);
  assert.deepEqual(aliasNames, []);
  assert.equal(noAliasNames.length, 1);
  assert.match(noAliasNames[0] ?? "", /formatDomainName_quillboard_inventory_sync/);
});
