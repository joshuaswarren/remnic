import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createOpikExporter } from "./opik-exporter.js";
import type { LoggerBackend } from "./logger.js";

const silentLogger: LoggerBackend = {
  debug() {},
  info() {},
  warn() {},
  error() {},
};

test("createOpikExporter prefers active OpenClaw config path over legacy config path", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "remnic-opik-config-path-"));
  const activeConfigPath = path.join(root, "active-openclaw.json");
  const legacyConfigPath = path.join(root, "legacy-openclaw.json");
  const previousOpenClawConfigPath = process.env.OPENCLAW_CONFIG_PATH;
  const previousOpenClawEngramConfigPath = process.env.OPENCLAW_ENGRAM_CONFIG_PATH;

  try {
    await writeFile(
      activeConfigPath,
      JSON.stringify({
        plugins: {
          entries: {
            "opik-openclaw": {
              enabled: true,
              config: {
                apiUrl: "https://opik-active.example/api",
                projectName: "active-project",
                workspaceName: "active-workspace",
                apiKey: "active-key",
              },
            },
          },
        },
      }),
      "utf8",
    );
    await writeFile(legacyConfigPath, "{not valid json", "utf8");

    process.env.OPENCLAW_CONFIG_PATH = activeConfigPath;
    process.env.OPENCLAW_ENGRAM_CONFIG_PATH = legacyConfigPath;

    const exporter = createOpikExporter({}, silentLogger);
    assert.ok(exporter, "expected Opik exporter to auto-detect active config");
    assert.deepEqual((exporter as any).cfg, {
      enabled: true,
      apiUrl: "https://opik-active.example/api",
      projectName: "active-project",
      workspaceName: "active-workspace",
      apiKey: "active-key",
      traceRecallContent: false,
    });
  } finally {
    if (previousOpenClawConfigPath === undefined) {
      delete process.env.OPENCLAW_CONFIG_PATH;
    } else {
      process.env.OPENCLAW_CONFIG_PATH = previousOpenClawConfigPath;
    }
    if (previousOpenClawEngramConfigPath === undefined) {
      delete process.env.OPENCLAW_ENGRAM_CONFIG_PATH;
    } else {
      process.env.OPENCLAW_ENGRAM_CONFIG_PATH = previousOpenClawEngramConfigPath;
    }
    await rm(root, { recursive: true, force: true });
  }
});
