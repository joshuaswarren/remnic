import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

// Supported public workspace packages. The workflow generates dependency-safe
// publish order from package metadata before any workspace package is published.
const expectedPublishDirs = [
  "packages/remnic-core",
  "packages/bench",
  "packages/export-weclone",
  "packages/import-weclone",
  "packages/import-chatgpt",
  "packages/import-claude",
  "packages/import-gemini",
  "packages/import-mem0",
  "packages/import-lossless-claw",
  "packages/import-supermemory",
  "packages/connector-weclone",
  "packages/connector-replit",
  "packages/connector-limitless",
  "packages/hermes-provider",
  "packages/belief-ledger",
  "packages/remnic-server",
  "packages/plugin-pi",
  "packages/remnic-cli",
  "packages/plugin-openclaw",
  "packages/plugin-claude-code",
  "packages/plugin-codex",
  "packages/shim-openclaw-engram",
] as const;
test("release workflow publish order matches the supported npm install surfaces", async () => {
  const workflow = await readFile(".github/workflows/release-and-publish.yml", "utf8");
  const order = spawnSync(process.execPath, ["scripts/publish-order.mjs", "--json"], {
    encoding: "utf8",
  });
  assert.equal(order.status, 0, order.stderr);
  const publishDirs = JSON.parse(order.stdout) as string[];

  assert.deepEqual([...publishDirs].sort(), [...expectedPublishDirs].sort());
  assert.match(
    workflow,
    /Checkout release source for publish[\s\S]*Install dependencies for release source[\s\S]*Generate workspace package publish order/,
  );
  assert.match(workflow, /cp scripts\/publish-order\.mjs "\$\{RUNNER_TEMP\}\/publish-order\.mjs"/);
  assert.match(workflow, /node "\$\{RUNNER_TEMP\}\/publish-order\.mjs" --repo-root "\$PWD" --output/);
  assert.match(workflow, /mapfile -t PUBLISH_ORDER/);
});

test("release workflow verifies the OpenClaw ClawHub packlist after build", async () => {
  const workflow = await readFile(".github/workflows/release-and-publish.yml", "utf8");
  const verifyScript = await readFile("scripts/verify-openclaw-clawpack.mjs", "utf8");

  assert.match(
    workflow,
    /Build all packages[\s\S]*Verify OpenClaw ClawHub artifact packlist[\s\S]*Publish root package to npm/,
    "release workflow must verify the built OpenClaw package before any publish step",
  );
  assert.match(
    workflow,
    /pnpm run verify:openclaw-clawpack/,
    "release workflow must call the OpenClaw ClawPack verifier",
  );
  assert.match(
    verifyScript,
    /dist\/index\.js/,
    "ClawPack verifier must require the OpenClaw runtime entrypoint",
  );
  assert.match(
    verifyScript,
    /packageJson\.openclaw\?\.extensions/,
    "ClawPack verifier must check every declared OpenClaw extension",
  );
  assert.match(
    verifyScript,
    /packageJson\.openclaw\?\.runtimeExtensions/,
    "ClawPack verifier must check every declared OpenClaw runtime extension",
  );
});

test("release workflow treats known ClawHub backend digest limits as nonfatal", async () => {
  const workflow = await readFile(".github/workflows/release-and-publish.yml", "utf8");

  assert.match(
    workflow,
    /Too many bytes read in a single function execution/,
    "release workflow must recognize ClawHub's Convex read-limit backend failure",
  );
  assert.ok(
    workflow.includes("syncPackage[A-Za-z]*SearchDigests?"),
    "release workflow must constrain the nonfatal skip to ClawHub search-digest failures " +
      "(matching both syncPackageSearchDigest and syncPackageCapabilitySearchDigests)",
  );
  assert.match(
    workflow,
    /ClawHub publish failed in its backend search-digest sync[\s\S]*exit 0/,
    "known external ClawHub backend failures should not block GitHub release creation after npm publish",
  );
  assert.match(
    workflow,
    /rm -f "\$\{publish_log\}"\n            exit "\$\{publish_status\}"/,
    "unknown ClawHub publish failures must remain fatal",
  );
});

test("@remnic/server build verifies declared bin artifacts", async () => {
  const packageJson = JSON.parse(await readFile("packages/remnic-server/package.json", "utf8"));

  assert.deepEqual(packageJson.bin, {
    "remnic-server": "./bin/remnic-server.js",
    "engram-server": "./bin/engram-server.js",
  });
  await assert.rejects(
    access("package-lock.json"),
    /ENOENT/,
    "root package-lock.json must stay absent because npm cannot resolve pnpm workspace: dependencies",
  );
  assert.ok(
    packageJson.files.includes("bin/*.js"),
    "@remnic/server package must include source-controlled bin wrappers",
  );
  const remnicServerBin = await readFile("packages/remnic-server/bin/remnic-server.js", "utf8");
  const engramServerBin = await readFile("packages/remnic-server/bin/engram-server.js", "utf8");
  const sharedServerBin = await readFile("packages/remnic-server/bin/server-bin.js", "utf8");
  assert.notEqual(remnicServerBin, engramServerBin, "bin wrappers must stay command-specific");
  assert.match(remnicServerBin, /runServerBin\("remnic-server"\)/);
  assert.match(engramServerBin, /runServerBin\("engram-server"\)/);
  assert.match(sharedServerBin, /export async function runServerBin/);
  assert.match(
    packageJson.scripts.build,
    /node scripts\/verify-bin\.mjs/,
    "@remnic/server build must verify the generated bin files before publish",
  );
  assert.match(
    packageJson.scripts.build,
    /^npm run check-types && tsup\b/,
    "@remnic/server build must typecheck before transpiling for publish",
  );
  assert.equal(packageJson.scripts["verify:bin"], "node scripts/verify-bin.mjs");
  assert.equal(packageJson.scripts.prepublishOnly, "npm run build");
});

test("@remnic/server bin wrapper help includes the CLI environment contract", async () => {
  // The source-controlled bin helper is plain JavaScript; keep this
  // test typed at the call site until it grows a declared TypeScript
  // export surface.
  const { runServerBin } = await import("../packages/remnic-server/bin/server-bin.js") as {
    runServerBin: (
      commandName: string,
      options: { argv: string[]; stdout: (text: string) => void },
    ) => Promise<void>;
  };
  const output: string[] = [];

  await runServerBin("remnic-server", {
    argv: ["--help"],
    stdout: (text) => output.push(text),
  });

  const help = output.join("");
  assert.match(help, /Environment:/);
  assert.match(help, /REMNIC_CONFIG_PATH/);
  assert.match(help, /REMNIC_MEMORY_DIR/);
  assert.match(help, /OPENAI_API_KEY/);
});

test("legacy OpenClaw Engram shim package ships its postinstall script", async () => {
  const packageJson = JSON.parse(
    await readFile("packages/shim-openclaw-engram/package.json", "utf8"),
  ) as {
    files?: string[];
    scripts?: Record<string, string>;
  };

  assert.equal(
    packageJson.scripts?.postinstall,
    "node ./scripts/postinstall-banner.mjs",
  );
  assert.ok(
    packageJson.files?.includes("scripts/postinstall-banner.mjs"),
    "postinstall-banner.mjs must be included in the packed shim package",
  );
});

test("@remnic/server bin verifier accepts Node executable bin targets", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "remnic-server-bin-ok-"));
  try {
    await mkdir(path.join(tempDir, "dist", "bin"), { recursive: true });
    await writeFile(
      path.join(tempDir, "package.json"),
      JSON.stringify({
        name: "@remnic/server",
        type: "module",
        bin: {
          "remnic-server": "./dist/bin/remnic-server.js",
        },
      }),
    );
    await writeFile(
      path.join(tempDir, "dist", "bin", "remnic-server.js"),
      [
        "#!/usr/bin/env node",
        "if (process.argv.includes('--help')) {",
        "  console.log('remnic-server help');",
        "  process.exit(0);",
        "}",
        "process.exit(1);",
      ].join("\n"),
    );

    const result = spawnSync(
      process.execPath,
      ["packages/remnic-server/scripts/verify-bin.mjs", tempDir],
      { cwd: process.cwd(), encoding: "utf8" },
    );

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Verified 1 @remnic\/server bin entries/);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("@remnic/server bin verifier rejects missing bin targets", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "remnic-server-bin-missing-"));
  try {
    await writeFile(
      path.join(tempDir, "package.json"),
      JSON.stringify({
        name: "@remnic/server",
        type: "module",
        bin: {
          "remnic-server": "./dist/bin/remnic-server.js",
        },
      }),
    );

    const result = spawnSync(
      process.execPath,
      ["packages/remnic-server/scripts/verify-bin.mjs", tempDir],
      { cwd: process.cwd(), encoding: "utf8" },
    );

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /points to missing file/);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("OpenClaw security scan wrapper handles minified skill scanner exports", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "remnic-openclaw-scan-"));
  try {
    const openclawDir = path.join(tempDir, "openclaw");
    const openclawDistDir = path.join(openclawDir, "dist");
    const pluginDir = path.join(tempDir, "plugin");
    await mkdir(openclawDistDir, { recursive: true });
    await mkdir(pluginDir, { recursive: true });
    await writeFile(
      path.join(openclawDir, "package.json"),
      JSON.stringify({ name: "openclaw", version: "2026.5.16-beta.3", type: "module" }),
    );
    await writeFile(
      path.join(openclawDistDir, "skill-scanner-fake.js"),
      [
        "function clearSkillScanCacheForTest() {}",
        "async function scanDirectoryWithSummary(dirPath) {",
        "  return { scannedFiles: 1, critical: 0, warn: 0, findings: [] };",
        "}",
        "export { scanDirectoryWithSummary as i, clearSkillScanCacheForTest as t };",
      ].join("\n"),
    );

    const result = spawnSync(
      process.execPath,
      ["scripts/openclaw-plugin-security-scan.mjs", pluginDir],
      {
        cwd: process.cwd(),
        env: { ...process.env, OPENCLAW_PACKAGE_DIR: openclawDir },
        encoding: "utf8",
      },
    );

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /OpenClaw 2026\.5\.16-beta\.3 scanner:/);
    assert.match(result.stdout, /scanned=1 critical=0 warn=0/);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("OpenClaw security scan wrapper handles current scanner bundle names", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "remnic-openclaw-scan-"));
  try {
    const openclawDir = path.join(tempDir, "openclaw");
    const openclawDistDir = path.join(openclawDir, "dist");
    const pluginDir = path.join(tempDir, "plugin");
    await mkdir(openclawDistDir, { recursive: true });
    await mkdir(pluginDir, { recursive: true });
    await writeFile(
      path.join(openclawDir, "package.json"),
      JSON.stringify({ name: "openclaw", version: "2026.5.30-beta.1", type: "module" }),
    );
    await writeFile(
      path.join(openclawDistDir, "scanner-fake.js"),
      [
        "export async function scanDirectoryWithSummary(dirPath) {",
        "  return { scannedFiles: 2, critical: 0, warn: 1, findings: [{ severity: 'warn', message: 'demo', file: dirPath, line: 1 }] };",
        "}",
      ].join("\n"),
    );

    const result = spawnSync(
      process.execPath,
      ["scripts/openclaw-plugin-security-scan.mjs", pluginDir],
      {
        cwd: process.cwd(),
        env: { ...process.env, OPENCLAW_PACKAGE_DIR: openclawDir },
        encoding: "utf8",
      },
    );

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /OpenClaw 2026\.5\.30-beta\.1 scanner:/);
    assert.match(result.stdout, /warn\tdemo\t/);
    assert.match(result.stdout, /scanned=2 critical=0 warn=1/);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});
