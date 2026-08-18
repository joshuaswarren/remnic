import assert from "node:assert/strict";
import { test } from "node:test";

import {
  normalizeCorpusEntry,
  normalizeMcpPayload,
  recordFingerprint,
  stableStringify,
  suggestionForRecord,
} from "./normalize.js";

const V2_PAGE = {
  data: [
    {
      id: "1800",
      text: "Great post on agent memory https://example.com/x",
      author_id: "7",
      created_at: "2026-07-01T12:00:00.000Z",
      entities: { urls: [{ url: "https://t.co/abc", expanded_url: "https://example.com/x" }] },
      attachments: { media_keys: ["3_1", "3_2"] },
    },
  ],
  includes: { users: [{ id: "7", username: "karpathy", name: "Andrej" }] },
  meta: { next_token: "p2" },
};

test("normalizes a v2 MCP payload with includes-based author resolution", () => {
  const records = normalizeMcpPayload(V2_PAGE, "bookmark");
  assert.equal(records.length, 1);
  const record = records[0];
  assert.equal(record.postId, "1800");
  assert.equal(record.kind, "bookmark");
  assert.equal(record.author?.username, "karpathy");
  assert.equal(record.author?.id, "7");
  assert.deepEqual(record.urls, ["https://example.com/x"]);
  assert.equal(record.mediaCount, 2);
  assert.equal(record.createdAt, "2026-07-01T12:00:00.000Z");
});

test("trims the trailing t.co share link from text", () => {
  const records = normalizeMcpPayload(
    {
      data: [
        {
          id: "1801",
          text: "Read this https://t.co/abc",
          entities: { urls: [{ url: "https://t.co/abc", expanded_url: "https://example.com/a" }] },
        },
      ],
    },
    "bookmark"
  );
  assert.equal(records[0].text, "Read this");
  assert.deepEqual(records[0].urls, ["https://example.com/a"]);
});

test("drops rows without an id or any content", () => {
  const records = normalizeMcpPayload({ data: [{ text: "no id" }, { id: "9" }, null] }, "bookmark");
  assert.equal(records.length, 0);
});

test("normalizes corpus entries across field aliases and kind labels", () => {
  const record = normalizeCorpusEntry(
    {
      tweet_id: "42",
      kind: "own_post",
      username: "jane",
      full_text: "Shipping the connector",
      url: "https://x.com/jane/status/42",
      bookmarked_at: "2026-07-02T00:00:00Z",
      enrichment: { title: "launch note" },
    },
    "bookmark"
  );
  assert.ok(record !== null);
  assert.equal(record.kind, "own_post");
  assert.equal(record.author?.username, "jane");
  assert.equal(record.text, "Shipping the connector");
  assert.deepEqual(record.urls, ["https://x.com/jane/status/42"]);
  assert.equal(record.bookmarkedAt, "2026-07-02T00:00:00Z");
  assert.equal(record.enrichment?.title, "launch note");
});

test("fingerprint is stable across key order and ignores provenance", () => {
  const a = normalizeCorpusEntry({ id: "5", text: "same", urls: "https://a.io" }, "bookmark");
  const b = normalizeCorpusEntry({ urls: "https://a.io", text: "same", id: "5" }, "bookmark");
  assert.ok(a !== null && b !== null);
  a.provenance = { sourceId: "one", sourceKind: "corpusDir", syncRunId: "r1", fetchedAt: "now" };
  b.provenance = { sourceId: "two", sourceKind: "cli", syncRunId: "r2", fetchedAt: "later" };
  assert.equal(recordFingerprint(a), recordFingerprint(b));
  assert.notEqual(stableStringify({ b: 1, a: 2 }), JSON.stringify({ b: 1, a: 2 }));
  assert.equal(stableStringify({ b: 1, a: 2 }), stableStringify({ a: 2, b: 1 }));
});

test("changed content changes the fingerprint (re-bookmark without churn)", () => {
  const base = normalizeCorpusEntry({ id: "5", text: "v1" }, "bookmark");
  const edited = normalizeCorpusEntry({ id: "5", text: "v2" }, "bookmark");
  assert.ok(base !== null && edited !== null);
  assert.notEqual(recordFingerprint(base), recordFingerprint(edited));
});

test("bookmark suggestion maps to x/bookmark reference with entity link", () => {
  const record = normalizeMcpPayload(V2_PAGE, "bookmark")[0];
  const suggestion = suggestionForRecord(record);
  assert.deepEqual(suggestion.tags, ["x/bookmark"]);
  assert.equal(suggestion.category, "reference");
  assert.equal(suggestion.entityRef, "person-karpathy");
  assert.equal(suggestion.confidence, 0.7);
  assert.equal(suggestion.postUrl, "https://x.com/karpathy/status/1800");
  assert.match(suggestion.content, /Bookmarked on X from @karpathy/);
  assert.match(suggestion.content, /https:\/\/example\.com\/x/);
});

test("own-post suggestion maps to x/post expression with higher confidence", () => {
  const record = normalizeCorpusEntry(
    { id: "9", kind: "post", username: "me", text: "I think connectors should compose" },
    "bookmark"
  );
  assert.ok(record !== null);
  const suggestion = suggestionForRecord(record);
  assert.deepEqual(suggestion.tags, ["x/post"]);
  assert.equal(suggestion.category, "expression");
  assert.equal(suggestion.confidence, 0.9);
  assert.equal(suggestion.postUrl, "https://x.com/me/status/9");
});

test("url-less bookmark classifies as interest and falls back to /i/status url", () => {
  const record = normalizeCorpusEntry({ id: "10", text: "just an idea" }, "bookmark");
  assert.ok(record !== null);
  const suggestion = suggestionForRecord(record);
  assert.equal(suggestion.category, "interest");
  assert.equal(suggestion.postUrl, "https://x.com/i/status/10");
});
