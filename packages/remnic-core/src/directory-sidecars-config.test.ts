import assert from "node:assert/strict";
import test from "node:test";

import { parseConfig } from "./config.js";

test("#3088 parseConfig directorySidecarsEnabled is off by default and opt-in only", () => {
  assert.equal(parseConfig({}).directorySidecarsEnabled, false);
  assert.equal(parseConfig({ directorySidecarsEnabled: "false" }).directorySidecarsEnabled, false);
  assert.equal(parseConfig({ directorySidecarsEnabled: true }).directorySidecarsEnabled, true);
});
