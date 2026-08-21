import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp } from "node:fs/promises";
import { runRouteCliCommand } from "../src/cli.js";

test("route CLI wrapper supports add/list/test/remove", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-cli-route-"));

  await runRouteCliCommand({
    action: "add",
    memoryDir,
    pattern: "outage",
    targetRaw: "category=decision,namespace=ops",
    patternType: "keyword",
    priority: 10,
  });

  await runRouteCliCommand({
    action: "add",
    memoryDir,
    pattern: "incident\\s+#\\d+",
    targetRaw: '{"category":"fact","namespace":"default"}',
    patternType: "regex",
    priority: 5,
  });

  const listed = await runRouteCliCommand({
    action: "list",
    memoryDir,
  });
  assert.equal(Array.isArray(listed), true);
  assert.equal((listed as Array<{ pattern: string }>).length, 2);

  const selected = await runRouteCliCommand({
    action: "test",
    memoryDir,
    text: "major outage in prod",
  });
  assert.ok(selected);
  assert.equal((selected as { target: { category: string } }).target.category, "decision");

  const afterRemove = await runRouteCliCommand({
    action: "remove",
    memoryDir,
    pattern: "outage",
  });
  assert.equal(Array.isArray(afterRemove), true);
  assert.equal((afterRemove as Array<{ pattern: string }>).length, 1);
});

test("route CLI wrapper validates target and pattern type", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-cli-route-validate-"));

  await assert.rejects(() =>
    runRouteCliCommand({
      action: "add",
      memoryDir,
      pattern: "incident",
      targetRaw: "namespace=../bad",
    }),
  );

  await assert.rejects(() =>
    runRouteCliCommand({
      action: "add",
      memoryDir,
      pattern: "incident",
      targetRaw: "category=fact",
      patternType: "glob" as unknown as "keyword",
    }),
  );

  await assert.rejects(() =>
    runRouteCliCommand({
      action: "add",
      memoryDir,
      pattern: "incident",
      targetRaw: "category=fact",
      priority: Number.NaN,
    }),
  );
});
