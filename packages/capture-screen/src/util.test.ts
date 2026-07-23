import assert from "node:assert/strict";
import { test } from "node:test";

import { formatHostForUrl, isLoopbackHost, stripIpv6Brackets } from "./util.js";

test("formatHostForUrl brackets a bare IPv6 once and never double-brackets", () => {
  assert.equal(formatHostForUrl("::1"), "[::1]");
  assert.equal(formatHostForUrl("[::1]"), "[::1]");
  assert.equal(formatHostForUrl("127.0.0.1"), "127.0.0.1");
  assert.equal(formatHostForUrl("localhost"), "localhost");
});

test("stripIpv6Brackets and isLoopbackHost accept bracketed and bare loopback", () => {
  assert.equal(stripIpv6Brackets("[::1]"), "::1");
  assert.equal(stripIpv6Brackets("::1"), "::1");
  assert.equal(isLoopbackHost("[::1]"), true);
  assert.equal(isLoopbackHost("::1"), true);
  assert.equal(isLoopbackHost("10.0.0.5"), false);
});
