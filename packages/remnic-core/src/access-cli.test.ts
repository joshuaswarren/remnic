import assert from "node:assert/strict";
import test from "node:test";

import { main } from "./access-cli.js";

async function rejectsUsage(argv: string[]): Promise<void> {
  await assert.rejects(
    async () => {
      await main(argv);
    },
    /invalid access-cli arguments/,
  );
}

test("access-cli rejects malformed dry-run values before store can run", async () => {
  await rejectsUsage([
    "store",
    "--content",
    "hello",
    "--category",
    "fact",
    "--dry-run=true",
  ]);

  await rejectsUsage([
    "store",
    "--content",
    "hello",
    "--category",
    "fact",
    "--dry-run",
    "true",
  ]);
});

test("access-cli rejects unknown options before runtime initialization", async () => {
  await rejectsUsage([
    "store",
    "--content",
    "hello",
    "--category",
    "fact",
    "--typo",
    "value",
  ]);
});

test("access-cli rejects value options with missing values", async () => {
  await rejectsUsage(["browse", "--limit"]);
  await rejectsUsage(["store", "--content", "hello", "--category"]);
});

test("access-cli rejects partial numeric values", async () => {
  await rejectsUsage(["browse", "--limit", "10abc"]);
  await rejectsUsage(["browse", "--offset", "1.5"]);
  await rejectsUsage([
    "store",
    "--content",
    "hello",
    "--category",
    "fact",
    "--confidence",
    "0.5x",
  ]);
});

test("access-cli rejects confidence outside the documented range", async () => {
  await rejectsUsage([
    "store",
    "--content",
    "hello",
    "--category",
    "fact",
    "--confidence",
    "1.1",
  ]);
});
