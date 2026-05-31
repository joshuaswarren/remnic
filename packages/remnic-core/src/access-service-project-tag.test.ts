import assert from "node:assert/strict";
import test from "node:test";
import { EngramAccessService } from "./access-service.js";
import { projectTagProjectId } from "./coding/coding-namespace.js";
import type { CodingContext } from "./types.js";

test("projectTag auto-resolution uses the shared project tag canonicalizer", async () => {
  const contexts = new Map<string, CodingContext>();
  const service = new EngramAccessService({
    config: {
      memoryDir: "/tmp/remnic-access-service-project-tag-test",
      recallCrossNamespaceBudgetEnabled: false,
      recallCrossNamespaceBudgetWindowMs: 60_000,
      recallCrossNamespaceBudgetSoftLimit: 10,
      recallCrossNamespaceBudgetHardLimit: 30,
      codingMode: {
        projectScope: true,
      },
    },
    getCodingContextForSession: (sessionKey: string) => contexts.get(sessionKey) ?? null,
    setCodingContextForSession: (sessionKey: string, context: CodingContext) => {
      contexts.set(sessionKey, context);
    },
  } as any);

  await (service as any).maybeAttachCodingContext("session-a", {
    projectTag: "Blend/Supply",
  });

  const projectId = projectTagProjectId("Blend/Supply");
  assert.deepEqual(contexts.get("session-a"), {
    projectId,
    branch: null,
    rootPath: projectId,
    defaultBranch: null,
  });
});
