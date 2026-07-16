import assert from "node:assert/strict";
import test from "node:test";

import {
  buildEvidencePack,
  type EvidencePackSelectionReceipt,
} from "./evidence-pack.js";

test("buildEvidencePack deduplicates evidence and stays within budget", () => {
  const pack = buildEvidencePack(
    [
      {
        sessionId: "s1",
        turnIndex: 1,
        role: "assistant",
        content: "The project deadline is Friday.",
      },
      {
        sessionId: "s1",
        turnIndex: 1,
        role: "assistant",
        content: "The project deadline is Friday.",
      },
      {
        sessionId: "s1",
        turnIndex: 2,
        role: "user",
        content: "Please remind me about the Friday deadline.",
      },
    ],
    { title: "Search evidence", maxChars: 180, maxItemChars: 80 },
  );

  assert.ok(pack.length <= 180);
  assert.match(pack, /^## Search evidence/);
  assert.equal(
    pack.match(/The project deadline is Friday\./g)?.length,
    1,
  );
  assert.match(pack, /\[s1, turn 2, user\]/);
});

test("buildEvidencePack returns empty text when no useful evidence fits", () => {
  assert.equal(
    buildEvidencePack(
      [{ sessionId: "s1", turnIndex: 1, role: "user", content: "   " }],
      { maxChars: 100 },
    ),
    "",
  );
  assert.equal(
    buildEvidencePack(
      [{ sessionId: "s1", turnIndex: 1, role: "user", content: "hello" }],
      { maxChars: 0 },
    ),
    "",
  );
});

test("buildEvidencePack keeps query-focused evidence from later long turns", () => {
  const content = [
    "BEAM turn anchors: chat_id=2; source_chat_id=2",
    "Sure, let's break it down for my budget tracker project.",
    "### Components:",
    "1. User Authentication",
    "2. Transaction Management",
    "3. Basic Analytics",
    "4. Deployment",
    "### Milestones:",
    "- Nov 1 - Nov 15, 2023: Initial setup",
    "- Nov 16 - Dec 15, 2023: Authentication",
    "- Dec 16, 2023 - Jan 15, 2024: Develop transaction management features",
    "- Jan 16 - Feb 15, 2024: Analytics",
    "- Feb 16 - Mar 15, 2024: Final adjustments, testing, and deployment",
  ].join("\n");

  const pack = buildEvidencePack(
    [{ sessionId: "beam", turnIndex: 3, role: "user", content }],
    {
      title: "Explicit Cue Evidence",
      maxChars: 520,
      maxItemChars: 260,
      query:
        "How many weeks do I have between finishing the transaction management features and the final deployment deadline?",
    },
  );

  assert.ok(pack.length <= 520);
  assert.match(pack, /source_chat_id=2/);
  assert.match(pack, /Dec 16, 2023 - Jan 15, 2024/);
  assert.match(pack, /Feb 16 - Mar 15, 2024/);
});

test("buildEvidencePack reports only appended blocks with exact content-free offsets", () => {
  const receipts: EvidencePackSelectionReceipt[] = [];
  const items = [
    {
      id: "selected",
      archiveRowId: 41,
      sessionId: "private-session",
      turnIndex: 7,
      role: "user",
      content: "selected private evidence",
      score: 2,
    },
    {
      id: "duplicate-content",
      archiveRowId: 42,
      sessionId: "private-session",
      turnIndex: 8,
      role: "assistant",
      content: "selected private evidence",
      score: 1,
    },
    {
      id: "budget-rejected",
      archiveRowId: 43,
      sessionId: "private-session",
      turnIndex: 9,
      role: "assistant",
      content: "this block cannot fit inside the remaining budget",
    },
  ];
  const options = {
    title: "Receipt evidence",
    maxChars:
      "## Receipt evidence".length +
      2 +
      "[private-session, turn 7, user, score 2.000]: selected private evidence".length,
    maxItemChars: 200,
  };

  const baseline = buildEvidencePack(items, options);
  const traced = buildEvidencePack(items, {
    ...options,
    onSelection: (receipt) => receipts.push(receipt),
  });

  assert.equal(traced, baseline);
  assert.equal(receipts.length, 1);
  const receipt = receipts[0]!;
  assert.equal(
    traced.slice(receipt.blockStart, receipt.blockEnd),
    "[private-session, turn 7, user, score 2.000]: selected private evidence",
  );
  assert.deepEqual(receipt.item, {
    archiveRowId: 41,
    turnIndex: 7,
    role: "user",
    score: 2,
  });
  assert.equal("content" in receipt.item, false);
  assert.equal("sessionId" in receipt.item, false);
});
