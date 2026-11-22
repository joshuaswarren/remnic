#!/usr/bin/env node

// before falling through to the canonical "openclaw-remnic" entry.  This
// prevents `engram-access` from silently reading/writing the wrong memory
// store during migration when both blocks exist with no plugins.slots.memory
// override (#403).  The id is hardcoded (not imported from @remnic/core)
// because the shim *is* the legacy alias — the string is its identity.
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
