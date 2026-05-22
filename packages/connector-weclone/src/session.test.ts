import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { SingleSessionMapper, CallerIdSessionMapper } from "./session.js";

describe("SingleSessionMapper", () => {
  it("returns the default fixed key", () => {
    const mapper = new SingleSessionMapper();
    const key = mapper.resolve({}, {});
    assert.equal(key, "weclone-default");
  });

  it("returns a custom fixed key", () => {
    const mapper = new SingleSessionMapper("my-session");
    const key = mapper.resolve({}, { user: "ignored" });
    assert.equal(key, "my-session");
  });

  it("ignores headers and body", () => {
    const mapper = new SingleSessionMapper("fixed");
    const key = mapper.resolve(
      { "x-caller-id": "alice" },
      { user: "bob" }
    );
    assert.equal(key, "fixed");
  });
});

describe("CallerIdSessionMapper", () => {
  it("extracts from X-Caller-Id header", () => {
    const mapper = new CallerIdSessionMapper();
    const key = mapper.resolve(
      { "x-caller-id": "alice" },
      { user: "bob" }
    );
    assert.equal(key, "alice");
  });

  it("extracts from public X-Caller-Id header spelling", () => {
    const mapper = new CallerIdSessionMapper();
    const key = mapper.resolve(
      { "X-Caller-Id": "alice" },
      { user: "bob" }
    );
    assert.equal(key, "alice");
  });

  it("extracts from body.user when header is absent", () => {
    const mapper = new CallerIdSessionMapper();
    const key = mapper.resolve({}, { user: "charlie" });
    assert.equal(key, "charlie");
  });

  it("falls back to default when neither is present", () => {
    const mapper = new CallerIdSessionMapper();
    const key = mapper.resolve({}, {});
    assert.equal(key, "default");
  });

  it("uses custom fallback", () => {
    const mapper = new CallerIdSessionMapper("anonymous");
    const key = mapper.resolve({}, {});
    assert.equal(key, "anonymous");
  });

  it("prefers header over body.user", () => {
    const mapper = new CallerIdSessionMapper();
    const key = mapper.resolve(
      { "x-caller-id": "from-header" },
      { user: "from-body" }
    );
    assert.equal(key, "from-header");
  });

  it("ignores empty header and falls through to body", () => {
    const mapper = new CallerIdSessionMapper();
    const key = mapper.resolve(
      { "x-caller-id": "" },
      { user: "from-body" }
    );
    assert.equal(key, "from-body");
  });

  it("ignores empty body.user and falls back to default", () => {
    const mapper = new CallerIdSessionMapper();
    const key = mapper.resolve({}, { user: "" });
    assert.equal(key, "default");
  });
});
