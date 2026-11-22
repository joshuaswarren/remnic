/**
 * Release-discipline gate tests (issue #3032).
 *
 * Each case builds a throwaway git repository in a temp dir with a base commit
 * and a head commit, then runs the real scripts/check-release-discipline.mjs
 * against it as a subprocess. Exercising the shipped entrypoint (not a
 * re-implementation) is what makes these tests discriminate: the git
 * collection, the rule evaluation, and the exit-code contract are all live.
 */

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  parseRegistry,
  parseStabilityDeclarations,
  extractDefaultOffGates,
} from "../scripts/check-release-discipline.mjs";

const REPO_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = path.join(REPO_ROOT, "scripts", "check-release-discipline.mjs");
const CONFIG_PATH = "packages/remnic-core/src/config.ts";
const REGISTRY_PATH = "scripts/flag-graduation.json";

const BASE_CONFIG = `import { coerceBool } from "./connectors/coerce.js";

export function parseConfig(raw: unknown): PluginConfig {
  const cfg = (raw ?? {}) as Record<string, unknown>;
  return {
    existingGate: coerceBool(cfg.existingGate) === true,
    maxThings: 5,
  };
}
`;

const BASE_REGISTRY = {
  version: 1,
  flags: [
    {
      flag: "existingGate",
      addedIn: "1.2.3",
      issue: 1234,
      graduationCriterion: "Bench suites green for 2 consecutive stable releases.",
    },
  ],
};

function git(cwd, args) {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

async function writeFileIn(root, relativePath, contents) {
  const target = path.join(root, relativePath);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, contents);
}

/**
 * A temp repo whose base commit holds one registered default-off gate.
 * `head` is a callback that mutates the tree for the head commit.
 */
async function fixture(head) {
  const root = await mkdtemp(path.join(os.tmpdir(), "remnic-release-discipline-"));
  git(root, ["init", "--quiet", "-b", "main"]);
  git(root, ["config", "user.email", "test@example.invalid"]);
  git(root, ["config", "user.name", "Release Discipline Test"]);
  git(root, ["config", "commit.gpgsign", "false"]);

  await writeFileIn(root, "packages/remnic-core/package.json", `${JSON.stringify({ name: "@remnic/core", version: "1.2.3" }, null, 2)}\n`);
  await writeFileIn(root, CONFIG_PATH, BASE_CONFIG);
  await writeFileIn(root, REGISTRY_PATH, `${JSON.stringify(BASE_REGISTRY, null, 2)}\n`);
  await writeFileIn(root, ".changeset/README.md", "Changesets live here.\n");
  git(root, ["add", "-A"]);
  git(root, ["commit", "--quiet", "--no-gpg-sign", "-m", "base"]);
  const baseSha = git(root, ["rev-parse", "HEAD"]).trim();

  await head({ root, write: (p, c) => writeFileIn(root, p, c), rm: (p) => rm(path.join(root, p)) });
  git(root, ["add", "-A"]);
  git(root, ["commit", "--quiet", "--no-gpg-sign", "-m", "head"]);

  return { root, baseSha };
}

function runGate({ root, baseSha }) {
  const result = spawnSync(process.execPath, [SCRIPT, "--repo-root", root, "--base", baseSha, "--head", "HEAD"], {
    encoding: "utf8",
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

async function withFixture(head, assertions) {
  const built = await fixture(head);
  try {
    assertions(runGate(built));
  } finally {
    await rm(built.root, { recursive: true, force: true });
  }
}

function changeset(body) {
  return `---\n"@remnic/core": patch\n---\n\n${body}\n`;
}

// --- (a) changeset stability -------------------------------------------------

test("a diff touching a published package without a changeset fails", async () => {
  await withFixture(
    async ({ write }) => {
      await write("packages/remnic-core/src/recall.ts", "export const recall = 1;\n");
    },
    (result) => {
      assert.equal(result.status, 1, result.stderr);
      assert.match(result.stderr, /no added\/modified changeset/);
      assert.match(result.stderr, /@remnic\/core/);
    },
  );
});

test("a valid Stability line satisfies the changeset rule", async () => {
  await withFixture(
    async ({ write }) => {
      await write("packages/remnic-core/src/recall.ts", "export const recall = 1;\n");
      await write(".changeset/recall.md", changeset("Tighten recall ordering.\n\nStability: stable"));
    },
    (result) => {
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /release-discipline: clean/);
    },
  );
});

test("a malformed Stability value fails instead of being normalized", async () => {
  await withFixture(
    async ({ write }) => {
      await write("packages/remnic-core/src/recall.ts", "export const recall = 1;\n");
      await write(".changeset/recall.md", changeset("Tighten recall ordering.\n\nStability:  Beta "));
    },
    (result) => {
      assert.equal(result.status, 1, result.stderr);
      assert.match(result.stderr, /invalid stability declaration/);
    },
  );
});

test("a doc-only diff needs no changeset", async () => {
  await withFixture(
    async ({ write }) => {
      await write("docs/releases.md", "# Releases\n");
      await write("packages/remnic-core/README.md", "# core\n");
    },
    (result) => {
      assert.equal(result.status, 0, result.stderr);
    },
  );
});

test("a CI-only diff needs no changeset", async () => {
  await withFixture(
    async ({ write }) => {
      await write(".github/workflows/release-promote.yml", "name: promote\n");
      await write("scripts/check-release-discipline-helper.mjs", "export const x = 1;\n");
    },
    (result) => {
      assert.equal(result.status, 0, result.stderr);
    },
  );
});

// --- (b) flag registration ---------------------------------------------------

test("a new default-off gate without a registry entry fails", async () => {
  await withFixture(
    async ({ write }) => {
      await write(CONFIG_PATH, BASE_CONFIG.replace("    maxThings: 5,", "    newAlphaGate: coerceBool(cfg.newAlphaGate) === true,\n    maxThings: 5,"));
      await write(".changeset/alpha.md", changeset("Add newAlphaGate behind a flag.\n\nStability: alpha"));
    },
    (result) => {
      assert.equal(result.status, 1, result.stderr);
      assert.match(result.stderr, /New default-off gate `newAlphaGate`.*has no entry/s);
    },
  );
});

test("a new default-off gate with a registry entry passes", async () => {
  await withFixture(
    async ({ write }) => {
      await write(CONFIG_PATH, BASE_CONFIG.replace("    maxThings: 5,", "    newAlphaGate: coerceBool(cfg.newAlphaGate) === true,\n    maxThings: 5,"));
      await write(
        REGISTRY_PATH,
        `${JSON.stringify(
          {
            ...BASE_REGISTRY,
            flags: [
              ...BASE_REGISTRY.flags,
              {
                flag: "newAlphaGate",
                addedIn: "1.3.0",
                issue: 3032,
                graduationCriterion: "Bench say-once suite green for 2 consecutive stable releases.",
              },
            ],
          },
          null,
          2,
        )}\n`,
      );
      await write(".changeset/alpha.md", changeset("Add newAlphaGate behind a flag.\n\nStability: alpha"));
    },
    (result) => {
      assert.equal(result.status, 0, result.stderr);
    },
  );
});

// --- (c) stability/flag coupling ---------------------------------------------

test("Stability: stable plus a new default-off gate fails", async () => {
  await withFixture(
    async ({ write }) => {
      await write(CONFIG_PATH, BASE_CONFIG.replace("    maxThings: 5,", "    newAlphaGate: coerceBool(cfg.newAlphaGate) === true,\n    maxThings: 5,"));
      await write(
        REGISTRY_PATH,
        `${JSON.stringify(
          {
            ...BASE_REGISTRY,
            flags: [
              ...BASE_REGISTRY.flags,
              {
                flag: "newAlphaGate",
                addedIn: "1.3.0",
                issue: 3032,
                graduationCriterion: "Bench say-once suite green for 2 consecutive stable releases.",
              },
            ],
          },
          null,
          2,
        )}\n`,
      );
      await write(".changeset/stable.md", changeset("Ship it.\n\nStability: stable"));
    },
    (result) => {
      assert.equal(result.status, 1, result.stderr);
      assert.match(result.stderr, /Stable work ships default-on/);
    },
  );
});

test("Stability: alpha with neither a new gate nor a registered flag fails", async () => {
  await withFixture(
    async ({ write }) => {
      await write("packages/remnic-core/src/recall.ts", "export const recall = 1;\n");
      await write(".changeset/alpha.md", changeset("New recall behavior, always on.\n\nStability: alpha"));
    },
    (result) => {
      assert.equal(result.status, 1, result.stderr);
      assert.match(result.stderr, /Experimental behavior must be default-off behind a registered flag/);
    },
  );
});

test("Stability: alpha naming an already-registered flag passes", async () => {
  await withFixture(
    async ({ write }) => {
      await write("packages/remnic-core/src/recall.ts", "export const recall = 1;\n");
      await write(".changeset/alpha.md", changeset("Extend the existingGate path.\n\nStability: alpha"));
    },
    (result) => {
      assert.equal(result.status, 0, result.stderr);
    },
  );
});

// --- (d) graduation symmetry -------------------------------------------------

test("a default flip whose registry entry survives fails", async () => {
  await withFixture(
    async ({ write }) => {
      await write(
        CONFIG_PATH,
        BASE_CONFIG.replace(
          "existingGate: coerceBool(cfg.existingGate) === true,",
          "existingGate: coerceBool(cfg.existingGate) ?? true,",
        ),
      );
      await write(".changeset/graduate.md", changeset("Graduate existingGate.\n\nStability: stable"));
    },
    (result) => {
      assert.equal(result.status, 1, result.stderr);
      assert.match(result.stderr, /entry survives/);
    },
  );
});

test("deleting a registry entry while the flag is still default-off fails", async () => {
  await withFixture(
    async ({ write }) => {
      await write(REGISTRY_PATH, `${JSON.stringify({ ...BASE_REGISTRY, flags: [] }, null, 2)}\n`);
    },
    (result) => {
      assert.equal(result.status, 1, result.stderr);
      assert.match(result.stderr, /was deleted, but the flag is still default-off/);
    },
  );
});

test("a graduation PR that flips the default and deletes the entry passes", async () => {
  await withFixture(
    async ({ write }) => {
      await write(
        CONFIG_PATH,
        BASE_CONFIG.replace(
          "existingGate: coerceBool(cfg.existingGate) === true,",
          "existingGate: coerceBool(cfg.existingGate) ?? true,",
        ),
      );
      await write(REGISTRY_PATH, `${JSON.stringify({ ...BASE_REGISTRY, flags: [] }, null, 2)}\n`);
      await write(".changeset/graduate.md", changeset("Graduate existingGate to default-on.\n\nStability: stable"));
    },
    (result) => {
      assert.equal(result.status, 0, result.stderr);
    },
  );
});

test("a registry entry that outlives its config key fails", async () => {
  await withFixture(
    async ({ write }) => {
      await write(CONFIG_PATH, BASE_CONFIG.replace("    existingGate: coerceBool(cfg.existingGate) === true,\n", ""));
      await write(".changeset/remove.md", changeset("Remove the gate.\n\nStability: stable"));
    },
    (result) => {
      assert.equal(result.status, 1, result.stderr);
      assert.match(result.stderr, /no longer appears in/);
    },
  );
});

// --- unit-level guards -------------------------------------------------------

test("extractDefaultOffGates finds every default-off signature and no default-on one", () => {
  const gates = extractDefaultOffGates(`export function parseConfig(raw: unknown) {
  return {
    a: coerceBool(cfg.a) === true,
    b: coerceBooleanLike(cfg.b) ?? false,
    c: cfg.c === true,
    d: coerceBool(cfg.d) ?? true,
    e: coerceBooleanLike(cfg.e) ?? true,
  };
}
`);
  assert.deepEqual(gates, ["a", "b", "c"]);
});

test("extractDefaultOffGates throws instead of returning an empty set", () => {
  assert.throws(() => extractDefaultOffGates("export const x = 1;\n"), /Could not locate/);
});

test("parseStabilityDeclarations accepts only the exact line", () => {
  assert.deepEqual(parseStabilityDeclarations("Stability: beta").levels, ["beta"]);
  for (const bad of ["Stability:beta", "Stability: Beta", "stability: beta", "Stability: beta ", "Stability: gamma"]) {
    const parsed = parseStabilityDeclarations(bad);
    assert.deepEqual(parsed.levels, [], `${bad} must not be accepted`);
    assert.equal(parsed.invalid.length, 1, `${bad} must be reported invalid`);
  }
});

test("parseRegistry rejects non-integer and non-finite issue numbers", () => {
  for (const issue of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, "1234", null]) {
    assert.throws(
      () =>
        parseRegistry({
          flags: [{ flag: "f", addedIn: "1.0.0", issue, graduationCriterion: "x" }],
        }),
      /"issue" must be a positive integer/,
      `issue=${String(issue)} must be rejected`,
    );
  }
});

test("parseRegistry sees non-enumerable and inherited fields", () => {
  const nonEnumerable = { flag: "f", addedIn: "1.0.0", issue: 1 };
  Object.defineProperty(nonEnumerable, "sneaky", { value: 1, enumerable: false });
  assert.throws(() => parseRegistry({ flags: [nonEnumerable] }), /missing "graduationCriterion"|unknown field "sneaky"/);

  const inherited = Object.create({ graduationCriterion: "inherited" });
  Object.assign(inherited, { flag: "f", addedIn: "1.0.0", issue: 1 });
  assert.throws(() => parseRegistry({ flags: [inherited] }), /missing "graduationCriterion"/);
});

test("parseRegistry rejects duplicates and a missing flags array", () => {
  assert.throws(() => parseRegistry({}), /missing required "flags"/);
  assert.throws(() => parseRegistry({ flags: {} }), /"flags" must be an array/);
  const entry = { flag: "dup", addedIn: "1.0.0", issue: 1, graduationCriterion: "x" };
  assert.throws(() => parseRegistry({ flags: [entry, { ...entry }] }), /duplicate entry for dup/);
});

test("the shipped registry parses and covers every default-off gate in config.ts", async () => {
  const { readFile } = await import("node:fs/promises");
  const registry = parseRegistry(await readFile(path.join(REPO_ROOT, REGISTRY_PATH), "utf8"));
  const gates = extractDefaultOffGates(await readFile(path.join(REPO_ROOT, CONFIG_PATH), "utf8"));
  const unregistered = gates.filter((flag) => !registry.has(flag));
  assert.deepEqual(unregistered, [], `unregistered default-off gates: ${unregistered.join(", ")}`);
});
