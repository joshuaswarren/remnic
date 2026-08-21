import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { StorageManager } from "../src/storage.js";
import {
  buildBriefing,
  buildChainFollowupGenerator,
  parseBriefingWindow,
  type BriefingChainLlmClient,
} from "../src/briefing.js";

const NOW = new Date("2026-04-11T12:00:00.000Z");

async function makeTempStorage(): Promise<{ dir: string; storage: StorageManager }> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-briefing-chain-"));
  StorageManager.clearAllStaticCaches();
  const storage = new StorageManager(dir);
  await storage.ensureDirectories();
  return { dir, storage };
}

function chainClient(content: string | null): BriefingChainLlmClient {
  return {
    async chatCompletion() {
      return content === null ? null : { content };
    },
  };
}

test("buildChainFollowupGenerator parses plain JSON responses", async () => {
  const generator = buildChainFollowupGenerator(
    chainClient('{"followups": [{"text": "Review the deploy checklist", "rationale": "open commitment"}]}'),
  );
  const followups = await generator({
    sections: {
      activeThreads: [],
      recentEntities: [],
      openCommitments: [],
      suggestedFollowups: [],
    },
    windowLabel: "yesterday",
    maxFollowups: 5,
  });
  assert.equal(followups.length, 1);
  assert.equal(followups[0].text, "Review the deploy checklist");
  assert.equal(followups[0].rationale, "open commitment");
});

test("buildChainFollowupGenerator handles fenced JSON from local models", async () => {
  const generator = buildChainFollowupGenerator(
    chainClient(
      'Here you go:\n```json\n{"followups": [{"text": "Ping the vendor about the renewal"}]}\n```\n',
    ),
  );
  const followups = await generator({
    sections: {
      activeThreads: [],
      recentEntities: [],
      openCommitments: [],
      suggestedFollowups: [],
    },
    windowLabel: "yesterday",
    maxFollowups: 3,
  });
  assert.equal(followups.length, 1);
  assert.equal(followups[0].text, "Ping the vendor about the renewal");
});

test("buildChainFollowupGenerator throws when the chain returns nothing", async () => {
  const generator = buildChainFollowupGenerator(chainClient(null));
  await assert.rejects(
    generator({
      sections: {
        activeThreads: [],
        recentEntities: [],
        openCommitments: [],
        suggestedFollowups: [],
      },
      windowLabel: "yesterday",
      maxFollowups: 3,
    }),
    /LLM chain returned no response/,
  );
});

test("buildChainFollowupGenerator throws when no candidate parses", async () => {
  const generator = buildChainFollowupGenerator(
    chainClient("Sorry, I cannot produce JSON right now."),
  );
  await assert.rejects(
    generator({
      sections: {
        activeThreads: [],
        recentEntities: [],
        openCommitments: [],
        suggestedFollowups: [],
      },
      windowLabel: "yesterday",
      maxFollowups: 3,
    }),
    /no valid followups JSON/,
  );
});

test("buildBriefing uses a chain generator without an OpenAI key", async () => {
  const { dir, storage } = await makeTempStorage();
  try {
    const result = await buildBriefing({
      storage,
      window: parseBriefingWindow("yesterday", NOW)!,
      maxFollowups: 5,
      allowLlm: true,
      // Intentionally no openaiApiKey — the chain generator must carry it.
      followupGenerator: buildChainFollowupGenerator(
        chainClient('{"followups": [{"text": "Follow up with the team"}]}'),
      ),
      now: NOW,
    });

    assert.equal(result.followupsUnavailableReason, undefined);
    assert.equal(result.sections.suggestedFollowups.length, 1);
    assert.equal(result.sections.suggestedFollowups[0].text, "Follow up with the team");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("buildBriefing surfaces chain failures via followupsUnavailableReason", async () => {
  const { dir, storage } = await makeTempStorage();
  try {
    const result = await buildBriefing({
      storage,
      window: parseBriefingWindow("yesterday", NOW)!,
      maxFollowups: 5,
      allowLlm: true,
      followupGenerator: buildChainFollowupGenerator(chainClient(null)),
      now: NOW,
    });

    assert.equal(result.sections.suggestedFollowups.length, 0);
    assert.match(result.followupsUnavailableReason ?? "", /LLM follow-ups failed/);
    assert.match(result.followupsUnavailableReason ?? "", /LLM chain returned no response/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
