import { copyFileSync, readFileSync, unlinkSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";

const packageDir = process.cwd();
const manifestPath = path.join(packageDir, "openclaw.plugin.json");
const backupPath = path.join(packageDir, ".openclaw.plugin.json.prepack");

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
  if (!existsSync(backupPath)) {
    copyFileSync(manifestPath, backupPath);
  }
  writeFileSync(manifestPath, compact);
  console.log(`openclaw.plugin.json minified for pack: ${bytes} bytes (cap ${HARD_CAP_BYTES}).`);
} else if (command === "restore") {
  if (existsSync(backupPath)) {
    // copy+unlink instead of rename: fs.renameSync cannot overwrite an
    // existing destination on Windows (EEXIST) and the destination always
    // exists here (it is the minified manifest).
    copyFileSync(backupPath, manifestPath);
    unlinkSync(backupPath);
    console.log("openclaw.plugin.json reset to the committed pretty form.");
  }
} else {
  console.error("usage: manifest-pack.mjs <minify|restore>");
  process.exit(1);
}
