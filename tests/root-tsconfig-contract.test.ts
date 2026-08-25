import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));

type CompilerOptions = Record<string, unknown>;

type Tsconfig = {
  extends?: string;
  compilerOptions?: CompilerOptions;
  include?: string[];
  exclude?: string[];
};

function readTsconfig(rel: string): Tsconfig {
  return JSON.parse(readFileSync(join(repoRoot, rel), "utf8")) as Tsconfig;
}

const base = readTsconfig("tsconfig.base.json");
const root = readTsconfig("tsconfig.json");
const tests = readTsconfig("tsconfig.tests.json");

/** Merge the way tsc resolves `extends`: child scalars win, arrays replace. */
function effective(child: Tsconfig, parentOptions: CompilerOptions): CompilerOptions {
  return { ...parentOptions, ...(child.compilerOptions ?? {}) };
}

const rootOptions = base.compilerOptions ?? {};
const rootEffective = effective(root, rootOptions);
const testsEffective = effective(tests, rootEffective);

test("root tsconfig extends the shared base without restating shared options", () => {
  assert.equal(root.extends, "./tsconfig.base.json");
  for (const shared of [
    "target",
    "module",
    "moduleResolution",
    "strict",
    "esModuleInterop",
    "skipLibCheck",
    "forceConsistentCasingInFileNames",
    "resolveJsonModule",
  ]) {
    assert.equal(
      Object.hasOwn(root.compilerOptions ?? {}, shared),
      false,
      `${shared} is duplicated from tsconfig.base.json`,
    );
    assert.deepEqual(rootEffective[shared], rootOptions[shared]);
  }
});

test("root effective coverage keeps the pre-extends contract", () => {
  // Deliberate divergence from base: the root program reads ambient const
  // enum members (TS2748 under isolatedModules), so it stays non-isolated.
  assert.equal(rootEffective.isolatedModules, false);
  assert.deepEqual(rootEffective.lib, ["ES2022", "ES2024.Promise"]);
  assert.equal(rootEffective.noEmit, true);
  assert.equal(rootEffective.baseUrl, ".");
  const paths = rootEffective.paths as Record<string, string[]> | undefined;
  assert.deepEqual(paths?.["@remnic/core"], ["./packages/remnic-core/src/index.ts"]);
  assert.deepEqual(paths?.["@remnic/server"], ["./packages/remnic-server/src/index.ts"]);
  // `src/**/*.ts` already matches `.d.ts` files, so no separate d.ts glob.
  assert.deepEqual(root.include, ["src/**/*.ts", "packages/remnic-core/src/**/*.ts"]);
  assert.ok(existsSync(join(repoRoot, "src", "openclaw-plugin-sdk.d.ts")));
});

test("tests tsconfig stays a pure delta over the root contract", () => {
  assert.equal(tests.extends, "./tsconfig.json");
  assert.deepEqual(testsEffective.lib, ["ES2022", "ES2024.Promise", "DOM", "DOM.Iterable"]);
  assert.equal(testsEffective.noEmit, true);
  assert.equal(testsEffective.declaration, false);
  assert.equal(testsEffective.declarationMap, false);
  assert.equal(testsEffective.allowImportingTsExtensions, true);
});

test("lint gate checks only files that exist", () => {
  const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")) as {
    scripts?: Record<string, string>;
  };
  const lint = pkg.scripts?.lint ?? "";
  assert.match(lint, /^biome check /);
  const fileArgs = lint.split(/\s+/).filter((arg) => /\.(json|js|mjs|cjs|ts)$/.test(arg));
  assert.ok(fileArgs.length > 0, "lint script must name at least one file");
  for (const arg of fileArgs) {
    assert.equal(existsSync(join(repoRoot, arg)), true, `lint script references missing file ${arg}`);
  }
});

test("root tsconfig is typecheck-only when package path aliases point at source files", () => {
  const paths = (rootEffective.paths as Record<string, string[]> | undefined) ?? {};
  const sourceAliases = Object.entries(paths).filter(([, targets]) =>
    targets.some((target) => target.includes("/src/") || target.endsWith("/src/index.ts")),
  );

  assert.notEqual(sourceAliases.length, 0, "expected root tsconfig to define source-backed package aliases");
  assert.equal(
    rootEffective.noEmit,
    true,
    "root tsconfig must stay typecheck-only so source-backed aliases are not emitted into release output",
  );
});
