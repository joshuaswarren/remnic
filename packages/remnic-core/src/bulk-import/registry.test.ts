import assert from "node:assert/strict";
import { describe, it, beforeEach } from "node:test";

import {
  registerBulkImportSource,
  getBulkImportSource,
  listBulkImportSources,
  clearBulkImportSources,
} from "./registry.js";
import type { BulkImportSourceAdapter } from "./types.js";

function makeAdapter(
  name: string,
): BulkImportSourceAdapter {
  return {
    name,
    parse: () => ({
      turns: [],
      metadata: {
        source: name,
        exportDate: "2024-06-15T00:00:00.000Z",
        messageCount: 0,
        dateRange: {
          from: "2024-01-01T00:00:00.000Z",
          to: "2024-06-15T00:00:00.000Z",
        },
      },
    }),
  };
}

describe("bulk-import registry", () => {
  beforeEach(() => {
    clearBulkImportSources();
  });

  it("registers and retrieves a source adapter", () => {
    const adapter = makeAdapter("weclone-telegram");
    registerBulkImportSource(adapter);
    const retrieved = getBulkImportSource("weclone-telegram");
    assert.equal(retrieved, adapter);
  });

  it("lists registered adapter names", () => {
    registerBulkImportSource(makeAdapter("source-a"));
    registerBulkImportSource(makeAdapter("source-b"));
    const names = listBulkImportSources();
    assert.deepEqual(names.sort(), ["source-a", "source-b"]);
  });

  it("rejects duplicate registration", () => {
    registerBulkImportSource(makeAdapter("dup-source"));
    assert.throws(
      () => registerBulkImportSource(makeAdapter("dup-source")),
      (err: Error) => {
        assert.ok(
          err.message.includes("already registered"),
          `expected 'already registered' in: ${err.message}`,
        );
        return true;
      },
    );
  });

  it("returns undefined for unknown source", () => {
    const result = getBulkImportSource("nonexistent");
    assert.equal(result, undefined);
  });

  it("rejects empty adapter name", () => {
    assert.throws(
      () => registerBulkImportSource(makeAdapter("")),
      (err: Error) => {
        assert.ok(
          err.message.includes("non-empty string"),
          `expected 'non-empty string' in: ${err.message}`,
        );
        return true;
      },
    );
  });

  it("rejects whitespace-only adapter name", () => {
    assert.throws(
      () => registerBulkImportSource(makeAdapter("   ")),
      (err: Error) => {
        assert.ok(
          err.message.includes("non-empty string"),
          `expected 'non-empty string' in: ${err.message}`,
        );
        return true;
      },
    );
  });

  it("rejects null adapter", () => {
    assert.throws(
      () =>
        registerBulkImportSource(
          null as unknown as BulkImportSourceAdapter,
        ),
      (err: Error) => {
        assert.ok(err.message.includes("must be an object"));
        return true;
      },
    );
  });

  it("rejects adapter without parse function", () => {
    const bad = { name: "no-parse" } as unknown as BulkImportSourceAdapter;
    assert.throws(
      () => registerBulkImportSource(bad),
      (err: Error) => {
        assert.ok(err.message.includes("parse function"));
        return true;
      },
    );
  });

  it("clearBulkImportSources removes all adapters", () => {
    registerBulkImportSource(makeAdapter("x"));
    assert.equal(listBulkImportSources().length, 1);
    clearBulkImportSources();
    assert.equal(listBulkImportSources().length, 0);
  });

  it("retrieves adapter when lookup name has leading/trailing whitespace", () => {
    // Registration trims the name on write; lookup must trim as well,
    // otherwise `get('  weclone  ')` would miss the adapter stored
    // under the trimmed key `weclone`.
    const adapter = makeAdapter("weclone");
    registerBulkImportSource(adapter);
    assert.equal(getBulkImportSource("weclone"), adapter);
    assert.equal(getBulkImportSource("  weclone  "), adapter);
    assert.equal(getBulkImportSource("\tweclone\n"), adapter);
  });

  it("returns undefined for non-string or empty lookup names", () => {
    registerBulkImportSource(makeAdapter("weclone"));
    assert.equal(getBulkImportSource(""), undefined);
    assert.equal(getBulkImportSource("   "), undefined);
    assert.equal(
      getBulkImportSource(null as unknown as string),
      undefined,
    );
    assert.equal(
      getBulkImportSource(undefined as unknown as string),
      undefined,
    );
  });
});
