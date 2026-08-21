import test from "node:test";
import assert from "node:assert/strict";
import {
  hasBroadGraphIntent,
  inferIntentFromText,
  isTaskInitiationIntent,
  planRecallMode,
} from "../src/intent.ts";

test("planRecallMode keeps acknowledgements in no_recall", () => {
  assert.equal(planRecallMode("ok"), "no_recall");
  assert.equal(planRecallMode("thanks"), "no_recall");
  assert.equal(planRecallMode("ok."), "no_recall");
  assert.equal(planRecallMode("thanks!"), "no_recall");
  assert.equal(planRecallMode("ok,"), "no_recall");
  assert.equal(planRecallMode("thanks:"), "no_recall");
  assert.equal(planRecallMode("got it :)"), "no_recall");
});

test("planRecallMode uses graph_mode for timeline/history prompts", () => {
  assert.equal(planRecallMode("what happened in the timeline"), "graph_mode");
});

test("planRecallMode treats Japanese acknowledgements as no_recall", () => {
  assert.equal(planRecallMode("はい"), "no_recall");
  assert.equal(planRecallMode("わかった"), "no_recall");
});

test("planRecallMode matches Japanese timeline prompts to the English mode", () => {
  assert.equal(planRecallMode("what happened in the timeline"), "graph_mode");
  assert.equal(planRecallMode("タイムラインで何があった"), "graph_mode");
});

test("hasBroadGraphIntent matches expanded causal phrasing", () => {
  assert.equal(hasBroadGraphIntent("What changed in our recall pipeline?"), true);
  assert.equal(hasBroadGraphIntent("How did we get here with QMD failures?"), true);
  assert.equal(hasBroadGraphIntent("Give me a normal status update"), false);
});

test("planRecallMode defaults non-ack prompts to full recall", () => {
  assert.equal(planRecallMode("Summarize last week's key points"), "full");
  assert.equal(planRecallMode("What decisions did we make about the API?"), "full");
});

test("planRecallMode returns minimal for short operational directives", () => {
  assert.equal(planRecallMode("Check gateway status"), "minimal");
  assert.equal(planRecallMode("Reload the gateway"), "minimal");
});

test("inferIntentFromText matches common verb conjugations", () => {
  const inferred = inferIntentFromText("We reviewed and fixed the deploy failures");
  assert.equal(inferred.goal, "stabilize");
  assert.equal(inferred.actionType, "review");
  assert.equal(inferred.entityTypes.includes("repo"), false);
});

test("inferIntentFromText detects decide/plan conjugations", () => {
  const inferred = inferIntentFromText("We decided on planning changes to the roadmap");
  assert.equal(inferred.actionType, "plan");
  assert.equal(inferred.goal, "plan");
});

test("inferIntentFromText recognizes decision/chose variants for decide action", () => {
  const fromDecision = inferIntentFromText("Final decision: choose the safer rollout");
  assert.equal(fromDecision.actionType, "decide");

  const fromChose = inferIntentFromText("We chose this approach for rollout");
  assert.equal(fromChose.actionType, "decide");
});

test("inferIntentFromText recognizes built as execute action", () => {
  const inferred = inferIntentFromText("We built the channel-specific recall patch yesterday");
  assert.equal(inferred.actionType, "execute");
});

test("inferIntentFromText recognizes summarize/recap conjugations", () => {
  const summarized = inferIntentFromText("She summarized the outage notes");
  assert.equal(summarized.actionType, "summarize");

  const recapped = inferIntentFromText("We recapped the timeline at standup");
  assert.equal(recapped.actionType, "summarize");
});

test("inferIntentFromText sets taskInitiation for ship/deploy/run tests phrasing", () => {
  const deploy = inferIntentFromText("Let's deploy the gateway to production");
  assert.equal(deploy.taskInitiation, true);
  assert.equal(isTaskInitiationIntent(deploy), true);

  const vague = inferIntentFromText("What is deployment?");
  assert.ok(vague.taskInitiation !== true);
  assert.equal(isTaskInitiationIntent(vague), false);
});

test("inferIntentFromText taskInitiation matches broken-build phrasing (issue #519 bench)", () => {
  const fixBuild = inferIntentFromText("Fixing the broken build on main");
  assert.equal(fixBuild.taskInitiation, true);
});

test("inferIntentFromText does not treat conversational let's as task initiation", () => {
  const discuss = inferIntentFromText("Let's discuss the roadmap tomorrow");
  assert.equal(discuss.taskInitiation, false);
});

test("runtime guards tolerate nullish/non-string inputs", () => {
  assert.doesNotThrow(() => planRecallMode(undefined as unknown as string));
  assert.doesNotThrow(() => planRecallMode(null as unknown as string));
  assert.equal(planRecallMode(undefined as unknown as string), "no_recall");
  assert.equal(planRecallMode(null as unknown as string), "no_recall");

  assert.doesNotThrow(() => inferIntentFromText(undefined as unknown as string));
  assert.doesNotThrow(() => inferIntentFromText(null as unknown as string));
  assert.equal(inferIntentFromText(undefined as unknown as string).goal, "unknown");
  assert.equal(inferIntentFromText(null as unknown as string).actionType, "unknown");
});
