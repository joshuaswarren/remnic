import assert from "node:assert/strict";
import test from "node:test";

import {
  LEGACY_FALLBACK_CHANNEL_ID,
  LEGACY_FALLBACK_CHANNEL_TYPE,
  SESSION_CHANNEL_TYPE,
  legacyParserReadbackDir,
  parseSessionIdentity,
  sessionStoragePaths,
} from "./session-identity.js";

test("legacy agent:<id>:main keeps main/default channel identity", () => {
  const id = parseSessionIdentity("agent:generalist:main");
  assert.equal(id.legacy, true);
  assert.equal(id.channelType, "main");
  assert.equal(id.channelId, "default");
  assert.equal(id.canonicalSessionKey, "agent:generalist:main");
});

test("legacy discord channel keeps discord/<channelId> identity", () => {
  const id = parseSessionIdentity("agent:generalist:discord:channel:998877");
  assert.equal(id.legacy, true);
  assert.equal(id.channelType, "discord");
  assert.equal(id.channelId, "998877");
});

test("legacy slack channel keeps slack/<channelId> identity", () => {
  const id = parseSessionIdentity("agent:generalist:slack:channel:C12345");
  assert.equal(id.legacy, true);
  assert.equal(id.channelType, "slack");
  assert.equal(id.channelId, "C12345");
});

test("legacy cron job keeps cron/<jobId> identity", () => {
  const id = parseSessionIdentity("agent:generalist:cron:nightly-sync");
  assert.equal(id.legacy, true);
  assert.equal(id.channelType, "cron");
  assert.equal(id.channelId, "nightly-sync");
});

test("arbitrary key becomes a first-class session/<hash> identity, never other/default", () => {
  const id = parseSessionIdentity("pi-geek:abc123");
  assert.equal(id.legacy, false);
  assert.equal(id.channelType, SESSION_CHANNEL_TYPE);
  assert.notEqual(id.channelType, LEGACY_FALLBACK_CHANNEL_TYPE);
  assert.notEqual(id.channelId, LEGACY_FALLBACK_CHANNEL_ID);
  assert.match(id.channelId, /^[0-9a-f]{16}$/);
});

test("distinct arbitrary keys get distinct, collision-resistant hashes", () => {
  const geek = parseSessionIdentity("pi-geek:abc123");
  const friend = parseSessionIdentity("pi-friend:def456");
  assert.notEqual(geek.channelId, friend.channelId);
});

test("identity is deterministic for the same key", () => {
  const a = parseSessionIdentity("pi-geek:abc123");
  const b = parseSessionIdentity("pi-geek:abc123");
  assert.deepEqual(a, b);
});

test("a bare token without the agent prefix is treated as arbitrary, not legacy", () => {
  // "foo:bar:baz" must NOT be misread as channelType="baz".
  const id = parseSessionIdentity("foo:bar:baz");
  assert.equal(id.legacy, false);
  assert.equal(id.channelType, SESSION_CHANNEL_TYPE);
});

test("empty session key resolves without throwing", () => {
  const id = parseSessionIdentity("");
  assert.equal(id.legacy, false);
  assert.equal(id.channelType, SESSION_CHANNEL_TYPE);
  assert.equal(typeof id.channelId, "string");
});

test("sessionStoragePaths routes arbitrary keys to session/<hash>", () => {
  const paths = sessionStoragePaths("pi-geek:abc123");
  assert.equal(paths.channelType, SESSION_CHANNEL_TYPE);
  assert.match(paths.dir, /^session\/[0-9a-f]{16}$/);
});

test("sessionStoragePaths keeps legacy main at main/default", () => {
  const paths = sessionStoragePaths("agent:generalist:main");
  assert.equal(paths.dir, "main/default");
});

test("two arbitrary keys never share a storage dir", () => {
  const a = sessionStoragePaths("pi-geek:abc123");
  const b = sessionStoragePaths("pi-friend:def456");
  assert.notEqual(a.dir, b.dir);
  assert.notEqual(a.dir, "other/default");
  assert.notEqual(b.dir, "other/default");
});

test("display label strips control characters and separators", () => {
  const id = parseSessionIdentity("pi-geek:abc/123");
  assert.ok(!id.displayLabel.includes("/"));
  assert.ok(id.displayLabel.length > 0);
});

test("legacyParserReadbackDir reconstructs the OLD parser dir for >=3-part keys", () => {
  // foo:bar:baz → channelType=baz, channelId=default
  assert.equal(legacyParserReadbackDir("foo:bar:baz"), "baz/default");
  // foo:bar:baz:qux → channelType=baz, channelId=qux
  assert.equal(legacyParserReadbackDir("foo:bar:baz:qux"), "baz/qux");
});

test("legacyParserReadbackDir returns undefined for <3-part keys (old build used other/default)", () => {
  assert.equal(legacyParserReadbackDir("pi-geek:abc123"), undefined);
  assert.equal(legacyParserReadbackDir("bare"), undefined);
  assert.equal(legacyParserReadbackDir(""), undefined);
});

test("readbackDirs for a >=3-part arbitrary key include other/default AND the old parser dir", () => {
  const paths = sessionStoragePaths("foo:bar:baz");
  assert.match(paths.dir, /^session\/[0-9a-f]{16}$/);
  assert.ok(paths.readbackDirs.includes("other/default"));
  assert.ok(paths.readbackDirs.includes("baz/default"));
});

test("readbackDirs for a 2-part arbitrary key include only other/default", () => {
  const paths = sessionStoragePaths("pi-geek:abc123");
  assert.deepEqual(paths.readbackDirs, ["other/default"]);
});

test("legacy agent:<id>:... keys expose no read-back dirs (their location never moved)", () => {
  assert.deepEqual(sessionStoragePaths("agent:generalist:main").readbackDirs, []);
  assert.deepEqual(sessionStoragePaths("agent:generalist:discord:channel:998877").readbackDirs, []);
});
