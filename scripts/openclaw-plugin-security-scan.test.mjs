import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);

test("openclaw plugin security scan expands quoted tilde paths", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "remnic-openclaw-scan-"));
  const home = path.join(root, "home");
  const openclawDir = path.join(home, "openclaw");
  const pluginDir = path.join(home, "plugin");
  const distDir = path.join(openclawDir, "dist");
  await fs.mkdir(distDir, { recursive: true });
  await fs.mkdir(pluginDir, { recursive: true });
  await fs.writeFile(path.join(openclawDir, "package.json"), JSON.stringify({ version: "test" }));
  await fs.writeFile(
    path.join(distDir, "skill-scanner-test.js"),
    [
      "export async function scanDirectoryWithSummary(dir) {",
      "  return { scannedFiles: dir, critical: 0, warn: 0, findings: [] };",
      "}",
      "",
    ].join("\n"),
  );

  try {
    const { stdout } = await execFileAsync(
      process.execPath,
      [path.join(process.cwd(), "scripts", "openclaw-plugin-security-scan.mjs"), "~/plugin"],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          HOME: home,
          OPENCLAW_PACKAGE_DIR: "~/openclaw",
        },
      },
    );

    assert.match(stdout, new RegExp(`scanned=${escapeRegExp(pluginDir)}`));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
