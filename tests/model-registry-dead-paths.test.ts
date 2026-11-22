import test from "node:test";
import assert from "node:assert/strict";
import { ModelRegistry } from "../packages/remnic-core/src/model-registry.ts";

test("ModelRegistry carries no unimplemented Hugging Face fetch path (#3561)", () => {
  assert.equal(
    "fetchFromHuggingFace" in ModelRegistry.prototype,
    false,
    "fetchFromHuggingFace only logged 'not yet implemented' and returned false; nothing calls it",
  );
});
