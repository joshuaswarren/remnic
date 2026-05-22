import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  parseAnthropicMessageParts,
  parseMessageParts,
  parseOpenClawMessageParts,
  parseOpenAiMessageParts,
  parsePiMessageParts,
} from "./index.js";

describe("message-parts parsers", () => {
  it("extracts OpenAI Responses function calls and file paths", () => {
    const parts = parseOpenAiMessageParts({
      output: [
        {
          type: "message",
          content: [{ type: "output_text", text: "Updated src/auth.ts" }],
        },
        {
          type: "function_call",
          name: "apply_patch",
          arguments: JSON.stringify({
            patch: "*** Begin Patch\n*** Update File: src/auth.ts\n*** End Patch",
          }),
        },
      ],
    });

    assert.equal(parts.length, 2);
    assert.equal(parts[0]!.kind, "text");
    assert.equal(parts[0]!.filePath, "src/auth.ts");
    assert.equal(parts[1]!.kind, "patch");
    assert.equal(parts[1]!.toolName, "apply_patch");
    assert.equal(parts[1]!.filePath, "src/auth.ts");
  });

  it("infers OpenAI single message objects before generic content arrays", () => {
    const parts = parseMessageParts({
      type: "message",
      content: [{ type: "output_text", text: "Read src/config.ts" }],
    });

    assert.equal(parts.length, 1);
    assert.equal(parts[0]!.kind, "text");
    assert.equal(parts[0]!.filePath, "src/config.ts");
  });

  it("infers top-level OpenAI response item arrays before Anthropic arrays", () => {
    const parts = parseMessageParts([
      {
        type: "message",
        content: [{ type: "output_text", text: "Updated src/router.ts" }],
      },
      {
        type: "function_call",
        name: "apply_patch",
        arguments: JSON.stringify({
          patch: "*** Begin Patch\n*** Update File: src/router.ts\n*** End Patch",
        }),
      },
    ]);

    assert.equal(parts.length, 2);
    assert.equal(parts[0]!.kind, "text");
    assert.equal(parts[0]!.filePath, "src/router.ts");
    assert.equal(parts[1]!.kind, "patch");
    assert.equal(parts[1]!.toolName, "apply_patch");
  });

  it("infers top-level OpenAI content-block arrays", () => {
    const parts = parseMessageParts([
      { type: "output_text", text: "Updated src/auth.ts." },
      { type: "output_text", text: "Read src/session.ts" },
    ]);

    assert.equal(parts.length, 2);
    assert.equal(parts[0]!.kind, "text");
    assert.equal(parts[0]!.filePath, "src/auth.ts");
    assert.equal(parts[1]!.filePath, "src/session.ts");
  });

  it("infers untyped OpenAI content-block wrappers", () => {
    const parts = parseMessageParts({
      content: [{ type: "output_text", text: "Updated src/auth.ts" }],
    });

    assert.equal(parts.length, 1);
    assert.equal(parts[0]!.kind, "text");
    assert.equal(parts[0]!.filePath, "src/auth.ts");
  });

  it("preserves leading dots in extracted file paths", () => {
    const parts = parseMessageParts([
      { type: "output_text", text: "Touched ./src/auth.ts." },
      { type: "output_text", text: "Read ../src/session.ts." },
      { type: "output_text", text: "Updated .github/workflows/ci.yml." },
    ]);

    assert.equal(parts.length, 3);
    assert.equal(parts[0]!.filePath, "./src/auth.ts");
    assert.equal(parts[1]!.filePath, "../src/session.ts");
    assert.equal(parts[2]!.filePath, ".github/workflows/ci.yml");
  });

  it("extracts basename dotfiles and extensionless repository files", () => {
    const parts = parseMessageParts([
      { type: "output_text", text: "Updated .env." },
      { type: "output_text", text: "Updated .gitignore." },
      { type: "output_text", text: "Read Dockerfile." },
      { type: "output_text", text: "Read Makefile." },
    ]);

    assert.equal(parts.length, 4);
    assert.deepEqual(parts.map((part) => part.filePath), [
      ".env",
      ".gitignore",
      "Dockerfile",
      "Makefile",
    ]);
  });

  it("does not treat lowercase prose as extensionless repository files", () => {
    const parts = parseMessageParts([
      { type: "output_text", text: "I notice this issue and will readme later." },
      { type: "output_text", text: "Read README." },
    ]);

    assert.equal(parts.length, 2);
    assert.equal(parts[0]!.filePath, null);
    assert.equal(parts[1]!.filePath, "README");
  });

  it("does not treat prose dot-prefixed words as bare dotfiles", () => {
    const parts = parseMessageParts([
      { type: "output_text", text: "I built it in .NET." },
      { type: "output_text", text: "Updated .env." },
      { type: "output_text", text: "Updated ./.config." },
    ]);

    assert.equal(parts.length, 3);
    assert.equal(parts[0]!.filePath, null);
    assert.equal(parts[1]!.filePath, ".env");
    assert.equal(parts[2]!.filePath, "./.config");
  });

  it("routes OpenClaw OpenAI-style typed content blocks through the OpenAI parser", () => {
    const parts = parseOpenClawMessageParts({
      content: [{ type: "output_text", text: "Updated src/openclaw.ts." }],
    });

    assert.equal(parts.length, 1);
    assert.equal(parts[0]!.kind, "text");
    assert.equal(parts[0]!.filePath, "src/openclaw.ts");
  });

  it("routes OpenClaw tool-call blocks through the structured tool parser", () => {
    const parts = parseOpenClawMessageParts({
      content: [
        { type: "toolCall", name: "edit", arguments: { path: "src/openclaw.ts" } },
      ],
    });

    assert.equal(parts.length, 1);
    assert.equal(parts[0]!.kind, "file_write");
    assert.equal(parts[0]!.toolName, "edit");
    assert.equal(parts[0]!.filePath, "src/openclaw.ts");
  });

  it("preserves mixed OpenClaw OpenAI text and tool-call content blocks", () => {
    const parts = parseOpenClawMessageParts({
      content: [
        { type: "output_text", text: "Updated src/openclaw.ts." },
        { type: "toolCall", name: "edit", arguments: { path: "src/openclaw.ts" } },
      ],
    });

    assert.equal(parts.length, 2);
    assert.equal(parts[0]!.kind, "text");
    assert.equal(parts[0]!.filePath, "src/openclaw.ts");
    assert.equal(parts[1]!.kind, "file_write");
    assert.equal(parts[1]!.toolName, "edit");
    assert.equal(parts[1]!.filePath, "src/openclaw.ts");
  });

  it("preserves mixed OpenClaw Pi text and tool-call content blocks", () => {
    const parts = parseOpenClawMessageParts({
      content: [
        { type: "text", text: "Updated packages/plugin-pi/src/index.ts" },
        { type: "toolCall", name: "edit", arguments: { path: "packages/plugin-pi/src/index.ts" } },
      ],
    });

    assert.equal(parts.length, 2);
    assert.equal(parts[0]!.kind, "text");
    assert.equal(parts[0]!.filePath, "packages/plugin-pi/src/index.ts");
    assert.equal(parts[1]!.kind, "file_write");
    assert.equal(parts[1]!.toolName, "edit");
    assert.equal(parts[1]!.filePath, "packages/plugin-pi/src/index.ts");
  });

  it("does not infer text-only content arrays as Pi", () => {
    const parts = parseMessageParts({
      role: "assistant",
      content: [
        { type: "text", text: "Updated packages/plugin-anthropic/src/index.ts" },
      ],
    });

    assert.equal(parts.length, 1);
    assert.equal(parts[0]!.kind, "text");
    assert.equal(parts[0]!.filePath, "packages/plugin-anthropic/src/index.ts");
  });

  it("infers mixed OpenClaw content without dropping tool-call blocks", () => {
    const parts = parseMessageParts({
      content: [
        { type: "output_text", text: "Updated src/openclaw.ts." },
        { type: "toolCall", name: "edit", arguments: { path: "src/openclaw.ts" } },
      ],
    });

    assert.equal(parts.length, 2);
    assert.equal(parts[0]!.kind, "text");
    assert.equal(parts[1]!.kind, "file_write");
    assert.equal(parts[1]!.toolName, "edit");
    assert.equal(parts[1]!.filePath, "src/openclaw.ts");
  });

  it("infers mixed OpenAI text and Anthropic tool blocks as OpenClaw", () => {
    const parts = parseMessageParts({
      content: [
        { type: "output_text", text: "Updated src/mixed-provider.ts." },
        {
          type: "tool_use",
          id: "toolu_mixed",
          name: "Edit",
          input: { path: "src/mixed-provider.ts", old_string: "a", new_string: "b" },
        },
      ],
    });

    assert.equal(parts.length, 2);
    assert.equal(parts[0]!.kind, "text");
    assert.equal(parts[0]!.filePath, "src/mixed-provider.ts");
    assert.equal(parts[1]!.kind, "file_write");
    assert.equal(parts[1]!.toolName, "Edit");
    assert.equal(parts[1]!.filePath, "src/mixed-provider.ts");
  });

  it("extracts Pi tool-call content blocks as structured file writes", () => {
    const parts = parsePiMessageParts({
      role: "assistant",
      content: [
        { type: "text", text: "Updated packages/plugin-pi/src/index.ts" },
        { type: "toolCall", name: "edit", arguments: { path: "packages/plugin-pi/src/index.ts" } },
      ],
    });

    assert.equal(parts.length, 2);
    assert.equal(parts[0]!.kind, "text");
    assert.equal(parts[0]!.filePath, "packages/plugin-pi/src/index.ts");
    assert.equal(parts[1]!.kind, "file_write");
    assert.equal(parts[1]!.toolName, "edit");
    assert.equal(parts[1]!.filePath, "packages/plugin-pi/src/index.ts");
  });

  it("extracts top-level Pi tool-call arrays without rendered fallback", () => {
    const parts = parseMessageParts(
      [{ type: "toolCall", name: "edit", arguments: { path: "src/a.ts" } }],
      { sourceFormat: "pi" },
    );

    assert.equal(parts.length, 1);
    assert.equal(parts[0]!.kind, "file_write");
    assert.equal(parts[0]!.toolName, "edit");
    assert.equal(parts[0]!.filePath, "src/a.ts");
  });

  it("infers top-level Pi mixed arrays without dropping tool-call blocks", () => {
    const parts = parseMessageParts([
      { type: "text", text: "Updated src/a.ts" },
      { type: "toolCall", name: "edit", arguments: { path: "src/a.ts" } },
    ]);

    assert.equal(parts.length, 2);
    assert.equal(parts[0]!.kind, "text");
    assert.equal(parts[0]!.filePath, "src/a.ts");
    assert.equal(parts[1]!.kind, "file_write");
    assert.equal(parts[1]!.toolName, "edit");
    assert.equal(parts[1]!.filePath, "src/a.ts");
  });

  it("extracts top-level OpenClaw arrays through mixed block parsing", () => {
    const parts = parseMessageParts(
      [
        { type: "output_text", text: "Updated src/openclaw.ts" },
        { type: "toolCall", name: "edit", arguments: { path: "src/openclaw.ts" } },
      ],
      { sourceFormat: "openclaw" },
    );

    assert.equal(parts.length, 2);
    assert.equal(parts[0]!.kind, "text");
    assert.equal(parts[0]!.filePath, "src/openclaw.ts");
    assert.equal(parts[1]!.kind, "file_write");
    assert.equal(parts[1]!.toolName, "edit");
    assert.equal(parts[1]!.filePath, "src/openclaw.ts");
  });

  it("infers Pi source format for Pi-shaped raw content", () => {
    const parts = parseMessageParts({
      role: "assistant",
      content: [
        { type: "toolCall", name: "read", arguments: { path: "src/config.ts" } },
      ],
    });

    assert.equal(parts.length, 1);
    assert.equal(parts[0]!.kind, "file_read");
    assert.equal(parts[0]!.filePath, "src/config.ts");
  });

  it("preserves top-level Pi tool results with string content", () => {
    const parts = parseMessageParts({
      role: "toolResult",
      toolName: "read",
      toolCallId: "call_1",
      isError: true,
      content: "Read failed for src/config.ts",
    });

    assert.equal(parts.length, 1);
    assert.equal(parts[0]!.kind, "tool_result");
    assert.equal(parts[0]!.toolName, "read");
    assert.equal(parts[0]!.filePath, "src/config.ts");
    assert.deepEqual(parts[0]!.payload, {
      id: "call_1",
      name: "read",
      output: "Read failed for src/config.ts",
      isError: true,
    });
  });

  it("prefers Pi tool-result content paths over cwd metadata", () => {
    const parts = parseMessageParts({
      role: "toolResult",
      toolName: "read",
      cwd: "/repo",
      content: "Read failed for src/config.ts",
    });

    assert.equal(parts.length, 1);
    assert.equal(parts[0]!.kind, "tool_result");
    assert.equal(parts[0]!.filePath, "src/config.ts");
  });

  it("uses rendered fallback inside the Pi parser when structured parsing finds no parts", () => {
    const parts = parsePiMessageParts(
      { role: "assistant", content: [{ type: "unknown", value: "ignored" }] },
      { renderedContent: "Updated packages/plugin-pi/src/index.ts" },
    );

    assert.equal(parts.length, 1);
    assert.equal(parts[0]!.kind, "file_read");
    assert.equal(parts[0]!.filePath, "packages/plugin-pi/src/index.ts");
  });

  it("extracts Anthropic tool_use blocks as structured file writes", () => {
    const parts = parseAnthropicMessageParts({
      content: [
        { type: "text", text: "I will edit packages/core/src/config.ts" },
        {
          type: "tool_use",
          id: "toolu_1",
          name: "Edit",
          input: { path: "packages/core/src/config.ts", old_string: "a", new_string: "b" },
        },
      ],
    });

    assert.equal(parts.length, 2);
    assert.equal(parts[1]!.kind, "file_write");
    assert.equal(parts[1]!.filePath, "packages/core/src/config.ts");
  });

  it("extracts Anthropic kind aliases as structured parts", () => {
    const parts = parseAnthropicMessageParts({
      content: [
        { kind: "text", text: "I will edit packages/core/src/aliases.ts" },
        {
          kind: "tool_use",
          id: "toolu_kind",
          name: "Edit",
          input: { path: "packages/core/src/aliases.ts", old_string: "a", new_string: "b" },
        },
      ],
    });

    assert.equal(parts.length, 2);
    assert.equal(parts[0]!.kind, "text");
    assert.equal(parts[0]!.filePath, "packages/core/src/aliases.ts");
    assert.equal(parts[1]!.kind, "file_write");
    assert.equal(parts[1]!.filePath, "packages/core/src/aliases.ts");
  });

  it("preserves Anthropic tool_result error flags", () => {
    const parts = parseAnthropicMessageParts({
      content: [
        {
          type: "tool_result",
          tool_use_id: "toolu_failed",
          is_error: true,
          content: [{ type: "text", text: "exit code 1" }],
        },
      ],
    });

    assert.equal(parts.length, 1);
    assert.equal(parts[0]!.kind, "tool_result");
    assert.equal(parts[0]!.payload.id, "toolu_failed");
    assert.equal(parts[0]!.payload.is_error, true);
  });

  it("infers Anthropic tool_result blocks before Pi source format", () => {
    const parts = parseMessageParts({
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "toolu_inferred",
          content: [{ type: "text", text: "exit code 1" }],
        },
      ],
    });

    assert.equal(parts.length, 1);
    assert.equal(parts[0]!.kind, "tool_result");
    assert.equal(parts[0]!.payload.id, "toolu_inferred");
  });

  it("infers Anthropic kind alias blocks before Pi source format", () => {
    const parts = parseMessageParts({
      role: "user",
      content: [
        {
          kind: "tool_result",
          tool_use_id: "toolu_kind_inferred",
          content: [{ kind: "text", text: "Updated src/aliases.ts" }],
        },
      ],
    });

    assert.equal(parts.length, 1);
    assert.equal(parts[0]!.kind, "tool_result");
    assert.equal(parts[0]!.payload.id, "toolu_kind_inferred");
    assert.equal(parts[0]!.filePath, "src/aliases.ts");
  });

  it("normalizes explicit Remnic parts and redacts secrets", () => {
    const parts = parseMessageParts({
      parts: [
        {
          kind: "tool_call",
          tool_name: "fetch",
          payload: { authorization: "Bearer abc", url: "https://example.test" },
        },
      ],
    });

    assert.equal(parts.length, 1);
    assert.deepEqual(parts[0]!.payload, {
      authorization: "[redacted]",
      url: "https://example.test",
    });
  });

  it("can disable rendered text fallback for structured-only callers", () => {
    const parts = parseMessageParts(
      {
        role: "assistant",
        content: [
          "Suggested patch:",
          "*** Begin Patch",
          "*** Update File: src/suggested.ts",
          "+not executed",
          "*** End Patch",
        ].join("\n"),
      },
      {
        sourceFormat: "openclaw",
        allowRenderedFallback: false,
      },
    );

    assert.deepEqual(parts, []);
  });
});
