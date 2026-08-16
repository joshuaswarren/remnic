import assert from "node:assert/strict";
import test from "node:test";
import {
  changedWorkingTreeFiles,
  inferChangeset,
  inferTouchedPackages,
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

  assert.deepEqual(result.published.map((pkg) => pkg.name), ["@remnic/core"]);
  assert.match(result.markdown, /"@remnic\/core": patch/);
  assert.match(result.markdown, /TODO:/);
});

test("changeset stub lists every touched published package", () => {
  const result = inferTouchedPackages(
    ["packages/remnic-cli/src/cli.ts", "packages/remnic-core/src/index.ts"],
    packages,
  );

  assert.deepEqual(result.published.map((pkg) => pkg.name), ["@remnic/cli", "@remnic/core"]);
});

test("Python-only changes emit no npm changeset and retain an explanation target", () => {
  const result = inferTouchedPackages(["packages/plugin-hermes/remnic_hermes/provider.py"], packages);

  assert.deepEqual(result.published, []);
  assert.deepEqual(result.python.map((pkg) => pkg.name), ["remnic-hermes"]);
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

test("working-tree diff collection uses stubbed git output from the merge-base", () => {
  const calls = [];
  const git = (_repoRoot, args) => {
    calls.push(args);
    if (args[0] === "merge-base") return "base-sha";
    if (args[0] === "diff") return "packages/remnic-core/src/index.ts\n";
    if (args[0] === "ls-files") return "packages/remnic-cli/src/cli.ts\n";
    throw new Error(`unexpected git call: ${args.join(" ")}`);
  };

  assert.deepEqual(changedWorkingTreeFiles("/repo", { baseRef: "main", git }), [
    "packages/remnic-cli/src/cli.ts",
    "packages/remnic-core/src/index.ts",
  ]);
  assert.deepEqual(calls, [
    ["merge-base", "HEAD", "main"],
    ["diff", "--name-only", "base-sha", "--"],
    ["ls-files", "--others", "--exclude-standard"],
  ]);
});

test("private packages are skipped", () => {
  const result = inferTouchedPackages(["packages/bench-ui/src/main.ts"], packages);

  assert.deepEqual(result.published, []);
  assert.deepEqual(result.skipped.map((pkg) => pkg.name), ["@remnic/bench-ui"]);
});
