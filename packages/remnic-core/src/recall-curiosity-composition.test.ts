import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { parseConfig } from "./config.js";
import { EngramAccessService } from "./access-service.js";
import { Orchestrator } from "./orchestrator.js";
import type { RecallContextComposition } from "./recall-context-composition.js";

async function makeOrchestrator(injectQuestions: boolean): Promise<{
  orchestrator: Orchestrator;
  memoryDir: string;
}> {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-curiosity-composition-"));
  const orchestrator = new Orchestrator(
    parseConfig({
      openaiApiKey: "test-key",
      memoryDir,
      workspaceDir: path.join(memoryDir, "workspace"),
      injectQuestions,
      qmdEnabled: false,
      embeddingFallbackEnabled: false,
      recallPlannerEnabled: false,
      sharedContextEnabled: false,
    }),
  );
  await orchestrator.initialize();
  return { orchestrator, memoryDir };
}

async function recallWithComposition(orchestrator: Orchestrator): Promise<{
  legacyContext: string;
  composition: RecallContextComposition | undefined;
}> {
  let composition: RecallContextComposition | undefined;
  const legacyContext = await orchestrator.recall("Which deployment decision matters?", "session-a", {
    onContextComposition: (value: RecallContextComposition) => {
      composition = value;
    },
  });
  return { legacyContext, composition };
}

test("enabled injectQuestions emits one separate curiosity footer while preserving legacy context", async () => {
  const { orchestrator, memoryDir } = await makeOrchestrator(true);
  try {
    await orchestrator.storage.writeQuestion(
      "Which deployment decision needs an owner?",
      "The rollout is waiting for an owner.",
      1,
    );

    const { composition, legacyContext } = await recallWithComposition(orchestrator);

    assert.equal(composition?.context.includes("## Open Question"), false);
    assert.equal(
      composition?.footer,
      "## Open Question\n\n" +
        "Something I've been curious about: Which deployment decision needs an owner?\n\n" +
        "_Context: The rollout is waiting for an owner._",
    );
    assert.match(legacyContext, /## Open Question/);
  } finally {
    await orchestrator.destroy();
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("disabled or empty injectQuestions emits no curiosity footer", async () => {
  const disabled = await makeOrchestrator(false);
  const empty = await makeOrchestrator(true);
  try {
    await disabled.orchestrator.storage.writeQuestion("Should this stay hidden?", "Disabled.", 1);

    const disabledResult = await recallWithComposition(disabled.orchestrator);
    const emptyResult = await recallWithComposition(empty.orchestrator);

    assert.equal(disabledResult.composition?.footer, undefined);
    assert.doesNotMatch(disabledResult.legacyContext, /## Open Question/);
    assert.equal(emptyResult.composition?.footer, undefined);
    assert.doesNotMatch(emptyResult.legacyContext, /## Open Question/);
  } finally {
    await disabled.orchestrator.destroy();
    await empty.orchestrator.destroy();
    await rm(disabled.memoryDir, { recursive: true, force: true });
    await rm(empty.memoryDir, { recursive: true, force: true });
  }
});

test("injectQuestions reads the question queue for the recalled namespace", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-curiosity-namespace-"));
  const orchestrator = new Orchestrator(
    parseConfig({
      openaiApiKey: "test-key",
      memoryDir,
      workspaceDir: path.join(memoryDir, "workspace"),
      injectQuestions: true,
      namespacesEnabled: true,
      defaultNamespace: "default",
      sharedNamespace: "shared",
      namespacePolicies: [
        { name: "alpha", readPrincipals: ["reader"], writePrincipals: ["reader"] },
        { name: "beta", readPrincipals: ["reader"], writePrincipals: ["reader"] },
      ],
      principalFromSessionKeyMode: "disabled",
      defaultRecallNamespaces: [],
      qmdEnabled: false,
      embeddingFallbackEnabled: false,
      recallPlannerEnabled: false,
      sharedContextEnabled: false,
    }),
  );
  await orchestrator.initialize();
  try {
    await (await orchestrator.getStorage("alpha")).writeQuestion(
      "Which alpha decision needs review?",
      "Alpha context.",
      1,
    );
    await (await orchestrator.getStorage("beta")).writeQuestion(
      "Which beta decision needs review?",
      "Beta context.",
      1,
    );

    let composition: RecallContextComposition | undefined;
    await orchestrator.recall("Which decision matters?", "session-alpha", {
      namespace: "alpha",
      principalOverride: "reader",
      onContextComposition: (value: RecallContextComposition) => {
        composition = value;
      },
    });

    assert.match(composition?.footer ?? "", /Which alpha decision needs review\?/);
    assert.doesNotMatch(composition?.footer ?? "", /Which beta decision needs review\?/);
  } finally {
    await orchestrator.destroy();
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("access recall returns the configured curiosity footer in its server response", async () => {
  const { orchestrator, memoryDir } = await makeOrchestrator(true);
  try {
    await orchestrator.storage.writeQuestion(
      "Which server-side decision needs review?",
      "The daemon should compose the same footer.",
      1,
    );

    const response = await new EngramAccessService(orchestrator).recall({
      query: "Which decision matters?",
      sessionKey: "daemon-session",
    });

    assert.match(response.context, /## Open Question/);
    assert.equal(
      response.contextComposition?.footer,
      "## Open Question\n\n" +
        "Something I've been curious about: Which server-side decision needs review?\n\n" +
        "_Context: The daemon should compose the same footer._",
    );
    assert.match(response.context, /Which server-side decision needs review\?/);
  } finally {
    await orchestrator.destroy();
    await rm(memoryDir, { recursive: true, force: true });
  }
});
