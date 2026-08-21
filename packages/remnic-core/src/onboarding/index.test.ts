import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { onboard } from "./index.js";

test("onboard normalizes trailing separators before root-level shape detection", async () => {
  const projectDir = await mkdtemp(path.join(os.tmpdir(), "remnic-onboard-library-"));
  try {
    await writeFile(
      path.join(projectDir, "package.json"),
      JSON.stringify({ name: "library", exports: "./index.js" }),
      "utf8",
    );
    await writeFile(path.join(projectDir, "README.md"), "# Library\n", "utf8");

    const result = onboard({ directory: `${projectDir}${path.sep}` });

    assert.equal(result.directory, projectDir);
    assert.equal(result.shape, "library");
    assert.deepEqual(result.shapeEvidence, ["package.json has exports/main"]);
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
});

test("onboard resolves relative directory input before returning docs", async () => {
  const projectDir = await mkdtemp(path.join(os.tmpdir(), "remnic-onboard-relative-"));
  try {
    await writeFile(path.join(projectDir, "README.md"), "# Relative\n", "utf8");
    const relativeDir = path.relative(process.cwd(), projectDir);

    const result = onboard({ directory: relativeDir });

    assert.equal(result.directory, path.resolve(relativeDir));
    assert.equal(result.docs.length, 1);
    assert.equal(path.isAbsolute(result.docs[0]!.path), true);
    assert.equal(result.docs[0]!.path, path.join(projectDir, "README.md"));
    assert.equal(result.docs[0]!.relativePath, "README.md");
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
});

test("onboard does not treat package.json alone as TypeScript or JavaScript", async () => {
  const projectDir = await mkdtemp(path.join(os.tmpdir(), "remnic-onboard-package-only-"));
  try {
    await writeFile(path.join(projectDir, "package.json"), JSON.stringify({ name: "pkg" }), "utf8");

    const result = onboard({ directory: projectDir });

    assert.deepEqual(result.languages.map((entry) => entry.language), []);
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
});

test("onboard detects JavaScript from source files without adding TypeScript from package.json", async () => {
  const projectDir = await mkdtemp(path.join(os.tmpdir(), "remnic-onboard-js-"));
  try {
    await writeFile(path.join(projectDir, "package.json"), JSON.stringify({ name: "pkg" }), "utf8");
    await writeFile(path.join(projectDir, "index.js"), "export const value = 1;\n", "utf8");

    const result = onboard({ directory: projectDir });

    assert.deepEqual(result.languages.map((entry) => entry.language), ["JavaScript"]);
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
});

test("onboard detects TypeScript from TypeScript-specific evidence", async () => {
  const projectDir = await mkdtemp(path.join(os.tmpdir(), "remnic-onboard-ts-"));
  try {
    await writeFile(path.join(projectDir, "package.json"), JSON.stringify({ name: "pkg" }), "utf8");
    await writeFile(path.join(projectDir, "index.ts"), "export const value: number = 1;\n", "utf8");

    const result = onboard({ directory: projectDir });

    assert.deepEqual(result.languages.map((entry) => entry.language), ["TypeScript"]);
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
});

test("onboard rejects missing and file-backed scan roots", async () => {
  const projectDir = await mkdtemp(path.join(os.tmpdir(), "remnic-onboard-invalid-root-"));
  try {
    assert.throws(
      () => onboard({ directory: path.join(projectDir, "missing") }),
      /Cannot scan onboarding directory/,
    );

    const filePath = path.join(projectDir, "README.md");
    await writeFile(filePath, "# Not a directory\n", "utf8");
    assert.throws(
      () => onboard({ directory: filePath }),
      /not a directory/,
    );
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
});
