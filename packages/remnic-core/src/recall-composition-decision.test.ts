import assert from "node:assert/strict";
import test from "node:test";

import { abortError } from "./abort-error.js";
import {
  compactRecallContextFromBuckets,
  decideRecallContextComposition,
  notifyContextComposition,
  recallFailureComposition,
} from "./recall-composition-decision.js";

test("#2972 healthy recall composition carries no degradation marker", () => {
  const { composition, truncated } = decideRecallContextComposition({
    context: "A remembered deployment decision.",
    maxChars: 512,
  });

  assert.equal("degradation" in composition, false);
  assert.equal(truncated, false);
  assert.ok(!JSON.stringify(composition).includes("degradation"));
});

test("#2972 empty recall stays marker-free", () => {
  const { composition, context } = decideRecallContextComposition({
    context: "",
    maxChars: 512,
  });

  assert.equal(context, "");
  assert.equal("degradation" in composition, false);
});

test("#2972 compact form from section buckets is preferred over clipping", () => {
  const longOne = "full-form entry one with a long body ".repeat(6).trim();
  const longTwo = "full-form entry two with a long body ".repeat(6).trim();
  const buckets = new Map<string, Array<string | { content: string }>>([
    [
      "memories",
      [
        "## Relevant Memories",
        { content: `[1] notes/one.md (score: 0.900)\n${longOne}` },
        { content: `[2] notes/two.md (score: 0.800)\n${longTwo}` },
      ],
    ],
  ]);
  const compactContext = compactRecallContextFromBuckets(buckets);
  assert.equal(
    compactContext,
    "## Relevant Memories\n[1] notes/one.md (score: 0.900)\n[2] notes/two.md (score: 0.800)",
  );

  const fullContext = `[1] notes/one.md (score: 0.900)\n${longOne}\n\n[2] notes/two.md (score: 0.800)\n${longTwo}`;
  assert.ok(fullContext.length > compactContext.length);
  assert.ok(compactContext.length <= 90);

  const { composition, truncated } = decideRecallContextComposition({
    context: fullContext,
    compactContext,
    maxChars: 90,
  });

  assert.equal(composition.context, compactContext);
  assert.equal(composition.degradation?.state, "degraded");
  assert.equal(composition.degradation?.reason, "budget-compacted");
  assert.equal(truncated, true);
});

test("#2972 whitespace-only context stays marker-free", () => {
  const { composition, context, truncated } = decideRecallContextComposition({
    context: "   ",
    maxChars: 512,
  });

  assert.equal(context, "");
  assert.equal("degradation" in composition, false);
  assert.equal(truncated, false);
});

test("#2972 recall failure composition is missing, abort stays silent", () => {
  const timeout = recallFailureComposition(new Error("recall timeout"));
  assert.equal(timeout?.degradation?.state, "missing");
  assert.equal(timeout?.degradation?.reason, "backend-unavailable");
  assert.equal(timeout?.degradation?.detail, "timeout");
  assert.match(timeout?.context ?? "", /memory context unavailable/i);

  const failed = recallFailureComposition(new Error("qmd exploded"));
  assert.equal(failed?.degradation?.detail, "recall_failed");

  assert.equal(recallFailureComposition(abortError("recall aborted")), null);
});

test("#2972 composition observer is fail-open", async () => {
  const seen: unknown[] = [];
  notifyContextComposition(
    (composition) => {
      seen.push(composition.context);
    },
    { context: "ok" },
    () => {
      throw new Error("onError must not run on success");
    },
  );
  assert.deepEqual(seen, ["ok"]);

  const errors: unknown[] = [];
  notifyContextComposition(
    () => {
      throw new Error("observer boom");
    },
    { context: "ok" },
    (err) => {
      errors.push(err);
    },
  );
  assert.equal(errors.length, 1);

  await new Promise<void>((resolve, reject) => {
    notifyContextComposition(
      async () => {
        throw new Error("async boom");
      },
      { context: "ok" },
      (err) => {
        try {
          assert.equal((err as Error).message, "async boom");
          resolve();
        } catch (caught) {
          reject(caught);
        }
      },
    );
  });
});

