import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  discoverMemoryExtensions,
  REMNIC_EXTENSION_INSTRUCTIONS_BYTE_LIMIT,
  REMNIC_EXTENSION_SCHEMA_BYTE_LIMIT,
} from "./host-discovery.js";

function testLogger() {
  const warnings: string[] = [];
  return {
    warnings,
    logger: {
      warn(message: string) {
        warnings.push(message);
      },
      debug() {},
    },
  };
}

test("discoverMemoryExtensions skips oversized instructions before discovery", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "remnic-ext-large-instructions-"));
  try {
    const extDir = path.join(root, "large-instructions");
    await mkdir(extDir, { recursive: true });
    await writeFile(
      path.join(extDir, "instructions.md"),
      "x".repeat(REMNIC_EXTENSION_INSTRUCTIONS_BYTE_LIMIT + 1),
      "utf8",
    );
    const { logger, warnings } = testLogger();

    const extensions = await discoverMemoryExtensions(root, logger);

    assert.equal(extensions.length, 0);
    assert.ok(warnings.some((warning) => warning.includes("instructions.md exceeds")));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("discoverMemoryExtensions ignores oversized schema without dropping extension", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "remnic-ext-large-schema-"));
  try {
    const extDir = path.join(root, "large-schema");
    await mkdir(extDir, { recursive: true });
    await writeFile(path.join(extDir, "instructions.md"), "Use this extension.\n", "utf8");
    await writeFile(
      path.join(extDir, "schema.json"),
      "x".repeat(REMNIC_EXTENSION_SCHEMA_BYTE_LIMIT + 1),
      "utf8",
    );
    const { logger, warnings } = testLogger();

    const extensions = await discoverMemoryExtensions(root, logger);

    assert.equal(extensions.length, 1);
    assert.equal(extensions[0]!.name, "large-schema");
    assert.equal(extensions[0]!.schema, undefined);
    assert.ok(warnings.some((warning) => warning.includes("schema.json exceeds")));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
