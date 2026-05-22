/**
 * Tests for coding context auto-resolution wiring (issue #569).
 *
 * Validates that:
 *   - `cwd` in recall/observe triggers git-context resolution and attaches
 *     a CodingContext to the session
 *   - `projectTag` creates a tag-based CodingContext
 *   - explicit `codingContext` takes precedence over `cwd` and `projectTag`
 *   - the MCP `set_coding_context` tool accepts `projectTag` as an
 *     alternative to full `codingContext`
 *   - zod schemas accept `cwd` and `projectTag` fields
 */

import assert from "node:assert/strict";
import test from "node:test";

import { EngramMcpServer } from "../access-mcp.js";
import { EngramAccessInputError, EngramAccessService } from "../access-service.js";
import type { CodingContext } from "../types.js";
import { validateRequest, type RecallRequest, type ObserveRequest } from "../access-schema.js";

// ──────────────────────────────────────────────────────────────────────────
// Schema validation tests
// ──────────────────────────────────────────────────────────────────────────

test("recall schema accepts cwd field", () => {
  const result = validateRequest<RecallRequest>("recall", {
    query: "test query",
    sessionKey: "sess-1",
    cwd: "/home/user/project",
  });
  assert.equal(result.success, true);
  if (result.success) {
    assert.equal(result.data.cwd, "/home/user/project");
  }
});

test("recall schema accepts projectTag field", () => {
  const result = validateRequest<RecallRequest>("recall", {
    query: "test query",
    sessionKey: "sess-1",
    projectTag: "blend-supply",
  });
  assert.equal(result.success, true);
  if (result.success) {
    assert.equal(result.data.projectTag, "blend-supply");
  }
});

test("recall schema accepts both cwd and projectTag", () => {
  const result = validateRequest("recall", {
    query: "test query",
    sessionKey: "sess-1",
    cwd: "/home/user/project",
    projectTag: "blend-supply",
  });
  assert.equal(result.success, true);
});

test("recall schema rejects empty cwd", () => {
  const result = validateRequest("recall", {
    query: "test query",
    cwd: "",
  });
  assert.equal(result.success, false);
});

test("recall schema rejects empty projectTag", () => {
  const result = validateRequest("recall", {
    query: "test query",
    projectTag: "",
  });
  assert.equal(result.success, false);
});

test("observe schema accepts cwd field", () => {
  const result = validateRequest<ObserveRequest>("observe", {
    sessionKey: "sess-1",
    messages: [{ role: "user", content: "hello" }],
    cwd: "/home/user/project",
  });
  assert.equal(result.success, true);
  if (result.success) {
    assert.equal(result.data.cwd, "/home/user/project");
  }
});

test("observe schema accepts projectTag field", () => {
  const result = validateRequest<ObserveRequest>("observe", {
    sessionKey: "sess-1",
    messages: [{ role: "user", content: "hello" }],
    projectTag: "worthington-direct",
  });
  assert.equal(result.success, true);
  if (result.success) {
    assert.equal(result.data.projectTag, "worthington-direct");
  }
});

test("observe schema preserves structured message-part fields", () => {
  const result = validateRequest<ObserveRequest>("observe", {
    sessionKey: "sess-1",
    messages: [
      {
        role: "assistant",
        content: "edited src/auth.ts",
        sourceFormat: "anthropic",
        rawContent: {
          content: [
            {
              type: "tool_use",
              name: "Edit",
              input: { path: "src/auth.ts" },
            },
          ],
        },
        parts: [
          {
            kind: "file_write",
            payload: { path: "src/auth.ts" },
            toolName: "Edit",
            filePath: "src/auth.ts",
          },
        ],
      },
    ],
  });
  assert.equal(result.success, true);
  if (result.success) {
    assert.equal(result.data.messages[0]?.sourceFormat, "anthropic");
    assert.deepEqual(result.data.messages[0]?.rawContent, {
      content: [
        {
          type: "tool_use",
          name: "Edit",
          input: { path: "src/auth.ts" },
        },
      ],
    });
    assert.equal(result.data.messages[0]?.parts?.[0]?.filePath, "src/auth.ts");
  }
});

test("observe schema rejects empty cwd", () => {
  const result = validateRequest("observe", {
    sessionKey: "sess-1",
    messages: [{ role: "user", content: "hello" }],
    cwd: "",
  });
  assert.equal(result.success, false);
});

// ──────────────────────────────────────────────────────────────────────────
// MCP set_coding_context with projectTag
// ──────────────────────────────────────────────────────────────────────────

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

async function call(mcp: EngramMcpServer, name: string, args: Record<string, unknown>): Promise<unknown> {
  const anyMcp = mcp as unknown as {
    callTool(n: string, a: Record<string, unknown>): Promise<unknown>;
  };
  return anyMcp.callTool(name, args);
}

test("set_coding_context with projectTag creates tag-based context", async () => {
  const { mcp, calls } = makeMcp();
  const result = await call(mcp, "engram.set_coding_context", {
    sessionKey: "session-A",
    projectTag: "blend-supply",
  });
  assert.deepEqual(result, { ok: true });
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.ctx?.projectId, "tag:blend-supply");
  assert.equal(calls[0]!.ctx?.branch, null);
  assert.equal(calls[0]!.ctx?.rootPath, "tag:blend-supply");
  assert.equal(calls[0]!.ctx?.defaultBranch, null);
});

test("set_coding_context with projectTag disambiguates lossy tags", async () => {
  const { mcp, calls } = makeMcp();
  await call(mcp, "engram.set_coding_context", {
    sessionKey: "session-A",
    projectTag: "blend/supply",
  });
  await call(mcp, "engram.set_coding_context", {
    sessionKey: "session-B",
    projectTag: "blend-supply",
  });

  assert.notEqual(calls[0]!.ctx?.projectId, calls[1]!.ctx?.projectId);
  assert.match(calls[0]!.ctx?.projectId ?? "", /^tag:blend-supply-[0-9a-f]{8}$/);
  assert.equal(calls[1]!.ctx?.projectId, "tag:blend-supply");
});

test("set_coding_context with codingContext takes precedence over projectTag", async () => {
  const { mcp, calls } = makeMcp();
  await call(mcp, "engram.set_coding_context", {
    sessionKey: "session-A",
    codingContext: {
      projectId: "origin:abcd1234",
      branch: "main",
      rootPath: "/work/proj",
      defaultBranch: "main",
    },
    projectTag: "blend-supply",
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.ctx?.projectId, "origin:abcd1234");
});

test("set_coding_context without codingContext or projectTag rejects", async () => {
  const { mcp } = makeMcp();
  await assert.rejects(
    call(mcp, "engram.set_coding_context", {
      sessionKey: "session-A",
    }),
    (err: unknown) => err instanceof EngramAccessInputError,
  );
});

test("set_coding_context with codingContext=null clears (even with projectTag present)", async () => {
  const { mcp, calls } = makeMcp();
  await call(mcp, "engram.set_coding_context", {
    sessionKey: "session-A",
    codingContext: null,
    projectTag: "blend-supply",
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.ctx, null);
});

test("set_coding_context projectTag via canonical alias remnic.*", async () => {
  const { mcp, calls } = makeMcp();
  const result = await call(mcp, "remnic.set_coding_context", {
    sessionKey: "session-B",
    projectTag: "worthington-direct",
  });
  assert.deepEqual(result, { ok: true });
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.ctx?.projectId, "tag:worthington-direct");
});

// ──────────────────────────────────────────────────────────────────────────
// MCP recall tool lists cwd and projectTag properties
// ──────────────────────────────────────────────────────────────────────────

test("engram.recall tool schema includes cwd and projectTag", () => {
  const { mcp } = makeMcp();
  const tools = (mcp as unknown as { tools: Array<{ name: string; inputSchema: Record<string, unknown> }> }).tools;
  const recallTool = tools.find((t) => t.name === "engram.recall");
  assert.ok(recallTool, "engram.recall tool should exist");
  const props = (recallTool!.inputSchema as { properties: Record<string, unknown> }).properties;
  assert.ok("cwd" in props, "engram.recall should have cwd property");
  assert.ok("projectTag" in props, "engram.recall should have projectTag property");
});

test("engram.observe tool schema includes cwd and projectTag", () => {
  const { mcp } = makeMcp();
  const tools = (mcp as unknown as { tools: Array<{ name: string; inputSchema: Record<string, unknown> }> }).tools;
  const observeTool = tools.find((t) => t.name === "engram.observe");
  assert.ok(observeTool, "engram.observe tool should exist");
  const props = (observeTool!.inputSchema as { properties: Record<string, unknown> }).properties;
  assert.ok("cwd" in props, "engram.observe should have cwd property");
  assert.ok("projectTag" in props, "engram.observe should have projectTag property");
});

test("engram.set_coding_context tool schema includes projectTag", () => {
  const { mcp } = makeMcp();
  const tools = (mcp as unknown as { tools: Array<{ name: string; inputSchema: Record<string, unknown> }> }).tools;
  const tool = tools.find((t) => t.name === "engram.set_coding_context");
  assert.ok(tool, "engram.set_coding_context tool should exist");
  const props = (tool!.inputSchema as { properties: Record<string, unknown> }).properties;
  assert.ok("projectTag" in props, "engram.set_coding_context should have projectTag property");
});

// ──────────────────────────────────────────────────────────────────────────
// maybeAttachCodingContext via service integration
// ──────────────────────────────────────────────────────────────────────────

test("maybeAttachCodingContext: projectTag attaches tag-based context", async () => {
  const calls: Array<{ sessionKey: string; ctx: CodingContext | null }> = [];
  const stubOrchestrator = {
    setCodingContextForSession(sessionKey: string, ctx: CodingContext | null) {
      calls.push({ sessionKey, ctx });
    },
    getCodingContextForSession(_sessionKey: string) {
      return null;
    },
    config: {
      codingMode: { projectScope: true, branchScope: false },
      defaultNamespace: "default",
    },
  };
  const service = Object.create(EngramAccessService.prototype) as EngramAccessService;
  (service as unknown as { orchestrator: typeof stubOrchestrator }).orchestrator = stubOrchestrator;

  // Call the private method directly via cast
  const maybeAttach = (service as unknown as {
    maybeAttachCodingContext(
      sessionKey: string | undefined,
      options: { cwd?: string; projectTag?: string },
    ): Promise<void>;
  }).maybeAttachCodingContext.bind(service);

  await maybeAttach("session-X", { projectTag: "blend-supply" });
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.ctx?.projectId, "tag:blend-supply");
  assert.equal(calls[0]!.ctx?.rootPath, "tag:blend-supply");
});

test("maybeAttachCodingContext: skips when session already has context", async () => {
  const calls: Array<{ sessionKey: string; ctx: CodingContext | null }> = [];
  const stubOrchestrator = {
    setCodingContextForSession(sessionKey: string, ctx: CodingContext | null) {
      calls.push({ sessionKey, ctx });
    },
    getCodingContextForSession(_sessionKey: string) {
      return { projectId: "existing", branch: null, rootPath: "/x", defaultBranch: null };
    },
    config: {
      codingMode: { projectScope: true, branchScope: false },
      defaultNamespace: "default",
    },
  };
  const service = Object.create(EngramAccessService.prototype) as EngramAccessService;
  (service as unknown as { orchestrator: typeof stubOrchestrator }).orchestrator = stubOrchestrator;

  const maybeAttach = (service as unknown as {
    maybeAttachCodingContext(
      sessionKey: string | undefined,
      options: { cwd?: string; projectTag?: string },
    ): Promise<void>;
  }).maybeAttachCodingContext.bind(service);

  await maybeAttach("session-X", { projectTag: "blend-supply" });
  assert.equal(calls.length, 0, "should not overwrite existing context");
});

test("maybeAttachCodingContext: skips when projectScope disabled", async () => {
  const calls: Array<{ sessionKey: string; ctx: CodingContext | null }> = [];
  const stubOrchestrator = {
    setCodingContextForSession(sessionKey: string, ctx: CodingContext | null) {
      calls.push({ sessionKey, ctx });
    },
    getCodingContextForSession(_sessionKey: string) {
      return null;
    },
    config: {
      codingMode: { projectScope: false, branchScope: false },
      defaultNamespace: "default",
    },
  };
  const service = Object.create(EngramAccessService.prototype) as EngramAccessService;
  (service as unknown as { orchestrator: typeof stubOrchestrator }).orchestrator = stubOrchestrator;

  const maybeAttach = (service as unknown as {
    maybeAttachCodingContext(
      sessionKey: string | undefined,
      options: { cwd?: string; projectTag?: string },
    ): Promise<void>;
  }).maybeAttachCodingContext.bind(service);

  await maybeAttach("session-X", { projectTag: "blend-supply" });
  assert.equal(calls.length, 0, "should not attach when projectScope is disabled");
});

test("maybeAttachCodingContext: skips when no sessionKey", async () => {
  const calls: Array<{ sessionKey: string; ctx: CodingContext | null }> = [];
  const stubOrchestrator = {
    setCodingContextForSession(sessionKey: string, ctx: CodingContext | null) {
      calls.push({ sessionKey, ctx });
    },
    getCodingContextForSession(_sessionKey: string) {
      return null;
    },
    config: {
      codingMode: { projectScope: true, branchScope: false },
      defaultNamespace: "default",
    },
  };
  const service = Object.create(EngramAccessService.prototype) as EngramAccessService;
  (service as unknown as { orchestrator: typeof stubOrchestrator }).orchestrator = stubOrchestrator;

  const maybeAttach = (service as unknown as {
    maybeAttachCodingContext(
      sessionKey: string | undefined,
      options: { cwd?: string; projectTag?: string },
    ): Promise<void>;
  }).maybeAttachCodingContext.bind(service);

  await maybeAttach(undefined, { projectTag: "blend-supply" });
  assert.equal(calls.length, 0, "should not attach without sessionKey");
});

test("maybeAttachCodingContext: skips when neither cwd nor projectTag provided", async () => {
  const calls: Array<{ sessionKey: string; ctx: CodingContext | null }> = [];
  const stubOrchestrator = {
    setCodingContextForSession(sessionKey: string, ctx: CodingContext | null) {
      calls.push({ sessionKey, ctx });
    },
    getCodingContextForSession(_sessionKey: string) {
      return null;
    },
    config: {
      codingMode: { projectScope: true, branchScope: false },
      defaultNamespace: "default",
    },
  };
  const service = Object.create(EngramAccessService.prototype) as EngramAccessService;
  (service as unknown as { orchestrator: typeof stubOrchestrator }).orchestrator = stubOrchestrator;

  const maybeAttach = (service as unknown as {
    maybeAttachCodingContext(
      sessionKey: string | undefined,
      options: { cwd?: string; projectTag?: string },
    ): Promise<void>;
  }).maybeAttachCodingContext.bind(service);

  await maybeAttach("session-X", {});
  assert.equal(calls.length, 0, "should not attach without cwd or projectTag");
});

// ──────────────────────────────────────────────────────────────────────────
// P1: Non-string cwd/projectTag must be rejected in MCP (CLAUDE.md #51)
// ──────────────────────────────────────────────────────────────────────────

test("MCP recall rejects non-string cwd (e.g. number)", async () => {
  const { mcp } = makeMcp();
  await assert.rejects(
    call(mcp, "engram.recall", { query: "test", cwd: 123 }),
    (err: unknown) => err instanceof EngramAccessInputError && /cwd/i.test((err as Error).message),
  );
});

test("MCP recall rejects non-string projectTag (e.g. boolean)", async () => {
  const { mcp } = makeMcp();
  await assert.rejects(
    call(mcp, "engram.recall", { query: "test", projectTag: false }),
    (err: unknown) => err instanceof EngramAccessInputError && /projectTag/i.test((err as Error).message),
  );
});

test("MCP observe rejects non-string cwd", async () => {
  const { mcp } = makeMcp();
  await assert.rejects(
    call(mcp, "engram.observe", {
      sessionKey: "s",
      messages: [{ role: "user", content: "hi" }],
      cwd: 42,
    }),
    (err: unknown) => err instanceof EngramAccessInputError && /cwd/i.test((err as Error).message),
  );
});

test("MCP observe rejects non-string projectTag", async () => {
  const { mcp } = makeMcp();
  await assert.rejects(
    call(mcp, "engram.observe", {
      sessionKey: "s",
      messages: [{ role: "user", content: "hi" }],
      projectTag: true,
    }),
    (err: unknown) => err instanceof EngramAccessInputError && /projectTag/i.test((err as Error).message),
  );
});
