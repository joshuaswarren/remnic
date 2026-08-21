/**
 * Tests for the access-service setCodingContext entry point (issue #569 PR 5).
 *
 * The Claude Code / Codex / Cursor connectors call this either directly
 * (via `EngramAccessService.setCodingContext`) or through its HTTP /
 * MCP surfaces. Validation must reject malformed input per CLAUDE.md #51.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { EngramAccessService, EngramAccessInputError } from "../access-service.js";
import type { CodingContext } from "../types.js";

// ──────────────────────────────────────────────────────────────────────────
// Minimal orchestrator stub — only the surface `setCodingContext` touches.
// ──────────────────────────────────────────────────────────────────────────

function makeService(): {
  service: EngramAccessService;
  calls: Array<{ sessionKey: string; ctx: CodingContext | null }>;
} {
  const calls: Array<{ sessionKey: string; ctx: CodingContext | null }> = [];
  const stubOrchestrator = {
    setCodingContextForSession(sessionKey: string, ctx: CodingContext | null) {
      calls.push({ sessionKey, ctx });
    },
  };
  const service = Object.create(EngramAccessService.prototype) as EngramAccessService;
  (service as unknown as { orchestrator: typeof stubOrchestrator }).orchestrator = stubOrchestrator;
  return { service, calls };
}

// ──────────────────────────────────────────────────────────────────────────
// Happy path — full context
// ──────────────────────────────────────────────────────────────────────────

test("setCodingContext: passes a full valid context through to the orchestrator", () => {
  const { service, calls } = makeService();
  service.setCodingContext({
    sessionKey: "session-A",
    codingContext: {
      projectId: "origin:abcd1234",
      branch: "main",
      rootPath: "/work/proj",
      defaultBranch: "main",
    },
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.sessionKey, "session-A");
  assert.deepEqual(calls[0]!.ctx, {
    projectId: "origin:abcd1234",
    branch: "main",
    rootPath: "/work/proj",
    defaultBranch: "main",
  });
});

test("setCodingContext: null clears the session context", () => {
  const { service, calls } = makeService();
  service.setCodingContext({ sessionKey: "session-A", codingContext: null });
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.ctx, null);
});

test("setCodingContext: branch=null (detached HEAD) is accepted", () => {
  const { service, calls } = makeService();
  service.setCodingContext({
    sessionKey: "session-A",
    codingContext: {
      projectId: "origin:abcd",
      branch: null,
      rootPath: "/work/proj",
      defaultBranch: "main",
    },
  });
  assert.equal(calls[0]!.ctx?.branch, null);
});

// ──────────────────────────────────────────────────────────────────────────
// Validation — CLAUDE.md #51 (reject invalid input, do not silently default)
// ──────────────────────────────────────────────────────────────────────────

test("setCodingContext: empty sessionKey → throws EngramAccessInputError", () => {
  const { service } = makeService();
  assert.throws(
    () =>
      service.setCodingContext({
        sessionKey: "",
        codingContext: {
          projectId: "origin:abcd",
          branch: "main",
          rootPath: "/work",
          defaultBranch: "main",
        },
      }),
    (err: unknown) => err instanceof EngramAccessInputError && /sessionKey/i.test((err as Error).message),
  );
});

test("setCodingContext: whitespace-only sessionKey → throws", () => {
  const { service } = makeService();
  assert.throws(
    () =>
      service.setCodingContext({
        sessionKey: "   ",
        codingContext: {
          projectId: "origin:abcd",
          branch: "main",
          rootPath: "/work",
          defaultBranch: "main",
        },
      }),
    EngramAccessInputError,
  );
});

test("setCodingContext: empty projectId → throws", () => {
  const { service } = makeService();
  assert.throws(
    () =>
      service.setCodingContext({
        sessionKey: "s",
        codingContext: {
          projectId: "",
          branch: "main",
          rootPath: "/work",
          defaultBranch: "main",
        },
      }),
    (err: unknown) => err instanceof EngramAccessInputError && /projectId/i.test((err as Error).message),
  );
});

test("setCodingContext: empty rootPath → throws", () => {
  const { service } = makeService();
  assert.throws(
    () =>
      service.setCodingContext({
        sessionKey: "s",
        codingContext: {
          projectId: "origin:abcd",
          branch: "main",
          rootPath: "",
          defaultBranch: "main",
        },
      }),
    (err: unknown) => err instanceof EngramAccessInputError && /rootPath/i.test((err as Error).message),
  );
});

test("setCodingContext: whitespace-only rootPath → throws (parity with projectId)", () => {
  // Regression: previous check used `ctx.rootPath.length === 0` (no trim),
  // so a payload like `{ rootPath: "   " }` slipped through validation.
  // Must reject whitespace-only just like the projectId check does.
  const { service } = makeService();
  assert.throws(
    () =>
      service.setCodingContext({
        sessionKey: "s",
        codingContext: {
          projectId: "origin:abcd",
          branch: "main",
          rootPath: "   ",
          defaultBranch: "main",
        },
      }),
    (err: unknown) => err instanceof EngramAccessInputError && /rootPath/i.test((err as Error).message),
  );
});

test("setCodingContext: non-string branch (not null) → throws", () => {
  const { service } = makeService();
  // Use `as any` to deliberately pass a wrong-shape payload as a connector
  // might at runtime (e.g. from a mistyped JSON body).
  assert.throws(
    () =>
      service.setCodingContext({
        sessionKey: "s",
        codingContext: {
          projectId: "origin:abcd",
          branch: 42 as unknown as string,
          rootPath: "/work",
          defaultBranch: "main",
        },
      }),
    (err: unknown) => err instanceof EngramAccessInputError && /branch/i.test((err as Error).message),
  );
});

test("setCodingContext: codingContext missing entirely → throws", () => {
  const { service } = makeService();
  assert.throws(
    () => service.setCodingContext({ sessionKey: "s" } as unknown as { sessionKey: string; codingContext: null }),
    EngramAccessInputError,
  );
});
