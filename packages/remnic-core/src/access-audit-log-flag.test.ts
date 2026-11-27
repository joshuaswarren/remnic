import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import type { AccessAuditAdapter } from "./access-audit.js";
import { EngramAccessService } from "./access-service.js";
import { parseConfig } from "./config.js";
import type { Orchestrator } from "./orchestrator.js";
import type { RecallAuditEntry } from "./recall-audit.js";

// Issue #3548: the audit JSONL flag in the access-service setup was a
// hardcoded `false` ("off until wired to a directory"). memoryDir already
// supplies the directory and the recall response path already calls
// auditAdapter.record — the missing piece was a config flag gating
// audit.enabled. These tests drive the real service constructor with a
// stub orchestrator: only .config is read before the audit block runs.

function makeEntry(q = "q"): RecallAuditEntry {
  return {
    ts: new Date().toISOString(),
    sessionKey: "session-a",
    agentId: "agent-a",
    trigger: "test",
    queryText: q,
    candidateMemoryIds: [],
    summary: null,
    injectedChars: 0,
    toggleState: "enabled",
  };
}

function auditAdapterOf(config: ReturnType<typeof parseConfig>): AccessAuditAdapter | null {
  // SAFETY: the constructor reads only `orchestrator.config` eagerly; every
  // other collaborator resolves lazily, so a minimal stub is sound here.
  // oxlint-disable-next-line anti-slop/no-chained-type-assertions
  const service = new EngramAccessService({ config } as unknown as Orchestrator);
  // SAFETY: `auditAdapter` is a private field set by the constructor to
  // `AccessAuditAdapter | null`; the test seam inspects exactly that contract.
  // oxlint-disable-next-line anti-slop/no-chained-type-assertions, anti-slop/no-known-value-widening
  return (service as unknown as { auditAdapter: AccessAuditAdapter | null }).auditAdapter;
}

test("recallAuditLogEnabled writes the audit JSONL under memoryDir/transcripts", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "audit-log-flag-"));
  try {
    const adapter = auditAdapterOf(
      parseConfig({ memoryDir: root, recallAuditLogEnabled: true }),
    );
    assert.ok(adapter, "an audit adapter must exist when the log flag is on");
    const result = await adapter.record("p1", makeEntry());
    assert.ok(result.appendedAt, "record must append a JSONL shard");

    const day = new Date().toISOString().slice(0, 10);
    const shardDir = path.join(root, "transcripts", day);
    const files = await readdir(shardDir);
    assert.equal(files.length, 1);
    const line = (await readFile(path.join(shardDir, files[0]), "utf8")).trim();
    assert.equal(JSON.parse(line).queryText, "q");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the audit log defaults off and stays independent of anomaly detection", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "audit-log-flag-"));
  try {
    // Neither flag: no adapter at all — same as today's hardcoded state.
    const off = auditAdapterOf(parseConfig({ memoryDir: root }));
    assert.equal(off, null);

    // Detection alone: the adapter exists for the detector but must not
    // append JSONL — the two flags are independent by contract.
    const detectOnly = auditAdapterOf(
      parseConfig({ memoryDir: root, recallAuditAnomalyDetectionEnabled: true }),
    );
    assert.ok(detectOnly);
    const result = await detectOnly.record("p1", makeEntry());
    assert.equal(result.appendedAt, undefined);
    await assert.rejects(stat(path.join(root, "transcripts")), /ENOENT/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
