import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { ENTITY_CANONICAL_ID_MIGRATION_FILE } from "./entity-canonical-id-references.js";

function findRepoRoot(startDir: string): string {
  let dir = startDir;
  for (;;) {
    if (existsSync(path.join(dir, "packages", "remnic-core", "package.json"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) {
      throw new Error(`remnic repo root not found from ${startDir}`);
    }
    dir = parent;
  }
}

const REPO_ROOT = findRepoRoot(path.dirname(fileURLToPath(import.meta.url)));
const CACHE_MODULE = path.join(
  REPO_ROOT,
  "packages",
  "remnic-core",
  "src",
  "storage",
  "entity-migration-completion-cache.ts",
);

type ProbeResult = {
  completed: boolean | null;
  err: string | null;
  externalCount: number;
  seen: Array<{ raw: string; real: string }>;
  canaryReal: string;
};

test("isCompleted must not readdir through a symlinked entities root", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "remnic-entities-root-nofollow-"));
  const memoryDir = path.join(root, "memory");
  const canaryDir = path.join(root, "canary-external");
  const entitiesDir = path.join(memoryDir, "entities");
  const stateDir = path.join(memoryDir, "state");
  const probeFile = path.join(root, "completion-cache-nofollow.probe.mts");
  const resultFile = path.join(root, "probe-result.json");

  try {
    await mkdir(stateDir, { recursive: true });
    await mkdir(path.join(memoryDir, "config"), { recursive: true });
    await mkdir(canaryDir, { recursive: true });
    await writeFile(path.join(canaryDir, "outside-only.md"), "canary external entity body\n");

    await symlink(canaryDir, entitiesDir);
    assert.equal(
      (await lstat(entitiesDir)).isSymbolicLink(),
      true,
      "fixture: entities/ must be a symlink to the external canary directory",
    );
    const canaryReal = await realpath(canaryDir);

    await writeFile(
      path.join(stateDir, ENTITY_CANONICAL_ID_MIGRATION_FILE),
      JSON.stringify({
        version: 1,
        complete: true,
        mappings: {},
        completionFingerprint: "planted-complete-journal-for-symlink-root-regression",
      }),
    );

    await writeFile(
      probeFile,
      `import { mock } from "node:test";
import path from "node:path";
import { writeFile } from "node:fs/promises";
import { readdir as realReaddir, realpath } from "node:fs/promises";

const canaryReal = ${JSON.stringify(canaryReal)};
const memoryDir = ${JSON.stringify(memoryDir)};
const entitiesDir = ${JSON.stringify(entitiesDir)};
const cacheModule = ${JSON.stringify(CACHE_MODULE)};
const resultFile = ${JSON.stringify(resultFile)};
const seen = [];

const fsp = await import("node:fs/promises");
mock.module("node:fs/promises", {
  namedExports: {
    ...fsp,
    readdir: async (p, ...a) => {
      const raw = path.resolve(String(p));
      let real = raw;
      try { real = await realpath(raw); } catch { /* keep raw */ }
      seen.push({ raw, real });
      return realReaddir(p, ...a);
    },
  },
});

// Dynamic import: mock.module must wrap fs.promises before the cache loads it.
const { EntityMigrationCompletionCache } = await import(cacheModule);
const cache = new EntityMigrationCompletionCache();
let completed = null;
let err = null;
try {
  completed = await cache.isCompleted({
    baseDir: memoryDir,
    entitiesDir,
    getEntityMutationVersion: () => 0,
  });
} catch (e) {
  err = e && typeof e === "object" && "code" in e ? String(e.code) : String(e);
}
const entitiesResolved = path.resolve(entitiesDir);
const external = seen.filter((s) => s.real === canaryReal || s.raw === entitiesResolved);
const payload = {
  completed,
  err,
  seen,
  externalCount: external.length,
  canaryReal,
};
await writeFile(resultFile, JSON.stringify(payload), "utf8");
console.log(JSON.stringify(payload));
mock.reset();
`,
    );

    const probe = spawnSync(
      process.execPath,
      [
        "--experimental-test-module-mocks",
        "--import",
        "tsx",
        "--conditions=remnic-source",
        probeFile,
      ],
      {
        encoding: "utf8",
        cwd: REPO_ROOT,
        env: {
          ...process.env,
          NODE_PATH: path.join(REPO_ROOT, "node_modules"),
        },
        timeout: 60_000,
      },
    );

    if (probe.error) {
      assert.fail(`probe failed to start: ${probe.error.message}`);
    }

    let result: ProbeResult;
    try {
      // SAFETY: the child probe in this file writes `resultFile` as a ProbeResult before exiting.
      result = JSON.parse(await readFile(resultFile, "utf8")) as ProbeResult;
    } catch {
      assert.fail(
        [
          "probe did not write result file",
          `status=${String(probe.status)} signal=${String(probe.signal)}`,
          `stdout:\n${probe.stdout ?? ""}`,
          `stderr:\n${probe.stderr ?? ""}`,
        ].join("\n"),
      );
      return;
    }

    assert.equal(
      result.externalCount,
      0,
      [
        "isCompleted must not readdir a symlinked entities root (external canary).",
        `externalCount=${result.externalCount} canaryReal=${result.canaryReal}`,
        `seen=${JSON.stringify(result.seen)}`,
        result.err ? `isCompleted err=${result.err}` : `completed=${String(result.completed)}`,
      ].join(" "),
    );
    assert.equal(result.err, null, "untrusted root must fail closed without throwing through external IO");
    assert.equal(result.completed, false, "untrusted entities root must not report migration complete");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
