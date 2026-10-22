import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { CompoundingEngine } from "@remnic/core/compounding/engine";
import { parseConfig } from "@remnic/core/config";

const WEEK = "2026-W43";
const NEXT = "2026-W44";
const IN_WEEK = "2026-10-22T12:00:00.000Z";

function doc(id: string, content: string, status?: string): string {
  const lines = ["---", `id: ${id}`, "category: correction", `created: ${IN_WEEK}`, `updated: ${IN_WEEK}`, "confidence: 0.9"];
  if (status) lines.push(`status: ${status}`);
  lines.push("---", "", content, "");
  return lines.join("\n");
}

test("a forgotten correction retires its compounded mistake on the next synthesis", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-weekly-forget-"));
  try {
    const eng = new CompoundingEngine(parseConfig({
      memoryDir,
      workspaceDir: path.join(memoryDir, "workspace"),
      qmdEnabled: false,
      compoundingEnabled: true,
    }));
    const dir = path.join(memoryDir, "corrections");
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "correction-kept.md"), doc("kept", "Keep this lesson"));
    const dropped = path.join(dir, "correction-dropped.md");
    await writeFile(dropped, doc("dropped", "Forget this lesson"));
    await eng.synthesizeWeekly({ weekId: WEEK });
    assert.match(await eng.buildRecallSection("lesson") ?? "", /Forget this lesson/);
    await writeFile(dropped, doc("dropped", "Forget this lesson", "forgotten"));
    await eng.synthesizeWeekly({ weekId: NEXT });
    const registry = (await eng.readMistakes())?.registry ?? [];
    assert.equal(registry.find((entry) => entry.pattern.includes("Forget this lesson"))?.status, "retired");
    assert.equal(registry.find((entry) => entry.pattern.includes("Keep this lesson"))?.status, "active");
    const section = await eng.buildRecallSection("lesson") ?? "";
    assert.equal(section.includes("Forget this lesson"), false);
    assert.match(section, /Keep this lesson/);
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});
