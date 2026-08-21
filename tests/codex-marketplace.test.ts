import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

import {
  generateMarketplaceManifest,
  validateMarketplaceManifest,
  checkMarketplaceManifest,
  writeMarketplaceManifest,
  installFromMarketplace,
  MARKETPLACE_SCHEMA_VERSION,
  MARKETPLACE_MANIFEST_FILENAME,
} from "../packages/remnic-core/src/connectors/codex-marketplace.js";
import { parseConfig } from "../packages/remnic-core/src/config.js";

// ── Helpers ─────────────────────────────────────────────────────────────────

function makeConfig(overrides?: Record<string, unknown>) {
  return parseConfig({ ...overrides });
}

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "remnic-marketplace-test-"));
}

function cleanupDir(dir: string) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // ignore
  }
}

// ── generateMarketplaceManifest ─────────────────────────────────────────────

test("generateMarketplaceManifest produces valid manifest with correct version", () => {
  const manifest = generateMarketplaceManifest({ packageVersion: "9.3.11" });

  assert.equal(manifest.version, MARKETPLACE_SCHEMA_VERSION);
  assert.equal(manifest.name, "remnic");
  assert.ok(manifest.description.length > 0);
  assert.equal(manifest.plugins.length, 1);

  const plugin = manifest.plugins[0];
  assert.equal(plugin.name, "remnic");
  assert.equal(plugin.version, "9.3.11");
  assert.equal(plugin.repository, "joshuaswarren/remnic");
  assert.equal(plugin.installType, "github");
  assert.equal(plugin.entry, "packages/plugin-codex");
  assert.equal(plugin.configSchema, "openclaw.plugin.json");
});

test("generateMarketplaceManifest defaults to 0.0.0 when no version supplied", () => {
  // Force no version discovery by passing undefined
  const manifest = generateMarketplaceManifest({ packageVersion: undefined });

  // Should fall back to readPackageVersion() or 0.0.0
  assert.ok(typeof manifest.plugins[0].version === "string");
  assert.ok(manifest.plugins[0].version.length > 0);
});

test("generateMarketplaceManifest output passes validation", () => {
  const manifest = generateMarketplaceManifest({ packageVersion: "1.0.0" });
  const validation = checkMarketplaceManifest(manifest);

  assert.ok(validation.valid, `validation failed: ${validation.errors.join("; ")}`);
});

// ── validateMarketplaceManifest ─────────────────────────────────────────────

test("validateMarketplaceManifest accepts valid manifest", () => {
  const valid = {
    version: 1,
    name: "test-marketplace",
    description: "Test marketplace",
    plugins: [
      {
        name: "test-plugin",
        version: "1.0.0",
        description: "A test plugin",
        repository: "owner/repo",
        installType: "github",
      },
    ],
  };

  const result = validateMarketplaceManifest(valid);
  assert.equal(result.version, 1);
  assert.equal(result.name, "test-marketplace");
  assert.equal(result.plugins.length, 1);
});

test("validateMarketplaceManifest rejects missing fields", () => {
  const cases = [
    { input: { version: 1, description: "d", plugins: [{ name: "n", version: "1", description: "d", repository: "r", installType: "github" }] }, missing: "name" },
    { input: { version: 1, name: "n", plugins: [{ name: "n", version: "1", description: "d", repository: "r", installType: "github" }] }, missing: "description" },
    { input: { version: 1, name: "n", description: "d" }, missing: "plugins" },
    { input: { version: 1, name: "n", description: "d", plugins: [] }, missing: "plugins (empty)" },
  ];

  for (const { input, missing } of cases) {
    assert.throws(
      () => validateMarketplaceManifest(input),
      (err: Error) => {
        assert.ok(err.message.includes("Invalid marketplace manifest"), `Expected validation error for missing ${missing}`);
        return true;
      },
    );
  }
});

test("validateMarketplaceManifest rejects invalid version", () => {
  const invalid = {
    version: 2,
    name: "test",
    description: "test",
    plugins: [
      {
        name: "p",
        version: "1.0.0",
        description: "d",
        repository: "r",
        installType: "github",
      },
    ],
  };

  assert.throws(
    () => validateMarketplaceManifest(invalid),
    (err: Error) => {
      assert.ok(err.message.includes("version must be 1"));
      return true;
    },
  );
});

test("validateMarketplaceManifest rejects invalid installType", () => {
  const invalid = {
    version: 1,
    name: "test",
    description: "test",
    plugins: [
      {
        name: "p",
        version: "1.0.0",
        description: "d",
        repository: "r",
        installType: "ftp",
      },
    ],
  };

  assert.throws(
    () => validateMarketplaceManifest(invalid),
    (err: Error) => {
      assert.ok(err.message.includes("installType"));
      return true;
    },
  );
});

test("validateMarketplaceManifest rejects null input", () => {
  assert.throws(
    () => validateMarketplaceManifest(null),
    (err: Error) => {
      assert.ok(err.message.includes("non-null object"));
      return true;
    },
  );
});

test("validateMarketplaceManifest rejects string input", () => {
  assert.throws(
    () => validateMarketplaceManifest("not an object"),
    (err: Error) => {
      assert.ok(err.message.includes("non-null object"));
      return true;
    },
  );
});

// ── checkMarketplaceManifest ────────────────────────────────────────────────

test("checkMarketplaceManifest returns structured errors without throwing", () => {
  const result = checkMarketplaceManifest({
    version: 99,
    name: "",
    description: "",
    plugins: "not-an-array",
  });

  assert.equal(result.valid, false);
  assert.ok(result.errors.length >= 3);
  assert.ok(result.errors.some((e) => e.includes("version")));
  assert.ok(result.errors.some((e) => e.includes("name")));
  assert.ok(result.errors.some((e) => e.includes("plugins")));
});

test("checkMarketplaceManifest validates plugin entry fields", () => {
  const result = checkMarketplaceManifest({
    version: 1,
    name: "test",
    description: "test",
    plugins: [
      {
        name: "",
        version: "",
        description: "",
        repository: "",
        installType: "invalid",
      },
    ],
  });

  assert.equal(result.valid, false);
  assert.ok(result.errors.length >= 4);
  assert.ok(result.errors.some((e) => e.includes("plugins[0].name")));
  assert.ok(result.errors.some((e) => e.includes("plugins[0].version")));
  assert.ok(result.errors.some((e) => e.includes("plugins[0].installType")));
});

// ── Optional field type validation (PR #427 post-merge) ───────────────────

test("checkMarketplaceManifest rejects malformed optional entry field", () => {
  const result = checkMarketplaceManifest({
    version: 1,
    name: "test",
    description: "test",
    plugins: [
      {
        name: "p",
        version: "1.0.0",
        description: "d",
        repository: "o/r",
        installType: "github",
        entry: 123,
      },
    ],
  });

  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes("plugins[0].entry")));
});

test("checkMarketplaceManifest rejects malformed optional manifestUrl field", () => {
  const result = checkMarketplaceManifest({
    version: 1,
    name: "test",
    description: "test",
    plugins: [
      {
        name: "p",
        version: "1.0.0",
        description: "d",
        repository: "o/r",
        installType: "github",
        manifestUrl: {},
      },
    ],
  });

  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes("plugins[0].manifestUrl")));
});

test("checkMarketplaceManifest rejects malformed optional configSchema field", () => {
  const result = checkMarketplaceManifest({
    version: 1,
    name: "test",
    description: "test",
    plugins: [
      {
        name: "p",
        version: "1.0.0",
        description: "d",
        repository: "o/r",
        installType: "github",
        configSchema: false,
      },
    ],
  });

  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes("plugins[0].configSchema")));
});

test("checkMarketplaceManifest rejects empty-string optional fields", () => {
  const result = checkMarketplaceManifest({
    version: 1,
    name: "test",
    description: "test",
    plugins: [
      {
        name: "p",
        version: "1.0.0",
        description: "d",
        repository: "o/r",
        installType: "github",
        entry: "",
        manifestUrl: "  ",
        configSchema: "",
      },
    ],
  });

  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes("plugins[0].entry")));
  assert.ok(result.errors.some((e) => e.includes("plugins[0].manifestUrl")));
  assert.ok(result.errors.some((e) => e.includes("plugins[0].configSchema")));
});

test("checkMarketplaceManifest accepts valid optional fields", () => {
  const result = checkMarketplaceManifest({
    version: 1,
    name: "test",
    description: "test",
    plugins: [
      {
        name: "p",
        version: "1.0.0",
        description: "d",
        repository: "o/r",
        installType: "github",
        entry: "packages/plugin",
        manifestUrl: "https://example.com/manifest.json",
        configSchema: "plugin.json",
      },
    ],
  });

  assert.equal(result.valid, true);
  assert.equal(result.errors.length, 0);
});

test("checkMarketplaceManifest accepts absent optional fields", () => {
  const result = checkMarketplaceManifest({
    version: 1,
    name: "test",
    description: "test",
    plugins: [
      {
        name: "p",
        version: "1.0.0",
        description: "d",
        repository: "o/r",
        installType: "github",
      },
    ],
  });

  assert.equal(result.valid, true);
  assert.equal(result.errors.length, 0);
});

// ── writeMarketplaceManifest ────────────────────────────────────────────────

test("writeMarketplaceManifest writes valid JSON to disk", async () => {
  const tmpDir = makeTmpDir();
  try {
    const manifest = {
      version: 1 as const,
      name: "write-test",
      description: "Test write",
      plugins: [
        {
          name: "test-plugin",
          version: "1.0.0",
          description: "Test plugin",
          repository: "owner/repo",
          installType: "github" as const,
        },
      ],
    };

    await writeMarketplaceManifest(tmpDir, manifest);

    const outPath = path.join(tmpDir, MARKETPLACE_MANIFEST_FILENAME);
    assert.ok(fs.existsSync(outPath), "marketplace.json should exist");

    const written = JSON.parse(fs.readFileSync(outPath, "utf-8"));
    assert.equal(written.version, 1);
    assert.equal(written.name, "write-test");
    assert.equal(written.plugins.length, 1);
    assert.equal(written.plugins[0].name, "test-plugin");
  } finally {
    cleanupDir(tmpDir);
  }
});

test("writeMarketplaceManifest rejects invalid manifest", async () => {
  const tmpDir = makeTmpDir();
  try {
    const invalid = {
      version: 99 as any,
      name: "bad",
      description: "bad",
      plugins: [],
    };

    await assert.rejects(
      () => writeMarketplaceManifest(tmpDir, invalid as any),
      (err: Error) => {
        assert.ok(err.message.includes("Refusing to write invalid manifest"));
        return true;
      },
    );
  } finally {
    cleanupDir(tmpDir);
  }
});

test("writeMarketplaceManifest creates parent directories", async () => {
  const tmpDir = makeTmpDir();
  const nested = path.join(tmpDir, "a", "b", "c");
  try {
    const manifest = {
      version: 1 as const,
      name: "nested-test",
      description: "Nested dir test",
      plugins: [
        {
          name: "p",
          version: "1.0.0",
          description: "d",
          repository: "o/r",
          installType: "github" as const,
        },
      ],
    };

    await writeMarketplaceManifest(nested, manifest);
    assert.ok(fs.existsSync(path.join(nested, MARKETPLACE_MANIFEST_FILENAME)));
  } finally {
    cleanupDir(tmpDir);
  }
});

// ── installFromMarketplace — local ─────────────────────────────────────────

test("installFromMarketplace reads local marketplace.json correctly", async () => {
  const tmpDir = makeTmpDir();
  try {
    const manifest = {
      version: 1,
      name: "local-test",
      description: "Local marketplace test",
      plugins: [
        {
          name: "local-plugin",
          version: "2.0.0",
          description: "A local plugin",
          repository: "local/repo",
          installType: "local",
        },
      ],
    };
    fs.writeFileSync(
      path.join(tmpDir, "marketplace.json"),
      JSON.stringify(manifest, null, 2),
    );

    const config = makeConfig();
    const result = await installFromMarketplace(tmpDir, "local", config);

    assert.equal(result.ok, true);
    assert.equal(result.sourceType, "local");
    assert.deepEqual(result.pluginsFound, ["local-plugin"]);
    assert.equal(result.errors.length, 0);
  } finally {
    cleanupDir(tmpDir);
  }
});

test("installFromMarketplace fails for missing local directory", async () => {
  const config = makeConfig();
  const result = await installFromMarketplace(
    "/nonexistent/path",
    "local",
    config,
  );

  assert.equal(result.ok, false);
  assert.ok(result.errors.length > 0);
  assert.ok(result.message.includes("Failed"));
});

test("installFromMarketplace fails when marketplace disabled", async () => {
  const config = makeConfig({ codexMarketplaceEnabled: false });
  const result = await installFromMarketplace(
    "/some/path",
    "local",
    config,
  );

  assert.equal(result.ok, false);
  assert.ok(result.message.includes("disabled"));
  assert.deepEqual(result.pluginsFound, []);
});

// ── installFromMarketplace — URL (mock) ─────────────────────────────────────

test("installFromMarketplace handles invalid URL", async () => {
  const config = makeConfig();
  const result = await installFromMarketplace(
    "not-a-url",
    "url",
    config,
  );

  assert.equal(result.ok, false);
  assert.ok(result.errors.length > 0);
});

// ── installFromMarketplace — GitHub (format check) ─────────────────────────

test("installFromMarketplace rejects invalid GitHub repo format", async () => {
  const config = makeConfig();
  const result = await installFromMarketplace(
    "not-a-valid-repo",
    "github",
    config,
  );

  assert.equal(result.ok, false);
  assert.ok(result.errors.length > 0);
  assert.ok(result.message.includes("Invalid GitHub repo format"));
});

// ── Root marketplace.json validity ──────────────────────────────────────────

test("root marketplace.json is valid per the marketplace schema", () => {
  const rootDir = path.resolve(import.meta.dirname ?? ".", "..");
  const manifestPath = path.join(rootDir, "marketplace.json");

  assert.ok(fs.existsSync(manifestPath), "root marketplace.json should exist");

  const raw = fs.readFileSync(manifestPath, "utf-8");
  const parsed = JSON.parse(raw);

  const validation = checkMarketplaceManifest(parsed);
  if (!validation.valid) {
    assert.fail(`root marketplace.json validation failed: ${validation.errors.join("; ")}`);
  }

  assert.equal(parsed.version, 1);
  assert.equal(parsed.name, "remnic");
  assert.ok(parsed.plugins.length >= 1);
  assert.equal(parsed.plugins[0].name, "remnic");
});

// ── Config integration ──────────────────────────────────────────────────────

test("parseConfig defaults codexMarketplaceEnabled to true", () => {
  const config = parseConfig({});
  assert.equal(config.codexMarketplaceEnabled, true);
});

test("parseConfig respects codexMarketplaceEnabled: false", () => {
  const config = parseConfig({ codexMarketplaceEnabled: false });
  assert.equal(config.codexMarketplaceEnabled, false);
});

// ── MARKETPLACE_MANIFEST_FILENAME constant ──────────────────────────────────

test("MARKETPLACE_MANIFEST_FILENAME is marketplace.json", () => {
  assert.equal(MARKETPLACE_MANIFEST_FILENAME, "marketplace.json");
});

test("MARKETPLACE_SCHEMA_VERSION is 1", () => {
  assert.equal(MARKETPLACE_SCHEMA_VERSION, 1);
});
