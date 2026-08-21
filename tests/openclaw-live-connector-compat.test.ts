import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

import { hasEnabledLiveConnectorConfig } from "../src/openclaw-live-connector-config.js";

test("OpenClaw live connector cron gate detects enabled connector configs", () => {
  assert.equal(hasEnabledLiveConnectorConfig(undefined), false);
  assert.equal(hasEnabledLiveConnectorConfig({}), false);
  assert.equal(
    hasEnabledLiveConnectorConfig({
      googleDrive: { enabled: false },
      notion: { enabled: false },
    }),
    false,
  );
  assert.equal(
    hasEnabledLiveConnectorConfig({
      googleDrive: { enabled: false },
      notion: { enabled: true },
    }),
    true,
  );
});

test("OpenClaw adapter does not import live connector cron gate from @remnic/core", async () => {
  const source = await readFile(new URL("../src/index.ts", import.meta.url), "utf8");
  const coreImportBlocks = source.matchAll(
    /import\s*\{(?<names>[\s\S]*?)\}\s*from\s*["@']@remnic\/core["@']/g,
  );

  for (const match of coreImportBlocks) {
    assert.doesNotMatch(
      match.groups?.names ?? "",
      /\bhasEnabledLiveConnector\b/,
      "OpenClaw startup must not statically import this optional core helper",
    );
  }
});
