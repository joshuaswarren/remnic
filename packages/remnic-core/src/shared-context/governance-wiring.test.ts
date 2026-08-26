/**
 * Regression: #1957 governance controls 2-4 wired into the REAL manager
 * synthesis and curation paths (issue #3012).
 *
 * - Control 2: an expired item never appears in cross-signals sources or the
 *   roundtable; a superseded item that still circulates is marked, not dropped.
 * - Control 3: two agents ruling differently on the same feedback ref surface
 *   as a disputed section citing both — neither entry is silently dropped.
 * - Control 4: the persisted report carries curator provenance and every
 *   synthesized overlap claim cites source item ids (lint tripwire holds).
 */

import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { SharedContextManager } from "./manager.js";
import { parseConfig } from "../config.js";

async function makeManager() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-gov-wiring-"));
  const config = parseConfig({
    sharedContextEnabled: true,
    sharedContextDir: dir,
  });
  const manager = new SharedContextManager(config);
  await manager.ensureStructure();
  return { manager, dir };
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Stored-item shape the write path cannot produce (past expiry), but the
 *  read path must still classify: legacy or externally written items. */
async function writeStoredItem(
  dir: string,
  opts: { agent: string; title: string; expiresAt?: string; supersedes?: string },
): Promise<string> {
  const dayDir = path.join(dir, "agent-outputs", opts.agent, today());
  await mkdir(dayDir, { recursive: true });
  const fp = path.join(dayDir, `000000-${opts.title.replace(/\s+/g, "-").toLowerCase()}.md`);
  const frontmatter = [
    "kind: agent_output",
    `agent: ${JSON.stringify(opts.agent)}`,
    `createdAt: ${new Date().toISOString()}`,
    `title: ${JSON.stringify(opts.title)}`,
    ...(opts.expiresAt ? [`expiresAt: ${JSON.stringify(opts.expiresAt)}`] : []),
    ...(opts.supersedes ? [`supersedes: ${JSON.stringify(opts.supersedes)}`] : []),
  ];
  await writeFile(fp, `---\n${frontmatter.join("\n")}\n---\n\nbody text about deploy runbook\n`, "utf-8");
  return fp;
}

test("expired items never appear in cross-signals or curation; superseded circulation is marked", async (t) => {
  const { manager, dir } = await makeManager();
  t.after(() => rm(dir, { recursive: true, force: true }));

  const livePath = await writeStoredItem(dir, { agent: "agent-live", title: "live item" });
  const expiredPath = await writeStoredItem(dir, {
    agent: "agent-old",
    title: "expired item",
    expiresAt: "2020-01-01T00:00:00.000Z",
  });

  const signals = await manager.synthesizeCrossSignals({ date: today() });
  const paths = signals.report.sources.map((source) => source.path);
  assert.ok(paths.includes(livePath), "live item must appear in sources");
  assert.ok(!paths.includes(expiredPath), "expired item must never appear in sources");
  assert.equal(signals.report.staleness.expiredDropped, 1);
  assert.deepEqual(signals.report.staleness.supersededStillCirculating, []);

  const curation = await manager.curateDaily({ date: today() });
  const roundtable = await readFile(curation.roundtablePath, "utf-8");
  assert.ok(!roundtable.includes(expiredPath), "expired item must never appear in the roundtable");
  assert.match(roundtable, /## Staleness/);
  assert.match(roundtable, /Expired items dropped: 1/);
});

test("a superseded item that still circulates is marked, not dropped", async (t) => {
  const { manager, dir } = await makeManager();
  t.after(() => rm(dir, { recursive: true, force: true }));

  const olderPath = await writeStoredItem(dir, { agent: "agent-a", title: "older item" });
  await writeStoredItem(dir, { agent: "agent-b", title: "newer item", supersedes: olderPath });

  const signals = await manager.synthesizeCrossSignals({ date: today() });
  assert.deepEqual(signals.report.staleness.supersededStillCirculating, [olderPath]);
  const paths = signals.report.sources.map((source) => source.path);
  assert.ok(paths.includes(olderPath), "superseded item still circulates (marked, not dropped)");

  const curation = await manager.curateDaily({ date: today() });
  const roundtable = await readFile(curation.roundtablePath, "utf-8");
  assert.match(roundtable, /Superseded items still circulating: 1/);
});

test("contradictory agent rulings on the same ref surface as disputed, both preserved", async (t) => {
  const { manager, dir } = await makeManager();
  t.after(() => rm(dir, { recursive: true, force: true }));

  await manager.appendFeedback({
    agent: "agent-a",
    decision: "approved",
    reason: "matches the runbook",
    date: `${today()}T10:00:00.000Z`,
    refs: ["out-0001"],
  });
  await manager.appendFeedback({
    agent: "agent-b",
    decision: "rejected",
    reason: "misses the rollback step",
    date: `${today()}T11:00:00.000Z`,
    refs: ["out-0001"],
  });

  const signals = await manager.synthesizeCrossSignals({ date: today() });
  assert.deepEqual(signals.report.disputed, [
    { ref: "out-0001", agents: ["agent-a", "agent-b"], decisions: ["approved", "rejected"] },
  ]);
  assert.equal(signals.report.feedbackEntries.length, 2, "neither disputed entry is dropped");

  const curation = await manager.curateDaily({ date: today() });
  const roundtable = await readFile(curation.roundtablePath, "utf-8");
  assert.match(roundtable, /## Disputed/);
  assert.match(roundtable, /`out-0001` disputed by agent-a, agent-b/);
  assert.match(roundtable, /agent-a\] approved/);
  assert.match(roundtable, /agent-b\] rejected/);
});

test("curation report carries provenance and cited synthesized claims", async (t) => {
  const { manager, dir } = await makeManager();
  t.after(() => rm(dir, { recursive: true, force: true }));

  // Two agents on one topic produce a synthesized overlap claim.
  await manager.writeAgentOutput({ agentId: "agent-a", title: "deploy runbook notes", content: "deploy runbook steps" });
  await manager.writeAgentOutput({ agentId: "agent-b", title: "deploy runbook review", content: "deploy runbook feedback" });

  const signals = await manager.synthesizeCrossSignals({ date: today() });
  assert.equal(signals.report.provenance.actor, "shared-context:curation");
  assert.ok(!Number.isNaN(Date.parse(signals.report.provenance.at)), "provenance.at is a valid instant");
  assert.ok(signals.report.overlaps.length > 0, "shared topic produces an overlap claim");
  for (const overlap of signals.report.overlaps) {
    assert.ok(overlap.sourcePaths.length > 0, `overlap ${overlap.token} cites source item ids`);
  }

  // The curation self-check gates the roundtable: it throws on an
  // uncited synthesized claim and passes when every claim cites.
  const curation = await manager.curateDaily({ date: today() });
  const roundtable = await readFile(curation.roundtablePath, "utf-8");
  assert.match(roundtable, /\[sources: [^\]]+\]/, "synthesized overlap claims cite their sources");
});
