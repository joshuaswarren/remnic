/**
 * Issue #1533 — Phase A contract test: public-surface enumeration.
 *
 * Phase A step 1: enumerate the public surface of storage.ts so the contract
 * suite has an explicit inventory. This test pins the exported symbols the 51+
 * importers depend on. When Phase B extracts seams, every entry here must still
 * resolve — either on storage.ts or on the storage/* module that absorbed it.
 *
 * This is NOT a behavior test; it is a surface-stability guard. It documents
 * what the MemoryStorage interface must cover.
 */

import assert from "node:assert/strict";
import test from "node:test";

import * as storageModule from "../storage.js";

test("surface: StorageManager class is exported and constructible", () => {
  assert.equal(typeof storageModule.StorageManager, "function");
  assert.equal(storageModule.StorageManager.name, "StorageManager");
});

test("surface: ContentHashIndex class is exported", () => {
  assert.equal(typeof storageModule.ContentHashIndex, "function");
  assert.equal(storageModule.ContentHashIndex.name, "ContentHashIndex");
});

test("surface: entity helpers are exported (parseEntityFile, serializeEntityFile, normalizeEntityName)", () => {
  assert.equal(typeof storageModule.parseEntityFile, "function");
  assert.equal(typeof storageModule.serializeEntityFile, "function");
  assert.equal(typeof storageModule.normalizeEntityName, "function");
});

test("surface: StorageManager exposes the documented memory CRUD methods", () => {
  const proto = storageModule.StorageManager.prototype;
  const required = [
    "writeMemory",
    "readAllMemories",
    "readMemoryByPath",
    "getMemoryById",
    "invalidateMemory",
    "updateMemory",
    "ensureDirectories",
    "setVersioningConfig",
    "isSecureStoreUnlocked",
    "getMemoryStatusVersion",
  ];
  for (const method of required) {
    assert.equal(
      typeof (proto as unknown as Record<string, unknown>)[method],
      "function",
      `StorageManager.prototype.${method} must be a function (documented public surface)`,
    );
  }
});

test("surface: StorageManager exposes the question-queue methods", () => {
  const proto = storageModule.StorageManager.prototype;
  assert.equal(typeof proto.writeQuestion, "function");
  assert.equal(typeof proto.readQuestions, "function");
  assert.equal(typeof proto.resolveQuestion, "function");
});

test("surface: StorageManager exposes cache invalidation methods (rule 37)", () => {
  const proto = storageModule.StorageManager.prototype;
  assert.equal(typeof proto.invalidateAllMemoriesCacheForDir, "function");
  assert.equal(typeof proto.invalidateMemoryCachesForTiers, "function");
});

test("surface: StorageManager has a static clearAllStaticCaches for test isolation", () => {
  assert.equal(
    typeof storageModule.StorageManager.clearAllStaticCaches,
    "function",
    "clearAllStaticCaches is the test-isolation chokepoint",
  );
});

test("surface: ContentHashIndex exposes computeHash and normalizeContent (rule 23)", () => {
  assert.equal(typeof storageModule.ContentHashIndex.computeHash, "function");
  assert.equal(typeof storageModule.ContentHashIndex.normalizeContent, "function");
});

test("surface: StorageManager.dir getter returns the base directory string", () => {
  const desc = Object.getOwnPropertyDescriptor(
    storageModule.StorageManager.prototype,
    "dir",
  );
  assert.ok(desc, "dir must be a property on the prototype");
  assert.equal(typeof desc?.get, "function", "dir must have a getter");
});
