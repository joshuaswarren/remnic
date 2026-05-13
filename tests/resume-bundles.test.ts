import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import {
  buildResumeBundleFromState,
  getResumeBundleStatus,
  recordResumeBundle,
  resolveResumeBundleDir,
  validateResumeBundle,
} from "../src/resume-bundles.js";
import {
  registerCli,
  runResumeBundleBuildCliCommand,
  runResumeBundleRecordCliCommand,
  runResumeBundleStatusCliCommand,
} from "../src/cli.js";
import { recordObjectiveStateSnapshot } from "../src/objective-state.js";
import { recordWorkProductLedgerEntry } from "../src/work-product-ledger.js";
import { recordCommitmentLedgerEntry } from "../src/commitment-ledger.js";
import { parseConfig } from "../src/config.js";
import { TranscriptManager } from "../src/transcript.js";

test("resume bundle path resolves under memoryDir by default", () => {
  assert.equal(
    resolveResumeBundleDir("/tmp/engram-memory"),
    path.join("/tmp/engram-memory", "state", "resume-bundles"),
  );
});

test("validateResumeBundle accepts the normalized contract", () => {
  const bundle = validateResumeBundle({
    schemaVersion: 1,
    bundleId: "resume-pr27-foundation",
    recordedAt: "2026-03-08T03:00:00.000Z",
    sessionKey: "agent:main",
    source: "cli",
    scope: "openclaw-engram roadmap",
    summary: "Compact resume bundle for the next crash-recovery handoff.",
    objectiveStateSnapshotRefs: ["snapshot-1"],
    workProductEntryRefs: ["work-product-1"],
    commitmentEntryRefs: ["commitment-1"],
    keyFacts: ["PR26 merged cleanly"],
    nextActions: ["Start PR27 implementation"],
    riskFlags: ["builder not shipped yet"],
    metadata: { owner: "engram" },
  });

  assert.equal(bundle.bundleId, "resume-pr27-foundation");
  assert.deepEqual(bundle.keyFacts, ["PR26 merged cleanly"]);
  assert.deepEqual(bundle.nextActions, ["Start PR27 implementation"]);
});

test("validateResumeBundle reports bundleId field name on invalid ids", () => {
  assert.throws(
    () => validateResumeBundle({
      schemaVersion: 1,
      bundleId: "resume/pr27",
      recordedAt: "2026-03-08T03:00:00.000Z",
      sessionKey: "agent:main",
      source: "cli",
      scope: "bad bundle id",
      summary: "This bundle uses an unsafe id.",
    }),
    /bundleId/,
  );
});

test("validateResumeBundle rejects date-like timestamps that Date.parse cannot read", () => {
  assert.throws(
    () => validateResumeBundle({
      schemaVersion: 1,
      bundleId: "resume-bad-date",
      recordedAt: "2026-13-40T00:00:00Z",
      sessionKey: "agent:main",
      source: "cli",
      scope: "bad date",
      summary: "This bundle carries a malformed timestamp.",
    }),
    /recordedAt must be an ISO timestamp/,
  );
});

test("recordResumeBundle persists bundles into dated storage", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-resume-bundle-record-"));
  const filePath = await recordResumeBundle({
    memoryDir,
    bundle: {
      schemaVersion: 1,
      bundleId: "resume-pr27-1",
      recordedAt: "2026-03-08T03:01:00.000Z",
      sessionKey: "agent:main",
      source: "cli",
      scope: "PR27",
      summary: "Ship the resume bundle format slice.",
      nextActions: ["Open PR27"],
    },
  });

  assert.equal(
    filePath,
    path.join(memoryDir, "state", "resume-bundles", "bundles", "2026-03-08", "resume-pr27-1.json"),
  );
});

test("resume bundle status reports valid and invalid bundles", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-resume-bundle-status-"));
  await recordResumeBundle({
    memoryDir,
    bundle: {
      schemaVersion: 1,
      bundleId: "resume-pr27-2",
      recordedAt: "2026-03-08T03:02:00.000Z",
      sessionKey: "agent:main",
      source: "system",
      scope: "crash recovery",
      summary: "Snapshot the latest roadmap checkpoint for a fresh agent.",
      keyFacts: ["PR25 and PR26 merged"],
    },
  });
  const invalidPath = path.join(
    memoryDir,
    "state",
    "resume-bundles",
    "bundles",
    "2026-03-08",
    "invalid.json",
  );
  await writeFile(invalidPath, JSON.stringify({ schemaVersion: 1, bundleId: "" }, null, 2), "utf8");
  const malformedDatePath = path.join(
    memoryDir,
    "state",
    "resume-bundles",
    "bundles",
    "2026-03-08",
    "bad-date.json",
  );
  await writeFile(
    malformedDatePath,
    JSON.stringify(
      {
        schemaVersion: 1,
        bundleId: "resume-bad-date",
        recordedAt: "2026-13-40T00:00:00Z",
        sessionKey: "agent:main",
        source: "system",
        scope: "bad date",
        summary: "This malformed timestamp should be rejected.",
      },
      null,
      2,
    ),
    "utf8",
  );

  const status = await getResumeBundleStatus({
    memoryDir,
    enabled: true,
  });

  assert.equal(status.enabled, true);
  assert.equal(status.bundles.total, 3);
  assert.equal(status.bundles.valid, 1);
  assert.equal(status.bundles.invalid, 2);
  assert.equal(status.bundles.bySource.system, 1);
  assert.equal(status.latestBundle?.bundleId, "resume-pr27-2");
  const invalidPaths = status.invalidBundles.map((entry) => entry.path);
  assert.equal(invalidPaths.some((candidate) => /invalid\.json$/.test(candidate)), true);
  assert.equal(invalidPaths.some((candidate) => /bad-date\.json$/.test(candidate)), true);
});

test("resume-bundle CLI commands write and report only when the feature is enabled", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-resume-bundle-cli-"));

  const skipped = await runResumeBundleRecordCliCommand({
    memoryDir,
    creationMemoryEnabled: true,
    resumeBundlesEnabled: false,
    bundle: {
      schemaVersion: 1,
      bundleId: "resume-skip",
      recordedAt: "2026-03-08T03:03:00.000Z",
      sessionKey: "agent:main",
      source: "cli",
      scope: "skip",
      summary: "Would have written a resume bundle.",
    },
  });
  assert.equal(skipped, null);

  const filePath = await runResumeBundleRecordCliCommand({
    memoryDir,
    creationMemoryEnabled: true,
    resumeBundlesEnabled: true,
    bundle: {
      schemaVersion: 1,
      bundleId: "resume-pr27-3",
      recordedAt: "2026-03-08T03:04:00.000Z",
      sessionKey: "agent:main",
      source: "cli",
      scope: "resume scope",
      summary: "Bundle the current state for the next autonomous PR slice.",
      nextActions: ["Continue PR loop"],
    },
  });

  assert.match(filePath ?? "", /resume-pr27-3\.json$/);

  const disabledStatus = await runResumeBundleStatusCliCommand({
    memoryDir,
    creationMemoryEnabled: true,
    resumeBundlesEnabled: false,
  });
  assert.equal(disabledStatus.enabled, false);
  assert.equal(disabledStatus.bundles.total, 0);
  assert.equal(disabledStatus.bundles.valid, 0);
  assert.equal(disabledStatus.bundles.invalid, 0);
  assert.equal(disabledStatus.latestBundle, undefined);

  const enabledStatus = await runResumeBundleStatusCliCommand({
    memoryDir,
    creationMemoryEnabled: true,
    resumeBundlesEnabled: true,
  });
  assert.equal(enabledStatus.bundles.total, 1);
  assert.equal(enabledStatus.latestBundle?.bundleId, "resume-pr27-3");
});

test("resume-bundle CLI wiring records bundles through command registration", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-resume-bundle-cli-wiring-"));

  class MockCommand {
    children = new Map<string, MockCommand>();
    actionHandler?: (...args: unknown[]) => Promise<void> | void;

    constructor(readonly name: string) {}

    command(name: string): MockCommand {
      const child = new MockCommand(name);
      this.children.set(name, child);
      return child;
    }

    description(): MockCommand {
      return this;
    }

    option(): MockCommand {
      return this;
    }

    requiredOption(): MockCommand {
      return this;
    }

    argument(): MockCommand {
      return this;
    }

    action(handler: (...args: unknown[]) => Promise<void> | void): MockCommand {
      this.actionHandler = handler;
      return this;
    }
  }

  const root = new MockCommand("root");
  registerCli(
    {
      registerCli(handler: (opts: { program: MockCommand }) => void): void {
        handler({ program: root });
      },
    },
    {
      config: {
        memoryDir,
        creationMemoryEnabled: true,
        resumeBundlesEnabled: true,
        resumeBundleDir: path.join(memoryDir, "state", "resume-bundles"),
      },
    } as never,
  );

  const action = root.children.get("engram")?.children.get("resume-bundle-record")?.actionHandler;
  assert.equal(typeof action, "function");

  await action?.({
    bundleId: "resume-pr27-4",
    recordedAt: "2026-03-08T03:05:00.000Z",
    sessionKey: "agent:main",
    source: "cli",
    scope: "handoff",
    summary: "Persist a deterministic resume bundle shell.",
    keyFact: ["PR27 is format-only"],
    nextAction: ["Implement PR28 builder later"],
    riskFlag: ["No transcript synthesis yet"],
  });

  const status = await runResumeBundleStatusCliCommand({
    memoryDir,
    creationMemoryEnabled: true,
    resumeBundlesEnabled: true,
  });
  assert.equal(status.bundles.total, 1);
  assert.deepEqual(status.latestBundle?.keyFacts, ["PR27 is format-only"]);
  assert.deepEqual(status.latestBundle?.nextActions, ["Implement PR28 builder later"]);
});

test("buildResumeBundleFromState assembles transcript, objective-state, work-product, and commitment context for one session", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-resume-bundle-builder-"));
  const sessionKey = "agent:main";

  const transcript = new TranscriptManager(parseConfig({ memoryDir, transcriptEnabled: true }));
  await transcript.initialize();
  await transcript.append({
    timestamp: "2026-03-08T04:00:00.000Z",
    role: "user",
    content: "Ship the PR28 builder slice.",
    sessionKey,
    turnId: "t1",
  });
  await transcript.append({
    timestamp: "2026-03-08T04:01:00.000Z",
    role: "assistant",
    content: "Working through the builder contract.",
    sessionKey,
    turnId: "t1",
  });
  await transcript.append({
    timestamp: "2026-03-08T04:02:00.000Z",
    role: "user",
    content: "Also keep recovery deterministic.",
    sessionKey,
    turnId: "t2",
  });
  await writeFile(path.join(memoryDir, "state", "checkpoint.json"), "{bad-json", "utf8");

  await recordObjectiveStateSnapshot({
    memoryDir,
    snapshot: {
      schemaVersion: 1,
      snapshotId: "snap-build-fail",
      recordedAt: "2026-03-08T04:03:00.000Z",
      sessionKey,
      source: "tool_result",
      kind: "process",
      changeKind: "failed",
      scope: "npm test",
      summary: "Verification failed in the resume-bundle builder tests.",
      command: "npm test -- tests/resume-bundles.test.ts",
      outcome: "failure",
      tags: ["verification"],
    },
  });
  await recordObjectiveStateSnapshot({
    memoryDir,
    snapshot: {
      schemaVersion: 1,
      snapshotId: "snap-other-session",
      recordedAt: "2026-03-08T04:04:00.000Z",
      sessionKey: "agent:other",
      source: "tool_result",
      kind: "workspace",
      changeKind: "observed",
      scope: "other",
      summary: "Should not leak into the target bundle.",
      outcome: "success",
    },
  });

  await recordWorkProductLedgerEntry({
    memoryDir,
    entry: {
      schemaVersion: 1,
      entryId: "wp-builder-doc",
      recordedAt: "2026-03-08T04:05:00.000Z",
      sessionKey,
      source: "cli",
      kind: "artifact",
      action: "created",
      scope: "docs/plans/pr28.md",
      summary: "Created the PR28 builder notes.",
      artifactPath: "docs/plans/pr28.md",
      tags: ["docs", "resume-bundles"],
    },
  });
  await recordCommitmentLedgerEntry({
    memoryDir,
    entry: {
      schemaVersion: 1,
      entryId: "commitment-pr28-open",
      recordedAt: "2026-03-08T04:06:00.000Z",
      sessionKey,
      source: "cli",
      kind: "follow_up",
      state: "open",
      scope: "resume bundles",
      summary: "Open the PR once builder verification passes.",
      tags: ["next-action"],
    },
  });
  await recordCommitmentLedgerEntry({
    memoryDir,
    entry: {
      schemaVersion: 1,
      entryId: "commitment-other-session",
      recordedAt: "2026-03-08T04:07:00.000Z",
      sessionKey: "agent:other",
      source: "cli",
      kind: "follow_up",
      state: "open",
      scope: "other",
      summary: "Should stay out of the bundle.",
    },
  });

  const bundle = await buildResumeBundleFromState({
    memoryDir,
    sessionKey,
    bundleId: "resume-pr28-built",
    recordedAt: "2026-03-08T04:10:00.000Z",
    scope: "resume-bundle builder",
    transcriptEnabled: true,
    objectiveStateMemoryEnabled: true,
    creationMemoryEnabled: true,
    commitmentLedgerEnabled: true,
  });

  assert.equal(bundle.bundleId, "resume-pr28-built");
  assert.equal(bundle.sessionKey, sessionKey);
  assert.equal(bundle.source, "system");
  assert.deepEqual(bundle.objectiveStateSnapshotRefs, ["snap-build-fail"]);
  assert.deepEqual(bundle.workProductEntryRefs, ["wp-builder-doc"]);
  assert.deepEqual(bundle.commitmentEntryRefs, ["commitment-pr28-open"]);
  assert.match(bundle.summary, /1 open commitment/i);
  assert.equal(bundle.keyFacts?.some((fact) => /Created the PR28 builder notes\./.test(fact)), true);
  assert.equal(bundle.keyFacts?.some((fact) => /Transcript recovery/i.test(fact)), true);
  assert.deepEqual(bundle.nextActions, ["Open the PR once builder verification passes."]);
  assert.equal(bundle.riskFlags?.some((flag) => /Verification failed in the resume-bundle builder tests\./.test(flag)), true);
  assert.equal(bundle.riskFlags?.some((flag) => /checkpoint/i.test(flag)), true);
});

test("buildResumeBundleFromState finds raw session snapshots in namespaced objective-state override stores", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-resume-bundle-ns-"));
  const objectiveStateStoreDir = await mkdtemp(path.join(os.tmpdir(), "engram-resume-bundle-ns-override-"));
  const namespace = "team-a";
  const namespaceDir = path.join(memoryDir, "namespaces", namespace);
  const namespaceObjectiveStateStoreDir = path.join(objectiveStateStoreDir, "namespaces", namespace);
  const sessionKey = "agent:main";
  await mkdir(namespaceDir, { recursive: true });

  try {
    await recordObjectiveStateSnapshot({
      memoryDir: namespaceDir,
      objectiveStateStoreDir: namespaceObjectiveStateStoreDir,
      snapshot: {
        schemaVersion: 1,
        snapshotId: "snap-team-raw-session",
        recordedAt: "2026-03-08T04:11:00.000Z",
        sessionKey,
        source: "tool_result",
        kind: "process",
        changeKind: "executed",
        scope: "npm test",
        summary: "Team namespace verification passed.",
        command: "npm test",
        outcome: "success",
        tags: ["verification"],
      },
    });
    await recordObjectiveStateSnapshot({
      memoryDir: namespaceDir,
      objectiveStateStoreDir: namespaceObjectiveStateStoreDir,
      snapshot: {
        schemaVersion: 1,
        snapshotId: "snap-team-prefixed-session",
        recordedAt: "2026-03-08T04:12:00.000Z",
        sessionKey: `${namespace}:${sessionKey}`,
        source: "tool_result",
        kind: "process",
        changeKind: "failed",
        scope: "npm run stale",
        summary: "Legacy prefixed session key should not match raw session lookups.",
        command: "npm run stale",
        outcome: "failure",
      },
    });

    const bundle = await buildResumeBundleFromState({
      memoryDir: namespaceDir,
      objectiveStateStoreDir: namespaceObjectiveStateStoreDir,
      sessionKey,
      bundleId: "resume-ns-raw-session",
      recordedAt: "2026-03-08T04:13:00.000Z",
      scope: "namespaced objective-state",
      objectiveStateMemoryEnabled: true,
    });

    assert.deepEqual(bundle.objectiveStateSnapshotRefs, ["snap-team-raw-session"]);
    assert.equal(
      bundle.objectiveStateSnapshotRefs?.includes("snap-team-prefixed-session"),
      false,
    );
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
    await rm(objectiveStateStoreDir, { recursive: true, force: true });
  }
});

test("buildResumeBundleFromState filters commitments to open entries before applying the recency cap", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-resume-bundle-open-filter-"));
  const sessionKey = "agent:main";

  for (let index = 0; index < 5; index += 1) {
    await recordCommitmentLedgerEntry({
      memoryDir,
      entry: {
        schemaVersion: 1,
        entryId: `commitment-closed-${index}`,
        recordedAt: `2026-03-08T05:0${index}:00.000Z`,
        sessionKey,
        source: "cli",
        kind: "follow_up",
        state: "fulfilled",
        scope: "closed commitments",
        summary: `Closed commitment ${index}`,
      },
    });
  }

  await recordCommitmentLedgerEntry({
    memoryDir,
    entry: {
      schemaVersion: 1,
      entryId: "commitment-open-older",
      recordedAt: "2026-03-08T04:59:00.000Z",
      sessionKey,
      source: "cli",
      kind: "deliverable",
      state: "open",
      scope: "resume bundles",
      summary: "Ship the bounded resume bundle builder fix.",
      dueAt: "2026-03-08T05:05:00.000Z",
    },
  });

  const bundle = await buildResumeBundleFromState({
    memoryDir,
    sessionKey,
    bundleId: "resume-open-filter",
    recordedAt: "2026-03-08T05:10:00.000Z",
    scope: "PR28 regression",
    creationMemoryEnabled: true,
    commitmentLedgerEnabled: true,
    maxRefsPerStore: 5,
  });

  assert.deepEqual(bundle.commitmentEntryRefs, ["commitment-open-older"]);
  assert.deepEqual(bundle.nextActions, ["Ship the bounded resume bundle builder fix."]);
  assert.equal(
    bundle.riskFlags?.includes("Overdue commitment: Ship the bounded resume bundle builder fix."),
    true,
  );
});

test("resume-bundle-build CLI command persists a built bundle only when the feature is enabled", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-resume-bundle-build-cli-"));
  const sessionKey = "agent:main";

  const transcript = new TranscriptManager(parseConfig({ memoryDir, transcriptEnabled: true }));
  await transcript.initialize();
  await transcript.append({
    timestamp: "2026-03-08T04:20:00.000Z",
    role: "user",
    content: "Resume me later.",
    sessionKey,
    turnId: "t1",
  });
  await transcript.append({
    timestamp: "2026-03-08T04:21:00.000Z",
    role: "assistant",
    content: "I will keep the next action explicit.",
    sessionKey,
    turnId: "t1",
  });

  await recordWorkProductLedgerEntry({
    memoryDir,
    entry: {
      schemaVersion: 1,
      entryId: "wp-build-cli",
      recordedAt: "2026-03-08T04:22:00.000Z",
      sessionKey,
      source: "cli",
      kind: "artifact",
      action: "created",
      scope: "README.md",
      summary: "Created the README update for the builder slice.",
      artifactPath: "README.md",
    },
  });
  await recordCommitmentLedgerEntry({
    memoryDir,
    entry: {
      schemaVersion: 1,
      entryId: "commitment-build-cli",
      recordedAt: "2026-03-08T04:23:00.000Z",
      sessionKey,
      source: "cli",
      kind: "follow_up",
      state: "open",
      scope: "builder",
      summary: "Loop the PR until Cursor is clean.",
    },
  });

  const skipped = await runResumeBundleBuildCliCommand({
    memoryDir,
    creationMemoryEnabled: true,
    resumeBundlesEnabled: false,
    transcriptEnabled: true,
    objectiveStateMemoryEnabled: true,
    commitmentLedgerEnabled: true,
    bundleId: "resume-pr28-skip",
    recordedAt: "2026-03-08T04:24:00.000Z",
    sessionKey,
    scope: "builder",
  });
  assert.equal(skipped, null);

  const built = await runResumeBundleBuildCliCommand({
    memoryDir,
    creationMemoryEnabled: true,
    resumeBundlesEnabled: true,
    transcriptEnabled: true,
    objectiveStateMemoryEnabled: true,
    commitmentLedgerEnabled: true,
    bundleId: "resume-pr28-cli",
    recordedAt: "2026-03-08T04:25:00.000Z",
    sessionKey,
    scope: "builder",
  });

  assert.equal(built?.bundle.bundleId, "resume-pr28-cli");
  assert.match(built?.filePath ?? "", /resume-pr28-cli\.json$/);

  const status = await runResumeBundleStatusCliCommand({
    memoryDir,
    creationMemoryEnabled: true,
    resumeBundlesEnabled: true,
  });
  assert.equal(status.latestBundle?.bundleId, "resume-pr28-cli");
  assert.deepEqual(status.latestBundle?.commitmentEntryRefs, ["commitment-build-cli"]);
});
