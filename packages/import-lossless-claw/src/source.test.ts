import assert from "node:assert/strict";
import { describe, it } from "node:test";

import BetterSqlite3 from "better-sqlite3";

import { assertLosslessClawSchema } from "./source.js";

describe("assertLosslessClawSchema", () => {
  it("passes when every required table is present", () => {
    const db = new BetterSqlite3(":memory:");
    db.exec(`
      CREATE TABLE conversations (conversation_id TEXT PRIMARY KEY);
      CREATE TABLE messages (message_id TEXT PRIMARY KEY);
      CREATE TABLE summaries (summary_id TEXT PRIMARY KEY);
      CREATE TABLE summary_messages (summary_id TEXT, message_id TEXT);
      CREATE TABLE summary_parents (summary_id TEXT, parent_summary_id TEXT, ordinal INTEGER);
    `);
    assert.doesNotThrow(() => assertLosslessClawSchema(db));
  });

  it("throws listing every missing table", () => {
    const db = new BetterSqlite3(":memory:");
    db.exec("CREATE TABLE conversations (conversation_id TEXT PRIMARY KEY);");
    let captured: Error | undefined;
    try {
      assertLosslessClawSchema(db);
    } catch (err) {
      captured = err as Error;
    }
    assert.ok(captured, "expected error");
    assert.match(captured!.message, /messages/);
    assert.match(captured!.message, /summaries/);
    assert.match(captured!.message, /summary_messages/);
    assert.match(captured!.message, /summary_parents/);
  });
});
