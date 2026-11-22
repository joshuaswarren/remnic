
import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { SharedContextManager } from "./manager.js";
import { parseConfig } from "../config.js";

async function makeManager(overrides: Record<string, unknown> = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-shared-envelope-"));
  const config = parseConfig({
    sharedContextEnabled: true,
    sharedContextDir: dir,
    ...overrides,
  });
  const manager = new SharedContextManager(config);
  await manager.ensureStructure();
  return { manager, dir };
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

test("authority envelope round-trips write -> cross-signals -> curation", async (t) => {
  const { manager, dir } = await makeManager();
  t.after(() => rm(dir, { recursive: true, force: true }));

  const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
  const fp = await manager.writeAgentOutput({
    agentId: "agent-alpha",
    title: "Deploy checklist",
    content: "Verified the deploy checklist end to end.",
    authority: "advisory",
    expiresAt,
    supersedes: "out-0001",
  });

  const raw = await readFile(fp, "utf-8");
  assert.match(raw, /^kind: agent_output$/m);
  assert.match(raw, /^sharedBy: "agent-alpha"$/m);
  assert.match(raw, /^authority: "advisory"$/m);
  assert.ok(raw.includes(`expiresAt: ${JSON.stringify(expiresAt)}`));
  assert.match(raw, /^supersedes: "out-0001"$/m);

  const signals = await manager.synthesizeCrossSignals({ date: today() });
  const source = signals.report.sources.find((s) => s.path === fp);
  assert.ok(source, "written output must appear in cross-signals sources");
  assert.equal(source.authority, "advisory");
  assert.equal(source.sharedBy, "agent-alpha");
  const curation = await manager.curateDaily({ date: today() });
  const roundtable = await readFile(curation.roundtablePath, "utf-8");
  assert.match(roundtable, /authority: advisory; sharedBy: agent-alpha/);
  assert.ok(roundtable.includes(fp), "roundtable cites the source path");
});

test("missing or unrecognized authority denies — never elevates", async (t) => {
  const { manager, dir } = await makeManager();
  t.after(() => rm(dir, { recursive: true, force: true }));

  await assert.rejects(
    manager.writeAgentOutput({
      agentId: "agent-alpha",
      title: "Malformed",
      content: "x",
      authority: " BINDING ",
    }),
    /authority must be informational, advisory, or binding/,
  );

  const date = today();
  const legacyDir = path.join(dir, "agent-outputs", "agent-legacy", date);
  await mkdir(legacyDir, { recursive: true });
  const legacyPath = path.join(legacyDir, "120000-legacy.md");
  await writeFile(
    legacyPath,
    '---\nkind: agent_output\nagent: "agent-legacy"\ntitle: "Legacy"\n---\n\nOld item.\n',
    "utf-8",
  );

  const signals = await manager.synthesizeCrossSignals({ date });
  const legacy = signals.report.sources.find((s) => s.path === legacyPath);
  assert.ok(legacy, "legacy item still appears in sources");
  assert.equal(legacy.authority, "informational");
  assert.equal(legacy.sharedBy, "agent-legacy");

  const bogusPath = path.join(legacyDir, "120100-bogus.md");
  await writeFile(
    bogusPath,
    '---\nkind: agent_output\nagent: "agent-legacy"\ntitle: "Bogus"\nsharedBy: "agent-legacy"\nauthority: "imperative"\n---\n\nBogus item.\n',
    "utf-8",
  );
  const reread = await manager.synthesizeCrossSignals({ date });
  const bogus = reread.report.sources.find((s) => s.path === bogusPath);
  assert.equal(bogus?.authority, "informational");
});

test("binding authority requires the config opt-in at write and on read", async (t) => {
  const gated = await makeManager();
  t.after(() => rm(gated.dir, { recursive: true, force: true }));

  await assert.rejects(
    gated.manager.writeAgentOutput({
      agentId: "agent-alpha",
      title: "Directive",
      content: "x",
      authority: "binding",
    }),
    /requires an explicit binding flag/,
  );

  const date = today();
  const bindingDir = path.join(gated.dir, "agent-outputs", "agent-alpha", date);
  await mkdir(bindingDir, { recursive: true });
  const bindingPath = path.join(bindingDir, "130000-directive.md");
  await writeFile(
    bindingPath,
    '---\nkind: agent_output\nagent: "agent-alpha"\ntitle: "Directive"\nsharedBy: "agent-alpha"\nauthority: "binding"\n---\n\nDirective.\n',
    "utf-8",
  );
  const gatedSignals = await gated.manager.synthesizeCrossSignals({ date });
  const stored = gatedSignals.report.sources.find((s) => s.path === bindingPath);
  assert.equal(stored?.authority, "advisory", "un-flagged stored binding must downgrade");

  const open = await makeManager({ sharedContextAllowBindingAuthority: true });
  t.after(() => rm(open.dir, { recursive: true, force: true }));
  const fp = await open.manager.writeAgentOutput({
    agentId: "agent-alpha",
    title: "Directive",
    content: "x",
    authority: "binding",
  });
  const raw = await readFile(fp, "utf-8");
  assert.match(raw, /^authority: "binding"$/m);
  const openSignals = await open.manager.synthesizeCrossSignals({ date });
  const source = openSignals.report.sources.find((s) => s.path === fp);
  assert.equal(source?.authority, "binding");
});

test("a whitespace-padded stored authority stays informational even with binding enabled", async (t) => {
  const date = today();
  for (const allowBinding of [false, true]) {
    const { manager, dir } = await makeManager({ sharedContextAllowBindingAuthority: allowBinding });
    t.after(() => rm(dir, { recursive: true, force: true }));
    const paddedDir = path.join(dir, "agent-outputs", "agent-padded", date);
    await mkdir(paddedDir, { recursive: true });
    const paddedPath = path.join(paddedDir, "140000-padded.md");
    await writeFile(
      paddedPath,
      '---\nkind: agent_output\nagent: "agent-padded"\ntitle: "Padded"\nsharedBy: "agent-padded"\nauthority: " binding "\n---\n\nPadded item.\n',
      "utf-8",
    );
    const signals = await manager.synthesizeCrossSignals({ date });
    const padded = signals.report.sources.find((s) => s.path === paddedPath);
    assert.equal(
      padded?.authority,
      "informational",
      `padded authority must stay informational (allowBinding=${allowBinding})`,
    );
  }

  const open = await makeManager({ sharedContextAllowBindingAuthority: true });
  t.after(() => rm(open.dir, { recursive: true, force: true }));
  await assert.rejects(
    open.manager.writeAgentOutput({
      agentId: "agent-padded",
      title: "Padded",
      content: "x",
      authority: " binding ",
    }),
    /authority must be informational, advisory, or binding/,
  );
});
