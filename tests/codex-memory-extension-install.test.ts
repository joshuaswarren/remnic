import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm, mkdir, writeFile, readFile } from "node:fs/promises";
import {
  installCodexMemoryExtension,
  removeCodexMemoryExtension,
  resolveCodexHome,
  resolveCodexMemoryExtensionPaths,
  installConnector,
  removeConnector,
  locatePluginCodexExtensionSource,
  getConnectorsDir,
} from "../packages/remnic-core/src/connectors/index.js";

async function makeTempCodexHome(): Promise<string> {
  return await mkdtemp(path.join(os.tmpdir(), "remnic-codex-ext-"));
}

async function makeTempRemnicConfigHome(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-config-"));
  // Redirect XDG_CONFIG_HOME so connectors registry lives in a temp dir.
  process.env.XDG_CONFIG_HOME = dir;
  return dir;
}

test("resolveCodexHome honors explicit override, then $CODEX_HOME, then ~/.codex", () => {
  const prev = process.env.CODEX_HOME;
  try {
    delete process.env.CODEX_HOME;
    const home = resolveCodexHome();
    assert.ok(home.endsWith(".codex"), `expected ~/.codex fallback, got ${home}`);

    process.env.CODEX_HOME = "/tmp/custom-codex-home";
    assert.equal(resolveCodexHome(), "/tmp/custom-codex-home");

    assert.equal(resolveCodexHome("/explicit/override"), "/explicit/override");
  } finally {
    if (prev === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = prev;
  }
});

test("resolveCodexMemoryExtensionPaths places extensions as a sibling of memories", () => {
  const paths = resolveCodexMemoryExtensionPaths("/tmp/fake-codex");
  assert.equal(paths.codexHome, "/tmp/fake-codex");
  assert.equal(paths.memoriesDir, "/tmp/fake-codex/memories");
  assert.equal(paths.extensionsRoot, "/tmp/fake-codex/memories_extensions");
  assert.equal(
    paths.remnicExtensionDir,
    "/tmp/fake-codex/memories_extensions/remnic",
  );
  // Extensions must NOT live inside the memories folder.
  assert.ok(
    !paths.extensionsRoot.startsWith(paths.memoriesDir + path.sep),
    "extensionsRoot must not be inside memoriesDir",
  );
});

test("installCodexMemoryExtension drops instructions.md at the correct sibling path", async () => {
  const codexHome = await makeTempCodexHome();
  try {
    const result = installCodexMemoryExtension({ codexHome });

    // Correct location: sibling, not inside memories/
    assert.equal(result.codexHome, codexHome);
    assert.equal(result.memoriesDir, path.join(codexHome, "memories"));
    assert.equal(
      result.extensionsRoot,
      path.join(codexHome, "memories_extensions"),
    );
    assert.equal(
      result.remnicExtensionDir,
      path.join(codexHome, "memories_extensions", "remnic"),
    );
    assert.equal(
      result.instructionsPath,
      path.join(codexHome, "memories_extensions", "remnic", "instructions.md"),
    );

    // The file exists and is non-empty.
    assert.ok(fs.existsSync(result.instructionsPath));
    const content = await readFile(result.instructionsPath, "utf8");
    assert.ok(content.length > 0);
    assert.ok(result.filesCopied >= 1);

    // Nothing placed inside memories/.
    const memoriesDir = path.join(codexHome, "memories");
    if (fs.existsSync(memoriesDir)) {
      const memEntries = fs.readdirSync(memoriesDir);
      assert.ok(
        !memEntries.some((e) => e.startsWith("remnic")),
        "no remnic folder should appear inside memories/",
      );
    }
  } finally {
    await rm(codexHome, { recursive: true, force: true });
  }
});

test("installCodexMemoryExtension is idempotent — re-install overwrites remnic only", async () => {
  const codexHome = await makeTempCodexHome();
  try {
    const extRoot = path.join(codexHome, "memories_extensions");

    // Pre-create an adjacent vendor extension that MUST survive reinstall.
    const siblingDir = path.join(extRoot, "other-vendor");
    await mkdir(siblingDir, { recursive: true });
    await writeFile(path.join(siblingDir, "instructions.md"), "DO NOT TOUCH");

    installCodexMemoryExtension({ codexHome });

    // Mutate the installed remnic file and confirm reinstall replaces it.
    const remnicInstructions = path.join(extRoot, "remnic", "instructions.md");
    await writeFile(remnicInstructions, "tampered");
    installCodexMemoryExtension({ codexHome });
    const fresh = await readFile(remnicInstructions, "utf8");
    assert.notEqual(fresh, "tampered");
    assert.ok(fresh.length > 0);

    // Sibling extension must be intact.
    const sibling = await readFile(path.join(siblingDir, "instructions.md"), "utf8");
    assert.equal(sibling, "DO NOT TOUCH");

    // No leftover tmp directories.
    const leftover = fs
      .readdirSync(extRoot)
      .filter((name) => name.startsWith(".remnic.tmp-"));
    assert.deepEqual(leftover, []);
  } finally {
    await rm(codexHome, { recursive: true, force: true });
  }
});

test("removeCodexMemoryExtension only removes the remnic folder", async () => {
  const codexHome = await makeTempCodexHome();
  try {
    const extRoot = path.join(codexHome, "memories_extensions");

    // Install and add an unrelated sibling.
    installCodexMemoryExtension({ codexHome });
    const siblingDir = path.join(extRoot, "other-vendor");
    await mkdir(siblingDir, { recursive: true });
    await writeFile(path.join(siblingDir, "keep.md"), "keep me");

    const result = removeCodexMemoryExtension({ codexHome });
    assert.equal(result.removed, true);
    assert.ok(!fs.existsSync(path.join(extRoot, "remnic")));

    // Sibling extension must survive.
    assert.ok(fs.existsSync(path.join(siblingDir, "keep.md")));

    // Remove again is a no-op.
    const second = removeCodexMemoryExtension({ codexHome });
    assert.equal(second.removed, false);
  } finally {
    await rm(codexHome, { recursive: true, force: true });
  }
});

test("installConnector(codex-cli) installs the memory extension to the given codexHome", async () => {
  const codexHome = await makeTempCodexHome();
  const xdg = await makeTempRemnicConfigHome();
  try {
    const result = installConnector({
      connectorId: "codex-cli",
      config: { codexHome },
      force: true,
    });
    assert.equal(result.status, "installed");

    const instructionsPath = path.join(
      codexHome,
      "memories_extensions",
      "remnic",
      "instructions.md",
    );
    assert.ok(
      fs.existsSync(instructionsPath),
      `expected instructions at ${instructionsPath}`,
    );
    assert.match(result.message, /memory extension/);
  } finally {
    await rm(codexHome, { recursive: true, force: true });
    await rm(xdg, { recursive: true, force: true });
  }
});

test("installConnector(codex-cli) with installExtension=false skips extension install", async () => {
  const codexHome = await makeTempCodexHome();
  const xdg = await makeTempRemnicConfigHome();
  try {
    const result = installConnector({
      connectorId: "codex-cli",
      config: { codexHome, installExtension: false },
      force: true,
    });
    assert.equal(result.status, "installed");

    const extPath = path.join(codexHome, "memories_extensions", "remnic");
    assert.ok(
      !fs.existsSync(extPath),
      "extension should not be installed when installExtension is false",
    );
    assert.match(result.message, /skipped/);
  } finally {
    await rm(codexHome, { recursive: true, force: true });
    await rm(xdg, { recursive: true, force: true });
  }
});

test("removeConnector(codex-cli) removes only the remnic extension folder", async () => {
  const codexHome = await makeTempCodexHome();
  const xdg = await makeTempRemnicConfigHome();
  try {
    installConnector({
      connectorId: "codex-cli",
      config: { codexHome },
      force: true,
    });

    // Drop a neighbor extension.
    const extRoot = path.join(codexHome, "memories_extensions");
    const neighbor = path.join(extRoot, "some-other-extension");
    await mkdir(neighbor, { recursive: true });
    await writeFile(path.join(neighbor, "note.md"), "keep me");

    const removeResult = removeConnector("codex-cli");
    assert.match(removeResult.message, /Removed/);

    assert.ok(!fs.existsSync(path.join(extRoot, "remnic")));
    assert.ok(fs.existsSync(path.join(neighbor, "note.md")));
  } finally {
    await rm(codexHome, { recursive: true, force: true });
    await rm(xdg, { recursive: true, force: true });
  }
});

// ── Finding 2: resolveCodexHome always returns an absolute path ──────────────

test("resolveCodexHome returns an absolute path even when HOME and USERPROFILE are unset", () => {
  const prevHome = process.env.HOME;
  const prevUserProfile = process.env.USERPROFILE;
  const prevCodexHome = process.env.CODEX_HOME;
  try {
    delete process.env.HOME;
    delete process.env.USERPROFILE;
    delete process.env.CODEX_HOME;
    const result = resolveCodexHome();
    assert.equal(result, path.resolve(os.homedir(), ".codex"));
    assert.ok(
      path.isAbsolute(result),
      `expected an absolute path, got: ${result}`,
    );
  } finally {
    if (prevHome !== undefined) process.env.HOME = prevHome;
    if (prevUserProfile !== undefined) process.env.USERPROFILE = prevUserProfile;
    if (prevCodexHome !== undefined) process.env.CODEX_HOME = prevCodexHome;
    else delete process.env.CODEX_HOME;
  }
});

// ── Finding 3: bundled payload works without @remnic/plugin-codex ────────────

test("locatePluginCodexExtensionSource finds bundled payload without @remnic/plugin-codex", () => {
  // The bundled codex/ directory lives alongside the connectors source file.
  // This test verifies the primary lookup path resolves and contains instructions.md,
  // confirming installCodexMemoryExtension works in a standalone @remnic/core install.
  const sourceDir = locatePluginCodexExtensionSource(null);
  assert.ok(
    path.isAbsolute(sourceDir),
    `expected absolute path, got: ${sourceDir}`,
  );
  const instructionsPath = path.join(sourceDir, "instructions.md");
  assert.ok(
    fs.existsSync(instructionsPath),
    `expected instructions.md at ${instructionsPath}`,
  );
  const content = fs.readFileSync(instructionsPath, "utf8");
  assert.ok(content.length > 0, "instructions.md should be non-empty");
});

test("installCodexMemoryExtension works against a temp codexHome using only bundled payload", async () => {
  const codexHome = await makeTempCodexHome();
  try {
    // Pass no sourceDir — forces locatePluginCodexExtensionSource to find the
    // bundled payload (primary path) without relying on @remnic/plugin-codex.
    const result = installCodexMemoryExtension({ codexHome });
    assert.equal(result.codexHome, codexHome);
    assert.ok(fs.existsSync(result.instructionsPath));
    const content = fs.readFileSync(result.instructionsPath, "utf8");
    assert.ok(content.length > 0);
    assert.ok(result.filesCopied >= 1);
  } finally {
    await rm(codexHome, { recursive: true, force: true });
  }
});

// ── Whole-payload install: all source files/dirs reach the destination ────────

/**
 * Recursively collect all relative file paths under a directory.
 * Symlinks and non-file entries are skipped — consistent with copyDirRecursiveSync.
 */
function collectRelativeFiles(dir: string, base = dir): string[] {
  const results: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...collectRelativeFiles(full, base));
    } else if (entry.isFile()) {
      results.push(path.relative(base, full));
    }
  }
  return results.sort();
}

test("installCodexMemoryExtension copies the ENTIRE source payload — not just instructions.md", async () => {
  // Locate the bundled source so we know exactly what should be installed.
  const sourceDir = locatePluginCodexExtensionSource(null);
  const sourceFiles = collectRelativeFiles(sourceDir);

  // There must be at least one file (instructions.md) to make this test meaningful.
  assert.ok(sourceFiles.length >= 1, "source payload must have at least one file");

  const codexHome = await makeTempCodexHome();
  try {
    const result = installCodexMemoryExtension({ codexHome });
    const destFiles = collectRelativeFiles(result.remnicExtensionDir);

    assert.deepEqual(
      destFiles,
      sourceFiles,
      "installed extension must contain exactly the same files as the source payload " +
        "(recursive copy via tsup onSuccess must include all files and subdirectories)",
    );
    assert.equal(
      result.filesCopied,
      sourceFiles.length,
      "filesCopied must equal the number of files in the source payload",
    );
  } finally {
    await rm(codexHome, { recursive: true, force: true });
  }
});

// ── Finding 2 (PR #394): bundled payload must include resources/namespace-cheatsheet.md ─

test("bundled codex payload contains resources/namespace-cheatsheet.md", () => {
  // The canonical source (packages/plugin-codex/memories_extensions/remnic/) has
  // a resources/ subdirectory. The bundled path (packages/remnic-core/src/connectors/codex/)
  // must mirror it so installs via the bundled path are complete.
  const sourceDir = locatePluginCodexExtensionSource(null);
  const cheatsheetPath = path.join(sourceDir, "resources", "namespace-cheatsheet.md");
  assert.ok(
    fs.existsSync(cheatsheetPath),
    `bundled payload must include resources/namespace-cheatsheet.md at ${cheatsheetPath}`,
  );
  const content = fs.readFileSync(cheatsheetPath, "utf8");
  assert.ok(content.length > 0, "namespace-cheatsheet.md must be non-empty");
});

test("bundled codex payload matches the canonical plugin-codex source file set", () => {
  // Walk upward from __dirname to find the monorepo root (contains packages/).
  // This assertion ensures the bundled path is always kept in sync with the
  // canonical source.
  let repoRoot: string | null = null;
  let dir = path.dirname(new URL(import.meta.url).pathname);
  for (let depth = 0; depth < 8; depth++) {
    if (fs.existsSync(path.join(dir, "packages", "plugin-codex"))) {
      repoRoot = dir;
      break;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  if (repoRoot === null) {
    // Not running inside the monorepo (e.g. standalone install) — skip.
    return;
  }

  const canonicalSource = path.join(
    repoRoot,
    "packages",
    "plugin-codex",
    "memories_extensions",
    "remnic",
  );
  if (!fs.existsSync(canonicalSource)) {
    // plugin-codex not present in this environment — skip.
    return;
  }

  const bundledSource = locatePluginCodexExtensionSource(null);
  const canonicalFiles = collectRelativeFiles(canonicalSource);
  const bundledFiles = collectRelativeFiles(bundledSource);

  assert.deepEqual(
    bundledFiles,
    canonicalFiles,
    "bundled payload (packages/remnic-core/src/connectors/codex/) must contain " +
      "exactly the same relative file set as the canonical source " +
      "(packages/plugin-codex/memories_extensions/remnic/). " +
      "Run: cp -r packages/plugin-codex/memories_extensions/remnic/resources " +
      "packages/remnic-core/src/connectors/codex/",
  );
});

// ── Finding 3 (PR #394): rollback extension when config write fails ───────────

test("installConnector(codex-cli) rolls back extension when config write fails", async () => {
  const codexHome = await makeTempCodexHome();
  // Use a temp XDG_CONFIG_HOME so the config dir is predictable.
  const xdg = await makeTempRemnicConfigHome();

  // Derive the connectors dir from the same helper the code uses (issue #1518:
  // the canonical path is now remnic/.remnic-connectors, with engram as a
  // read-fallback). Resolve BEFORE creating the trap so we get the canonical
  // fresh-install path; creating a subdir under it then makes the active root
  // resolve there for the install too.
  const connectorsDir = getConnectorsDir();
  fs.mkdirSync(connectorsDir, { recursive: true });
  const configPath = path.join(connectorsDir, "codex-cli.json");
  // Create a directory at the config path so writeFileSync throws EISDIR.
  fs.mkdirSync(configPath, { recursive: true });

  try {
    const result = installConnector({
      connectorId: "codex-cli",
      config: { codexHome },
      force: true,
    });

    // Config write must fail, returning an error status.
    assert.equal(result.status, "error", `expected error status, got: ${result.status} — ${result.message}`);

    // The extension must have been rolled back — the remnic dir should not exist.
    const remnicDir = path.join(codexHome, "memories_extensions", "remnic");
    assert.ok(
      !fs.existsSync(remnicDir),
      `extension directory should be rolled back after config write failure, but found: ${remnicDir}`,
    );
  } finally {
    await rm(codexHome, { recursive: true, force: true });
    await rm(xdg, { recursive: true, force: true });
  }
});

// ── Finding 4 (PR #394): preserve malformed codex config when skipping cleanup ─

test("removeConnector(codex-cli) with malformed config leaves config and extension untouched", async () => {
  const codexHome = await makeTempCodexHome();
  const xdg = await makeTempRemnicConfigHome();

  try {
    // Install normally first so the extension directory exists.
    installConnector({
      connectorId: "codex-cli",
      config: { codexHome },
      force: true,
    });

    // Corrupt the saved config file at the path the install actually wrote
    // (issue #1518: fresh installs now write to remnic/.remnic-connectors;
    // use getConnectorsDir() so the test tracks the code's resolution
    // instead of a hardcoded path).
    const configPath = path.join(getConnectorsDir(), "codex-cli.json");
    fs.writeFileSync(configPath, "{ this is not valid JSON !!!!");

    const remnicDir = path.join(codexHome, "memories_extensions", "remnic");
    assert.ok(fs.existsSync(remnicDir), "extension dir should exist before removeConnector");
    assert.ok(fs.existsSync(configPath), "config should exist before removeConnector");

    // Run removeConnector — should abort gracefully.
    const result = removeConnector("codex-cli");

    // Config file must still exist (provenance preserved for retry).
    assert.ok(
      fs.existsSync(configPath),
      "malformed config file must NOT be deleted — operator needs it for inspection/retry",
    );

    // Extension directory must NOT have been touched.
    assert.ok(
      fs.existsSync(remnicDir),
      "extension directory must NOT be removed when config is malformed",
    );

    // Return value must signal the skip.
    assert.equal(
      result.status,
      "skipped",
      `expected status "skipped", got: ${result.status} — ${result.message}`,
    );
    assert.equal(result.reason, "config-parse-failed");
  } finally {
    await rm(codexHome, { recursive: true, force: true });
    await rm(xdg, { recursive: true, force: true });
  }
});
