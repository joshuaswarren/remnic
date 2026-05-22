import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";

import { getCategoryDir } from "./category-dir.js";

test("getCategoryDir falls back for unknown and prototype category names", () => {
  const memoryDir = "/tmp/remnic";
  for (const category of ["unknown", "constructor", "toString", "__proto__"]) {
    assert.equal(
      getCategoryDir(memoryDir, category),
      path.join(memoryDir, "facts"),
    );
  }
});
