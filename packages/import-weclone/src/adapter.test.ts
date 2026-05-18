// ---------------------------------------------------------------------------
// Tests — WeClone bulk-import source adapter
// ---------------------------------------------------------------------------

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { wecloneImportAdapter } from "./adapter.js";

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("wecloneImportAdapter", () => {
  it("has correct name", () => {
    assert.equal(wecloneImportAdapter.name, "weclone");
  });

  it("parse delegates to parseWeCloneExport and returns valid result", async () => {
    const input = {
      platform: "telegram",
      messages: [
        {
          sender: "Alice",
          text: "hello world",
          timestamp: "2025-01-10T08:00:00.000Z",
        },
        {
          sender: "Bob",
          text: "hi there",
          timestamp: "2025-01-10T08:05:00.000Z",
        },
      ],
    };
    const result = await wecloneImportAdapter.parse(input);
    assert.equal(typeof result, "object");
    assert.ok(Array.isArray(result.turns));
    assert.equal(result.turns.length, 2);
    assert.equal(result.metadata.source, "weclone-telegram");
    assert.equal(result.metadata.messageCount, 2);
  });

  it("parse passes strict option through", () => {
    const input = {
      platform: "telegram",
      messages: [
        { sender: "", text: "no sender", timestamp: "2025-01-10T08:00:00.000Z" },
      ],
    };
    assert.throws(
      () => wecloneImportAdapter.parse(input, { strict: true }),
      /invalid/,
    );
  });

  it("parse works without options", async () => {
    const input = {
      messages: [
        {
          sender: "Alice",
          text: "test",
          timestamp: "2025-01-10T08:00:00.000Z",
        },
      ],
    };
    const result = await wecloneImportAdapter.parse(input);
    assert.equal(result.turns.length, 1);
  });

  it("parse forwards platform option to parser", async () => {
    const input = {
      messages: [
        {
          sender: "Alice",
          text: "hello",
          timestamp: "2025-01-10T08:00:00.000Z",
        },
      ],
    };
    const result = await wecloneImportAdapter.parse(input, { platform: "discord" });
    assert.equal(result.metadata.source, "weclone-discord");
  });

  it("parse rejects invalid platform option", () => {
    const input = {
      messages: [
        {
          sender: "Alice",
          text: "hello",
          timestamp: "2025-01-10T08:00:00.000Z",
        },
      ],
    };
    assert.throws(
      () => wecloneImportAdapter.parse(input, { platform: "signal" }),
      /invalid platform/,
    );
  });

  it("implements BulkImportSourceAdapter interface correctly", () => {
    assert.equal(typeof wecloneImportAdapter.name, "string");
    assert.equal(typeof wecloneImportAdapter.parse, "function");
  });
});
