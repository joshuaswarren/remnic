/**
 * Tests for memory extension discovery (#382).
 *
 * Covers: discovery, slug validation, instructions.md requirement,
 * schema.json parsing, example capping, sorting, scripts/ safety,
 * renderExtensionsBlock token budget, and consolidation wiring.
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  discoverMemoryExtensions,
  renderExtensionsBlock,
  renderExtensionsFooter,
  REMNIC_EXTENSIONS_TOTAL_TOKEN_LIMIT,
} from "../packages/remnic-core/src/memory-extension-host/index.ts";
import type { DiscoveredExtension } from "../packages/remnic-core/src/memory-extension-host/types.ts";
import {
  buildConsolidationPrompt,
  buildExtensionsBlockForConsolidation,
  resolveExtensionsRoot,
} from "../packages/remnic-core/src/semantic-consolidation.ts";
import { buildExtensionsFooterForSummary } from "../packages/remnic-core/src/day-summary.ts";
import type { PluginConfig } from "../packages/remnic-core/src/types.ts";
import { parseConfig } from "../packages/remnic-core/src/config.ts";

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "remnic-ext-test-"));
}

function createExtension(
  root: string,
  name: string,
  opts: {
    instructions?: string;
    schema?: Record<string, unknown>;
    exampleCount?: number;
    includeScripts?: boolean;
  } = {},
): void {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });

  if (opts.instructions !== undefined) {
    fs.writeFileSync(path.join(dir, "instructions.md"), opts.instructions, "utf-8");
  }

  if (opts.schema !== undefined) {
    fs.writeFileSync(path.join(dir, "schema.json"), JSON.stringify(opts.schema), "utf-8");
  }

  if (opts.exampleCount && opts.exampleCount > 0) {
    const exDir = path.join(dir, "examples");
    fs.mkdirSync(exDir, { recursive: true });
    for (let i = 0; i < opts.exampleCount; i++) {
      fs.writeFileSync(
        path.join(exDir, `example-${String(i).padStart(3, "0")}.md`),
        `Example ${i}`,
        "utf-8",
      );
    }
  }

  if (opts.includeScripts) {
    const scriptsDir = path.join(dir, "scripts");
    fs.mkdirSync(scriptsDir, { recursive: true });
    fs.writeFileSync(path.join(scriptsDir, "install.sh"), "#!/bin/bash\necho hi", "utf-8");
  }
}

const silentLog = { warn: () => {}, debug: () => {} };

function collectWarnings(): { log: { warn: (msg: string) => void; debug: () => void }; warnings: string[] } {
  const warnings: string[] = [];
  return {
    log: {
      warn: (msg: string) => warnings.push(msg),
      debug: () => {},
    },
    warnings,
  };
}

// ── discoverMemoryExtensions ─────────────────────────────────────────────────

test("empty root returns []", async () => {
  const root = makeTempDir();
  const result = await discoverMemoryExtensions(root, silentLog);
  assert.deepStrictEqual(result, []);
  fs.rmSync(root, { recursive: true });
});

test("missing root returns [] without warning", async () => {
  const root = path.join(os.tmpdir(), `nonexistent-${Date.now()}`);
  const { log, warnings } = collectWarnings();
  const result = await discoverMemoryExtensions(root, log);
  assert.deepStrictEqual(result, []);
  assert.equal(warnings.length, 0);
});

test("one valid extension returns one entry with correct fields", async () => {
  const root = makeTempDir();
  createExtension(root, "github-issues", {
    instructions: "Track GitHub issues as reference memories.",
    schema: {
      memoryTypes: ["reference"],
      groupingHints: ["repository"],
      version: "1.0.0",
    },
    exampleCount: 2,
  });

  const result = await discoverMemoryExtensions(root, silentLog);
  assert.equal(result.length, 1);
  assert.equal(result[0].name, "github-issues");
  assert.equal(result[0].root, path.join(root, "github-issues"));
  assert.equal(result[0].instructionsPath, path.join(root, "github-issues", "instructions.md"));
  assert.equal(result[0].instructions, "Track GitHub issues as reference memories.");
  assert.deepStrictEqual(result[0].schema, {
    memoryTypes: ["reference"],
    groupingHints: ["repository"],
    version: "1.0.0",
  });
  assert.equal(result[0].examplesPaths.length, 2);

  fs.rmSync(root, { recursive: true });
});

test("extension missing instructions.md is skipped with warning", async () => {
  const root = makeTempDir();
  // Create directory but no instructions.md
  fs.mkdirSync(path.join(root, "no-instructions"), { recursive: true });

  const { log, warnings } = collectWarnings();
  const result = await discoverMemoryExtensions(root, log);
  assert.equal(result.length, 0);
  assert.equal(warnings.length, 1);
  assert.ok(warnings[0].includes("missing instructions.md"));

  fs.rmSync(root, { recursive: true });
});

test("invalid slug is skipped with warning", async () => {
  const root = makeTempDir();
  // Capital letters are invalid
  createExtension(root, "BadSlug", { instructions: "test" });

  const { log, warnings } = collectWarnings();
  const result = await discoverMemoryExtensions(root, log);
  assert.equal(result.length, 0);
  assert.equal(warnings.length, 1);
  assert.ok(warnings[0].includes("invalid slug"));

  fs.rmSync(root, { recursive: true });
});

test("malformed schema.json results in entry with schema undefined", async () => {
  const root = makeTempDir();
  const dir = path.join(root, "bad-schema");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "instructions.md"), "Test", "utf-8");
  fs.writeFileSync(path.join(dir, "schema.json"), "not valid json{{{", "utf-8");

  const { log, warnings } = collectWarnings();
  const result = await discoverMemoryExtensions(root, log);
  assert.equal(result.length, 1);
  assert.equal(result[0].schema, undefined);
  assert.equal(warnings.length, 1);
  assert.ok(warnings[0].includes("malformed schema.json"));

  fs.rmSync(root, { recursive: true });
});

test("15 example files: only first 10 collected", async () => {
  const root = makeTempDir();
  createExtension(root, "many-examples", {
    instructions: "Test",
    exampleCount: 15,
  });

  const result = await discoverMemoryExtensions(root, silentLog);
  assert.equal(result.length, 1);
  assert.equal(result[0].examplesPaths.length, 10);

  fs.rmSync(root, { recursive: true });
});

test("discovery results sorted by name", async () => {
  const root = makeTempDir();
  createExtension(root, "zeta-ext", { instructions: "Zeta" });
  createExtension(root, "alpha-ext", { instructions: "Alpha" });
  createExtension(root, "middle-ext", { instructions: "Middle" });

  const result = await discoverMemoryExtensions(root, silentLog);
  assert.equal(result.length, 3);
  assert.equal(result[0].name, "alpha-ext");
  assert.equal(result[1].name, "middle-ext");
  assert.equal(result[2].name, "zeta-ext");

  fs.rmSync(root, { recursive: true });
});

test("discovery never reads scripts/ directory", async () => {
  const root = makeTempDir();
  createExtension(root, "has-scripts", {
    instructions: "Test",
    includeScripts: true,
  });

  // Track all readFile/readdir calls via spying on fs
  const originalReadFile = fs.promises.readFile;
  const readPaths: string[] = [];
  // @ts-expect-error -- spy override for test
  fs.promises.readFile = async function (filePath: string, ...args: unknown[]) {
    readPaths.push(String(filePath));
    return (originalReadFile as Function).call(fs.promises, filePath, ...args);
  };

  try {
    await discoverMemoryExtensions(root, silentLog);
    // Verify no path under scripts/ was read
    const scriptsReads = readPaths.filter((p) => p.includes("/scripts/"));
    assert.equal(scriptsReads.length, 0, `Unexpected reads from scripts/: ${scriptsReads.join(", ")}`);
  } finally {
    fs.promises.readFile = originalReadFile;
  }

  fs.rmSync(root, { recursive: true });
});

test("discovery ignores symlinked examples directory", async () => {
  const root = makeTempDir();
  createExtension(root, "symlink-examples", {
    instructions: "Test",
    includeScripts: true,
  });
  const extensionDir = path.join(root, "symlink-examples");
  fs.writeFileSync(path.join(extensionDir, "scripts", "leak.md"), "leak", "utf-8");
  try {
    fs.symlinkSync(path.join(extensionDir, "scripts"), path.join(extensionDir, "examples"), "dir");
  } catch {
    fs.rmSync(root, { recursive: true });
    return;
  }

  const { log, warnings } = collectWarnings();
  const result = await discoverMemoryExtensions(root, log);

  assert.equal(result.length, 1);
  assert.deepEqual(result[0].examplesPaths, []);
  assert.equal(warnings.some((warning) => warning.includes("examples/ is a symlink")), true);
  fs.rmSync(root, { recursive: true });
});

test("discovery ignores symlinked example markdown files", async () => {
  const root = makeTempDir();
  createExtension(root, "symlink-example-file", {
    instructions: "Test",
  });
  const extensionDir = path.join(root, "symlink-example-file");
  const examplesDir = path.join(extensionDir, "examples");
  fs.mkdirSync(examplesDir, { recursive: true });
  const outside = path.join(root, "outside.md");
  fs.writeFileSync(outside, "outside", "utf-8");
  try {
    fs.symlinkSync(outside, path.join(examplesDir, "leak.md"));
  } catch {
    fs.rmSync(root, { recursive: true });
    return;
  }

  const { log, warnings } = collectWarnings();
  const result = await discoverMemoryExtensions(root, log);

  assert.equal(result.length, 1);
  assert.deepEqual(result[0].examplesPaths, []);
  assert.equal(warnings.some((warning) => warning.includes("examples/leak.md is a symlink")), true);
  fs.rmSync(root, { recursive: true });
});

// ── renderExtensionsBlock ────────────────────────────────────────────────────

test("renderExtensionsBlock: empty list returns empty string", () => {
  const result = renderExtensionsBlock([]);
  assert.equal(result, "");
});

test("renderExtensionsBlock: two small extensions both inlined", () => {
  const extensions: DiscoveredExtension[] = [
    {
      name: "alpha",
      root: "/tmp/alpha",
      instructionsPath: "/tmp/alpha/instructions.md",
      instructions: "Alpha extension instructions.",
      examplesPaths: [],
    },
    {
      name: "beta",
      root: "/tmp/beta",
      instructionsPath: "/tmp/beta/instructions.md",
      instructions: "Beta extension instructions.",
      examplesPaths: [],
    },
  ];

  const result = renderExtensionsBlock(extensions);
  assert.ok(result.includes("## Active memory extensions"));
  assert.ok(result.includes("### remnic-extension/alpha"));
  assert.ok(result.includes("### remnic-extension/beta"));
  assert.ok(result.includes("Alpha extension instructions."));
  assert.ok(result.includes("Beta extension instructions."));
  assert.ok(!result.includes("omitted"));
});

test("renderExtensionsBlock: exceeds token budget adds truncation footer", () => {
  // Create extensions that collectively exceed the budget
  const bigInstruction = "x".repeat(REMNIC_EXTENSIONS_TOTAL_TOKEN_LIMIT * 4);
  const extensions: DiscoveredExtension[] = [
    {
      name: "big-one",
      root: "/tmp/big-one",
      instructionsPath: "/tmp/big-one/instructions.md",
      instructions: bigInstruction,
      examplesPaths: [],
    },
    {
      name: "small-one",
      root: "/tmp/small-one",
      instructionsPath: "/tmp/small-one/instructions.md",
      instructions: "Small extension.",
      examplesPaths: [],
    },
  ];

  const result = renderExtensionsBlock(extensions);
  // Big one takes all budget, small one is omitted (or vice versa depending on order)
  assert.ok(result.includes("omitted"));
});

// ── renderExtensionsFooter ──────────────────────────────────────────────────

test("renderExtensionsFooter: empty list returns empty string", () => {
  assert.equal(renderExtensionsFooter([]), "");
});

test("renderExtensionsFooter: returns comma-separated names", () => {
  const exts: DiscoveredExtension[] = [
    { name: "alpha", root: "", instructionsPath: "", instructions: "", examplesPaths: [] },
    { name: "beta", root: "", instructionsPath: "", instructions: "", examplesPaths: [] },
  ];
  const footer = renderExtensionsFooter(exts);
  assert.equal(footer, "Active extensions: alpha, beta");
});

// ── resolveExtensionsRoot ────────────────────────────────────────────────────

test("resolveExtensionsRoot: uses memoryExtensionsRoot when set", () => {
  const config = parseConfig({ memoryExtensionsRoot: "/custom/extensions" });
  const root = resolveExtensionsRoot(config);
  assert.equal(root, "/custom/extensions");
});

test("resolveExtensionsRoot: derives from memoryDir when empty", () => {
  const config = parseConfig({ memoryDir: "/home/user/.openclaw/workspace/memory/local" });
  const root = resolveExtensionsRoot(config);
  assert.equal(root, "/home/user/.openclaw/workspace/memory/memory_extensions");
});

// ── Config parsing ──────────────────────────────────────────────────────────

test("parseConfig: memoryExtensionsEnabled defaults to true", () => {
  const config = parseConfig({});
  assert.equal(config.memoryExtensionsEnabled, true);
});

test("parseConfig: memoryExtensionsEnabled can be set to false", () => {
  const config = parseConfig({ memoryExtensionsEnabled: false });
  assert.equal(config.memoryExtensionsEnabled, false);
});

test("parseConfig: memoryExtensionsRoot defaults to empty string", () => {
  const config = parseConfig({});
  assert.equal(config.memoryExtensionsRoot, "");
});

test("parseConfig: memoryExtensionsRoot preserves custom value", () => {
  const config = parseConfig({ memoryExtensionsRoot: "/my/extensions" });
  assert.equal(config.memoryExtensionsRoot, "/my/extensions");
});

// ── Consolidation wiring ────────────────────────────────────────────────────

test("consolidation prompt includes extensions block when extensions exist", async () => {
  const root = makeTempDir();
  createExtension(root, "test-ext", {
    instructions: "Test extension for consolidation wiring.",
  });

  const config = parseConfig({
    memoryExtensionsEnabled: true,
    memoryExtensionsRoot: root,
  });

  const block = await buildExtensionsBlockForConsolidation(config);
  assert.ok(block.includes("## Active memory extensions"));
  assert.ok(block.includes("### remnic-extension/test-ext"));
  assert.ok(block.includes("Test extension for consolidation wiring."));

  fs.rmSync(root, { recursive: true });
});

test("consolidation prompt unchanged when no extensions", async () => {
  const root = makeTempDir();

  const config = parseConfig({
    memoryExtensionsEnabled: true,
    memoryExtensionsRoot: root,
  });

  const block = await buildExtensionsBlockForConsolidation(config);
  assert.equal(block, "");

  fs.rmSync(root, { recursive: true });
});

test("consolidation prompt empty when extensions disabled", async () => {
  const root = makeTempDir();
  createExtension(root, "test-ext", {
    instructions: "Should not appear.",
  });

  const config = parseConfig({
    memoryExtensionsEnabled: false,
    memoryExtensionsRoot: root,
  });

  const block = await buildExtensionsBlockForConsolidation(config);
  assert.equal(block, "");

  fs.rmSync(root, { recursive: true });
});

// ── Symlink traversal blocking (#382 P2) ───────────────────────────────────

test("symlink extension entry is skipped with warning", async () => {
  const root = makeTempDir();

  // Create a real extension to be the symlink target
  const targetDir = path.join(root, "_real-target");
  fs.mkdirSync(targetDir, { recursive: true });
  fs.writeFileSync(path.join(targetDir, "instructions.md"), "Should not be discovered via symlink", "utf-8");

  // Create a symlink inside the extensions root
  const symlinkPath = path.join(root, "symlink-ext");
  fs.symlinkSync(targetDir, symlinkPath);

  const { log, warnings } = collectWarnings();
  const result = await discoverMemoryExtensions(root, log);

  // The symlink should NOT be discovered
  assert.equal(result.length, 0);
  assert.ok(warnings.some((w) => w.includes("symlinks are not followed")));

  fs.rmSync(root, { recursive: true });
});

// ── Symlinked extension files (#428 P1) ────────────────────────────────────

test("symlinked instructions.md is skipped with warning (#428 P1)", async () => {
  const root = makeTempDir();

  // Create a real instructions.md outside the extension dir
  const targetFile = path.join(root, "_target-instructions.md");
  fs.writeFileSync(targetFile, "Should not be read via symlink", "utf-8");

  // Create extension dir with symlinked instructions.md
  const extDir = path.join(root, "symlink-file-ext");
  fs.mkdirSync(extDir, { recursive: true });
  fs.symlinkSync(targetFile, path.join(extDir, "instructions.md"));

  const { log, warnings } = collectWarnings();
  const result = await discoverMemoryExtensions(root, log);

  assert.equal(result.length, 0);
  assert.ok(warnings.some((w) => w.includes("instructions.md is a symlink")));

  fs.rmSync(root, { recursive: true });
});

test("symlinked schema.json is ignored with warning (#428 P1)", async () => {
  const root = makeTempDir();

  // Create a real schema.json outside the extension dir
  const targetFile = path.join(root, "_target-schema.json");
  fs.writeFileSync(targetFile, JSON.stringify({ memoryTypes: ["fact"] }), "utf-8");

  // Create extension with real instructions.md but symlinked schema.json
  const extDir = path.join(root, "symlink-schema-ext");
  fs.mkdirSync(extDir, { recursive: true });
  fs.writeFileSync(path.join(extDir, "instructions.md"), "Real instructions", "utf-8");
  fs.symlinkSync(targetFile, path.join(extDir, "schema.json"));

  const { log, warnings } = collectWarnings();
  const result = await discoverMemoryExtensions(root, log);

  // Extension should still be discovered but schema should be undefined
  assert.equal(result.length, 1);
  assert.equal(result[0].name, "symlink-schema-ext");
  assert.equal(result[0].schema, undefined);
  assert.ok(warnings.some((w) => w.includes("schema.json is a symlink")));

  fs.rmSync(root, { recursive: true });
});

// ── Symlinked root directory (#428 P2) ─────────────────────────────────────

test("symlinked root directory outside expected parent is rejected (#428 P2)", async () => {
  const parentDir = makeTempDir();
  const outsideDir = makeTempDir();

  // Create a real extensions directory outside the expected parent
  const realExtensionsDir = path.join(outsideDir, "memory_extensions");
  fs.mkdirSync(realExtensionsDir, { recursive: true });
  createExtension(realExtensionsDir, "sneaky-ext", {
    instructions: "Should not be discovered",
  });

  // Create a symlink inside parentDir pointing to the outside location
  const symlinkRoot = path.join(parentDir, "memory_extensions");
  fs.symlinkSync(realExtensionsDir, symlinkRoot);

  const { log, warnings } = collectWarnings();
  const result = await discoverMemoryExtensions(symlinkRoot, log);

  // Should reject because realpath resolves outside the expected parent
  assert.equal(result.length, 0);
  assert.ok(warnings.some((w) => w.includes("symlink resolving outside")));

  fs.rmSync(parentDir, { recursive: true });
  fs.rmSync(outsideDir, { recursive: true });
});

test("symlinked root directory within expected parent is allowed (#428 P2)", async () => {
  const parentDir = makeTempDir();

  // Create a real extensions directory under the parent
  const realExtensionsDir = path.join(parentDir, "real_extensions");
  fs.mkdirSync(realExtensionsDir, { recursive: true });
  createExtension(realExtensionsDir, "ok-ext", {
    instructions: "Should be discovered",
  });

  // Create a symlink under the same parent
  const symlinkRoot = path.join(parentDir, "memory_extensions");
  fs.symlinkSync(realExtensionsDir, symlinkRoot);

  const { log, warnings } = collectWarnings();
  const result = await discoverMemoryExtensions(symlinkRoot, log);

  // Should be allowed because realpath resolves within the expected parent
  assert.equal(result.length, 1);
  assert.equal(result[0].name, "ok-ext");

  fs.rmSync(parentDir, { recursive: true });
});

// ── Symlink root normalization (#431) ─────────────────────────────────────

test("symlinked root with intermediate parent symlink is accepted (#431 Finding 2)", async () => {
  // Simulates macOS /var -> /private/var: the parent itself contains a symlink
  // so path.dirname(root) != realpath(path.dirname(root)).
  const base = makeTempDir();

  // Create a real parent directory
  const realParent = path.join(base, "real-parent");
  fs.mkdirSync(realParent, { recursive: true });

  // Create a symlink that acts as an intermediate directory symlink
  // (like /var -> /private/var on macOS)
  const symlinkParent = path.join(base, "symlink-parent");
  fs.symlinkSync(realParent, symlinkParent);

  // Create a real extensions directory under the real parent
  const realExtDir = path.join(realParent, "memory_extensions");
  fs.mkdirSync(realExtDir, { recursive: true });
  createExtension(realExtDir, "ok-ext", {
    instructions: "Should be discovered despite intermediate symlink",
  });

  // Create symlink root under the symlink-parent path
  // root = <base>/symlink-parent/memory_extensions -> <base>/real-parent/memory_extensions
  // path.dirname(root) = <base>/symlink-parent (unresolved)
  // realpath(root) = <base>/real-parent/memory_extensions (resolved)
  // Without the fix, containment check fails because resolved path starts with
  // real-parent but expectedParent is symlink-parent.
  const symlinkRoot = path.join(symlinkParent, "memory_extensions");
  // symlinkRoot is not itself a symlink — it's a real dir accessed through a symlinked parent.
  // But we need the root to be a symlink for the guard to trigger, so create one.
  const symlinkRootLink = path.join(symlinkParent, "ext-link");
  fs.symlinkSync(realExtDir, symlinkRootLink);

  const { log, warnings } = collectWarnings();
  const result = await discoverMemoryExtensions(symlinkRootLink, log);

  // Should be allowed: realpath of both root and parent resolve consistently
  assert.equal(result.length, 1);
  assert.equal(result[0].name, "ok-ext");
  assert.equal(warnings.filter((w) => w.includes("symlink resolving outside")).length, 0);

  fs.rmSync(base, { recursive: true });
});

test("symlinked root with relative path is handled correctly (#431 Finding 1)", async () => {
  // When root is relative like "./memory_extensions", path.dirname returns "."
  // which without normalization can't match the absolute resolved path.
  const base = makeTempDir();

  // Create a real extensions dir and a symlink to it
  const realExtDir = path.join(base, "real_exts");
  fs.mkdirSync(realExtDir, { recursive: true });
  createExtension(realExtDir, "rel-ext", {
    instructions: "Should be discovered via relative symlink root",
  });

  const symlinkRoot = path.join(base, "link-exts");
  fs.symlinkSync(realExtDir, symlinkRoot);

  // Use a relative path for the symlink root by changing to the base dir
  const originalCwd = process.cwd();
  try {
    process.chdir(base);
    const relativeRoot = "./link-exts";

    const { log, warnings } = collectWarnings();
    const result = await discoverMemoryExtensions(relativeRoot, log);

    // Should be accepted: both sides normalize through path.resolve + realpath
    assert.equal(result.length, 1);
    assert.equal(result[0].name, "rel-ext");
    assert.equal(warnings.filter((w) => w.includes("symlink resolving outside")).length, 0);
  } finally {
    process.chdir(originalCwd);
  }

  fs.rmSync(base, { recursive: true });
});

// ── buildExtensionsFooterForSummary wiring (#382) ──────────────────────────

test("buildExtensionsFooterForSummary returns footer when extensions exist", async () => {
  const root = makeTempDir();
  createExtension(root, "day-ext", {
    instructions: "Day summary extension.",
  });

  const config = parseConfig({
    memoryExtensionsEnabled: true,
    memoryExtensionsRoot: root,
  });

  const footer = await buildExtensionsFooterForSummary(config);
  assert.ok(footer.includes("Active extensions: day-ext"));

  fs.rmSync(root, { recursive: true });
});

test("buildExtensionsFooterForSummary returns empty when disabled", async () => {
  const root = makeTempDir();
  createExtension(root, "day-ext", {
    instructions: "Should not appear.",
  });

  const config = parseConfig({
    memoryExtensionsEnabled: false,
    memoryExtensionsRoot: root,
  });

  const footer = await buildExtensionsFooterForSummary(config);
  assert.equal(footer, "");

  fs.rmSync(root, { recursive: true });
});

test("buildExtensionsFooterForSummary returns empty when no extensions", async () => {
  const root = makeTempDir();

  const config = parseConfig({
    memoryExtensionsEnabled: true,
    memoryExtensionsRoot: root,
  });

  const footer = await buildExtensionsFooterForSummary(config);
  assert.equal(footer, "");

  fs.rmSync(root, { recursive: true });
});
