import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

// Regression for issue #2062: the standalone `remnic connectors status` row
// builder hardcoded `enabled: true`, so status output lied when a connector
// was disabled in config. It must reflect parsed config, matching the source
// `connectors run` already reads.
//
// Exercises the real CLI dispatch (src/index.ts via tsx) so the assertion
// guards the actual status branch, not a re-implementation of its logic. The
// `--conditions=remnic-source` node flag mirrors the root test runner so the
// child's dynamic `import("@remnic/core")` resolves to source without a build.
const repoRoot = dirname(dirname(dirname(dirname(fileURLToPath(import.meta.url)))));
const cliEntry = join(repoRoot, "packages", "remnic-cli", "src", "index.ts");

test("connectors status reflects config enabled flags (issue #2062)", async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), "remnic-2062-status-"));
  try {
    const memoryDir = join(tempRoot, "mem");
    const configPath = join(tempRoot, "remnic.json");
    await writeFile(
      configPath,
      JSON.stringify({
        memoryDir,
        connectors: {
          googleDrive: { enabled: true },
          notion: { enabled: false },
        },
      })
    );

    const result = spawnSync(
      process.execPath,
      ["--conditions=remnic-source", "--import", "tsx", cliEntry, "connectors", "status", "--format", "json"],
      {
        cwd: repoRoot,
        encoding: "utf8",
        env: {
          ...process.env,
          REMNIC_CLI_BIN: "1",
          REMNIC_CONFIG_PATH: configPath,
        },
      }
    );

    assert.equal(result.status, 0, `status exited nonzero: ${result.stderr}`);
    const rows = JSON.parse(result.stdout) as Array<{
      id: string;
      enabled: boolean;
      lastSyncStatus: string;
    }>;

    const notion = rows.find((r) => r.id === "notion");
    assert.ok(notion, "notion row must be present");
    assert.equal(notion.enabled, false, "disabled connector must report enabled:false");

    const drive = rows.find((r) => r.id === "google-drive");
    assert.ok(drive, "google-drive row must be present");
    assert.equal(drive.enabled, true, "enabled connector must report enabled:true");
    assert.equal(drive.lastSyncStatus, "never", "never-synced connector must still report never");
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("connectors status fails cleanly on invalid connector config (issue #2062)", async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), "remnic-2062-status-bad-"));
  try {
    const memoryDir = join(tempRoot, "mem");
    const configPath = join(tempRoot, "remnic.json");
    // Valid JSON, but a value parseConfig rejects (poll interval below the
    // allowed floor). This exercises the status branch's own config guard,
    // which must exit 2 without echoing the parser message (it can contain
    // raw config values, e.g. secrets — Cursor Bugbot learned rule).
    await writeFile(
      configPath,
      JSON.stringify({
        memoryDir,
        connectors: { googleDrive: { pollIntervalMs: 5 } },
      })
    );

    const result = spawnSync(
      process.execPath,
      ["--conditions=remnic-source", "--import", "tsx", cliEntry, "connectors", "status", "--format", "json"],
      {
        cwd: repoRoot,
        encoding: "utf8",
        env: {
          ...process.env,
          REMNIC_CLI_BIN: "1",
          REMNIC_CONFIG_PATH: configPath,
        },
      }
    );

    assert.equal(result.status, 2, `expected exit 2, got ${result.status}: ${result.stderr}`);
    assert.match(result.stderr, /^connectors status:/m);
    // The caught parser message must not be echoed (it can carry config values).
    assert.doesNotMatch(result.stderr, /pollIntervalMs/);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});
