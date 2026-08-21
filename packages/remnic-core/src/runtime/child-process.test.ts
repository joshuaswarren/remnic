import assert from "node:assert/strict";
import test from "node:test";

import { launchProcessSync } from "./child-process.js";

test("launchProcessSync executes commands through the shared process wrapper", () => {
  const result = launchProcessSync(
    process.execPath,
    ["-e", "process.stdout.write('ok')"],
    { encoding: "utf8" },
  );

  assert.equal(result.status, 0);
  assert.equal(result.stdout, "ok");
});
