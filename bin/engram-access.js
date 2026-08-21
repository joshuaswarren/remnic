#!/usr/bin/env node

// This root bin keeps the legacy `engram-access` command alive for workspace
// users. Identify it as the legacy OpenClaw plugin id so access-cli targets
// plugins.entries["openclaw-engram"] before falling through to the canonical
// Remnic entry when both config blocks exist.
let accessCli;
try {
  accessCli = await import("../dist/access-cli.js");
} catch (error) {
  const message = error instanceof Error ? error.message : "unknown load error";
  console.error(`access-cli failed to load dist/access-cli.js: ${message}`);
  process.exit(1);
}

try {
  await accessCli.runCli(process.argv.slice(2), { preferredId: "openclaw-engram" });
} catch (error) {
  const message = error instanceof Error ? error.message : "unknown error";
  console.error(`engram-access failed: ${message}`);
  process.exit(1);
}
