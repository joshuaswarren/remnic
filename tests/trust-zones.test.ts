import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import test from "node:test";
import {
  getTrustZoneStoreStatus,
  listTrustZoneRecords,
  planTrustZonePromotion,
  promoteTrustZoneRecord,
  recordTrustZoneRecord,
  resolveTrustZoneStoreDir,
  scoreTrustZoneProvenance,
  seedTrustZoneDemoDataset,
  summarizeTrustZonePromotionReadiness,
  validateTrustZoneRecord,
} from "../src/trust-zones.js";
import {
  runTrustZoneDemoSeedCliCommand,
  runTrustZonePromoteCliCommand,
  runTrustZoneStatusCliCommand,
} from "../src/cli.js";

test("trust-zones config path resolves under memoryDir by default", () => {
  assert.equal(
    resolveTrustZoneStoreDir("/tmp/engram-memory"),
    path.join("/tmp/engram-memory", "state", "trust-zones"),
  );
  assert.equal(resolveTrustZoneStoreDir("/tmp/engram-memory", "  /tmp/custom-trust-zones  "), "/tmp/custom-trust-zones");
});

test("validateTrustZoneRecord accepts the normalized trust-zone contract", () => {
  const record = validateTrustZoneRecord({
    schemaVersion: 1,
    recordId: "trust-zone-1",
    zone: "quarantine",
    recordedAt: "2026-03-07T18:00:00.000Z",
    kind: "artifact",
    summary: "Captured raw web content before promotion into durable memory.",
    provenance: {
      sourceClass: "web_content",
      observedAt: "2026-03-07T17:59:00.000Z",
      sessionKey: "agent:main",
      sourceId: "https://example.com/runbook",
      evidenceHash: "sha256:abc123",
    },
    promotedFromZone: "working",
    entityRefs: ["project:engram"],
    tags: ["trust-zone", "quarantine"],
    metadata: {
      actor: "engram",
    },
  });

  assert.equal(record.zone, "quarantine");
  assert.equal(record.provenance.sourceClass, "web_content");
  assert.equal(record.promotedFromZone, "working");
  assert.deepEqual(record.tags, ["trust-zone", "quarantine"]);
});

test("recordTrustZoneRecord persists records into zoned dated storage", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-trust-zone-record-"));
  const filePath = await recordTrustZoneRecord({
    memoryDir,
    record: {
      schemaVersion: 1,
      recordId: "tz-2",
      zone: "trusted",
      recordedAt: "2026-03-07T18:01:00.000Z",
      kind: "memory",
      summary: "Promoted corroborated preference memory into trusted storage.",
      provenance: {
        sourceClass: "system_memory",
        observedAt: "2026-03-07T18:00:00.000Z",
        sessionKey: "agent:main",
      },
      tags: ["promotion"],
    },
  });

  assert.equal(
    filePath,
    path.join(memoryDir, "state", "trust-zones", "zones", "trusted", "2026-03-07", "tz-2.json"),
  );
});

test("recordTrustZoneRecord rejects duplicate ids without overwriting the original record", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-trust-zone-duplicate-"));
  const filePath = await recordTrustZoneRecord({
    memoryDir,
    record: {
      schemaVersion: 1,
      recordId: "tz-duplicate",
      zone: "trusted",
      recordedAt: "2026-03-07T18:01:00.000Z",
      kind: "memory",
      summary: "Original trust-zone record.",
      provenance: {
        sourceClass: "system_memory",
        observedAt: "2026-03-07T18:00:00.000Z",
        sessionKey: "agent:main",
      },
    },
  });

  await assert.rejects(
    () =>
      recordTrustZoneRecord({
        memoryDir,
        record: {
          schemaVersion: 1,
          recordId: "tz-duplicate",
          zone: "trusted",
          recordedAt: "2026-03-07T18:01:30.000Z",
          kind: "memory",
          summary: "Replacement trust-zone record.",
          provenance: {
            sourceClass: "system_memory",
            observedAt: "2026-03-07T18:00:30.000Z",
            sessionKey: "agent:main",
          },
        },
      }),
    /EEXIST|exists/i,
  );

  const stored = JSON.parse(await readFile(filePath, "utf8")) as { summary: string };
  assert.equal(stored.summary, "Original trust-zone record.");
});

test("recordTrustZoneRecord rejects unsafe ids and malformed timestamps", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-trust-zone-reject-"));

  await assert.rejects(
    () =>
      recordTrustZoneRecord({
        memoryDir,
        record: {
          schemaVersion: 1,
          recordId: "../escape",
          zone: "working",
          recordedAt: "2026-03-07T18:01:00.000Z",
          kind: "state",
          summary: "invalid id",
          provenance: {
            sourceClass: "tool_output",
            observedAt: "2026-03-07T18:00:00.000Z",
          },
        },
      }),
    /recordId/i,
  );

  await assert.rejects(
    () =>
      recordTrustZoneRecord({
        memoryDir,
        record: {
          schemaVersion: 1,
          recordId: "tz-3",
          zone: "working",
          recordedAt: "2026-03-07",
          kind: "state",
          summary: "invalid date",
          provenance: {
            sourceClass: "tool_output",
            observedAt: "2026-03-07T18:00:00.000Z",
          },
        },
      }),
    /recordedAt/i,
  );
});

test("validateTrustZoneRecord reports the observedAt field name for invalid provenance timestamps", () => {
  assert.throws(
    () =>
      validateTrustZoneRecord({
        schemaVersion: 1,
        recordId: "tz-bad-observed-at",
        zone: "working",
        recordedAt: "2026-03-07T18:01:00.000Z",
        kind: "state",
        summary: "invalid observedAt",
        provenance: {
          sourceClass: "tool_output",
          observedAt: "not-an-iso-timestamp",
        },
      }),
    /observedAt/i,
  );
});

test("trust-zone status reports valid and invalid records by zone", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-trust-zone-status-"));
  await recordTrustZoneRecord({
    memoryDir,
    record: {
      schemaVersion: 1,
      recordId: "tz-4",
      zone: "quarantine",
      recordedAt: "2026-03-07T18:02:00.000Z",
      kind: "external",
      summary: "Raw search result captured for later corroboration.",
      provenance: {
        sourceClass: "web_content",
        observedAt: "2026-03-07T18:01:00.000Z",
        sessionKey: "agent:main",
      },
    },
  });
  await recordTrustZoneRecord({
    memoryDir,
    record: {
      schemaVersion: 1,
      recordId: "tz-5",
      zone: "trusted",
      recordedAt: "2026-03-07T18:03:00.000Z",
      kind: "trajectory",
      summary: "Corroborated causal trajectory promoted into trusted storage.",
      provenance: {
        sourceClass: "system_memory",
        observedAt: "2026-03-07T18:02:30.000Z",
        sessionKey: "agent:main",
      },
      promotedFromZone: "working",
    },
  });

  const invalidDir = path.join(memoryDir, "state", "trust-zones", "zones", "working", "2026-03-07");
  await mkdir(invalidDir, { recursive: true });
  await writeFile(path.join(invalidDir, "invalid.json"), "{\"schemaVersion\":2}", "utf8");

  const status = await getTrustZoneStoreStatus({
    memoryDir,
    enabled: true,
    promotionEnabled: false,
    poisoningDefenseEnabled: false,
  });

  assert.equal(status.records.total, 3);
  assert.equal(status.records.valid, 2);
  assert.equal(status.records.invalid, 1);
  assert.equal(status.records.byZone.quarantine, 1);
  assert.equal(status.records.byZone.trusted, 1);
  assert.equal(status.records.latestRecordId, "tz-5");
  assert.equal(status.latestRecord?.zone, "trusted");
  assert.equal(status.invalidRecords[0]?.path.endsWith("invalid.json"), true);
  assert.equal(status.records.averageTrustScore, undefined);
  assert.equal(status.latestRecordTrustScore, undefined);
});

test("trust-zone-status CLI command returns the store summary", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-trust-zone-cli-"));
  await recordTrustZoneRecord({
    memoryDir,
    record: {
      schemaVersion: 1,
      recordId: "tz-cli-1",
      zone: "working",
      recordedAt: "2026-03-07T18:05:00.000Z",
      kind: "state",
      summary: "Ephemeral working-state snapshot awaiting promotion decision.",
      provenance: {
        sourceClass: "tool_output",
        observedAt: "2026-03-07T18:04:00.000Z",
        sessionKey: "agent:main",
      },
    },
  });

  const summary = await runTrustZoneStatusCliCommand({
    memoryDir,
    trustZonesEnabled: true,
    quarantinePromotionEnabled: false,
    memoryPoisoningDefenseEnabled: false,
  });
  assert.equal(summary.records.valid, 1);
  assert.equal(summary.latestRecord.recordId, "tz-cli-1");
});

test("scoreTrustZoneProvenance is deterministic and rewards anchored provenance", () => {
  const anchored = scoreTrustZoneProvenance(
    validateTrustZoneRecord({
      schemaVersion: 1,
      recordId: "tz-score-anchored",
      zone: "working",
      recordedAt: "2026-03-07T18:12:00.000Z",
      kind: "state",
      summary: "Anchored tool output with explicit evidence.",
      provenance: {
        sourceClass: "tool_output",
        observedAt: "2026-03-07T18:11:30.000Z",
        sessionKey: "agent:main",
        sourceId: "tool:deploy",
        evidenceHash: "sha256:deploy-log",
      },
    }),
  );
  const unanchored = scoreTrustZoneProvenance(
    validateTrustZoneRecord({
      schemaVersion: 1,
      recordId: "tz-score-unanchored",
      zone: "working",
      recordedAt: "2026-03-07T18:12:00.000Z",
      kind: "state",
      summary: "Unanchored tool output.",
      provenance: {
        sourceClass: "tool_output",
        observedAt: "2026-03-07T18:11:30.000Z",
      },
    }),
  );

  assert.equal(anchored.total, 0.9);
  assert.equal(anchored.band, "high");
  assert.equal(anchored.anchored, true);
  assert.equal(anchored.sourceClassWeight, 0.55);
  assert.equal(anchored.sourceIdBonus, 0.1);
  assert.equal(anchored.evidenceHashBonus, 0.2);
  assert.equal(anchored.sessionKeyBonus, 0.05);
  assert.equal(unanchored.total, 0.55);
  assert.equal(unanchored.band, "medium");
  assert.equal(unanchored.anchored, false);
});

test("trust-zone status reports aggregate provenance trust scores when memory poisoning defense is enabled", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-trust-zone-score-status-"));
  await recordTrustZoneRecord({
    memoryDir,
    record: {
      schemaVersion: 1,
      recordId: "tz-score-status-1",
      zone: "working",
      recordedAt: "2026-03-07T18:13:00.000Z",
      kind: "state",
      summary: "Anchored tool output.",
      provenance: {
        sourceClass: "tool_output",
        observedAt: "2026-03-07T18:12:30.000Z",
        sessionKey: "agent:main",
        sourceId: "tool:test",
        evidenceHash: "sha256:test-output",
      },
    },
  });
  await recordTrustZoneRecord({
    memoryDir,
    record: {
      schemaVersion: 1,
      recordId: "tz-score-status-2",
      zone: "quarantine",
      recordedAt: "2026-03-07T18:14:00.000Z",
      kind: "external",
      summary: "Unanchored web content.",
      provenance: {
        sourceClass: "web_content",
        observedAt: "2026-03-07T18:13:30.000Z",
      },
    },
  });

  const status = await getTrustZoneStoreStatus({
    memoryDir,
    enabled: true,
    promotionEnabled: false,
    poisoningDefenseEnabled: true,
  });

  assert.equal(status.records.averageTrustScore, 0.625);
  assert.deepEqual(status.records.byTrustBand, { high: 1, low: 1 });
  assert.equal(status.latestRecordTrustScore?.total, 0.35);
  assert.equal(status.latestRecordTrustScore?.band, "low");
});

test("planTrustZonePromotion blocks direct quarantine to trusted promotion", () => {
  const plan = planTrustZonePromotion({
    record: validateTrustZoneRecord({
      schemaVersion: 1,
      recordId: "tz-plan-1",
      zone: "quarantine",
      recordedAt: "2026-03-07T18:06:00.000Z",
      kind: "external",
      summary: "Raw web result awaiting corroboration.",
      provenance: {
        sourceClass: "web_content",
        observedAt: "2026-03-07T18:05:00.000Z",
      },
    }),
    targetZone: "trusted",
  });

  assert.equal(plan.allowed, false);
  assert.match(plan.reasons.join(" "), /quarantine/i);
  assert.match(plan.reasons.join(" "), /trusted/i);
});

test("planTrustZonePromotion requires provenance anchors before promoting working records to trusted", () => {
  const denied = planTrustZonePromotion({
    record: validateTrustZoneRecord({
      schemaVersion: 1,
      recordId: "tz-plan-2",
      zone: "working",
      recordedAt: "2026-03-07T18:07:00.000Z",
      kind: "state",
      summary: "Intermediate state derived from tool output.",
      provenance: {
        sourceClass: "tool_output",
        observedAt: "2026-03-07T18:06:30.000Z",
      },
    }),
    targetZone: "trusted",
  });
  assert.equal(denied.allowed, false);
  assert.match(denied.reasons.join(" "), /sourceId/i);
  assert.match(denied.reasons.join(" "), /evidenceHash/i);

  const allowed = planTrustZonePromotion({
    record: validateTrustZoneRecord({
      schemaVersion: 1,
      recordId: "tz-plan-3",
      zone: "working",
      recordedAt: "2026-03-07T18:08:00.000Z",
      kind: "state",
      summary: "Intermediate state with anchored provenance.",
      provenance: {
        sourceClass: "tool_output",
        observedAt: "2026-03-07T18:07:30.000Z",
        sourceId: "tool:build",
        evidenceHash: "sha256:trust-anchor",
      },
    }),
    targetZone: "trusted",
  });
  assert.equal(allowed.allowed, true);
  assert.equal(allowed.reasons.length, 0);
});

test("promoteTrustZoneRecord writes a lineage-aware promoted record", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-trust-zone-promote-"));
  await recordTrustZoneRecord({
    memoryDir,
    record: {
      schemaVersion: 1,
      recordId: "tz-promote-source",
      zone: "working",
      recordedAt: "2026-03-07T18:09:00.000Z",
      kind: "artifact",
      summary: "Candidate artifact promoted after manual review.",
      provenance: {
        sourceClass: "manual",
        observedAt: "2026-03-07T18:08:30.000Z",
        sourceId: "review:ops",
        evidenceHash: "sha256:manual-review",
      },
      tags: ["reviewed"],
    },
  });

  const result = await promoteTrustZoneRecord({
    memoryDir,
    enabled: true,
    promotionEnabled: true,
    sourceRecordId: "tz-promote-source",
    targetZone: "trusted",
    recordedAt: "2026-03-07T18:10:00.000Z",
    promotionReason: "Manual review approved the artifact for trusted recall.",
  });

  assert.equal(result.record.zone, "trusted");
  assert.equal(result.record.promotedFromZone, "working");
  assert.equal(result.record.metadata?.sourceRecordId, "tz-promote-source");
  assert.equal(result.record.metadata?.promotionReason?.includes("Manual review approved"), true);
  assert.equal(result.filePath.endsWith(".json"), true);

  const status = await getTrustZoneStoreStatus({
    memoryDir,
    enabled: true,
    promotionEnabled: true,
  });
  assert.equal(status.records.valid, 2);
  assert.equal(status.records.byZone.working, 1);
  assert.equal(status.records.byZone.trusted, 1);
  assert.equal(status.latestRecord?.recordId, result.record.recordId);
});

test("promoteTrustZoneRecord requires corroboration for risky trusted promotions when poisoning defense is enabled", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-trust-zone-corroboration-deny-"));
  await recordTrustZoneRecord({
    memoryDir,
    record: {
      schemaVersion: 1,
      recordId: "tz-corroboration-source",
      zone: "working",
      recordedAt: "2026-03-07T18:15:00.000Z",
      kind: "artifact",
      summary: "Anchored tool-derived artifact awaiting corroboration.",
      provenance: {
        sourceClass: "tool_output",
        observedAt: "2026-03-07T18:14:30.000Z",
        sourceId: "tool:deploy",
        evidenceHash: "sha256:deploy-output",
      },
      entityRefs: ["deploy:release-42"],
      tags: ["release"],
    },
  });

  await assert.rejects(
    () =>
      promoteTrustZoneRecord({
        memoryDir,
        enabled: true,
        promotionEnabled: true,
        poisoningDefenseEnabled: true,
        sourceRecordId: "tz-corroboration-source",
        targetZone: "trusted",
        recordedAt: "2026-03-07T18:16:00.000Z",
        promotionReason: "Attempt promotion without corroboration.",
      }),
    /corroborat/i,
  );
});

test("promoteTrustZoneRecord accepts corroboration from an independent non-quarantine source", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-trust-zone-corroboration-allow-"));
  await recordTrustZoneRecord({
    memoryDir,
    record: {
      schemaVersion: 1,
      recordId: "tz-corroboration-source-2",
      zone: "working",
      recordedAt: "2026-03-07T18:17:00.000Z",
      kind: "artifact",
      summary: "Anchored tool-derived artifact awaiting corroboration.",
      provenance: {
        sourceClass: "tool_output",
        observedAt: "2026-03-07T18:16:30.000Z",
        sourceId: "tool:deploy",
        evidenceHash: "sha256:deploy-output",
      },
      entityRefs: ["deploy:release-43"],
      tags: ["release"],
    },
  });
  await recordTrustZoneRecord({
    memoryDir,
    record: {
      schemaVersion: 1,
      recordId: "tz-corroboration-support",
      zone: "working",
      recordedAt: "2026-03-07T18:17:30.000Z",
      kind: "external",
      summary: "Independent web confirmation of the same release artifact.",
      provenance: {
        sourceClass: "web_content",
        observedAt: "2026-03-07T18:17:15.000Z",
        sourceId: "https://example.com/releases/43",
        evidenceHash: "sha256:web-confirmation",
      },
      entityRefs: ["deploy:release-43"],
      tags: ["release"],
    },
  });

  const result = await promoteTrustZoneRecord({
    memoryDir,
    enabled: true,
    promotionEnabled: true,
    poisoningDefenseEnabled: true,
    sourceRecordId: "tz-corroboration-source-2",
    targetZone: "trusted",
    recordedAt: "2026-03-07T18:18:00.000Z",
    promotionReason: "Promotion after corroborated confirmation.",
  });

  assert.equal(result.record.zone, "trusted");
  assert.equal(result.record.metadata?.corroborated, "true");
  assert.equal(result.record.metadata?.corroborationCount, "1");
  assert.equal(result.record.metadata?.corroborationSources, "web_content");
});

test("promoteTrustZoneRecord ignores quarantine-only corroboration candidates", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-trust-zone-corroboration-quarantine-"));
  await recordTrustZoneRecord({
    memoryDir,
    record: {
      schemaVersion: 1,
      recordId: "tz-corroboration-source-3",
      zone: "working",
      recordedAt: "2026-03-07T18:19:00.000Z",
      kind: "artifact",
      summary: "Anchored tool-derived artifact awaiting corroboration.",
      provenance: {
        sourceClass: "tool_output",
        observedAt: "2026-03-07T18:18:30.000Z",
        sourceId: "tool:deploy",
        evidenceHash: "sha256:deploy-output",
      },
      entityRefs: ["deploy:release-44"],
      tags: ["release"],
    },
  });
  await recordTrustZoneRecord({
    memoryDir,
    record: {
      schemaVersion: 1,
      recordId: "tz-corroboration-quarantine-support",
      zone: "quarantine",
      recordedAt: "2026-03-07T18:19:30.000Z",
      kind: "external",
      summary: "Untrusted web confirmation still in quarantine.",
      provenance: {
        sourceClass: "web_content",
        observedAt: "2026-03-07T18:19:15.000Z",
        sourceId: "https://example.com/releases/44",
        evidenceHash: "sha256:web-confirmation",
      },
      entityRefs: ["deploy:release-44"],
      tags: ["release"],
    },
  });

  await assert.rejects(
    () =>
      promoteTrustZoneRecord({
        memoryDir,
        enabled: true,
        promotionEnabled: true,
        poisoningDefenseEnabled: true,
        sourceRecordId: "tz-corroboration-source-3",
        targetZone: "trusted",
        recordedAt: "2026-03-07T18:20:00.000Z",
        promotionReason: "Attempt promotion from quarantine-only corroboration.",
      }),
    /corroborat/i,
  );
});

test("trust-zone-promote CLI dry-run returns the promotion plan without writing", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-trust-zone-cli-promote-"));
  await recordTrustZoneRecord({
    memoryDir,
    record: {
      schemaVersion: 1,
      recordId: "tz-cli-promote-source",
      zone: "quarantine",
      recordedAt: "2026-03-07T18:11:00.000Z",
      kind: "external",
      summary: "Raw fetch result with anchored provenance.",
      provenance: {
        sourceClass: "web_content",
        observedAt: "2026-03-07T18:10:30.000Z",
        sourceId: "https://example.com/source",
        evidenceHash: "sha256:web-proof",
      },
    },
  });

  const plan = await runTrustZonePromoteCliCommand({
    memoryDir,
    trustZonesEnabled: true,
    quarantinePromotionEnabled: true,
    memoryPoisoningDefenseEnabled: false,
    sourceRecordId: "tz-cli-promote-source",
    targetZone: "working",
    promotionReason: "Promote into working memory for corroboration.",
    dryRun: true,
  });

  assert.equal(plan.dryRun, true);
  assert.equal(plan.plan.allowed, true);
  assert.equal(plan.wroteRecord, false);

  const status = await getTrustZoneStoreStatus({
    memoryDir,
    enabled: true,
    promotionEnabled: true,
  });
  assert.equal(status.records.valid, 1);
  assert.equal(status.records.byZone.quarantine, 1);
});

test("trust-zone-promote CLI enforces corroboration when poisoning defense is enabled", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-trust-zone-cli-defense-"));
  await recordTrustZoneRecord({
    memoryDir,
    record: {
      schemaVersion: 1,
      recordId: "tz-cli-defense-source",
      zone: "working",
      recordedAt: "2026-03-07T18:21:00.000Z",
      kind: "state",
      summary: "Tool output captured a deployment result.",
      provenance: {
        sourceClass: "tool_output",
        observedAt: "2026-03-07T18:20:30.000Z",
        sourceId: "tool:deploy",
        evidenceHash: "sha256:deploy",
      },
      entityRefs: ["deploy:release-45"],
      tags: ["release"],
    },
  });

  await assert.rejects(
    () =>
      runTrustZonePromoteCliCommand({
        memoryDir,
        trustZonesEnabled: true,
        quarantinePromotionEnabled: true,
        memoryPoisoningDefenseEnabled: true,
        sourceRecordId: "tz-cli-defense-source",
        targetZone: "trusted",
        promotionReason: "Promote risky deployment evidence without corroboration.",
        dryRun: true,
      }),
    /corroborat/i,
  );
});

test("listTrustZoneRecords filters and paginates trust-zone records", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-trust-zone-list-"));
  await recordTrustZoneRecord({
    memoryDir,
    record: {
      schemaVersion: 1,
      recordId: "tz-list-1",
      zone: "working",
      recordedAt: "2026-03-07T18:22:00.000Z",
      kind: "state",
      summary: "Working deployment evidence for release forty-six.",
      provenance: {
        sourceClass: "tool_output",
        observedAt: "2026-03-07T18:21:30.000Z",
        sourceId: "tool:deploy-46",
        evidenceHash: "sha256:deploy-46",
      },
      tags: ["release-46"],
    },
  });
  await recordTrustZoneRecord({
    memoryDir,
    record: {
      schemaVersion: 1,
      recordId: "tz-list-2",
      zone: "quarantine",
      recordedAt: "2026-03-07T18:23:00.000Z",
      kind: "external",
      summary: "Quarantined vendor policy snippet.",
      provenance: {
        sourceClass: "web_content",
        observedAt: "2026-03-07T18:22:30.000Z",
      },
      tags: ["vendor-policy"],
    },
  });

  const workingOnly = await listTrustZoneRecords({
    memoryDir,
    zone: "working",
    limit: 10,
    offset: 0,
  });
  assert.equal(workingOnly.total, 1);
  assert.equal(workingOnly.records[0]?.record.recordId, "tz-list-1");

  const queried = await listTrustZoneRecords({
    memoryDir,
    query: "vendor policy",
    limit: 10,
    offset: 0,
  });
  assert.equal(queried.total, 1);
  assert.equal(queried.records[0]?.record.recordId, "tz-list-2");
});

test("summarizeTrustZonePromotionReadiness surfaces corroboration requirements", async () => {
  const source = validateTrustZoneRecord({
    schemaVersion: 1,
    recordId: "tz-readiness-source",
    zone: "working",
    recordedAt: "2026-03-07T18:24:00.000Z",
    kind: "state",
    summary: "Anchored tool-derived deployment evidence.",
    provenance: {
      sourceClass: "tool_output",
      observedAt: "2026-03-07T18:23:30.000Z",
      sourceId: "tool:deploy-47",
      evidenceHash: "sha256:deploy-47",
    },
    entityRefs: ["deploy:47"],
    tags: ["release-47"],
  });
  const support = validateTrustZoneRecord({
    schemaVersion: 1,
    recordId: "tz-readiness-support",
    zone: "working",
    recordedAt: "2026-03-07T18:25:00.000Z",
    kind: "external",
    summary: "Independent ticket corroboration.",
    provenance: {
      sourceClass: "web_content",
      observedAt: "2026-03-07T18:24:30.000Z",
      sourceId: "https://tickets.example.com/CHG-47",
      evidenceHash: "sha256:chg-47",
    },
    entityRefs: ["deploy:47"],
    tags: ["release-47"],
  });

  const blocked = summarizeTrustZonePromotionReadiness({
    record: source,
    allRecords: [source],
    poisoningDefenseEnabled: true,
  });
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.nextTargetZone, "trusted");
  assert.match(blocked.reasons.join(" "), /corroborat/i);

  const allowed = summarizeTrustZonePromotionReadiness({
    record: source,
    allRecords: [source, support],
    poisoningDefenseEnabled: true,
  });
  assert.equal(allowed.allowed, true);
  assert.equal(allowed.corroborationCount, 1);
  assert.deepEqual(allowed.corroborationSourceClasses, ["web_content"]);
});

test("seedTrustZoneDemoDataset stays explicit and writes the enterprise demo scenario", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-trust-zone-demo-seed-"));
  const preview = await seedTrustZoneDemoDataset({
    memoryDir,
    enabled: true,
    dryRun: true,
    recordedAt: "2026-03-30T18:00:00.000Z",
  });
  assert.equal(preview.dryRun, true);
  assert.equal(preview.recordsWritten, 0);
  assert.equal(preview.records.length, 6);
  assert.equal(new Set(preview.records.map((record) => record.recordId)).size, 6);
  const blockedByProvenance = preview.records.find((record) => record.metadata?.story === "working-missing-provenance");
  assert.ok(blockedByProvenance);
  assert.equal(blockedByProvenance.zone, "working");
  const blockedByProvenanceReadiness = summarizeTrustZonePromotionReadiness({
    record: blockedByProvenance,
    allRecords: preview.records,
    poisoningDefenseEnabled: true,
  });
  assert.equal(blockedByProvenanceReadiness.allowed, false);
  assert.match(blockedByProvenanceReadiness.reasons.join(" "), /sourceId|evidenceHash/i);

  const blockedByCorroboration = preview.records.find((record) => record.metadata?.story === "working-awaiting-corroboration");
  assert.ok(blockedByCorroboration);
  const blockedByCorroborationReadiness = summarizeTrustZonePromotionReadiness({
    record: blockedByCorroboration,
    allRecords: preview.records,
    poisoningDefenseEnabled: true,
  });
  assert.equal(blockedByCorroborationReadiness.allowed, false);
  assert.equal(blockedByCorroborationReadiness.corroborationCount, 0);
  assert.match(blockedByCorroborationReadiness.reasons.join(" "), /corroborat/i);

  const supportedByCorroboration = preview.records.find((record) => record.metadata?.story === "working-with-corroboration");
  assert.ok(supportedByCorroboration);
  const supportedByCorroborationReadiness = summarizeTrustZonePromotionReadiness({
    record: supportedByCorroboration,
    allRecords: preview.records,
    poisoningDefenseEnabled: true,
  });
  assert.equal(supportedByCorroborationReadiness.allowed, true);
  assert.equal(supportedByCorroborationReadiness.corroborationCount, 1);
  assert.deepEqual(supportedByCorroborationReadiness.corroborationSourceClasses, ["web_content"]);

  const written = await runTrustZoneDemoSeedCliCommand({
    memoryDir,
    trustZonesEnabled: true,
    dryRun: false,
    recordedAt: "2026-03-30T18:00:00.000Z",
  });
  assert.equal(written.dryRun, false);
  assert.equal(written.recordsWritten, 6);
  assert.equal(written.scenario, "enterprise-buyer-v1");
  assert.equal(new Set(written.records.map((record) => record.recordId)).size, 6);

  const secondRun = await runTrustZoneDemoSeedCliCommand({
    memoryDir,
    trustZonesEnabled: true,
    dryRun: false,
    recordedAt: "2026-03-31T18:00:00.000Z",
  });
  assert.equal(secondRun.recordsWritten, 6);
  const combinedIds = new Set([
    ...written.records.map((record) => record.recordId),
    ...secondRun.records.map((record) => record.recordId),
  ]);
  assert.equal(combinedIds.size, 12);

  const status = await getTrustZoneStoreStatus({
    memoryDir,
    enabled: true,
    promotionEnabled: true,
    poisoningDefenseEnabled: true,
  });
  assert.equal(status.records.valid, 12);
  assert.equal(status.records.byZone.quarantine, 2);
  assert.equal(status.records.byZone.working, 8);
  assert.equal(status.records.byZone.trusted, 2);
});

test("seedTrustZoneDemoDataset previews the agentic commerce scenario with boundaries", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-trust-zone-commerce-demo-seed-"));
  const preview = await seedTrustZoneDemoDataset({
    memoryDir,
    enabled: true,
    dryRun: true,
    scenario: "agentic-commerce-v1",
    recordedAt: "2026-04-02T16:00:00.000Z",
  });

  assert.equal(preview.dryRun, true);
  assert.equal(preview.scenario, "agentic-commerce-v1");
  assert.equal(preview.recordsWritten, 0);
  assert.equal(preview.records.length, 9);
  assert.equal(new Set(preview.records.map((record) => record.recordId)).size, 9);
  assert.equal(
    preview.records.filter((record) => record.metadata?.commerceFacet === "ask_before_checkout").length,
    1,
  );
  assert.equal(
    preview.records.filter((record) => record.metadata?.commerceFacet === "excluded_products").length,
    1,
  );
  assert.equal(
    preview.records.filter((record) => record.metadata?.commerceFacet === "shipping_urgency").length,
    2,
  );

  const blockedUpsell = preview.records.find((record) => record.metadata?.story === "commerce-blocked-unverified-upsell");
  assert.ok(blockedUpsell);
  assert.equal(blockedUpsell.zone, "working");
  const blockedReadiness = summarizeTrustZonePromotionReadiness({
    record: blockedUpsell,
    allRecords: preview.records,
    poisoningDefenseEnabled: true,
  });
  assert.equal(blockedReadiness.allowed, false);
  assert.match(blockedReadiness.reasons.join(" "), /sourceId|evidenceHash/i);

  const shippingEstimate = preview.records.find((record) => record.metadata?.story === "working-shipping-urgency");
  assert.ok(shippingEstimate);
  const shippingReadiness = summarizeTrustZonePromotionReadiness({
    record: shippingEstimate,
    allRecords: preview.records,
    poisoningDefenseEnabled: true,
  });
  assert.equal(shippingReadiness.allowed, true);
  assert.equal(shippingReadiness.corroborationCount, 1);
  assert.deepEqual(shippingReadiness.corroborationSourceClasses, ["web_content"]);

  const written = await runTrustZoneDemoSeedCliCommand({
    memoryDir,
    trustZonesEnabled: true,
    dryRun: false,
    scenario: "agentic-commerce-v1",
    recordedAt: "2026-04-02T16:00:00.000Z",
  });
  assert.equal(written.dryRun, false);
  assert.equal(written.recordsWritten, 9);
  assert.equal(written.scenario, "agentic-commerce-v1");

  const status = await getTrustZoneStoreStatus({
    memoryDir,
    enabled: true,
    promotionEnabled: true,
    poisoningDefenseEnabled: true,
  });
  assert.equal(status.records.valid, 9);
  assert.equal(status.records.byZone.quarantine, 1);
  assert.equal(status.records.byZone.working, 3);
  assert.equal(status.records.byZone.trusted, 5);
});

test("seedTrustZoneDemoDataset rejects non-parsable recordedAt values before date math", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-trust-zone-demo-seed-invalid-"));
  await assert.rejects(
    () => seedTrustZoneDemoDataset({
      memoryDir,
      enabled: true,
      dryRun: true,
      recordedAt: "2026-03-30Tbad",
    }),
    /recordedAt/i,
  );
});
