/**
 * Pack-time manifest minifier (issue: OpenClaw caps openclaw.plugin.json at
 * 256 KiB via MAX_PLUGIN_MANIFEST_BYTES; the pretty-printed manifest crossed
 * that cap at 9.15.x, so every install on current hosts failed with
 * "unsafe plugin manifest path: ... (validation)").
 *
 * `prepack` swaps the committed pretty manifest for a compact serialization
 * of the same document; `postpack` restores the pretty original so the git
 * tree stays clean. The committed file remains pretty-printed for review.
 */
import { copyFileSync, readFileSync, renameSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";

const packageDir = process.cwd();
const manifestPath = path.join(packageDir, "openclaw.plugin.json");
const backupPath = path.join(packageDir, ".openclaw.plugin.json.prepack");

// OpenClaw's MAX_PLUGIN_MANIFEST_BYTES is 256 KiB; fail earlier so schema
// growth surfaces in CI before it breaks installs on real hosts.
const HARD_CAP_BYTES = 256 * 1024;
const FAIL_AT_BYTES = 250_000;

const command = process.argv[2];

if (command === "minify") {
  const raw = readFileSync(manifestPath, "utf8");
  const compact = `${JSON.stringify(JSON.parse(raw))}\n`;
  const bytes = Buffer.byteLength(compact, "utf8");
  if (bytes >= FAIL_AT_BYTES) {
    console.error(
      `openclaw.plugin.json is ${bytes} bytes even minified — OpenClaw rejects manifests >= ${HARD_CAP_BYTES} bytes ` +
        `and this build fails at ${FAIL_AT_BYTES} to leave headroom. Shrink configSchema/uiHints before releasing.`,
    );
    process.exit(1);
  }
  copyFileSync(manifestPath, backupPath);
  writeFileSync(manifestPath, compact);
  console.log(`openclaw.plugin.json minified for pack: ${bytes} bytes (cap ${HARD_CAP_BYTES}).`);
} else if (command === "restore") {
  if (existsSync(backupPath)) {
    renameSync(backupPath, manifestPath);
    console.log("openclaw.plugin.json restored to the committed pretty form.");
  }
} else {
  console.error("usage: manifest-pack.mjs <minify|restore>");
  process.exit(1);
}
