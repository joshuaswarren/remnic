import assert from "node:assert/strict";
import { lstat, mkdir, mkdtemp, readFile, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  main,
  parseArgs,
  preparePrivateOutput,
  resolveDirectoryFdRoot,
  writePrivateOutput,
} from "./capture-locomo-retrieval-trace.js";

async function makeDataset(root: string): Promise<string> {
  const datasetDir = path.join(root, "dataset");
  await mkdir(datasetDir);
  await writeFile(
    path.join(datasetDir, "locomo10.json"),
    JSON.stringify([
      {
        sample_id: "safe-conversation",
        conversation: {
          speaker_a: "Maya",
          session_1: [{ speaker: "Maya", dia_id: "D1:1", text: "Maya moved to Seattle." }],
        },
        qa: [{ question: "Where did Maya move?", answer: "Seattle", evidence: ["D1:1"], category: 1 }],
      },
    ])
  );
  return datasetDir;
}

test("directory-fd anchoring selects supported platform paths and fails closed otherwise", () => {
  assert.equal(resolveDirectoryFdRoot("linux"), "/proc/self/fd");
  assert.equal(resolveDirectoryFdRoot("darwin"), "/dev/fd");
  assert.throws(() => resolveDirectoryFdRoot("win32"), /unsupported on platform/);
});

test("CLI path flags expand bare and slash-prefixed home tildes without expanding named users", async () => {
  const bareHome = parseArgs([
    "--dataset-dir",
    "~",
    "--runtime-profile",
    "baseline",
    "--remnic-config",
    "~",
    "--out",
    "~",
    "--task-ids-file",
    "~",
  ]);
  assert.equal(bareHome.datasetDir, os.homedir());
  assert.equal(bareHome.remnicConfigPath, os.homedir());
  assert.equal(bareHome.out, os.homedir());
  assert.equal(bareHome.taskIdsFile, os.homedir());

  const expanded = parseArgs([
    "--dataset-dir",
    "~/datasets/locomo",
    "--runtime-profile",
    "baseline",
    "--remnic-config",
    "~/configs/remnic.json",
    "--out",
    "~/receipts/trace.json",
    "--task-ids-file",
    "~/selectors/task-ids.json",
  ]);
  assert.equal(expanded.datasetDir, path.join(os.homedir(), "datasets/locomo"));
  assert.equal(expanded.remnicConfigPath, path.join(os.homedir(), "configs/remnic.json"));
  assert.equal(expanded.out, path.join(os.homedir(), "receipts/trace.json"));
  assert.equal(expanded.taskIdsFile, path.join(os.homedir(), "selectors/task-ids.json"));

  const namedUser = parseArgs([
    "--dataset-dir",
    "~other/datasets/locomo",
    "--runtime-profile",
    "baseline",
    "--remnic-config",
    "~other/configs/remnic.json",
    "--out",
    "~other/receipts/trace.json",
    "--task-ids-file",
    "~other/selectors/task-ids.json",
  ]);
  assert.equal(namedUser.datasetDir, "~other/datasets/locomo");
  assert.equal(namedUser.remnicConfigPath, "~other/configs/remnic.json");
  assert.equal(namedUser.out, "~other/receipts/trace.json");
  assert.equal(namedUser.taskIdsFile, "~other/selectors/task-ids.json");
  await assert.rejects(preparePrivateOutput(namedUser.out), /must be located under the private root/);
});

test("pre-capture proof exercises child traversal and fails closed when traversal is unavailable", async () => {
  let successfulProbe: string | undefined;
  const context = await preparePrivateOutput(undefined, {
    onChildTraversalProbe(pathname) {
      successfulProbe = pathname;
    },
  });
  assert.ok(successfulProbe?.startsWith(`${context.directoryFdRoot}/`));

  let unsupportedProbeRan = false;
  await assert.rejects(
    preparePrivateOutput(undefined, {
      buildAnchoredChildPath(_root, _fd, basename) {
        return path.join(os.tmpdir(), "unsupported-directory-fd-traversal", basename);
      },
      onChildTraversalProbe() {
        unsupportedProbeRan = true;
      },
    }),
    /ENOENT/
  );
  assert.equal(unsupportedProbeRan, false);
});

test("capture CLI restricts output to the canonical private root", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "remnic-locomo-output-policy-"));
  try {
    const datasetDir = await makeDataset(root);
    await assert.rejects(
      main([
        "--dataset-dir",
        datasetDir,
        "--runtime-profile",
        "baseline",
        "--task-id",
        "safe-conversation-q0-single_hop",
        "--out",
        path.join(root, "receipt.json"),
      ]),
      /must be located under the private root/
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("capture CLI rejects a symlinked output parent beneath the private root before adapter creation", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "remnic-locomo-output-symlink-"));
  const context = await preparePrivateOutput();
  const testRoot = path.join(context.privateRoot, `symlink-test-${process.pid}-${Date.now()}`);
  try {
    const datasetDir = await makeDataset(root);
    const actualOutputParent = path.join(root, "actual-output");
    const symlinkedOutputParent = path.join(testRoot, "linked-output");
    await mkdir(actualOutputParent);
    await mkdir(testRoot, { recursive: true, mode: 0o700 });
    try {
      await symlink(actualOutputParent, symlinkedOutputParent, "dir");
    } catch {
      t.skip("directory symlinks are unavailable on this platform");
      return;
    }

    await assert.rejects(
      main([
        "--dataset-dir",
        datasetDir,
        "--runtime-profile",
        "baseline",
        "--task-id",
        "safe-conversation-q0-single_hop",
        "--out",
        path.join(symlinkedOutputParent, "receipt.json"),
      ]),
      /symbolic-link component/
    );
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("anchored private writer succeeds with exclusive mode 0600", async () => {
  const context = await preparePrivateOutput();
  const testRoot = path.join(context.privateRoot, `writer-success-${process.pid}-${Date.now()}`);
  const outputPath = path.join(testRoot, "receipt.json");
  try {
    await mkdir(testRoot, { recursive: true, mode: 0o700 });
    await writePrivateOutput(outputPath, "safe receipt\n", context);
    assert.equal(await readFile(outputPath, "utf8"), "safe receipt\n");
    assert.equal((await stat(outputPath)).mode & 0o777, 0o600);
    await assert.rejects(writePrivateOutput(outputPath, "duplicate", context), /EEXIST/);
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("post-create failure removes only the created inode and permits a clean retry", async () => {
  const context = await preparePrivateOutput();
  const testRoot = path.join(context.privateRoot, `writer-retry-${process.pid}-${Date.now()}`);
  const outputPath = path.join(testRoot, "receipt.json");
  try {
    await mkdir(testRoot, { recursive: true, mode: 0o700 });
    await assert.rejects(
      writePrivateOutput(outputPath, "first attempt", context, {
        afterCreate() {
          throw new Error("injected post-create failure");
        },
      }),
      /injected post-create failure/
    );
    await assert.rejects(lstat(outputPath), { code: "ENOENT" });
    await writePrivateOutput(outputPath, "retry succeeded\n", context);
    assert.equal(await readFile(outputPath, "utf8"), "retry succeeded\n");
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("anchored cleanup survives parent rename and preserves the primary failure", async () => {
  const context = await preparePrivateOutput();
  const testRoot = path.join(context.privateRoot, `writer-rename-${process.pid}-${Date.now()}`);
  const movedRoot = `${testRoot}-moved`;
  const outputPath = path.join(testRoot, "receipt.json");
  const movedOutputPath = path.join(movedRoot, "receipt.json");
  try {
    await mkdir(testRoot, { recursive: true, mode: 0o700 });
    await assert.rejects(
      writePrivateOutput(outputPath, "first attempt", context, {
        async afterCreate() {
          await rename(testRoot, movedRoot);
          throw new Error("primary write failure");
        },
        async closeOutputHandle(close) {
          await close();
          throw new Error("secondary close failure");
        },
      }),
      /primary write failure/
    );
    await assert.rejects(lstat(movedOutputPath), { code: "ENOENT" });
    await rename(movedRoot, testRoot);
    await writePrivateOutput(outputPath, "retry succeeded\n", context);
    assert.equal(await readFile(outputPath, "utf8"), "retry succeeded\n");
  } finally {
    await rm(testRoot, { recursive: true, force: true });
    await rm(movedRoot, { recursive: true, force: true });
  }
});

test("close failure triggers anchored cleanup and permits retry", async () => {
  const context = await preparePrivateOutput();
  const testRoot = path.join(context.privateRoot, `writer-close-${process.pid}-${Date.now()}`);
  const outputPath = path.join(testRoot, "receipt.json");
  try {
    await mkdir(testRoot, { recursive: true, mode: 0o700 });
    await assert.rejects(
      writePrivateOutput(outputPath, "first attempt", context, {
        async closeOutputHandle(close) {
          await close();
          throw new Error("injected close failure");
        },
      }),
      /injected close failure/
    );
    await assert.rejects(lstat(outputPath), { code: "ENOENT" });
    await writePrivateOutput(outputPath, "retry succeeded\n", context);
    assert.equal(await readFile(outputPath, "utf8"), "retry succeeded\n");
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});
