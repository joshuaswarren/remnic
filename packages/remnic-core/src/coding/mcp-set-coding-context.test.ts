/**
 * Tests for the MCP `engram.set_coding_context` tool (issue #569 PR 7).
 *
 * The MCP server is accessed by Cursor, generic agents, and any client that
 * doesn't ship `cwd` in its session-start handshake. This tool lets those
 * clients set the coding context explicitly.
 *
 * Tests drive the tool through `callTool` directly — no JSON-RPC transport —
 * so we cover the handler's input validation and alias handling without
 * needing a stdio mock.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { EngramMcpServer } from "../access-mcp.js";
import { EngramAccessInputError, type EngramAccessService } from "../access-service.js";
import type { CodingContext } from "../types.js";

function makeMcp(): {
  mcp: EngramMcpServer;
  calls: Array<{ sessionKey: string; ctx: CodingContext | null }>;
} {
  const calls: Array<{ sessionKey: string; ctx: CodingContext | null }> = [];
  const service = {
    setCodingContext(request: { sessionKey: string; codingContext: CodingContext | null }) {
      if (!request.sessionKey || request.sessionKey.trim().length === 0) {
        throw new EngramAccessInputError("sessionKey is required for setCodingContext");
      }
      if (request.codingContext && !request.codingContext.projectId) {
        throw new EngramAccessInputError("codingContext.projectId must be a non-empty string");
      }
      calls.push({ sessionKey: request.sessionKey, ctx: request.codingContext });
    },
  } as unknown as EngramAccessService;
  const mcp = new EngramMcpServer(service);
  return { mcp, calls };
}

// Helper — bypass JSON-RPC layer.
async function call(mcp: EngramMcpServer, name: string, args: Record<string, unknown>): Promise<unknown> {
  const anyMcp = mcp as unknown as {
    callTool(n: string, a: Record<string, unknown>): Promise<unknown>;
  };
  return anyMcp.callTool(name, args);
}

// ──────────────────────────────────────────────────────────────────────────
// Tool listing — advertises both canonical and legacy names
// ──────────────────────────────────────────────────────────────────────────

test("engram.set_coding_context is listed in the tool catalogue", () => {
  const { mcp } = makeMcp();
  const tools = (mcp as unknown as { tools: Array<{ name: string }> }).tools;
  const names = tools.map((t) => t.name);
  assert.ok(
    names.includes("engram.set_coding_context"),
    `expected engram.set_coding_context in catalogue, got: ${names.join(", ")}`,
  );
});

// ──────────────────────────────────────────────────────────────────────────
// Happy path
// ──────────────────────────────────────────────────────────────────────────

test("engram.set_coding_context: attaches a full context", async () => {
  const { mcp, calls } = makeMcp();
  const result = await call(mcp, "engram.set_coding_context", {
    sessionKey: "session-A",
    codingContext: {
      projectId: "origin:abcd1234",
      branch: "main",
      rootPath: "/work/proj",
      defaultBranch: "main",
    },
  });
  assert.deepEqual(result, { ok: true });
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.sessionKey, "session-A");
  assert.equal(calls[0]!.ctx?.projectId, "origin:abcd1234");
  assert.equal(calls[0]!.ctx?.branch, "main");
});

test("engram.set_coding_context: codingContext=null clears the session", async () => {
  const { mcp, calls } = makeMcp();
  await call(mcp, "engram.set_coding_context", {
    sessionKey: "session-A",
    codingContext: null,
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.ctx, null);
});

test("engram.set_coding_context: branch=null (detached HEAD) accepted", async () => {
  const { mcp, calls } = makeMcp();
  await call(mcp, "engram.set_coding_context", {
    sessionKey: "session-A",
    codingContext: {
      projectId: "origin:abcd",
      branch: null,
      rootPath: "/work/proj",
      defaultBranch: null,
    },
  });
  assert.equal(calls[0]!.ctx?.branch, null);
  assert.equal(calls[0]!.ctx?.defaultBranch, null);
});

// ──────────────────────────────────────────────────────────────────────────
// Canonical alias — remnic.set_coding_context resolves to the same handler
// ──────────────────────────────────────────────────────────────────────────

test("remnic.set_coding_context: canonical name is aliased to the engram.* handler", async () => {
  const { mcp, calls } = makeMcp();
  const result = await call(mcp, "remnic.set_coding_context", {
    sessionKey: "session-B",
    codingContext: {
      projectId: "origin:deadbeef",
      branch: "feat/x",
      rootPath: "/work/x",
      defaultBranch: "main",
    },
  });
  assert.deepEqual(result, { ok: true });
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.sessionKey, "session-B");
});

// ──────────────────────────────────────────────────────────────────────────
// Validation — CLAUDE.md #51
// ──────────────────────────────────────────────────────────────────────────

test("engram.set_coding_context: empty sessionKey → throws EngramAccessInputError", async () => {
  const { mcp } = makeMcp();
  await assert.rejects(
    call(mcp, "engram.set_coding_context", {
      sessionKey: "",
      codingContext: {
        projectId: "origin:abcd",
        branch: "main",
        rootPath: "/work",
        defaultBranch: "main",
      },
    }),
    (err: unknown) => err instanceof EngramAccessInputError,
  );
});

test("engram.set_coding_context: non-null non-object codingContext → rejects", async () => {
  const { mcp } = makeMcp();
  await assert.rejects(
    call(mcp, "engram.set_coding_context", {
      sessionKey: "s",
      codingContext: "not-an-object",
    }),
    (err: unknown) => err instanceof EngramAccessInputError,
  );
});

test("engram.set_coding_context: branch missing (undefined) → rejects", async () => {
  const { mcp } = makeMcp();
  await assert.rejects(
    call(mcp, "engram.set_coding_context", {
      sessionKey: "s",
      codingContext: {
        projectId: "origin:abcd",
        rootPath: "/work",
        defaultBranch: "main",
        // branch field missing
      },
    }),
    (err: unknown) => err instanceof EngramAccessInputError && /branch/i.test((err as Error).message),
  );
});
