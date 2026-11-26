import test from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import path from "node:path";

import { makeTempDirSync } from "./helpers/tmp-dir.mjs";
import {
  captureOpenClawRegistrationApi,
  disableRegisterMigrationForCaptureTest,
  restoreOpenClawRegistrationGlobals,
  restoreRegisterMigrationForCaptureTest,
  saveAndResetOpenClawRegistrationGlobals,
} from "./helpers/openclaw-registration-harness.js";

// Failing-first coverage for the openclaw.json file-fallback hacks:
//
// - #3613 (`register()`/`start()`): the plugin always merges the on-disk
//   openclaw.json plugin entry *under* `api.pluginConfig`, so keys authored
//   only in the file leak into the effective config even when the gateway
//   passed a config of its own.
// - #3612 (`loadPluginEntryFromFile`): the file read resolves
//   OPENCLAW_CONFIG_PATH / ~/.openclaw/openclaw.json locally — a path that may
//   not be the file the gateway loaded — and is consulted regardless of what
//   the gateway supplied.
//
// The pinned contract: gateway-supplied plugin config is the sole source
// whenever the gateway provides one. The on-disk file may only act as a
// fallback for a gateway that passes no plugin config at all — and only until
// the upstream gateway reliably passes the full config (the issues' root fix).

type PluginModule = { register(api: unknown): void };

const CONFIG_PATH_ENV = "OPENCLAW_CONFIG_PATH";
const ALT_CONFIG_PATH_ENV = "OPENCLAW_ENGRAM_CONFIG_PATH";

function writeGatewayFile(dir: string, entryConfig: Record<string, unknown>): string {
  const configPath = path.join(dir, "openclaw.json");
  writeFileSync(
    configPath,
    `${JSON.stringify({
      plugins: {
        entries: {
          "openclaw-remnic": { config: entryConfig },
        },
      },
    })}\n`,
  );
  return configPath;
}

async function registerWithConfig(options: {
  pluginConfig?: Record<string, unknown>;
  config?: Record<string, unknown>;
  fileEntryConfig?: Record<string, unknown>;
}): Promise<{ infoLines: string[] }> {
  const saved = saveAndResetOpenClawRegistrationGlobals();
  const previousMigration = disableRegisterMigrationForCaptureTest();
  const previousConfigPath = process.env[CONFIG_PATH_ENV];
  const previousAltConfigPath = process.env[ALT_CONFIG_PATH_ENV];
  const infoLines: string[] = [];
  try {
    {
      const dir = makeTempDirSync("openclaw-config-fallback-");
      if (options.fileEntryConfig !== undefined) {
        process.env[CONFIG_PATH_ENV] = writeGatewayFile(dir, options.fileEntryConfig);
      } else {
        // Point the file fallback at an empty dir so a real ~/.openclaw
        // file can never leak into the test.
        process.env[CONFIG_PATH_ENV] = path.join(dir, "openclaw.json");
      }
      delete process.env[ALT_CONFIG_PATH_ENV];

      const capture = captureOpenClawRegistrationApi({
        pluginConfig: options.pluginConfig,
        config: options.config,
        logger: {
          debug: () => {},
          info: (...args: unknown[]) => infoLines.push(args.map(String).join(" ")),
          warn: () => {},
          error: () => {},
        },
      });

      const { default: plugin } = await import("../src/index.js");
      (plugin as PluginModule).register(capture.api);
    }
  } finally {
    if (previousConfigPath === undefined) delete process.env[CONFIG_PATH_ENV];
    else process.env[CONFIG_PATH_ENV] = previousConfigPath;
    if (previousAltConfigPath === undefined) delete process.env[ALT_CONFIG_PATH_ENV];
    else process.env[ALT_CONFIG_PATH_ENV] = previousAltConfigPath;
    restoreRegisterMigrationForCaptureTest(previousMigration);
    restoreOpenClawRegistrationGlobals(saved);
  }
  return { infoLines };
}

function initLine(infoLines: string[]): string {
  const line = infoLines.find((l) => l.includes("initialized (debug="));
  assert.ok(line, "register() should emit the initialized config summary line");
  return line;
}

test("gateway-supplied pluginConfig is the sole config source: file-only keys must not leak", async () => {
  // The gateway passes a config that does not enable debug logging. A stale
  // openclaw.json on disk still authors `debug: true`.
  //
  // Failing-first: today register() merges the file entry under
  // api.pluginConfig, so the file's `debug: true` silently takes effect even
  // though the gateway's config never asked for it.
  const { infoLines } = await registerWithConfig({
    pluginConfig: { memoryDir: "/tmp/gateway-managed" },
    fileEntryConfig: { debug: true, memoryDir: "/tmp/stale-file" },
  });

  assert.equal(
    initLine(infoLines).includes("debug=false"),
    true,
    `file-authored \`debug: true\` leaked into the effective config even though the gateway supplied pluginConfig: ${initLine(infoLines)}`,
  );
});

test("file fallback still applies when the gateway passes no plugin config", async () => {
  // Characterization of the retained workaround: with an empty
  // api.pluginConfig (the "gateway may not pass it" case), the on-disk entry
  // is still the only config source available and must keep working until the
  // root fix lands upstream.
  const { infoLines } = await registerWithConfig({
    pluginConfig: {},
    fileEntryConfig: { debug: true },
  });

  assert.equal(
    initLine(infoLines).includes("debug=true"),
    true,
    `file fallback should still supply config when the gateway passes none: ${initLine(infoLines)}`,
  );
});
