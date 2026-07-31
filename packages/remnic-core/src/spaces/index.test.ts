import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs, { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import { withEntityCanonicalMutationLock } from "../storage/entity-canonical-id-lock.js";
import { createSpace, loadManifest, pushToSpace, type SpacePushResult } from "./index.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "../../../..");
const tsxCli = path.join(repoRoot, "node_modules", "tsx", "dist", "cli.mjs");
const spacesSourcePath = path.join(__dirname, "index.ts");

function unsetEnv(name: string): void {
  Reflect.deleteProperty(process.env, name);
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    unsetEnv(name);
  } else {
    process.env[name] = value;
  }
}

test("personal space bootstrap prefers REMNIC_MEMORY_DIR over legacy ENGRAM_MEMORY_DIR", async () => {
  const baseDir = await mkdtemp(path.join(os.tmpdir(), "remnic-spaces-current-"));
  const remnicMemoryDir = path.join(baseDir, "remnic-memory");
  const legacyMemoryDir = path.join(baseDir, "engram-memory");
  const previousRemnic = process.env.REMNIC_MEMORY_DIR;
  const previousEngram = process.env.ENGRAM_MEMORY_DIR;

  process.env.REMNIC_MEMORY_DIR = remnicMemoryDir;
  process.env.ENGRAM_MEMORY_DIR = legacyMemoryDir;
  try {
    const manifest = loadManifest(baseDir);
    assert.equal(manifest.spaces[0]?.memoryDir, remnicMemoryDir);
  } finally {
    restoreEnv("REMNIC_MEMORY_DIR", previousRemnic);
    restoreEnv("ENGRAM_MEMORY_DIR", previousEngram);
    await rm(baseDir, { recursive: true, force: true });
  }
});

test("personal space bootstrap keeps ENGRAM_MEMORY_DIR as a legacy fallback", async () => {
  const baseDir = await mkdtemp(path.join(os.tmpdir(), "remnic-spaces-legacy-"));
  const legacyMemoryDir = path.join(baseDir, "engram-memory");
  const previousRemnic = process.env.REMNIC_MEMORY_DIR;
  const previousEngram = process.env.ENGRAM_MEMORY_DIR;

  unsetEnv("REMNIC_MEMORY_DIR");
  process.env.ENGRAM_MEMORY_DIR = legacyMemoryDir;
  try {
    const manifest = loadManifest(baseDir);
    assert.equal(manifest.spaces[0]?.memoryDir, legacyMemoryDir);
  } finally {
    restoreEnv("REMNIC_MEMORY_DIR", previousRemnic);
    restoreEnv("ENGRAM_MEMORY_DIR", previousEngram);
    await rm(baseDir, { recursive: true, force: true });
  }
});

test("personal space bootstrap normalizes relative memoryDir env values", async () => {
  const baseDir = await mkdtemp(path.join(os.tmpdir(), "remnic-spaces-relative-env-"));
  const previousRemnic = process.env.REMNIC_MEMORY_DIR;

  process.env.REMNIC_MEMORY_DIR = "relative-personal-memory";
  try {
    const manifest = loadManifest(baseDir);
    assert.equal(manifest.spaces[0]?.memoryDir, path.resolve("relative-personal-memory"));
  } finally {
    restoreEnv("REMNIC_MEMORY_DIR", previousRemnic);
    await rm(baseDir, { recursive: true, force: true });
  }
});

test("createSpace normalizes caller-provided memoryDir before saving manifest", async () => {
  const baseDir = await mkdtemp(path.join(os.tmpdir(), "remnic-spaces-relative-create-"));
  const projectMemoryDir = path.resolve("relative-project-memory");
  const previousRemnic = process.env.REMNIC_MEMORY_DIR;
  const previousEngram = process.env.ENGRAM_MEMORY_DIR;

  unsetEnv("REMNIC_MEMORY_DIR");
  unsetEnv("ENGRAM_MEMORY_DIR");
  try {
    const created = createSpace({
      baseDir,
      name: "Project",
      kind: "project",
      memoryDir: "relative-project-memory",
    });
    assert.equal(created.memoryDir, projectMemoryDir);

    const manifest = loadManifest(baseDir);
    const saved = manifest.spaces.find((space) => space.id === "project");
    assert.equal(saved?.memoryDir, projectMemoryDir);
  } finally {
    restoreEnv("REMNIC_MEMORY_DIR", previousRemnic);
    restoreEnv("ENGRAM_MEMORY_DIR", previousEngram);
    await rm(baseDir, { recursive: true, force: true });
    await rm(projectMemoryDir, { recursive: true, force: true });
  }
});

test("concurrent createSpace calls preserve both manifest updates", async () => {
  const baseDir = await mkdtemp(path.join(os.tmpdir(), "remnic-spaces-concurrent-"));
  const childScript = path.join(baseDir, "create-space-child.mjs");
  const goPath = path.join(baseDir, "go");
  const manifestPath = path.join(baseDir, ".config", "engram", "spaces", "manifest.json");

  await writeFile(
    childScript,
    `
      import fs from "node:fs";
      import path from "node:path";
      import { pathToFileURL } from "node:url";

      const [baseDir, name, manifestPath, goPath, spacesSourcePath] = process.argv.slice(2);
      const readyPath = path.join(baseDir, \`\${name}.ready\`);
      const originalReadFileSync = fs.readFileSync.bind(fs);
      const sleepBuffer = new Int32Array(new SharedArrayBuffer(4));
      let paused = false;

      fs.readFileSync = function patchedReadFileSync(filePath, ...args) {
        const result = originalReadFileSync(filePath, ...args);
        if (!paused && path.resolve(String(filePath)) === manifestPath) {
          paused = true;
          fs.writeFileSync(readyPath, "ready\\n");
          const deadline = Date.now() + 10_000;
          while (!fs.existsSync(goPath)) {
            if (Date.now() > deadline) {
              throw new Error(\`Timed out waiting for manifest race release: \${goPath}\`);
            }
            Atomics.wait(sleepBuffer, 0, 0, 20);
          }
        }
        return result;
      };

      const { createSpace } = await import(pathToFileURL(spacesSourcePath).href);
      createSpace({ baseDir, name, kind: "project" });
    `,
    "utf8"
  );

  try {
    loadManifest(baseDir);

    const first = runSpaceChild(baseDir, "Alpha", manifestPath, goPath, childScript);
    const second = runSpaceChild(baseDir, "Beta", manifestPath, goPath, childScript);

    await waitForAnyFile([path.join(baseDir, "Alpha.ready"), path.join(baseDir, "Beta.ready")]);
    await sleep(300);
    await writeFile(goPath, "go\n", "utf8");
    await Promise.all([first, second]);

    const manifest = loadManifest(baseDir);
    const ids = manifest.spaces.map((space) => space.id).sort();
    assert.ok(ids.includes("alpha"), `expected alpha in ${ids.join(", ")}`);
    assert.ok(ids.includes("beta"), `expected beta in ${ids.join(", ")}`);
  } finally {
    await rm(baseDir, { recursive: true, force: true });
  }
});

test("createSpace reclaims stale manifest locks only after the owner exits", async () => {
  const baseDir = await mkdtemp(path.join(os.tmpdir(), "remnic-spaces-stale-lock-"));
  const manifestPath = path.join(baseDir, ".config", "engram", "spaces", "manifest.json");
  const lockDir = `${manifestPath}.lock`;
  const staleTime = new Date(Date.now() - 31_000);

  try {
    loadManifest(baseDir);
    await mkdir(lockDir);
    await writeFile(path.join(lockDir, "owner"), "999999:stale-owner\n", "utf8");
    await utimes(lockDir, staleTime, staleTime);

    createSpace({ baseDir, name: "Recovered", kind: "project" });

    const manifest = loadManifest(baseDir);
    assert.ok(manifest.spaces.some((space) => space.id === "recovered"));
    assert.equal(existsSync(lockDir), false);
    assert.equal(existsSync(`${lockDir}.reclaim`), false);
  } finally {
    await rm(baseDir, { recursive: true, force: true });
  }
});

test("createSpace reclaims stale manifest reclaim locks", async () => {
  const baseDir = await mkdtemp(path.join(os.tmpdir(), "remnic-spaces-stale-reclaim-lock-"));
  const manifestPath = path.join(baseDir, ".config", "engram", "spaces", "manifest.json");
  const lockDir = `${manifestPath}.lock`;
  const reclaimDir = `${lockDir}.reclaim`;
  const staleTime = new Date(Date.now() - 31_000);

  try {
    loadManifest(baseDir);
    await mkdir(reclaimDir);
    await utimes(reclaimDir, staleTime, staleTime);

    createSpace({ baseDir, name: "Recovered", kind: "project" });

    const manifest = loadManifest(baseDir);
    assert.ok(manifest.spaces.some((space) => space.id === "recovered"));
    assert.equal(existsSync(reclaimDir), false);
  } finally {
    await rm(baseDir, { recursive: true, force: true });
  }
});

test("loadManifest persists bootstrap when manifest disappears between existence check and read", async () => {
  const baseDir = await mkdtemp(path.join(os.tmpdir(), "remnic-spaces-vanishing-manifest-"));
  const manifestPath = path.join(baseDir, ".config", "engram", "spaces", "manifest.json");
  const originalExistsSync = fs.existsSync.bind(fs);
  let forceInitialExists = true;

  fs.existsSync = ((filePath) => {
    if (forceInitialExists && path.resolve(String(filePath)) === manifestPath) {
      forceInitialExists = false;
      return true;
    }
    return originalExistsSync(filePath);
  }) as typeof fs.existsSync;

  try {
    const manifest = loadManifest(baseDir);

    assert.equal(manifest.activeSpaceId, "personal");
    assert.equal(manifest.spaces[0]?.id, "personal");
    assert.equal(originalExistsSync(manifestPath), true);
  } finally {
    fs.existsSync = originalExistsSync;
    await rm(baseDir, { recursive: true, force: true });
  }
});

test("pushToSpace serializes entity-page batches with the target canonical mutation lock", async () => {
  const baseDir = await mkdtemp(path.join(os.tmpdir(), "remnic-spaces-entity-lock-"));
  const sourceDir = path.join(baseDir, "source");
  const targetDir = path.join(baseDir, "target");
  const entityRelativePath = path.join("entities", "serialized-project.md");
  const sourceEntityPath = path.join(sourceDir, entityRelativePath);
  const targetEntityPath = path.join(targetDir, entityRelativePath);
  const entityBytes = Buffer.from(
    "---\nid: serialized-project\n---\n\n# Serialized Project\n\n**Type:** project\n\nPush bytes.\n",
    "utf8",
  );
  const lockHeld = Promise.withResolvers<void>();
  const releaseLock = Promise.withResolvers<void>();
  let lockPromise: Promise<void> | undefined;
  let pushPromise: Promise<SpacePushResult> | undefined;

  try {
    const source = createSpace({ baseDir, name: "Source", kind: "project", memoryDir: sourceDir });
    const target = createSpace({ baseDir, name: "Target", kind: "project", memoryDir: targetDir });
    await mkdir(path.dirname(sourceEntityPath), { recursive: true });
    await mkdir(path.join(targetDir, "state"), { recursive: true });
    await writeFile(sourceEntityPath, entityBytes);

    lockPromise = withEntityCanonicalMutationLock(path.join(targetDir, "state"), async () => {
      lockHeld.resolve();
      await releaseLock.promise;
    });
    await lockHeld.promise;

    let pushFinished = false;
    pushPromise = pushToSpace(source.id, target.id, { baseDir });
    void pushPromise.then(
      () => {
        pushFinished = true;
      },
      () => {
        pushFinished = true;
      },
    );
    await new Promise<void>((resolve) => setImmediate(resolve));

    assert.equal(pushFinished, false, "the push must not finish while the target entity lock is held");
    assert.equal(existsSync(targetEntityPath), false, "the entity page must not land before lock release");

    releaseLock.resolve();
    await lockPromise;
    const result = await pushPromise;

    assert.equal(result.memoriesPushed, 1);
    assert.deepEqual(await readFile(targetEntityPath), entityBytes);
  } finally {
    releaseLock.resolve();
    await lockPromise?.catch(() => undefined);
    await pushPromise?.catch(() => undefined);
    await rm(baseDir, { recursive: true, force: true });
  }
});

async function runSpaceChild(
  baseDir: string,
  name: string,
  manifestPath: string,
  goPath: string,
  childScript: string
): Promise<void> {
  const child = spawn(process.execPath, [tsxCli, childScript, baseDir, name, manifestPath, goPath, spacesSourcePath], {
    cwd: repoRoot,
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });

  const code = await new Promise<number | null>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", resolve);
  });
  assert.equal(code, 0, `child ${name} failed\nstdout:\n${stdout}\nstderr:\n${stderr}`);
}

async function waitForAnyFile(filePaths: string[]): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!filePaths.some((filePath) => existsSync(filePath))) {
    if (Date.now() > deadline) {
      throw new Error(`Timed out waiting for one of: ${filePaths.join(", ")}`);
    }
    await sleep(20);
  }
}
