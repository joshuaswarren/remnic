import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { CompoundingEngine } from "@remnic/core/compounding/engine";
import { parseConfig } from "@remnic/core/config";

const WEEK = "2026-W43";
const NEXT = "2026-W44";
const IN_WEEK = "2026-10-22T12:00:00.000Z";

function doc(id: string, content: string, status?: string, created = IN_WEEK): string {
  const lines = ["---", `id: ${id}`, "category: correction", `created: ${created}`, `updated: ${created}`, "confidence: 0.9"];
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

test("forgetting corrections carried from earlier weeks retires every one of them", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-weekly-forget-many-"));
  try {
    const eng = new CompoundingEngine(parseConfig({
      memoryDir,
      workspaceDir: path.join(memoryDir, "workspace"),
      qmdEnabled: false,
      compoundingEnabled: true,
    }));
    const dir = path.join(memoryDir, "corrections");
    await mkdir(dir, { recursive: true });
    const writeWave = async (startMs: number, label: string) => {
      for (let index = 0; index < 260; index += 1) {
        const ms = startMs + index * 1000;
        const created = new Date(ms).toISOString();
        await writeFile(
          path.join(dir, `correction-${ms}-${label}.md`),
          doc(`${label}-${index}`, `${label} lesson ${index}`, undefined, created),
        );
      }
    };
    const forgetWave = async (startMs: number, label: string) => {
      for (let index = 0; index < 260; index += 1) {
        const ms = startMs + index * 1000;
        const created = new Date(ms).toISOString();
        await writeFile(
          path.join(dir, `correction-${ms}-${label}.md`),
          doc(`${label}-${index}`, `${label} lesson ${index}`, "forgotten", created),
        );
      }
    };
    const waveA = Date.parse("2026-10-22T00:00:00.000Z");
    const waveB = Date.parse("2026-10-26T00:00:00.000Z");
    await writeWave(waveA, "wavea");
    await eng.synthesizeWeekly({ weekId: "2026-W43" });
    await writeWave(waveB, "waveb");
    await eng.synthesizeWeekly({ weekId: "2026-W44" });
    await forgetWave(waveA, "wavea");
    await forgetWave(waveB, "waveb");
    await eng.synthesizeWeekly({ weekId: "2026-W45" });
    const active = (await eng.readMistakes())?.registry?.filter((entry) =>
      entry.status === "active" && entry.category === "correction"
    ) ?? [];
    assert.equal(active.length, 0);
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("an unreadable correction file does not retire its mistake", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-weekly-forget-unreadable-"));
  try {
    const eng = new CompoundingEngine(parseConfig({
      memoryDir,
      workspaceDir: path.join(memoryDir, "workspace"),
      qmdEnabled: false,
      compoundingEnabled: true,
    }));
    const filePath = path.join(memoryDir, "corrections", "correction-kept.md");
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, doc("kept", "Keep this lesson"));
    await eng.synthesizeWeekly({ weekId: WEEK });
    await writeFile(filePath, "this is not a memory document\n");
    await eng.synthesizeWeekly({ weekId: NEXT });
    const afterUnreadable = (await eng.readMistakes())?.registry?.find((entry) => entry.pattern.includes("Keep this lesson"));
    assert.equal(afterUnreadable?.status, "active");
    await unlink(filePath);
    await eng.synthesizeWeekly({ weekId: "2026-W45" });
    const afterDelete = (await eng.readMistakes())?.registry?.find((entry) => entry.pattern.includes("Keep this lesson"));
    assert.equal(afterDelete?.status, "retired");
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});
