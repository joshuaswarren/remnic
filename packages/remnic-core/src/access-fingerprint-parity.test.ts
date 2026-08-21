import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import {
  AccessIdempotencyStore,
  hashAccessIdempotencyPayload,
} from "./access-idempotency.js";
import {
  buildAccessWriteRequestFingerprint,
  buildObserveRequestFingerprint,
} from "./write-envelope.js";

/**
 * Issue #1989 PR3 — fingerprint byte-parity safety net.
 *
 * The access surfaces' idempotency hashes are persisted indefinitely
 * (AccessIdempotencyStore: last-512 LRU, no time TTL). The shared builders
 * MUST reproduce the historical inline payload literals exactly, or every
 * stored key silently stops replaying / starts conflicting after upgrade.
 *
 * The `legacy*` literals below are verbatim copies of the inline objects
 * that lived at the call sites before PR3 (access-observe-write-surface.ts
 * memoryStore/suggestionSubmit, access-service.ts peek twins and observe).
 * Do NOT "sync" them with the builders — their whole point is to pin the
 * historical shape.
 */

type WriteRequestish = {
  content: string;
  category?: string;
  confidence?: number;
  tags?: string[];
  entityRef?: string;
  ttl?: string;
  sourceReason?: string;
  sourceConnector?: string;
};

function legacyWriteFingerprint(
  request: WriteRequestish,
  namespace: string,
  schemaVersion: number,
): Record<string, unknown> {
  // Verbatim pre-PR3 shape — field order as it appeared in the source.
  return {
    schemaVersion,
    content: request.content,
    category: request.category,
    confidence: request.confidence,
    namespace,
    tags: request.tags,
    entityRef: request.entityRef,
    ttl: request.ttl,
    sourceReason: request.sourceReason,
    sourceConnector: request.sourceConnector,
  };
}

const FULL_WRITE: WriteRequestish = {
  content: "User prefers dark mode",
  category: "preference",
  confidence: 0.8,
  tags: ["ui", "preference", "ui"],
  entityRef: "person-test-user",
  ttl: "2027-01-01T00:00:00.000Z",
  sourceReason: "operator request",
  sourceConnector: "cli",
};

const SPARSE_WRITE: WriteRequestish = {
  content: "Sparse fact with every optional absent",
};

test("memory_store/suggestion_submit fingerprints hash identically to the pre-PR3 literals", () => {
  for (const request of [FULL_WRITE, SPARSE_WRITE]) {
    for (const operation of ["memory_store", "suggestion_submit"] as const) {
      const legacy = hashAccessIdempotencyPayload({
        operation,
        request: legacyWriteFingerprint(request, "default", 1),
      });
      const migrated = hashAccessIdempotencyPayload({
        operation,
        request: buildAccessWriteRequestFingerprint({
          schemaVersion: 1,
          namespace: "default",
          content: request.content,
          category: request.category,
          confidence: request.confidence,
          tags: request.tags,
          entityRef: request.entityRef,
          ttl: request.ttl,
          sourceReason: request.sourceReason,
          sourceConnector: request.sourceConnector,
        }),
      });
      assert.equal(migrated, legacy, `${operation} fingerprint diverged for ${request.content}`);
    }
  }
});

test("write fingerprints keep raw values: tag order and duplicates are identity", () => {
  const base = {
    schemaVersion: 1,
    namespace: "default",
    content: "same content",
  };
  const a = hashAccessIdempotencyPayload(
    buildAccessWriteRequestFingerprint({ ...base, tags: ["b", "a"] }),
  );
  const b = hashAccessIdempotencyPayload(
    buildAccessWriteRequestFingerprint({ ...base, tags: ["a", "b"] }),
  );
  // The legacy shape hashed the RAW tags array; preserving stored state
  // means preserving that (documented per-surface quirk until a versioned
  // payload migration; the envelope's v1 payload sorts tags instead).
  assert.notEqual(a, b, "raw tag order must remain identity, matching stored pre-PR3 hashes");
});

test("observe fingerprint hashes identically to the pre-PR3 literal", () => {
  const request = {
    sessionKey: "agent:main:test",
    messages: [
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi there" },
    ],
    namespace: undefined as string | undefined,
    skipExtraction: false,
    authenticatedPrincipal: "operator",
    cwd: "/home/user/project",
    projectTag: "acme",
    sourceConnector: undefined as string | undefined,
  };
  const codingContext = { projectId: "origin:abc", branch: "main" };
  for (const effective of [codingContext, null]) {
    const legacy = hashAccessIdempotencyPayload({
      operation: "observe",
      request: {
        sessionKey: request.sessionKey,
        messages: request.messages,
        namespace: request.namespace,
        skipExtraction: request.skipExtraction,
        authenticatedPrincipal: request.authenticatedPrincipal,
        cwd: request.cwd,
        projectTag: request.projectTag,
        effectiveCodingContext: effective ?? null,
        sourceConnector: request.sourceConnector,
      },
    });
    const migrated = hashAccessIdempotencyPayload({
      operation: "observe",
      request: buildObserveRequestFingerprint({
        sessionKey: request.sessionKey,
        messages: request.messages,
        namespace: request.namespace,
        skipExtraction: request.skipExtraction,
        authenticatedPrincipal: request.authenticatedPrincipal,
        cwd: request.cwd,
        projectTag: request.projectTag,
        effectiveCodingContext: effective ?? null,
        sourceConnector: request.sourceConnector,
      }),
    });
    assert.equal(migrated, legacy);
  }
});

test("stored idempotency state from before PR3 still replays after PR3 (state-file round-trip)", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-idem-parity-"));
  try {
    const statePath = path.join(dir, "state", "access-idempotency.json");
    const preUpgrade = new AccessIdempotencyStore(statePath);
    // A pre-PR3 deployment recorded this response under the inline-literal hash.
    const preHash = hashAccessIdempotencyPayload({
      operation: "memory_store",
      request: legacyWriteFingerprint(FULL_WRITE, "default", 1),
    });
    const storedResponse = { operation: "memory_store", memoryId: "fact-pre-upgrade", accepted: true };
    await preUpgrade.put("idem-key-1", preHash, storedResponse);

    // Post-upgrade process: fresh store instance over the same state file,
    // hash computed through the PR3 builder.
    const postUpgrade = new AccessIdempotencyStore(statePath);
    const postHash = hashAccessIdempotencyPayload({
      operation: "memory_store",
      request: buildAccessWriteRequestFingerprint({
        schemaVersion: 1,
        namespace: "default",
        ...FULL_WRITE,
      }),
    });
    const replay = await postUpgrade.get("idem-key-1", postHash);
    assert.equal(replay.conflict, false, "same request must not conflict across the upgrade");
    assert.deepEqual(replay.response, storedResponse, "pre-upgrade response must replay");

    // And a DIFFERENT request on the same key still conflicts (hash still discriminates).
    const differentHash = hashAccessIdempotencyPayload({
      operation: "memory_store",
      request: buildAccessWriteRequestFingerprint({
        schemaVersion: 1,
        namespace: "default",
        content: "entirely different content",
      }),
    });
    const conflict = await postUpgrade.get("idem-key-1", differentHash);
    assert.equal(conflict.conflict, true, "different request on the same key must conflict");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
