import assert from "node:assert/strict";
import test from "node:test";
import {
  changedWorkingTreeFiles,
  inferChangeset,
  inferTouchedPackages,
  renderNotes,
} from "../scripts/changeset-stub.mjs";

const packages = [
  { dir: "packages/remnic-core", name: "@remnic/core", kind: "npm", private: false },
  { dir: "packages/remnic-cli", name: "@remnic/cli", kind: "npm", private: false },
  { dir: "packages/plugin-openclaw", name: "@remnic/plugin-openclaw", kind: "npm", private: false },
  { dir: "packages/bench-ui", name: "@remnic/bench-ui", kind: "npm", private: true },
  { dir: "packages/plugin-hermes", name: "remnic-hermes", kind: "python", private: false },
];

test("changeset stub emits the touched published package", async () => {
  const result = await inferChangeset("/repo", {
    packages,
    changedFiles: ["packages/remnic-core/src/index.ts"],
  });

  assert.deepEqual(
    result.published.map((pkg) => pkg.name),
    ["@remnic/core"]
  );
  assert.match(result.markdown, /"@remnic\/core": patch/);
  assert.match(result.markdown, /TODO:/);
});

test("changeset stub lists every touched published package", () => {
  const result = inferTouchedPackages(
    ["packages/remnic-cli/src/cli.ts", "packages/remnic-core/src/index.ts"],
    packages
  );

  assert.deepEqual(
    result.published.map((pkg) => pkg.name),
    ["@remnic/cli", "@remnic/core"]
  );
});

test("Python-only changes emit no npm changeset and print the release metadata explanation", () => {
  const result = inferTouchedPackages(["packages/plugin-hermes/remnic_hermes/provider.py"], packages);

  assert.deepEqual(result.published, []);
  assert.deepEqual(
    result.python.map((pkg) => pkg.name),
    ["remnic-hermes"]
  );
  assert.match(renderNotes(result), /Python-published; no npm changeset emitted/);
  assert.match(renderNotes(result), /packages\/plugin-hermes\/pyproject\.toml/);
});

test("documentation-only changes emit nothing", async () => {
  const result = await inferChangeset("/repo", {
    packages,
    changedFiles: ["docs/plugins/hermes.md", "README.md"],
  });

  assert.equal(result.markdown, "");
  assert.deepEqual(result.published, []);
  assert.deepEqual(result.python, []);
});

test("package documentation-only changes emit nothing", () => {
  const result = inferTouchedPackages(["packages/remnic-core/README.md"], packages);

  assert.deepEqual(result.published, []);
  assert.deepEqual(result.python, []);
});
test("published skill markdown is treated as package code", () => {
  const result = inferTouchedPackages(["packages/plugin-openclaw/skills/recall/SKILL.md"], packages);

  assert.deepEqual(
    result.published.map((pkg) => pkg.name),
    ["@remnic/plugin-openclaw"]
  );
});

test("root OpenClaw compatibility sources map to the published plugin", () => {
  const result = inferTouchedPackages(["src/openclaw-entry.ts"], packages);

  assert.deepEqual(
    result.published.map((pkg) => pkg.name),
    ["@remnic/plugin-openclaw"]
  );
});

test("root documentation remains documentation-only", () => {
  const result = inferTouchedPackages(["src/AGENTS.md", "src/README.md", "CONTRIBUTING.md"], packages);

  assert.deepEqual(result.published, []);
  assert.deepEqual(result.python, []);
});

test("source markdown remains release-bearing unless it is a known doc file", () => {
  const result = inferTouchedPackages(["src/runtime-notes.md"], packages);

  assert.deepEqual(
    result.published.map((pkg) => pkg.name),
    ["@remnic/plugin-openclaw"]
  );
});
test("working-tree diff collection uses stubbed git output from the merge-base", () => {
  const calls = [];
  const git = (_repoRoot, args) => {
    calls.push(args);
    if (args[0] === "merge-base") return "base-sha";
    if (args[0] === "diff") return "packages/remnic-core/src/index.ts\0";
    if (args[0] === "ls-files") return "packages/remnic-cli/src/cli.ts\0";
    throw new Error(`unexpected git call: ${args.join(" ")}`);
  };

  assert.deepEqual(changedWorkingTreeFiles("/repo", { baseRef: "main", git }), [
    "packages/remnic-cli/src/cli.ts",
    "packages/remnic-core/src/index.ts",
  ]);
  assert.deepEqual(calls, [
    ["merge-base", "HEAD", "main"],
    ["diff", "--name-only", "--no-renames", "-z", "base-sha", "--"],
    ["ls-files", "--others", "--exclude-standard", "-z"],
  ]);
});

test("working-tree diff collection preserves both sides of a rename", () => {
  const git = (_repoRoot, args) => {
    if (args[0] === "merge-base") return "base-sha";
    if (args[0] === "diff") {
      return "packages/remnic-core/src/é.ts\0packages/remnic-cli/src/new.ts\0";
    }
    if (args[0] === "ls-files") return "";
    throw new Error(`unexpected git call: ${args.join(" ")}`);
  };

  assert.deepEqual(changedWorkingTreeFiles("/repo", { baseRef: "main", git }), [
    "packages/remnic-cli/src/new.ts",
    "packages/remnic-core/src/é.ts",
  ]);
});

test("working-tree diff collection rejects an unavailable merge-base", () => {
  const git = (_repoRoot, args) => {
    if (args[0] === "merge-base") return null;
    throw new Error(`unexpected git call: ${args.join(" ")}`);
  };

  assert.throws(
    () => changedWorkingTreeFiles("/repo", { baseRef: "main", git }),
    /Unable to resolve merge-base for main/
  );
});

test("private packages are skipped", () => {
  const result = inferTouchedPackages(["packages/bench-ui/src/main.ts"], packages);

  assert.deepEqual(result.published, []);
  assert.deepEqual(
    result.skipped.map((pkg) => pkg.name),
    ["@remnic/bench-ui"]
  );
});
