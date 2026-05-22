import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { chmod, mkdtemp, mkdir, readFile, stat, symlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import {
  migrateFromEngram,
  rollbackFromEngramMigration,
} from "../src/migrate/from-engram.js";

async function makeTempHome(prefix: string): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), prefix));
}

async function makeExitedPid(): Promise<number> {
  const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
  assert.ok(child.pid, "expected child process pid");
  await new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", () => resolve());
  });
  return child.pid;
}

async function setModeIfPosix(filePath: string, mode: number): Promise<void> {
  if (process.platform !== "win32") {
    await chmod(filePath, mode);
  }
}

async function assertOwnerOnlyMode(filePath: string): Promise<void> {
  await assertFileMode(filePath, 0o600);
}

async function assertFileMode(filePath: string, expectedMode: number): Promise<void> {
  if (process.platform === "win32") return;
  const mode = (await stat(filePath)).mode & 0o777;
  assert.equal(
    mode,
    expectedMode,
    `${filePath} should have mode ${expectedMode.toString(8)}`,
  );
}

test("migrateFromEngram returns fresh-install when no legacy Engram state exists", async () => {
  const homeDir = await makeTempHome("remnic-migrate-fresh-");

  const result = await migrateFromEngram({
    homeDir,
    cwd: homeDir,
    quiet: true,
  });

  assert.equal(result.status, "fresh-install");
  assert.deepEqual(result.copied, []);
  assert.equal(result.tokensRegenerated, 0);
  assert.equal(existsSync(path.join(homeDir, ".remnic", ".migrated-from-engram")), false);
});

test("migrateFromEngram copies legacy state, rewrites tokens, updates connector config, and installs remnic service files", async () => {
  const homeDir = await makeTempHome("remnic-migrate-legacy-");
  const cwd = path.join(homeDir, "repo");
  const claudeConfig = path.join(cwd, "packages", "plugin-claude-code", ".mcp.json");
  const codexConfig = path.join(cwd, "packages", "plugin-codex", ".mcp.json");
  const legacyRoot = path.join(homeDir, ".engram");
  const legacyConfig = path.join(homeDir, ".config", "engram", "config.json");
  const legacyLaunchAgent = path.join(homeDir, "Library", "LaunchAgents", "ai.engram.daemon.plist");
  const execCalls: Array<{ command: string; args: string[] }> = [];

  await mkdir(path.join(legacyRoot, "logs"), { recursive: true });
  await mkdir(path.dirname(legacyConfig), { recursive: true });
  await mkdir(path.dirname(claudeConfig), { recursive: true });
  await mkdir(path.dirname(codexConfig), { recursive: true });
  await mkdir(path.dirname(legacyLaunchAgent), { recursive: true });

  const legacyTokensPath = path.join(legacyRoot, "tokens.json");
  await writeFile(
    legacyTokensPath,
    JSON.stringify({
      tokens: [
        { connector: "claude-code", token: "engram_cc_abc123", createdAt: "2026-04-08T00:00:00.000Z" },
      ],
    }),
    "utf8",
  );
  await setModeIfPosix(legacyTokensPath, 0o644);
  await writeFile(path.join(legacyRoot, "logs", "daemon.log"), "legacy log\n", "utf8");
  await writeFile(
    legacyConfig,
    JSON.stringify({
      engram: {
        memoryDir: path.join(homeDir, ".engram", "memory"),
      },
    }),
    "utf8",
  );
  await writeFile(
    claudeConfig,
    JSON.stringify({
      mcpServers: {
        engram: {
          headers: {
            Authorization: "Bearer {{ENGRAM_TOKEN}}",
            "X-Engram-Client-Id": "claude-code",
          },
        },
      },
    }),
    "utf8",
  );
  await writeFile(
    codexConfig,
    JSON.stringify({
      mcpServers: {
        engram: {
          headers: {
            Authorization: "Bearer {{ENGRAM_TOKEN}}",
            "X-Engram-Client-Id": "codex",
          },
        },
      },
    }),
    "utf8",
  );
  await writeFile(
    legacyLaunchAgent,
    [
      "<plist>",
      "<string>ai.engram.daemon</string>",
      "<string>~/.engram/server.log</string>",
      "<key>ENGRAM_CONFIG_PATH</key>",
      "</plist>",
    ].join("\n"),
    "utf8",
  );

  const result = await migrateFromEngram({
    homeDir,
    cwd,
    quiet: true,
    platform: "darwin",
    connectorConfigPaths: [claudeConfig, codexConfig],
    execCommand: (command, args) => execCalls.push({ command, args }),
  });

  assert.equal(result.status, "migrated");
  assert.equal(result.tokensRegenerated, 1);
  assert.ok(existsSync(path.join(homeDir, ".remnic", ".migrated-from-engram")));
  assert.ok(existsSync(path.join(homeDir, ".remnic", ".rollback.json")));
  assert.ok(existsSync(path.join(homeDir, ".remnic", "logs", "daemon.log")));
  assert.ok(existsSync(path.join(homeDir, ".config", "remnic", "config.json")));
  assert.ok(existsSync(path.join(homeDir, "Library", "LaunchAgents", "ai.remnic.daemon.plist")));
  assert.deepEqual(result.servicesReinstalled, ["ai.remnic.daemon"]);

  const remnicTokensPath = path.join(homeDir, ".remnic", "tokens.json");
  const tokens = JSON.parse(await readFile(remnicTokensPath, "utf8")) as {
    tokens: Array<{ token: string }>;
  };
  assert.equal(tokens.tokens[0]?.token, "remnic_cc_abc123");
  await assertOwnerOnlyMode(remnicTokensPath);

  const migratedConfig = JSON.parse(await readFile(path.join(homeDir, ".config", "remnic", "config.json"), "utf8")) as {
    remnic?: { memoryDir?: string };
  };
  assert.equal(migratedConfig.remnic?.memoryDir, path.join(homeDir, ".remnic", "memory"));

  const claude = JSON.parse(await readFile(claudeConfig, "utf8")) as {
    mcpServers: Record<string, { headers: { Authorization: string } }>;
  };
  assert.ok(claude.mcpServers.remnic);
  assert.equal(claude.mcpServers.remnic.headers.Authorization, "Bearer {{REMNIC_TOKEN}}");
  assert.equal(claude.mcpServers.engram, undefined);

  const remnicLaunchAgent = await readFile(
    path.join(homeDir, "Library", "LaunchAgents", "ai.remnic.daemon.plist"),
    "utf8",
  );
  assert.match(remnicLaunchAgent, /ai\.remnic\.daemon/);
  assert.match(remnicLaunchAgent, /\.remnic\/server\.log/);
  assert.match(remnicLaunchAgent, /REMNIC_CONFIG_PATH/);

  assert.deepEqual(
    execCalls.map((entry) => [entry.command, ...entry.args]),
    [
      ["launchctl", "unload", legacyLaunchAgent],
      ["launchctl", "load", "-w", path.join(homeDir, "Library", "LaunchAgents", "ai.remnic.daemon.plist")],
    ],
  );
});

test("migrateFromEngram skips connector configs with valid non-object JSON", async () => {
  const homeDir = await makeTempHome("remnic-migrate-non-object-config-");
  const cwd = path.join(homeDir, "repo");
  const legacyConfig = path.join(homeDir, ".config", "engram", "config.json");
  const nullConfig = path.join(cwd, "null.mcp.json");
  const arrayConfig = path.join(cwd, "array.mcp.json");
  const stringConfig = path.join(cwd, "string.mcp.json");
  const invalidConfig = path.join(cwd, "invalid.mcp.json");

  await mkdir(path.dirname(legacyConfig), { recursive: true });
  await mkdir(cwd, { recursive: true });
  await writeFile(legacyConfig, "null\n", "utf8");
  await writeFile(nullConfig, "null\n", "utf8");
  await writeFile(arrayConfig, "[]\n", "utf8");
  await writeFile(stringConfig, '"engram"\n', "utf8");
  await writeFile(invalidConfig, '{"mcpServers":{"engram":', "utf8");

  const result = await migrateFromEngram({
    homeDir,
    cwd,
    quiet: true,
    connectorConfigPaths: [nullConfig, arrayConfig, stringConfig, invalidConfig],
  });

  assert.equal(result.status, "migrated");
  assert.equal(await readFile(nullConfig, "utf8"), "null\n");
  assert.equal(await readFile(arrayConfig, "utf8"), "[]\n");
  assert.equal(await readFile(stringConfig, "utf8"), '"engram"\n');
  assert.equal(await readFile(invalidConfig, "utf8"), '{"mcpServers":{"engram":');
  assert.equal(await readFile(path.join(homeDir, ".config", "remnic", "config.json"), "utf8"), "null\n");

  const manifest = JSON.parse(await readFile(path.join(homeDir, ".remnic", ".rollback.json"), "utf8")) as {
    entries: Array<{ targetPath: string }>;
  };
  const backedUpTargets = manifest.entries.map((entry) => entry.targetPath);
  assert.equal(backedUpTargets.includes(nullConfig), false);
  assert.equal(backedUpTargets.includes(arrayConfig), false);
  assert.equal(backedUpTargets.includes(stringConfig), false);
  assert.equal(backedUpTargets.includes(invalidConfig), false);
});

test("migrateFromEngram skips legacy file symlinks without copying external target content", {
  skip: process.platform === "win32",
}, async () => {
  const homeDir = await makeTempHome("remnic-migrate-file-symlink-");
  const legacyRoot = path.join(homeDir, ".engram");
  const externalSecret = path.join(homeDir, "outside-secret.txt");
  const legacyLink = path.join(legacyRoot, "copied-key");
  const remnicLinkDestination = path.join(homeDir, ".remnic", "copied-key");

  await mkdir(legacyRoot, { recursive: true });
  await writeFile(path.join(legacyRoot, "tokens.json"), JSON.stringify({ tokens: [] }), "utf8");
  await writeFile(externalSecret, "synthetic external secret", "utf8");
  await symlink(externalSecret, legacyLink);

  const result = await migrateFromEngram({
    homeDir,
    cwd: homeDir,
    quiet: true,
  });

  assert.equal(result.status, "migrated");
  assert.equal(existsSync(remnicLinkDestination), false);
  assert.equal(result.copied.includes(remnicLinkDestination), false);
});

test("migrateFromEngram skips legacy directory symlinks without traversing outside the legacy root", {
  skip: process.platform === "win32",
}, async () => {
  const homeDir = await makeTempHome("remnic-migrate-dir-symlink-");
  const legacyRoot = path.join(homeDir, ".engram");
  const externalDir = path.join(homeDir, "outside-dir");
  const legacyLink = path.join(legacyRoot, "linked-dir");
  const remnicLinkedFile = path.join(homeDir, ".remnic", "linked-dir", "secret.txt");

  await mkdir(legacyRoot, { recursive: true });
  await mkdir(externalDir, { recursive: true });
  await writeFile(path.join(legacyRoot, "tokens.json"), JSON.stringify({ tokens: [] }), "utf8");
  await writeFile(path.join(externalDir, "secret.txt"), "synthetic external directory secret", "utf8");
  await symlink(externalDir, legacyLink, "dir");

  const result = await migrateFromEngram({
    homeDir,
    cwd: homeDir,
    quiet: true,
  });

  assert.equal(result.status, "migrated");
  assert.equal(existsSync(remnicLinkedFile), false);
  assert.equal(result.copied.includes(remnicLinkedFile), false);
});

test("migrateFromEngram rejects a symlinked legacy root before writing the marker", {
  skip: process.platform === "win32",
}, async () => {
  const homeDir = await makeTempHome("remnic-migrate-root-symlink-");
  const externalLegacyRoot = path.join(homeDir, "external-engram");
  const legacyRoot = path.join(homeDir, ".engram");

  await mkdir(externalLegacyRoot, { recursive: true });
  await writeFile(path.join(externalLegacyRoot, "tokens.json"), JSON.stringify({ tokens: [] }), "utf8");
  await symlink(externalLegacyRoot, legacyRoot, "dir");

  await assert.rejects(
    migrateFromEngram({
      homeDir,
      cwd: homeDir,
      quiet: true,
    }),
    /legacy migration root must not be a symlink/,
  );

  assert.equal(existsSync(path.join(homeDir, ".remnic", ".migrated-from-engram")), false);
});

test("migrateFromEngram skips symlinked connector configs without rewriting the target", {
  skip: process.platform === "win32",
}, async () => {
  const homeDir = await makeTempHome("remnic-migrate-connector-config-symlink-");
  const legacyRoot = path.join(homeDir, ".engram");
  const outsideConfig = path.join(homeDir, "outside-connector.json");
  const connectorLink = path.join(homeDir, ".claude.json");

  await mkdir(legacyRoot, { recursive: true });
  await writeFile(path.join(legacyRoot, "tokens.json"), JSON.stringify({ tokens: [] }), "utf8");
  await writeFile(
    outsideConfig,
    JSON.stringify({ mcpServers: { engram: { command: "engram" } } }, null, 2),
    "utf8",
  );
  await symlink(outsideConfig, connectorLink);

  const result = await migrateFromEngram({
    homeDir,
    cwd: homeDir,
    quiet: true,
    connectorConfigPaths: [connectorLink],
  });

  assert.equal(result.status, "migrated");
  const outside = JSON.parse(await readFile(outsideConfig, "utf8")) as {
    mcpServers: Record<string, unknown>;
  };
  assert.ok(outside.mcpServers.engram);
  assert.equal(outside.mcpServers.remnic, undefined);
});

test("migrateFromEngram skips symlinked legacy config copies", {
  skip: process.platform === "win32",
}, async () => {
  const homeDir = await makeTempHome("remnic-migrate-legacy-config-symlink-");
  const legacyRoot = path.join(homeDir, ".engram");
  const legacyConfig = path.join(homeDir, ".config", "engram", "config.json");
  const outsideConfig = path.join(homeDir, "outside-config.json");
  const remnicConfig = path.join(homeDir, ".config", "remnic", "config.json");

  await mkdir(legacyRoot, { recursive: true });
  await mkdir(path.dirname(legacyConfig), { recursive: true });
  await writeFile(path.join(legacyRoot, "tokens.json"), JSON.stringify({ tokens: [] }), "utf8");
  await writeFile(outsideConfig, JSON.stringify({ engram: { memoryDir: "/outside" } }), "utf8");
  await symlink(outsideConfig, legacyConfig);

  const result = await migrateFromEngram({ homeDir, cwd: homeDir, quiet: true });

  assert.equal(result.status, "migrated");
  assert.equal(existsSync(remnicConfig), false);
  assert.equal(result.copied.includes(remnicConfig), false);
});

test("migrateFromEngram rejects symlinked legacy token stores before marker write", {
  skip: process.platform === "win32",
}, async () => {
  const homeDir = await makeTempHome("remnic-migrate-token-symlink-");
  const legacyRoot = path.join(homeDir, ".engram");
  const outsideTokens = path.join(homeDir, "outside-tokens.json");

  await mkdir(legacyRoot, { recursive: true });
  await writeFile(outsideTokens, JSON.stringify({ tokens: [] }), "utf8");
  await symlink(outsideTokens, path.join(legacyRoot, "tokens.json"));

  await assert.rejects(
    migrateFromEngram({ homeDir, cwd: homeDir, quiet: true }),
    /legacy Engram token store must not be a symlink/,
  );
  assert.equal(existsSync(path.join(homeDir, ".remnic", ".migrated-from-engram")), false);
});

test("migrateFromEngram is idempotent after the marker is written", async () => {
  const homeDir = await makeTempHome("remnic-migrate-idempotent-");

  await mkdir(path.join(homeDir, ".engram"), { recursive: true });
  await writeFile(path.join(homeDir, ".engram", "tokens.json"), JSON.stringify({ tokens: [] }), "utf8");

  const first = await migrateFromEngram({ homeDir, cwd: homeDir, quiet: true });
  const second = await migrateFromEngram({ homeDir, cwd: homeDir, quiet: true });

  assert.equal(first.status, "migrated");
  assert.equal(second.status, "already-migrated");
});

test("migrateFromEngram tightens copied token store permissions even when tokens do not need rewriting", async () => {
  const homeDir = await makeTempHome("remnic-migrate-token-copy-mode-");
  const legacyRoot = path.join(homeDir, ".engram");
  const remnicRoot = path.join(homeDir, ".remnic");
  const legacyTokensPath = path.join(legacyRoot, "tokens.json");
  const remnicTokensPath = path.join(remnicRoot, "tokens.json");

  await mkdir(legacyRoot, { recursive: true });
  await writeFile(
    legacyTokensPath,
    JSON.stringify({
      tokens: [
        { connector: "claude-code", token: "remnic_cc_already", createdAt: "2026-04-08T00:00:00.000Z" },
      ],
    }),
    "utf8",
  );
  await setModeIfPosix(legacyTokensPath, 0o644);

  const result = await migrateFromEngram({
    homeDir,
    cwd: homeDir,
    quiet: true,
  });

  assert.equal(result.status, "migrated");
  assert.equal(result.tokensRegenerated, 0);
  await assertOwnerOnlyMode(remnicTokensPath);
});

test("migrateFromEngram tightens rewritten existing token store permissions without legacy tokens", async () => {
  const homeDir = await makeTempHome("remnic-migrate-token-rewrite-mode-");
  const legacyRoot = path.join(homeDir, ".engram");
  const remnicRoot = path.join(homeDir, ".remnic");
  const remnicTokensPath = path.join(remnicRoot, "tokens.json");

  await mkdir(legacyRoot, { recursive: true });
  await mkdir(remnicRoot, { recursive: true });
  await writeFile(
    remnicTokensPath,
    JSON.stringify({
      tokens: [
        { connector: "openclaw", token: "engram_oc_existing", createdAt: "2026-04-09T00:00:00.000Z" },
      ],
    }),
    "utf8",
  );
  await setModeIfPosix(remnicTokensPath, 0o644);

  const result = await migrateFromEngram({
    homeDir,
    cwd: homeDir,
    quiet: true,
  });

  assert.equal(result.status, "migrated");
  assert.equal(result.tokensRegenerated, 1);
  const tokens = JSON.parse(await readFile(remnicTokensPath, "utf8")) as {
    tokens: Array<{ connector: string; token: string }>;
  };
  assert.deepEqual(tokens.tokens.map(({ connector, token }) => ({ connector, token })), [
    { connector: "openclaw", token: "remnic_oc_existing" },
  ]);
  await assertOwnerOnlyMode(remnicTokensPath);
});

test("migrateFromEngram tightens unchanged merged token store permissions", async () => {
  const homeDir = await makeTempHome("remnic-migrate-token-unchanged-merge-mode-");
  const legacyRoot = path.join(homeDir, ".engram");
  const remnicRoot = path.join(homeDir, ".remnic");
  const remnicTokensPath = path.join(remnicRoot, "tokens.json");

  await mkdir(legacyRoot, { recursive: true });
  await mkdir(remnicRoot, { recursive: true });
  await writeFile(
    path.join(legacyRoot, "tokens.json"),
    JSON.stringify({
      tokens: [
        { connector: "claude-code", token: "remnic_cc_legacy", createdAt: "2026-04-08T00:00:00.000Z" },
      ],
    }),
    "utf8",
  );
  await writeFile(
    remnicTokensPath,
    JSON.stringify({
      tokens: [
        { connector: "claude-code", token: "remnic_cc_current", createdAt: "2026-04-09T00:00:00.000Z" },
      ],
    }),
    "utf8",
  );
  await setModeIfPosix(remnicTokensPath, 0o644);

  const result = await migrateFromEngram({
    homeDir,
    cwd: homeDir,
    quiet: true,
  });

  assert.equal(result.status, "migrated");
  assert.equal(result.tokensRegenerated, 0);
  const tokens = JSON.parse(await readFile(remnicTokensPath, "utf8")) as {
    tokens: Array<{ connector: string; token: string }>;
  };
  assert.deepEqual(tokens.tokens.map(({ connector, token }) => ({ connector, token })), [
    { connector: "claude-code", token: "remnic_cc_current" },
  ]);
  await assertOwnerOnlyMode(remnicTokensPath);
});

test("migrateFromEngram merges legacy tokens into an existing remnic token store", async () => {
  const homeDir = await makeTempHome("remnic-migrate-token-merge-");
  const legacyRoot = path.join(homeDir, ".engram");
  const remnicRoot = path.join(homeDir, ".remnic");
  const remnicTokensPath = path.join(remnicRoot, "tokens.json");

  await mkdir(legacyRoot, { recursive: true });
  await mkdir(remnicRoot, { recursive: true });
  await writeFile(
    path.join(legacyRoot, "tokens.json"),
    JSON.stringify({
      tokens: [
        { connector: "claude-code", token: "engram_cc_legacy", createdAt: "2026-04-08T00:00:00.000Z" },
        { connector: "codex", token: "engram_cx_legacy", createdAt: "2026-04-08T00:00:00.000Z" },
      ],
    }),
    "utf8",
  );
  await writeFile(
    remnicTokensPath,
    JSON.stringify({
      tokens: [
        { connector: "claude-code", token: "remnic_cc_current", createdAt: "2026-04-09T00:00:00.000Z" },
        { connector: "openclaw", token: "engram_oc_existing", createdAt: "2026-04-09T00:00:00.000Z" },
      ],
    }),
    "utf8",
  );
  await setModeIfPosix(remnicTokensPath, 0o644);

  const result = await migrateFromEngram({
    homeDir,
    cwd: homeDir,
    quiet: true,
  });

  assert.equal(result.status, "migrated");
  assert.equal(result.tokensRegenerated, 3);

  const tokens = JSON.parse(await readFile(remnicTokensPath, "utf8")) as {
    tokens: Array<{ connector: string; token: string }>;
  };
  assert.deepEqual(tokens.tokens.map(({ connector, token }) => ({ connector, token })), [
    { connector: "claude-code", token: "remnic_cc_current" },
    { connector: "openclaw", token: "remnic_oc_existing" },
    { connector: "codex", token: "remnic_cx_legacy" },
  ]);
  await assertOwnerOnlyMode(remnicTokensPath);

  const manifest = JSON.parse(await readFile(path.join(remnicRoot, ".rollback.json"), "utf8")) as {
    entries: Array<{ targetPath: string; backupPath?: string }>;
  };
  const tokenBackupPath = manifest.entries.find((entry) => entry.targetPath === remnicTokensPath)?.backupPath;
  assert.ok(tokenBackupPath, "expected token store backup in rollback manifest");
  await assertOwnerOnlyMode(tokenBackupPath);

  const rollback = await rollbackFromEngramMigration({ homeDir, cwd: homeDir, quiet: true });
  assert.ok(rollback.restored.includes(remnicTokensPath));
  await assertOwnerOnlyMode(remnicTokensPath);
});

test("migrateFromEngram recovers from a malformed remnic token store by rebuilding from legacy tokens", async () => {
  const homeDir = await makeTempHome("remnic-migrate-token-recovery-");
  const legacyRoot = path.join(homeDir, ".engram");
  const remnicRoot = path.join(homeDir, ".remnic");
  const remnicTokensPath = path.join(remnicRoot, "tokens.json");

  await mkdir(legacyRoot, { recursive: true });
  await mkdir(remnicRoot, { recursive: true });
  await writeFile(
    path.join(legacyRoot, "tokens.json"),
    JSON.stringify({
      tokens: [
        { connector: "claude-code", token: "engram_cc_legacy", createdAt: "2026-04-08T00:00:00.000Z" },
        { connector: "codex", token: "engram_cx_legacy", createdAt: "2026-04-08T00:00:00.000Z" },
      ],
    }),
    "utf8",
  );
  await writeFile(remnicTokensPath, "{", "utf8");
  await setModeIfPosix(remnicTokensPath, 0o644);

  const result = await migrateFromEngram({
    homeDir,
    cwd: homeDir,
    quiet: true,
  });

  assert.equal(result.status, "migrated");
  assert.equal(result.tokensRegenerated, 2);

  const tokens = JSON.parse(await readFile(remnicTokensPath, "utf8")) as {
    tokens: Array<{ connector: string; token: string }>;
  };
  assert.deepEqual(tokens.tokens.map(({ connector, token }) => ({ connector, token })), [
    { connector: "claude-code", token: "remnic_cc_legacy" },
    { connector: "codex", token: "remnic_cx_legacy" },
  ]);
  await assertOwnerOnlyMode(remnicTokensPath);
});

test("migrateFromEngram rejects existing remnic token-store symlinks", async () => {
  const homeDir = await makeTempHome("remnic-migrate-token-symlink-");
  const legacyRoot = path.join(homeDir, ".engram");
  const remnicRoot = path.join(homeDir, ".remnic");
  const remnicTokensPath = path.join(remnicRoot, "tokens.json");
  const externalTokensPath = path.join(homeDir, "external-tokens.json");
  const externalOriginal = JSON.stringify({ tokens: [{ connector: "external", token: "keep", createdAt: "2026-04-08T00:00:00.000Z" }] });

  await mkdir(legacyRoot, { recursive: true });
  await mkdir(remnicRoot, { recursive: true });
  await writeFile(
    path.join(legacyRoot, "tokens.json"),
    JSON.stringify({
      tokens: [
        { connector: "codex", token: "engram_cx_legacy", createdAt: "2026-04-08T00:00:00.000Z" },
      ],
    }),
    "utf8",
  );
  await writeFile(externalTokensPath, externalOriginal, "utf8");
  try {
    await symlink(externalTokensPath, remnicTokensPath);
  } catch {
    return;
  }

  await assert.rejects(
    () => migrateFromEngram({
      homeDir,
      cwd: homeDir,
      quiet: true,
    }),
    /Remnic token store must not be a symlink/,
  );

  assert.equal(await readFile(externalTokensPath, "utf8"), externalOriginal);
  assert.equal(existsSync(path.join(homeDir, ".remnic", ".migrated-from-engram")), false);
});

test("migrateFromEngram clears malformed migration locks before acquiring a fresh lock", async () => {
  const homeDir = await makeTempHome("remnic-migrate-lock-recovery-");
  const legacyRoot = path.join(homeDir, ".engram");
  const remnicRoot = path.join(homeDir, ".remnic");

  await mkdir(legacyRoot, { recursive: true });
  await mkdir(remnicRoot, { recursive: true });
  await writeFile(path.join(legacyRoot, "tokens.json"), JSON.stringify({ tokens: [] }), "utf8");
  await writeFile(path.join(remnicRoot, ".migration.lock"), "", "utf8");

  const result = await migrateFromEngram({
    homeDir,
    cwd: homeDir,
    quiet: true,
  });

  assert.equal(result.status, "migrated");
  assert.equal(existsSync(path.join(remnicRoot, ".migration.lock")), false);
  assert.equal(existsSync(path.join(remnicRoot, ".migrated-from-engram")), true);
});

test("migrateFromEngram clears migration locks from dead processes immediately", async () => {
  const homeDir = await makeTempHome("remnic-migrate-dead-lock-");
  const legacyRoot = path.join(homeDir, ".engram");
  const remnicRoot = path.join(homeDir, ".remnic");
  const lockPath = path.join(remnicRoot, ".migration.lock");
  const deadPid = await makeExitedPid();

  await mkdir(legacyRoot, { recursive: true });
  await mkdir(remnicRoot, { recursive: true });
  await writeFile(path.join(legacyRoot, "tokens.json"), JSON.stringify({ tokens: [] }), "utf8");
  await writeFile(lockPath, `${deadPid}\n${Date.now()}\n`, "utf8");

  const result = await migrateFromEngram({
    homeDir,
    cwd: homeDir,
    quiet: true,
  });

  assert.equal(result.status, "migrated");
  assert.equal(existsSync(lockPath), false);
  assert.equal(existsSync(path.join(remnicRoot, ".migrated-from-engram")), true);
});

test("migrateFromEngram clears unreadable migration locks before acquiring a fresh lock", {
  skip: process.platform === "win32",
}, async () => {
  const homeDir = await makeTempHome("remnic-migrate-unreadable-lock-");
  const legacyRoot = path.join(homeDir, ".engram");
  const remnicRoot = path.join(homeDir, ".remnic");
  const lockPath = path.join(remnicRoot, ".migration.lock");

  await mkdir(legacyRoot, { recursive: true });
  await mkdir(remnicRoot, { recursive: true });
  await writeFile(path.join(legacyRoot, "tokens.json"), JSON.stringify({ tokens: [] }), "utf8");
  await writeFile(lockPath, "unreadable\n", "utf8");
  await chmod(lockPath, 0o000);

  const result = await migrateFromEngram({
    homeDir,
    cwd: homeDir,
    quiet: true,
  });

  assert.equal(result.status, "migrated");
  assert.equal(existsSync(lockPath), false);
  assert.equal(existsSync(path.join(remnicRoot, ".migrated-from-engram")), true);
});

test("migrateFromEngram does not steal a stale lock from a live process", async () => {
  const homeDir = await makeTempHome("remnic-migrate-live-lock-");
  const legacyRoot = path.join(homeDir, ".engram");
  const remnicRoot = path.join(homeDir, ".remnic");
  const lockPath = path.join(remnicRoot, ".migration.lock");
  const lockContent = `${process.pid}\n${Date.now() - 31_000}\n`;

  await mkdir(legacyRoot, { recursive: true });
  await mkdir(remnicRoot, { recursive: true });
  await writeFile(path.join(legacyRoot, "tokens.json"), JSON.stringify({ tokens: [] }), "utf8");
  await writeFile(lockPath, lockContent, "utf8");

  await assert.rejects(
    migrateFromEngram({
      homeDir,
      cwd: homeDir,
      quiet: true,
    }),
    /timed out waiting for migration lock/,
  );

  assert.equal(await readFile(lockPath, "utf8"), lockContent);
  assert.equal(existsSync(path.join(remnicRoot, ".migrated-from-engram")), false);
});

test("migrateFromEngram stops a service command batch after the first command failure", {
  skip: process.platform === "win32",
}, async () => {
  const homeDir = await makeTempHome("remnic-migrate-service-failure-");
  const legacyRoot = path.join(homeDir, ".engram");
  const legacyUnit = path.join(homeDir, ".config", "systemd", "user", "engram.service");
  const binDir = path.join(homeDir, "bin");
  const callsLog = path.join(homeDir, "systemctl-calls.log");
  const fakeSystemctl = path.join(binDir, "systemctl");
  const escapedCallsLog = callsLog.replace(/'/g, "'\\''");
  const previousPath = process.env.PATH;

  await mkdir(legacyRoot, { recursive: true });
  await mkdir(path.dirname(legacyUnit), { recursive: true });
  await mkdir(binDir, { recursive: true });
  await writeFile(path.join(legacyRoot, "tokens.json"), JSON.stringify({ tokens: [] }), "utf8");
  await writeFile(legacyUnit, "[Unit]\nDescription=engram.service\n", "utf8");
  await writeFile(
    fakeSystemctl,
    `#!/bin/sh\nprintf '%s\\n' "$*" >> '${escapedCallsLog}'\nexit 7\n`,
    "utf8",
  );
  await chmod(fakeSystemctl, 0o755);

  process.env.PATH = `${binDir}${path.delimiter}${previousPath ?? ""}`;
  try {
    await migrateFromEngram({
      homeDir,
      cwd: homeDir,
      quiet: true,
      platform: "linux",
    });
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
  }

  const calls = (await readFile(callsLog, "utf8")).trim().split("\n");
  assert.deepEqual(calls, ["--user stop engram.service"]);
});

test("rollbackFromEngramMigration restores backed up connector configs and removes created service files", async () => {
  const homeDir = await makeTempHome("remnic-migrate-rollback-");
  const cwd = path.join(homeDir, "repo");
  const claudeConfig = path.join(cwd, "packages", "plugin-claude-code", ".mcp.json");
  const legacyRoot = path.join(homeDir, ".engram");
  const legacyLaunchAgent = path.join(homeDir, "Library", "LaunchAgents", "ai.engram.daemon.plist");
  const remnicLaunchAgent = path.join(homeDir, "Library", "LaunchAgents", "ai.remnic.daemon.plist");
  const execCalls: Array<{ command: string; args: string[] }> = [];

  await mkdir(path.join(legacyRoot, "logs"), { recursive: true });
  await mkdir(path.dirname(claudeConfig), { recursive: true });
  await mkdir(path.dirname(legacyLaunchAgent), { recursive: true });
  await writeFile(
    path.join(legacyRoot, "tokens.json"),
    JSON.stringify({ tokens: [{ connector: "claude-code", token: "engram_cc_rollback", createdAt: "2026-04-08T00:00:00.000Z" }] }),
    "utf8",
  );
  await writeFile(
    claudeConfig,
    JSON.stringify({
      mcpServers: {
        engram: {
          headers: {
            Authorization: "Bearer {{ENGRAM_TOKEN}}",
          },
        },
      },
    }),
    "utf8",
  );
  await setModeIfPosix(claudeConfig, 0o644);
  await writeFile(legacyLaunchAgent, "<plist>ai.engram.daemon</plist>", "utf8");

  await migrateFromEngram({
    homeDir,
    cwd,
    quiet: true,
    platform: "darwin",
    connectorConfigPaths: [claudeConfig],
    execCommand: () => undefined,
  });

  const manifest = JSON.parse(await readFile(path.join(homeDir, ".remnic", ".rollback.json"), "utf8")) as {
    entries: Array<{ targetPath: string; backupPath?: string }>;
  };
  const configBackupPath = manifest.entries.find((entry) => entry.targetPath === claudeConfig)?.backupPath;
  assert.ok(configBackupPath, "expected connector config backup in rollback manifest");
  await assertFileMode(configBackupPath, 0o644);

  const rollback = await rollbackFromEngramMigration({
    homeDir,
    quiet: true,
    platform: "darwin",
    execCommand: (command, args) => execCalls.push({ command, args }),
  });

  assert.ok(rollback.restored.includes(claudeConfig));
  assert.ok(rollback.removed.includes(remnicLaunchAgent));
  assert.equal(existsSync(path.join(homeDir, ".remnic", ".migrated-from-engram")), false);
  assert.deepEqual(execCalls, [{ command: "launchctl", args: ["unload", remnicLaunchAgent] }]);

  const restoredClaudeConfig = JSON.parse(await readFile(claudeConfig, "utf8")) as {
    mcpServers: Record<string, unknown>;
  };
  assert.ok(restoredClaudeConfig.mcpServers.engram);
  assert.equal(restoredClaudeConfig.mcpServers.remnic, undefined);
  await assertFileMode(claudeConfig, 0o644);
});

test("rollbackFromEngramMigration removes files created from first-run legacy copies", async () => {
  const homeDir = await makeTempHome("remnic-migrate-created-rollback-");
  const legacyRoot = path.join(homeDir, ".engram");
  const legacyConfig = path.join(homeDir, ".config", "engram", "config.json");
  const remnicTokensPath = path.join(homeDir, ".remnic", "tokens.json");
  const remnicLogPath = path.join(homeDir, ".remnic", "logs", "daemon.log");
  const remnicConfig = path.join(homeDir, ".config", "remnic", "config.json");

  await mkdir(path.join(legacyRoot, "logs"), { recursive: true });
  await mkdir(path.dirname(legacyConfig), { recursive: true });
  await writeFile(
    path.join(legacyRoot, "tokens.json"),
    JSON.stringify({
      tokens: [
        { connector: "claude-code", token: "engram_cc_created", createdAt: "2026-04-08T00:00:00.000Z" },
      ],
    }),
    "utf8",
  );
  await writeFile(path.join(legacyRoot, "logs", "daemon.log"), "legacy log\n", "utf8");
  await writeFile(
    legacyConfig,
    JSON.stringify({
      engram: {
        memoryDir: path.join(homeDir, ".engram", "memory"),
      },
    }),
    "utf8",
  );

  const result = await migrateFromEngram({
    homeDir,
    cwd: homeDir,
    quiet: true,
  });

  assert.equal(result.status, "migrated");
  assert.ok(result.copied.includes(remnicTokensPath));
  assert.ok(result.copied.includes(remnicLogPath));
  assert.ok(result.copied.includes(remnicConfig));

  const manifest = JSON.parse(await readFile(path.join(homeDir, ".remnic", ".rollback.json"), "utf8")) as {
    entries: Array<{ targetPath: string; createdByMigration?: boolean }>;
  };
  const createdTargets = new Set(
    manifest.entries
      .filter((entry) => entry.createdByMigration)
      .map((entry) => entry.targetPath),
  );
  assert.ok(createdTargets.has(remnicTokensPath), "expected copied token store in rollback manifest");
  assert.ok(createdTargets.has(remnicLogPath), "expected copied log file in rollback manifest");
  assert.ok(createdTargets.has(remnicConfig), "expected copied config in rollback manifest");

  const rollback = await rollbackFromEngramMigration({
    homeDir,
    cwd: homeDir,
    quiet: true,
  });

  assert.ok(rollback.removed.includes(remnicTokensPath));
  assert.ok(rollback.removed.includes(remnicLogPath));
  assert.ok(rollback.removed.includes(remnicConfig));
  assert.equal(existsSync(remnicTokensPath), false);
  assert.equal(existsSync(remnicLogPath), false);
  assert.equal(existsSync(remnicConfig), false);
  assert.equal(existsSync(path.join(homeDir, ".remnic", ".migrated-from-engram")), false);
});

test("migration retry preserves rollback entries created before a failed first run", async () => {
  const homeDir = await makeTempHome("remnic-migrate-retry-manifest-");
  const legacyRoot = path.join(homeDir, ".engram");
  const remnicTokensPath = path.join(homeDir, ".remnic", "tokens.json");
  const remnicLogPath = path.join(homeDir, ".remnic", "logs", "daemon.log");
  const badConnectorPath = path.join(homeDir, "bad-connector-config");

  await mkdir(path.join(legacyRoot, "logs"), { recursive: true });
  await writeFile(path.join(legacyRoot, "tokens.json"), JSON.stringify({ tokens: [] }), "utf8");
  await writeFile(path.join(legacyRoot, "logs", "daemon.log"), "legacy log\n", "utf8");
  await mkdir(badConnectorPath, { recursive: true });

  await assert.rejects(
    () => migrateFromEngram({
      homeDir,
      cwd: homeDir,
      quiet: true,
      connectorConfigPaths: [badConnectorPath],
    }),
    (err: unknown) => (err as NodeJS.ErrnoException).code === "EISDIR",
  );

  assert.equal(existsSync(remnicTokensPath), true);
  assert.equal(existsSync(remnicLogPath), true);
  assert.equal(existsSync(path.join(homeDir, ".remnic", ".rollback.json")), true);
  assert.equal(existsSync(path.join(homeDir, ".remnic", ".migrated-from-engram")), false);

  const result = await migrateFromEngram({
    homeDir,
    cwd: homeDir,
    quiet: true,
    connectorConfigPaths: [],
  });
  assert.equal(result.status, "migrated");

  const manifest = JSON.parse(await readFile(path.join(homeDir, ".remnic", ".rollback.json"), "utf8")) as {
    entries: Array<{ targetPath: string; createdByMigration?: boolean }>;
  };
  const createdTargets = new Set(
    manifest.entries
      .filter((entry) => entry.createdByMigration)
      .map((entry) => entry.targetPath),
  );
  assert.ok(createdTargets.has(remnicTokensPath), "expected retry manifest to retain token store");
  assert.ok(createdTargets.has(remnicLogPath), "expected retry manifest to retain copied log");

  const rollback = await rollbackFromEngramMigration({
    homeDir,
    cwd: homeDir,
    quiet: true,
  });

  assert.ok(rollback.removed.includes(remnicTokensPath));
  assert.ok(rollback.removed.includes(remnicLogPath));
  assert.equal(existsSync(remnicTokensPath), false);
  assert.equal(existsSync(remnicLogPath), false);
});

test("rollbackFromEngramMigration reloads systemd after removing migrated unit files", async () => {
  const homeDir = await makeTempHome("remnic-migrate-linux-rollback-");
  const cwd = path.join(homeDir, "repo");
  const legacyRoot = path.join(homeDir, ".engram");
  const legacyUnit = path.join(homeDir, ".config", "systemd", "user", "engram.service");
  const remnicUnit = path.join(homeDir, ".config", "systemd", "user", "remnic.service");
  const execCalls: Array<{ command: string; args: string[] }> = [];

  await mkdir(legacyRoot, { recursive: true });
  await mkdir(path.dirname(legacyUnit), { recursive: true });
  await writeFile(path.join(legacyRoot, "tokens.json"), JSON.stringify({ tokens: [] }), "utf8");
  await writeFile(legacyUnit, "[Unit]\nDescription=engram.service\n", "utf8");

  await migrateFromEngram({
    homeDir,
    cwd,
    quiet: true,
    platform: "linux",
    execCommand: () => undefined,
  });

  const rollback = await rollbackFromEngramMigration({
    homeDir,
    quiet: true,
    platform: "linux",
    execCommand: (command, args) => execCalls.push({ command, args }),
  });

  assert.ok(rollback.removed.includes(remnicUnit));
  assert.equal(existsSync(remnicUnit), false);
  assert.deepEqual(execCalls, [
    { command: "systemctl", args: ["--user", "stop", "remnic.service"] },
    { command: "systemctl", args: ["--user", "disable", "remnic.service"] },
    { command: "systemctl", args: ["--user", "daemon-reload"] },
  ]);
});
