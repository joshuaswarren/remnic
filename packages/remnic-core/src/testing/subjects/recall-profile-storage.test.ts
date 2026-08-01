/**
 * Recall-profile-storage contract lifecycle subject for the scenario-matrix harness.
 * Exercises resolveCompositeProfileStorage across single-storage pass-through,
 * empty storage fallback, multi-storage precedence, and aggregation deduplication.
 */

import assert from "node:assert/strict";
import path from "node:path";

import {
  type CompositeProfileStorageResult,
  resolveCompositeProfileStorage,
} from "../../orchestration/recall-profile-storage.js";
import { StorageManager } from "../../storage.js";
import { type LifecycleSubject, type MatrixRow, runLifecycleMatrix } from "../lifecycle-matrix.js";
import { cleanupDir, mkTempMemoryDir } from "../orchestrator-lite.js";

interface RecallProfileStorageState {
  readonly memoryDir: string;
  readonly storages: StorageManager[];
  readonly extraDirs: string[];
  result?: CompositeProfileStorageResult;
  readProfileResult?: string;
  readQuestionsResult?: unknown[];
  readIdentityAnchorResult?: string | null;
  readIdentityImprovementLoopsResult?: string | null;
  readContinuityIncidentsResult?: unknown[];
  listEntityNamesResult?: string[];
  readEntityResult?: unknown;
  readMemoryByPathResult?: unknown;
  readAllMemoriesResult?: unknown[];
}

const subject: LifecycleSubject<RecallProfileStorageState> = {
  appliesTo(row: MatrixRow): boolean | string {
    if (row.id === "compaction-flush") {
      return "profile storage proxying has no compaction flush behavior; compaction operates on transcripts";
    }
    if (row.id === "before-reset") {
      return "profile storage proxying has no before_reset lifecycle hook; reset operates on session state";
    }
    return true;
  },

  async setup(row: MatrixRow): Promise<RecallProfileStorageState> {
    const memoryDir = await mkTempMemoryDir(`recall-profile-storage-${row.id}`);
    const extraDirs: string[] = [];

    try {
      if (row.id === "sparse-metadata-without-binding") {
        return { memoryDir, storages: [], extraDirs };
      }

      if (row.id === "sparse-metadata-with-binding") {
        const s1 = new StorageManager(memoryDir);
        await s1.writeProfile("# Single Profile\n- Fact 1");
        return { memoryDir, storages: [s1], extraDirs };
      }

      if (row.id === "explicit-provider-identity") {
        const dir2 = await mkTempMemoryDir(`recall-profile-storage-${row.id}-2`);
        extraDirs.push(dir2);
        const dir3 = await mkTempMemoryDir(`recall-profile-storage-${row.id}-3`);
        extraDirs.push(dir3);

        const s1 = new StorageManager(memoryDir);
        const s2 = new StorageManager(dir2);
        const s3 = new StorageManager(dir3);

        await s1.writeEntity("Alice", "person", ["Alice works on Remnic"]);

        await s2.writeProfile("# Profile 2\n- User prefers TypeScript");
        await s2.writeIdentityAnchor("# Identity Anchor 2\n- Value: Integrity");
        await s2.writeEntity("Bob", "person", ["Bob works on Remnic"]);

        await s3.writeProfile("# Profile 3\n- User prefers Rust");
        await s3.writeIdentityAnchor("# Identity Anchor 3\n- Value: Speed");

        return { memoryDir, storages: [s1, s2, s3], extraDirs };
      }

      if (row.id === "provider-rebinding") {
        const dir2 = await mkTempMemoryDir(`recall-profile-storage-${row.id}-2`);
        extraDirs.push(dir2);

        const s1 = new StorageManager(memoryDir);
        const s2 = new StorageManager(memoryDir);
        const s3 = new StorageManager(dir2);
        const s4 = { dir: "" } as unknown as StorageManager;

        return { memoryDir, storages: [s1, s2, s3, s4], extraDirs };
      }

      if (row.id === "restart-reload-recovery") {
        const dir2 = await mkTempMemoryDir(`recall-profile-storage-${row.id}-2`);
        extraDirs.push(dir2);

        const s1Seed = new StorageManager(memoryDir);
        const s2Seed = new StorageManager(dir2);
        await s2Seed.writeProfile("# Recovered Profile\n- Persisted value");
        await s2Seed.writeIdentityAnchor("# Recovered Anchor\n- Persisted anchor");

        const seedResult = resolveCompositeProfileStorage({
          profileStorages: [s1Seed, s2Seed],
          memoryDir,
        });
        const seedProfile = await seedResult.profileStorage.readProfile();
        assert.ok(seedProfile.includes("Recovered Profile"));

        const s1Recovered = new StorageManager(memoryDir);
        const s2Recovered = new StorageManager(dir2);

        return { memoryDir, storages: [s1Recovered, s2Recovered], extraDirs };
      }

      if (row.id === "session-end") {
        const dir2 = await mkTempMemoryDir(`recall-profile-storage-${row.id}-2`);
        extraDirs.push(dir2);

        const s1 = new StorageManager(memoryDir);
        const s2 = new StorageManager(dir2);

        await s2.writeProfile("# Final Session Profile\n- Summary");

        return { memoryDir, storages: [s1, s2], extraDirs };
      }

      if (row.id === "dedupe-replay") {
        const dir2 = await mkTempMemoryDir(`recall-profile-storage-${row.id}-2`);
        extraDirs.push(dir2);

        const s1 = new StorageManager(memoryDir);
        const s2 = new StorageManager(memoryDir);
        const s3 = new StorageManager(dir2);

        await s1.writeQuestion("What is Remnic?", "context 1", 5);
        await s1.writeQuestion("How does recall work?", "context 2", 10);
        await s1.appendContinuityIncident({
          symptom: "Incident 1 symptom",
          suspectedCause: "Cause 1",
          triggerWindow: "2026-08-01",
        });
        await s1.writeIdentityImprovementLoops("# Improvement Loop A");
        await s1.writeEntity("ProjectX", "project", ["Fact X1"]);
        await s1.writeMemory("fact", "Memory fact 1");

        await s3.writeQuestion("Where are memories saved?", "context 3", 1);
        await s3.appendContinuityIncident({
          symptom: "Incident 2 symptom",
          suspectedCause: "Cause 2",
          triggerWindow: "2026-08-01",
        });
        await s3.writeIdentityImprovementLoops("# Improvement Loop B");
        await s3.writeEntity("ProjectY", "project", ["Fact Y1"]);
        await s3.writeMemory("fact", "Memory fact 2");

        return { memoryDir, storages: [s1, s2, s3], extraDirs };
      }

      return { memoryDir, storages: [], extraDirs };
    } catch (error) {
      await cleanupDir(memoryDir);
      for (const dir of extraDirs) {
        await cleanupDir(dir);
      }
      throw error;
    }
  },

  async exercise(state: RecallProfileStorageState, row: MatrixRow): Promise<void> {
    const result = resolveCompositeProfileStorage({
      profileStorages: state.storages,
      memoryDir: state.memoryDir,
    });
    state.result = result;

    const storage = result.profileStorage;

    if (row.id === "sparse-metadata-without-binding") {
      state.readProfileResult = await storage.readProfile();
      state.readQuestionsResult = await storage.readQuestions();
      state.readIdentityAnchorResult = await storage.readIdentityAnchor();
      state.readIdentityImprovementLoopsResult = await storage.readIdentityImprovementLoops();
      state.readContinuityIncidentsResult = await storage.readContinuityIncidents();
      state.listEntityNamesResult = await storage.listEntityNames();
      state.readEntityResult = await storage.readEntity("Alice");
      state.readMemoryByPathResult = await storage.readMemoryByPath("fact/1.md");
      state.readAllMemoriesResult = await storage.readAllMemories();
      return;
    }

    if (row.id === "sparse-metadata-with-binding") {
      state.readProfileResult = await storage.readProfile();
      return;
    }

    if (row.id === "explicit-provider-identity") {
      state.readProfileResult = await storage.readProfile();
      state.readIdentityAnchorResult = await storage.readIdentityAnchor();
      state.readEntityResult = await storage.readEntity("person-bob");
      state.readMemoryByPathResult = await storage.readMemoryByPath("nonexistent.md");
      return;
    }

    if (row.id === "restart-reload-recovery") {
      state.readProfileResult = await storage.readProfile();
      state.readIdentityAnchorResult = await storage.readIdentityAnchor();
      return;
    }

    if (row.id === "session-end") {
      state.readProfileResult = await storage.readProfile();
      return;
    }

    if (row.id === "dedupe-replay") {
      state.readQuestionsResult = await storage.readQuestions();
      state.readIdentityImprovementLoopsResult = await storage.readIdentityImprovementLoops();
      state.readContinuityIncidentsResult = await storage.readContinuityIncidents(10);
      state.listEntityNamesResult = await storage.listEntityNames();
      state.readAllMemoriesResult = await storage.readAllMemories();
      return;
    }
  },

  async invariants(state: RecallProfileStorageState, row: MatrixRow): Promise<void> {
    assert.ok(state.result, "composite profile storage result was populated");

    if (row.id === "sparse-metadata-without-binding") {
      assert.equal(state.result.profileStorageDirs.length, 0, "empty storage list returns empty storage dirs");
      assert.equal(
        state.result.profileStorage.dir,
        path.join(state.memoryDir, ".empty-scope-profile"),
        "empty storage fallback has .empty-scope-profile dir"
      );
      assert.equal(state.readProfileResult, "", "empty storage readProfile returns empty string");
      assert.deepEqual(state.readQuestionsResult, [], "empty storage readQuestions returns empty array");
      assert.equal(state.readIdentityAnchorResult, "", "empty storage readIdentityAnchor returns empty string");
      assert.equal(
        state.readIdentityImprovementLoopsResult,
        "",
        "empty storage readIdentityImprovementLoops returns empty string"
      );
      assert.deepEqual(
        state.readContinuityIncidentsResult,
        [],
        "empty storage readContinuityIncidents returns empty array"
      );
      assert.deepEqual(state.listEntityNamesResult, [], "empty storage listEntityNames returns empty array");
      assert.equal(state.readEntityResult, null, "empty storage readEntity returns null");
      assert.equal(state.readMemoryByPathResult, null, "empty storage readMemoryByPath returns null");
      assert.deepEqual(state.readAllMemoriesResult, [], "empty storage readAllMemories returns empty array");
      return;
    }

    if (row.id === "sparse-metadata-with-binding") {
      assert.strictEqual(
        state.result.profileStorage,
        state.storages[0],
        "single storage pass-through returns unproxied target instance"
      );
      assert.deepEqual(
        state.result.profileStorageDirs,
        [state.memoryDir],
        "single storage pass-through returns target storage directory"
      );
      assert.ok(
        state.readProfileResult?.includes("Single Profile"),
        "single storage readProfile delegates to target storage"
      );
      return;
    }

    if (row.id === "explicit-provider-identity") {
      assert.ok(
        state.readProfileResult?.includes("Profile 2"),
        "readProfile returns first non-empty profile in composite order"
      );
      assert.ok(
        state.readIdentityAnchorResult?.includes("Identity Anchor 2"),
        "readIdentityAnchor returns first non-empty anchor in composite order"
      );
      assert.ok(typeof state.readEntityResult === "string", "readEntity returns raw entity string");
      assert.ok(
        (state.readEntityResult as string).includes("Bob"),
        "readEntity returns entity content from matching storage"
      );
      assert.equal(state.readMemoryByPathResult, null, "readMemoryByPath returns null when absent in all storages");
      return;
    }

    if (row.id === "provider-rebinding") {
      assert.deepEqual(
        state.result.profileStorageDirs,
        [state.memoryDir, state.extraDirs[0]],
        "profileStorageDirs deduplicates directories and filters out empty strings"
      );
      return;
    }

    if (row.id === "restart-reload-recovery") {
      assert.ok(
        state.readProfileResult?.includes("Recovered Profile"),
        "composite profile storage recovers state over fresh instances after restart"
      );
      assert.ok(
        state.readIdentityAnchorResult?.includes("Recovered Anchor"),
        "composite identity anchor recovers state over fresh instances after restart"
      );
      return;
    }

    if (row.id === "session-end") {
      assert.ok(
        state.readProfileResult?.includes("Final Session Profile"),
        "session-end readProfile correctly falls back past blank profile to non-empty profile"
      );
      return;
    }

    if (row.id === "dedupe-replay") {
      const questions = state.readQuestionsResult;
      assert.ok(Array.isArray(questions), "readQuestions returns an array");
      assert.equal(questions.length, 3, "readQuestions deduplicates repeated storage records");
      const firstQ = questions[0];
      assert.ok(firstQ && typeof firstQ === "object" && "question" in firstQ && "priority" in firstQ);
      assert.equal(firstQ.question, "How does recall work?", "readQuestions sorts by priority descending");
      assert.equal(firstQ.priority, 10, "highest priority question comes first");

      const loops = state.readIdentityImprovementLoopsResult;
      assert.equal(
        loops,
        "# Improvement Loop A\n\n# Improvement Loop B",
        "readIdentityImprovementLoops deduplicates identical sections and joins with double newline"
      );

      const incidents = state.readContinuityIncidentsResult as unknown[];
      assert.ok(Array.isArray(incidents), "readContinuityIncidents returns an array");
      assert.equal(incidents.length, 2, "readContinuityIncidents deduplicates repeated storage records");

      const entityNames = state.listEntityNamesResult;
      assert.ok(Array.isArray(entityNames), "listEntityNames returns an array");
      assert.deepEqual(new Set(entityNames), new Set(["project-projectx", "project-projecty"]));

      const memories = state.readAllMemoriesResult as unknown[];
      assert.ok(Array.isArray(memories), "readAllMemories returns an array");
      assert.equal(memories.length, 2, "readAllMemories aggregates memories across composite storages");
      return;
    }
  },

  async teardown(state: RecallProfileStorageState): Promise<void> {
    if (state.memoryDir) {
      await cleanupDir(state.memoryDir);
    }
    for (const dir of state.extraDirs) {
      await cleanupDir(dir);
    }
  },
};

runLifecycleMatrix("recall-profile-storage", subject);
