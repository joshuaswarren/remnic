import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const SOURCE_PATH = path.resolve(import.meta.dirname, "../evals/adapter/engram-adapter.ts");

test("eval adapter uses session-scoped buffer APIs", async () => {
  const source = await readFile(SOURCE_PATH, "utf8");

  assert.match(
    source,
    /await orchestrator\.buffer\.addTurn\(sessionId,\s*\{/m,
    "eval adapter should add turns into the session-specific smart buffer entry",
  );
  assert.match(
    source,
    /const bufferedTurns = orchestrator\.buffer\.getTurns\(sessionId\);/m,
    "eval adapter should extract from the session-specific smart buffer entry",
  );
  assert.match(
    source,
    /queueBufferedExtraction\?\.\(bufferedTurns,\s*"trigger_mode",\s*\{\s*bufferKey:\s*sessionId,\s*clearBufferAfterExtraction:\s*false,\s*\}\)/m,
    "eval adapter should enqueue extraction with the session buffer key and keep buffer clearing under adapter control",
  );
  assert.match(
    source,
    /await orchestrator\.buffer\.clearAfterExtraction\(sessionId\);/m,
    "eval adapter should clear only the session-specific smart buffer entry",
  );
});
