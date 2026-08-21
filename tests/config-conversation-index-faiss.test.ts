import test from "node:test";
import assert from "node:assert/strict";
import { parseConfig } from "../src/config.js";

test("parseConfig sets FAISS conversation index defaults and keeps backend default qmd", () => {
  const cfg = parseConfig({ openaiApiKey: "sk-test" });

  assert.equal(cfg.conversationIndexBackend, "qmd");
  assert.equal(cfg.conversationIndexFaissScriptPath, undefined);
  assert.equal(cfg.conversationIndexFaissPythonBin, undefined);
  assert.equal(cfg.conversationIndexFaissModelId, "text-embedding-3-small");
  assert.equal(cfg.conversationIndexFaissIndexDir, "state/conversation-index/faiss");
  assert.equal(cfg.conversationIndexFaissUpsertTimeoutMs, 30_000);
  assert.equal(cfg.conversationIndexFaissSearchTimeoutMs, 5_000);
  assert.equal(cfg.conversationIndexFaissHealthTimeoutMs, 2_000);
  assert.equal(cfg.conversationIndexFaissMaxBatchSize, 512);
  assert.equal(cfg.conversationIndexFaissMaxSearchK, 50);
});

test("parseConfig supports explicit FAISS conversation index settings including zero-safe limits", () => {
  const cfg = parseConfig({
    openaiApiKey: "sk-test",
    conversationIndexBackend: "faiss",
    conversationIndexFaissScriptPath: "  /tmp/faiss_index.py  ",
    conversationIndexFaissPythonBin: " python3.11 ",
    conversationIndexFaissModelId: "text-embedding-3-large",
    conversationIndexFaissIndexDir: "custom/faiss",
    conversationIndexFaissUpsertTimeoutMs: 0,
    conversationIndexFaissSearchTimeoutMs: 0,
    conversationIndexFaissHealthTimeoutMs: 0,
    conversationIndexFaissMaxBatchSize: 0,
    conversationIndexFaissMaxSearchK: 0,
  });

  assert.equal(cfg.conversationIndexBackend, "faiss");
  assert.equal(cfg.conversationIndexFaissScriptPath, "/tmp/faiss_index.py");
  assert.equal(cfg.conversationIndexFaissPythonBin, "python3.11");
  assert.equal(cfg.conversationIndexFaissModelId, "text-embedding-3-large");
  assert.equal(cfg.conversationIndexFaissIndexDir, "custom/faiss");
  assert.equal(cfg.conversationIndexFaissUpsertTimeoutMs, 0);
  assert.equal(cfg.conversationIndexFaissSearchTimeoutMs, 0);
  assert.equal(cfg.conversationIndexFaissHealthTimeoutMs, 0);
  assert.equal(cfg.conversationIndexFaissMaxBatchSize, 0);
  assert.equal(cfg.conversationIndexFaissMaxSearchK, 0);
});

test("parseConfig clamps malformed FAISS numeric limits and trims blank path overrides", () => {
  const cfg = parseConfig({
    openaiApiKey: "sk-test",
    conversationIndexBackend: "faiss",
    conversationIndexFaissScriptPath: "   ",
    conversationIndexFaissPythonBin: "",
    conversationIndexFaissModelId: " ",
    conversationIndexFaissIndexDir: "",
    conversationIndexFaissUpsertTimeoutMs: -9.2,
    conversationIndexFaissSearchTimeoutMs: -8.7,
    conversationIndexFaissHealthTimeoutMs: -3.1,
    conversationIndexFaissMaxBatchSize: -5.9,
    conversationIndexFaissMaxSearchK: -2.3,
  });

  assert.equal(cfg.conversationIndexFaissScriptPath, undefined);
  assert.equal(cfg.conversationIndexFaissPythonBin, undefined);
  assert.equal(cfg.conversationIndexFaissModelId, "text-embedding-3-small");
  assert.equal(cfg.conversationIndexFaissIndexDir, "state/conversation-index/faiss");
  assert.equal(cfg.conversationIndexFaissUpsertTimeoutMs, 0);
  assert.equal(cfg.conversationIndexFaissSearchTimeoutMs, 0);
  assert.equal(cfg.conversationIndexFaissHealthTimeoutMs, 0);
  assert.equal(cfg.conversationIndexFaissMaxBatchSize, 0);
  assert.equal(cfg.conversationIndexFaissMaxSearchK, 0);
});
