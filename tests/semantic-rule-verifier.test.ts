import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { runSemanticRuleVerifyCliCommand } from "@remnic/core/cli";
import { parseConfig } from "@remnic/core/config";
import { Orchestrator } from "@remnic/core/orchestrator";
import {
  type SemanticRulePromotionReport,
  promoteSemanticRuleFromMemory,
  setSemanticRulePromotionTestHooks,
} from "@remnic/core/semantic-rule-promotion";
import { searchVerifiedSemanticRules } from "@remnic/core/semantic-rule-verifier";
import { StorageManager } from "@remnic/core/storage";
import { setInFlightRead } from "@remnic/core/in-flight-reads";

async function createSemanticRuleHarness() {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-semantic-rule-verify-"));
  const storage = new StorageManager(memoryDir);
  return { memoryDir, storage };
}

async function seedPromotedRule(memoryDir: string, storage: StorageManager) {
  const { id: sourceMemoryId } = await storage.writeMemory(
    "fact",
    "IF Cursor Bugbot is still pending THEN wait for the terminal result before merging.",
    {
      source: "test",
      tags: ["pr-loop", "cursor"],
      confidence: 0.92,
      memoryKind: "episode",
    }
  );

  const promotion = await promoteSemanticRuleFromMemory({
    memoryDir,
    enabled: true,
    sourceMemoryId,
  });

  assert.equal(promotion.promoted.length, 1);
  return {
    sourceMemoryId,
    ruleMemoryId: promotion.promoted[0]!.id,
  };
}

test("searchVerifiedSemanticRules returns promoted rules whose source episode still verifies", async () => {
  const { memoryDir, storage } = await createSemanticRuleHarness();
  const { ruleMemoryId, sourceMemoryId } = await seedPromotedRule(memoryDir, storage);

  const results = await searchVerifiedSemanticRules({
    memoryDir,
    query: "What rule says to wait for Cursor before merging?",
    maxResults: 3,
  });

  assert.equal(results.length, 1);
  assert.equal(results[0]?.rule.frontmatter.id, ruleMemoryId);
  assert.equal(results[0]?.sourceMemoryId, sourceMemoryId);
  assert.equal(results[0]?.verificationStatus, "verified");
  assert.equal((results[0]?.effectiveConfidence ?? 0) > 0.8, true);
});

test("concurrent semantic rule promotions are idempotent for one source memory", async () => {
  const { memoryDir, storage } = await createSemanticRuleHarness();
  const { id: sourceMemoryId } = await storage.writeMemory(
    "fact",
    "IF the reviewer check is still pending THEN wait for the current-head verdict before merging.",
    {
      source: "test",
      tags: ["pr-loop", "reviewer"],
      confidence: 0.91,
      memoryKind: "episode",
    }
  );

  const promotions = await Promise.all([
    promoteSemanticRuleFromMemory({
      memoryDir,
      enabled: true,
      sourceMemoryId,
    }),
    promoteSemanticRuleFromMemory({
      memoryDir,
      enabled: true,
      sourceMemoryId,
    }),
  ]);

  const promotedIds = promotions.flatMap((promotion) => promotion.promoted.map((candidate) => candidate.id));
  const duplicateSkips = promotions.flatMap((promotion) =>
    promotion.skipped.filter((skip) => skip.reason === "duplicate-rule")
  );
  const rules = (await storage.readAllMemories()).filter(
    (memory) => memory.frontmatter.category === "rule" && memory.frontmatter.source === "semantic-rule-promotion"
  );

  assert.equal(promotedIds.length, 1);
  assert.equal(duplicateSkips.length, 1);
  assert.equal(duplicateSkips[0]?.existingRuleId, promotedIds[0]);
  assert.equal(rules.length, 1);
  assert.equal(rules[0]?.frontmatter.id, promotedIds[0]);
});

test("semantic rule promotion refreshes duplicate scan after acquiring the lock", async () => {
  const { memoryDir, storage } = await createSemanticRuleHarness();
  const { id: sourceMemoryId } = await storage.writeMemory(
    "fact",
    "IF the duplicate scan was already in flight THEN refresh it after acquiring the lock.",
    {
      source: "test",
      tags: ["pr-loop", "stale-read"],
      confidence: 0.91,
      memoryKind: "episode",
    }
  );
  const sourceMemory = await storage.getMemoryById(sourceMemoryId);
  assert.ok(sourceMemory);
  const { id: existingRuleId } = await storage.writeMemory(
    "rule",
    "IF the duplicate scan was already in flight THEN refresh it after acquiring the lock.",
    {
      source: "semantic-rule-promotion",
      tags: ["semantic-rule", "promoted-rule"],
      confidence: 0.91,
      memoryKind: "note",
      lineage: [sourceMemoryId],
      sourceMemoryId,
    }
  );
  setInFlightRead(path.resolve(memoryDir), "", Promise.resolve([sourceMemory]));

  const promotion = await promoteSemanticRuleFromMemory({
    memoryDir,
    enabled: true,
    sourceMemoryId,
  });

  assert.equal(promotion.promoted.length, 0);
  assert.equal(promotion.skipped.length, 1);
  assert.equal(promotion.skipped[0]?.reason, "duplicate-rule");
  assert.equal(promotion.skipped[0]?.existingRuleId, existingRuleId);
});

test("semantic rule promotion recovers stale lock directories", async () => {
  const { memoryDir, storage } = await createSemanticRuleHarness();
  const { id: sourceMemoryId } = await storage.writeMemory(
    "fact",
    "IF a promotion lock is stale THEN recover it before writing the rule.",
    {
      source: "test",
      tags: ["pr-loop", "stale-lock"],
      confidence: 0.91,
      memoryKind: "episode",
    }
  );
  const ruleKey = "if a promotion lock is stale then recover it before writing the rule.";
  const lockDigest = createHash("sha256").update(ruleKey).digest("hex");
  const lockDir = path.join(memoryDir, "state", "semantic-rule-promotion-locks", `${lockDigest}.lock`);
  await mkdir(lockDir, { recursive: true });
  await writeFile(
    path.join(lockDir, "owner.json"),
    JSON.stringify({
      pid: 0,
      token: "stale-test-lock",
      acquiredAt: "2026-01-01T00:00:00.000Z",
    })
  );

  const promotion = await promoteSemanticRuleFromMemory({
    memoryDir,
    enabled: true,
    sourceMemoryId,
  });

  assert.equal(promotion.promoted.length, 1);
  assert.equal(promotion.skipped.length, 0);
});

test("semantic rule promotion recovers stale locks even when the recorded pid is live", async () => {
  const { memoryDir, storage } = await createSemanticRuleHarness();
  const { id: sourceMemoryId } = await storage.writeMemory(
    "fact",
    "IF a promotion lock owner pid was reused THEN recover the stale heartbeat before writing the rule.",
    {
      source: "test",
      tags: ["pr-loop", "stale-lock", "pid-reuse"],
      confidence: 0.91,
      memoryKind: "episode",
    }
  );
  const ruleKey = "if a promotion lock owner pid was reused then recover the stale heartbeat before writing the rule.";
  const lockDigest = createHash("sha256").update(ruleKey).digest("hex");
  const lockDir = path.join(memoryDir, "state", "semantic-rule-promotion-locks", `${lockDigest}.lock`);
  await mkdir(lockDir, { recursive: true });
  await writeFile(
    path.join(lockDir, "owner.json"),
    JSON.stringify({
      pid: process.pid,
      token: "stale-live-pid-test-lock",
      acquiredAt: "2026-01-01T00:00:00.000Z",
      heartbeatAt: "2026-01-01T00:00:00.000Z",
    })
  );

  const promotion = await promoteSemanticRuleFromMemory({
    memoryDir,
    enabled: true,
    sourceMemoryId,
  });

  assert.equal(promotion.promoted.length, 1);
  assert.equal(promotion.skipped.length, 0);
});

test("semantic rule promotion recovers ownerless lock directories after a short creation grace", async () => {
  const { memoryDir, storage } = await createSemanticRuleHarness();
  const { id: sourceMemoryId } = await storage.writeMemory(
    "fact",
    "IF a promotion lock has no owner file THEN recover it after the creation grace.",
    {
      source: "test",
      tags: ["pr-loop", "ownerless-lock"],
      confidence: 0.91,
      memoryKind: "episode",
    }
  );
  const ruleKey = "if a promotion lock has no owner file then recover it after the creation grace.";
  const lockDigest = createHash("sha256").update(ruleKey).digest("hex");
  const lockDir = path.join(memoryDir, "state", "semantic-rule-promotion-locks", `${lockDigest}.lock`);
  await mkdir(lockDir, { recursive: true });
  const abandonedDate = new Date(Date.now() - 2000);
  await utimes(lockDir, abandonedDate, abandonedDate);

  const promotion = await promoteSemanticRuleFromMemory({
    memoryDir,
    enabled: true,
    sourceMemoryId,
  });

  assert.equal(promotion.promoted.length, 1);
  assert.equal(promotion.skipped.length, 0);
});

test("semantic rule promotion retries when a delayed owner write loses the lock", { concurrency: false }, async () => {
  const { memoryDir, storage } = await createSemanticRuleHarness();
  const { id: sourceMemoryId } = await storage.writeMemory(
    "fact",
    "IF a delayed promotion owner loses the lock THEN retry before checking duplicates.",
    {
      source: "test",
      tags: ["pr-loop", "late-owner"],
      confidence: 0.91,
      memoryKind: "episode",
    }
  );
  let pauseFirstOwnerWrite = true;
  let releaseFirstOwnerWrite!: () => void;
  let firstOwnerWritePaused!: () => void;
  const firstOwnerWriteBlocked = new Promise<void>((resolve) => {
    firstOwnerWritePaused = resolve;
  });
  const firstOwnerWriteReleased = new Promise<void>((resolve) => {
    releaseFirstOwnerWrite = resolve;
  });

  setSemanticRulePromotionTestHooks({
    beforeLockOwnerWrite: async () => {
      if (!pauseFirstOwnerWrite) return;
      pauseFirstOwnerWrite = false;
      firstOwnerWritePaused();
      await firstOwnerWriteReleased;
    },
  });

  try {
    const delayedPromotion = promoteSemanticRuleFromMemory({
      memoryDir,
      enabled: true,
      sourceMemoryId,
    });
    await firstOwnerWriteBlocked;
    await sleep(1200);
    const competingPromotion = promoteSemanticRuleFromMemory({
      memoryDir,
      enabled: true,
      sourceMemoryId,
    });

    const competingReport = await competingPromotion;
    releaseFirstOwnerWrite();
    const delayedReport = await delayedPromotion;
    const promotedIds = [...competingReport.promoted, ...delayedReport.promoted].map((candidate) => candidate.id);
    const duplicateSkips = [...competingReport.skipped, ...delayedReport.skipped].filter(
      (skip) => skip.reason === "duplicate-rule"
    );
    const rules = (await storage.readAllMemories()).filter(
      (memory) => memory.frontmatter.category === "rule" && memory.frontmatter.source === "semantic-rule-promotion"
    );

    assert.equal(promotedIds.length, 1);
    assert.equal(duplicateSkips.length, 1);
    assert.equal(duplicateSkips[0]?.existingRuleId, promotedIds[0]);
    assert.equal(rules.length, 1);
    assert.equal(rules[0]?.frontmatter.id, promotedIds[0]);
  } finally {
    setSemanticRulePromotionTestHooks(null);
  }
});

test("semantic rule promotion does not write after losing the promotion lock", { concurrency: false }, async () => {
  const { memoryDir, storage } = await createSemanticRuleHarness();
  const { id: sourceMemoryId } = await storage.writeMemory(
    "fact",
    "IF a promotion lock is reaped before the write THEN do not write a duplicate rule.",
    {
      source: "test",
      tags: ["pr-loop", "lost-lock"],
      confidence: 0.91,
      memoryKind: "episode",
    }
  );
  let stealLockOnce = true;
  let competingPromotion: SemanticRulePromotionReport | undefined;

  setSemanticRulePromotionTestHooks({
    beforePromotedRuleWrite: async (lockDir) => {
      if (!stealLockOnce) return;
      stealLockOnce = false;
      await rm(lockDir, { recursive: true, force: true });
      competingPromotion = await promoteSemanticRuleFromMemory({
        memoryDir,
        enabled: true,
        sourceMemoryId,
      });
    },
  });

  try {
    await assert.rejects(
      promoteSemanticRuleFromMemory({
        memoryDir,
        enabled: true,
        sourceMemoryId,
      }),
      /Semantic rule promotion lock is no longer held/
    );
    if (!competingPromotion) {
      throw new Error("Expected competing promotion to complete");
    }
    const completedPromotion: SemanticRulePromotionReport = competingPromotion;
    const rules = (await storage.readAllMemories()).filter(
      (memory) => memory.frontmatter.category === "rule" && memory.frontmatter.source === "semantic-rule-promotion"
    );

    assert.equal(completedPromotion.promoted.length, 1);
    assert.equal(rules.length, 1);
    assert.equal(rules[0]?.frontmatter.id, completedPromotion.promoted[0]?.id);
  } finally {
    setSemanticRulePromotionTestHooks(null);
  }
});

test("semantic rule promotion does not treat a reap guard as proof of ownership", { concurrency: false }, async () => {
  const { memoryDir, storage } = await createSemanticRuleHarness();
  const { id: sourceMemoryId } = await storage.writeMemory(
    "fact",
    "IF a promotion lock owner token changes during reap THEN do not write the rule.",
    {
      source: "test",
      tags: ["pr-loop", "reap-token-mismatch"],
      confidence: 0.91,
      memoryKind: "episode",
    }
  );
  let replaceOwnerOnce = true;

  setSemanticRulePromotionTestHooks({
    beforePromotedRuleWrite: async (lockDir) => {
      if (!replaceOwnerOnce) return;
      replaceOwnerOnce = false;
      await mkdir(`${lockDir}.reap`, { recursive: true });
      await rm(path.join(lockDir, "owner.json"), { force: true });
      await writeFile(
        path.join(lockDir, "owner.json"),
        JSON.stringify({
          pid: process.pid,
          token: "different-owner-token",
          acquiredAt: new Date().toISOString(),
        })
      );
    },
  });

  try {
    await assert.rejects(
      promoteSemanticRuleFromMemory({
        memoryDir,
        enabled: true,
        sourceMemoryId,
      }),
      /Semantic rule promotion lock is no longer held/
    );
    const rules = (await storage.readAllMemories()).filter(
      (memory) => memory.frontmatter.category === "rule" && memory.frontmatter.source === "semantic-rule-promotion"
    );

    assert.equal(rules.length, 0);
  } finally {
    setSemanticRulePromotionTestHooks(null);
  }
});

test(
  "semantic rule promotion keeps a successful result when lock release times out",
  { concurrency: false },
  async () => {
    const { memoryDir } = await createSemanticRuleHarness();
    const storage = new StorageManager(memoryDir);
    const { id: sourceMemoryId } = await storage.writeMemory(
      "fact",
      "IF lock release stalls after promotion THEN report the already written rule.",
      {
        source: "test",
        tags: ["pr-loop", "release-timeout"],
        confidence: 0.91,
        memoryKind: "episode",
      }
    );
    let blockReleaseOnce = true;

    setSemanticRulePromotionTestHooks({
      lockTimeoutMs: 25,
      lockRetryMs: 1,
      beforeLockRelease: async (lockDir) => {
        if (!blockReleaseOnce) return;
        blockReleaseOnce = false;
        await mkdir(`${lockDir}.release`, { recursive: true });
      },
    });

    try {
      const promotion = await promoteSemanticRuleFromMemory({
        memoryDir,
        enabled: true,
        sourceMemoryId,
      });

      assert.equal(promotion.promoted.length, 1);
      assert.equal(promotion.skipped.length, 0);
    } finally {
      setSemanticRulePromotionTestHooks(null);
    }
  }
);

test("semantic rule promotion recovers abandoned release guards", async () => {
  const { memoryDir, storage } = await createSemanticRuleHarness();
  const { id: sourceMemoryId } = await storage.writeMemory(
    "fact",
    "IF a promotion release guard is stale THEN recover it before writing the rule.",
    {
      source: "test",
      tags: ["pr-loop", "release-guard"],
      confidence: 0.91,
      memoryKind: "episode",
    }
  );
  const ruleKey = "if a promotion release guard is stale then recover it before writing the rule.";
  const lockDigest = createHash("sha256").update(ruleKey).digest("hex");
  const lockDir = path.join(memoryDir, "state", "semantic-rule-promotion-locks", `${lockDigest}.lock`);
  const releaseDir = `${lockDir}.release`;
  await mkdir(releaseDir, { recursive: true });
  const oldDate = new Date("2026-01-01T00:00:00.000Z");
  await utimes(releaseDir, oldDate, oldDate);

  const promotion = await promoteSemanticRuleFromMemory({
    memoryDir,
    enabled: true,
    sourceMemoryId,
  });

  assert.equal(promotion.promoted.length, 1);
  assert.equal(promotion.skipped.length, 0);
});

test("searchVerifiedSemanticRules downgrades archived-source rules below the default recall threshold", async () => {
  const { memoryDir, storage } = await createSemanticRuleHarness();
  const { ruleMemoryId, sourceMemoryId } = await seedPromotedRule(memoryDir, storage);
  const sourceMemory = await storage.getMemoryById(sourceMemoryId);
  assert.ok(sourceMemory);
  await storage.writeMemoryFrontmatter(sourceMemory, {
    status: "archived",
    archivedAt: "2026-03-08T00:00:00.000Z",
  });

  const results = await searchVerifiedSemanticRules({
    memoryDir,
    query: "What rule says to wait for Cursor before merging?",
    maxResults: 3,
  });

  assert.deepEqual(results, []);

  const diagnosticResults = await searchVerifiedSemanticRules({
    memoryDir,
    query: "What rule says to wait for Cursor before merging?",
    maxResults: 3,
    minEffectiveConfidence: 0.1,
  });
  assert.equal(diagnosticResults.length, 1);
  assert.equal(diagnosticResults[0]?.rule.frontmatter.id, ruleMemoryId);
  assert.equal(diagnosticResults[0]?.verificationStatus, "source-memory-archived");
  assert.equal(diagnosticResults[0]?.sourceMemoryId, sourceMemoryId);
});

test("searchVerifiedSemanticRules reports forgotten-source rules distinctly from archived sources", async () => {
  const { memoryDir, storage } = await createSemanticRuleHarness();
  const { ruleMemoryId, sourceMemoryId } = await seedPromotedRule(memoryDir, storage);
  const sourceMemory = await storage.getMemoryById(sourceMemoryId);
  assert.ok(sourceMemory);
  await storage.writeMemoryFrontmatter(sourceMemory, {
    status: "forgotten",
    forgottenAt: "2026-03-09T00:00:00.000Z",
    forgottenReason: "operator removed stale source",
  });

  const results = await searchVerifiedSemanticRules({
    memoryDir,
    query: "What rule says to wait for Cursor before merging?",
    maxResults: 3,
  });

  assert.deepEqual(results, []);

  const diagnosticResults = await searchVerifiedSemanticRules({
    memoryDir,
    query: "What rule says to wait for Cursor before merging?",
    maxResults: 3,
    minEffectiveConfidence: 0.1,
  });
  assert.equal(diagnosticResults.length, 1);
  assert.equal(diagnosticResults[0]?.rule.frontmatter.id, ruleMemoryId);
  assert.equal(diagnosticResults[0]?.verificationStatus, "source-memory-forgotten");
  assert.equal(diagnosticResults[0]?.sourceMemoryId, sourceMemoryId);
});

test("semantic-rule-verify CLI command honors the verification feature flag", async () => {
  const { memoryDir, storage } = await createSemanticRuleHarness();
  const { ruleMemoryId } = await seedPromotedRule(memoryDir, storage);

  const disabled = await runSemanticRuleVerifyCliCommand({
    memoryDir,
    semanticRuleVerificationEnabled: false,
    query: "wait for Cursor before merging",
    maxResults: 3,
  });
  assert.deepEqual(disabled, []);

  const enabled = await runSemanticRuleVerifyCliCommand({
    memoryDir,
    semanticRuleVerificationEnabled: true,
    query: "wait for Cursor before merging",
    maxResults: 3,
  });
  assert.equal(enabled[0]?.rule.frontmatter.id, ruleMemoryId);
});

test("recall injects verified semantic rules only when the verifier flag and recall section are enabled", async () => {
  const { memoryDir, storage } = await createSemanticRuleHarness();
  await seedPromotedRule(memoryDir, storage);

  const enabled = new Orchestrator(
    parseConfig({
      openaiApiKey: "test-openai-key",
      memoryDir,
      qmdEnabled: false,
      transcriptEnabled: false,
      sharedContextEnabled: false,
      conversationIndexEnabled: false,
      hourlySummariesEnabled: false,
      injectQuestions: false,
      semanticRulePromotionEnabled: true,
      semanticRuleVerificationEnabled: true,
      recallPipeline: [
        {
          id: "verified-rules",
          enabled: true,
          maxResults: 3,
          maxChars: 1800,
        },
      ],
    })
  );

  const enabledContext = await (enabled as any).recallInternal(
    "What rule says to wait for Cursor before merging?",
    "agent:main"
  );
  assert.match(enabledContext, /## Verified Rules/);
  assert.match(enabledContext, /wait for the terminal result before merging/i);

  const disabled = new Orchestrator(
    parseConfig({
      openaiApiKey: "test-openai-key",
      memoryDir,
      qmdEnabled: false,
      transcriptEnabled: false,
      sharedContextEnabled: false,
      conversationIndexEnabled: false,
      hourlySummariesEnabled: false,
      injectQuestions: false,
      semanticRulePromotionEnabled: true,
      semanticRuleVerificationEnabled: false,
      recallPipeline: [
        {
          id: "verified-rules",
          enabled: true,
          maxResults: 3,
          maxChars: 1800,
        },
      ],
    })
  );

  const disabledContext = await (disabled as any).recallInternal(
    "What rule says to wait for Cursor before merging?",
    "agent:main"
  );
  assert.equal(disabledContext.includes("## Verified Rules"), false);
});
