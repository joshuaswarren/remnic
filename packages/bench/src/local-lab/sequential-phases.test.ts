import assert from "node:assert/strict";
import test from "node:test";

import { parseLocalLabManifest, type LocalLabManifest } from "./manifest.ts";
import {
  formatHandoffNote,
  LocalLabPreflightError,
  runSequentialPhases,
  type LocalLabPhase,
  type LocalLabPhaseDescriptor,
  type SequentialPhaseHooks,
} from "./sequential-phases.ts";
import type { LocalLabPreflightOptions } from "./preflight.ts";

/**
 * Build a manifest where responder and judge can share or differ on baseUrl.
 * Tests mutate `sameEndpoint` to exercise the hand-off branch.
 */
function manifest(opts: { sameEndpoint?: boolean } = {}): LocalLabManifest {
  const responderUrl = "http://127.0.0.1:8080/v1";
  const judgeUrl = opts.sameEndpoint ? responderUrl : "http://127.0.0.1:11434";
  return parseLocalLabManifest({
    profile: "local-lab",
    responder: {
      provider: "openai-compatible",
      baseUrl: responderUrl,
      model: "qwen3:14b",
      ctx: 16384,
      temperature: 0,
      seed: 1573,
    },
    judge: {
      provider: "ollama",
      baseUrl: judgeUrl,
      model: "gemma3:27b",
      ctx: 16384,
      temperature: 0,
      seed: 1573,
    },
    phases: "sequential",
    notes: {
      responderToJudgeHandoff:
        "stop responder (`Ctrl+C` on llama.cpp), then `ollama serve`",
    },
  });
}

/**
 * Test stub for the preflight pathway. The scheduler forwards
 * `preflightOptions` to the real `preflightLocalLabRole`, which calls the
 * injected `fetchImpl`. The stub responds to every discovery request with the
 * SAME list of model ids — production preflight then matches the manifest's
 * role.model against that list. To force a failure for a specific model,
 * omit it from `modelsOnEndpoint` (the manifest model id won't be found).
 *
 * The stub returns BOTH the OpenAI-compatible shape (`{ data: [...] }`) and
 * the Ollama shape (`{ models: [{ name }] }`) so any provider kind works
 * against the same stub.
 */
interface StubPreflight {
  preflightOptions: LocalLabPreflightOptions;
  seen: Array<{ url: string }>;
}

function makeStubPreflight(modelsOnEndpoint: string[]): StubPreflight {
  const seen: Array<{ url: string }> = [];
  const fetchImpl: typeof fetch = async (input) => {
    const url = typeof input === "string" ? input : input.toString();
    seen.push({ url });
    const body = {
      data: modelsOnEndpoint.map((id) => ({ id })),
      models: modelsOnEndpoint.map((id) => ({ name: id })),
    };
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  return {
    preflightOptions: { fetchImpl, timeoutMs: 1000 },
    seen,
  };
}

test("runSequentialPhases runs phases in input order and returns outcomes in the same order", async () => {
  const m = manifest();
  const order: string[] = [];
  const stub = makeStubPreflight([m.responder.model, m.judge.model]);

  const phases: LocalLabPhase<string>[] = [
    {
      name: "responder",
      role: m.responder,
      execute: async () => {
        order.push("responder");
        return "responder-result";
      },
    },
    {
      name: "judge",
      role: m.judge,
      execute: async () => {
        order.push("judge");
        return "judge-result";
      },
    },
  ];

  const outcomes = await runSequentialPhases(m, phases, {
    preflight: stub.preflightOptions,
  });

  assert.deepEqual(order, ["responder", "judge"], "phases must run in order");
  assert.equal(outcomes.length, 2);
  assert.equal(outcomes[0].phase.name, "responder");
  assert.equal(outcomes[0].result, "responder-result");
  assert.equal(outcomes[1].phase.name, "judge");
  assert.equal(outcomes[1].result, "judge-result");
});

test("runSequentialPhases forwards the resolved role (with temperature/seed) to execute", async () => {
  const m = manifest();
  const stub = makeStubPreflight([m.responder.model]);
  const observed = {
    temperature: undefined as number | undefined,
    seed: undefined as number | undefined,
    provider: undefined as string | undefined,
  };

  const phases: LocalLabPhase[] = [
    {
      name: "responder",
      role: m.responder,
      execute: async (role) => {
        observed.temperature = role.temperature;
        observed.seed = role.seed;
        observed.provider = role.providerConfig.provider;
      },
    },
  ];

  await runSequentialPhases(m, phases, {
    preflight: stub.preflightOptions,
  });

  assert.equal(observed.temperature, 0);
  assert.equal(observed.seed, 1573);
  assert.equal(observed.provider, "local-llm");
});

test("runSequentialPhases emits a hand-off between phases on different endpoints", async () => {
  const m = manifest({ sameEndpoint: false });
  const stub = makeStubPreflight([m.responder.model, m.judge.model]);
  const handoffs: Array<{ from: string; to: string; note: string | undefined }> = [];

  const phases: LocalLabPhase[] = [
    { name: "responder", role: m.responder, execute: async () => undefined },
    { name: "judge", role: m.judge, execute: async () => undefined },
  ];

  await runSequentialPhases(m, phases, {
    preflight: stub.preflightOptions,
    hooks: {
      onPhaseHandoff: (from, to, note) => {
        handoffs.push({ from: from.name, to: to.name, note });
      },
    },
  });

  assert.equal(handoffs.length, 1, "exactly one hand-off between two phases");
  assert.equal(handoffs[0].from, "responder");
  assert.equal(handoffs[0].to, "judge");
  assert.equal(
    handoffs[0].note,
    "stop responder (`Ctrl+C` on llama.cpp), then `ollama serve`",
  );
});

test("runSequentialPhases synthesizes a default hand-off note when the manifest omits it (cursor review: #1573 PR2)", async () => {
  // Build a manifest with NO notes — the hook must still receive a non-undefined
  // synthesized instruction (formatHandoffNote), not undefined.
  const m = parseLocalLabManifest({
    profile: "local-lab",
    responder: {
      provider: "openai-compatible",
      baseUrl: "http://127.0.0.1:8080/v1",
      model: "qwen3:14b",
      ctx: 16384,
      temperature: 0,
      seed: 1573,
    },
    judge: {
      provider: "ollama",
      baseUrl: "http://127.0.0.1:11434",
      model: "gemma3:27b",
      ctx: 16384,
      temperature: 0,
      seed: 1573,
    },
    phases: "sequential",
  });
  const stub = makeStubPreflight([m.responder.model, m.judge.model]);
  const handoffs: Array<{ note: string | undefined }> = [];

  const phases: LocalLabPhase[] = [
    { name: "responder", role: m.responder, execute: async () => undefined },
    { name: "judge", role: m.judge, execute: async () => undefined },
  ];

  await runSequentialPhases(m, phases, {
    preflight: stub.preflightOptions,
    hooks: {
      onPhaseHandoff: (_from, _to, note) => {
        handoffs.push({ note });
      },
    },
  });

  assert.equal(handoffs.length, 1);
  assert.ok(
    typeof handoffs[0].note === "string" && handoffs[0].note!.length > 0,
    "hook must receive a non-empty synthesized note, not undefined",
  );
  assert.match(
    handoffs[0].note!,
    /stop responder endpoint, start judge endpoint/,
    "synthesized note names both phases",
  );
});

test("runSequentialPhases suppresses the hand-off when both phases share an endpoint (Ollama hot-swap)", async () => {
  const m = manifest({ sameEndpoint: true });
  const stub = makeStubPreflight([m.responder.model, m.judge.model]);
  const handoffs: unknown[] = [];

  const phases: LocalLabPhase[] = [
    { name: "responder", role: m.responder, execute: async () => undefined },
    { name: "judge", role: m.judge, execute: async () => undefined },
  ];

  await runSequentialPhases(m, phases, {
    preflight: stub.preflightOptions,
    hooks: {
      onPhaseHandoff: () => {
        handoffs.push("fired");
      },
    },
  });

  assert.equal(handoffs.length, 0, "no hand-off when endpoints match");
});

test("runSequentialPhases does NOT emit a hand-off before the first phase", async () => {
  const m = manifest();
  const stub = makeStubPreflight([m.responder.model]);
  const handoffs: unknown[] = [];

  const phases: LocalLabPhase[] = [
    { name: "responder", role: m.responder, execute: async () => undefined },
  ];

  await runSequentialPhases(m, phases, {
    preflight: stub.preflightOptions,
    hooks: {
      onPhaseHandoff: () => {
        handoffs.push("fired");
      },
    },
  });

  assert.equal(handoffs.length, 0);
});

test("runSequentialPhases emits the hand-off BEFORE the next phase's preflight (cursor review: #1573 PR2)", async () => {
  // Regression: the hand-off must fire before the judge preflight so the
  // operator sees the swap guidance even when the judge endpoint is not yet
  // serving the manifest model. Previously preflight ran first and threw
  // LocalLabPreflightError before the hand-off callback ever fired — so
  // handoffs.length would be 0. Asserting handoffs.length === 1 here proves
  // the hand-off preceded the (failing) judge preflight.
  const m = manifest({ sameEndpoint: false });
  // Judge model deliberately absent from the endpoint → judge preflight fails.
  const stub = makeStubPreflight([m.responder.model]);
  const handoffs: Array<{ from: string; to: string }> = [];

  const phases: LocalLabPhase[] = [
    { name: "responder", role: m.responder, execute: async () => undefined },
    { name: "judge", role: m.judge, execute: async () => undefined },
  ];

  await assert.rejects(
    runSequentialPhases(m, phases, {
      preflight: stub.preflightOptions,
      hooks: {
        onPhaseHandoff: (from, to) => {
          handoffs.push({ from: from.name, to: to.name });
        },
      },
    }),
    (e: unknown) => e instanceof LocalLabPreflightError,
  );

  // The hand-off fired before the judge preflight attempted + threw. Before
  // the fix this would be 0 (preflight threw first, hand-off never reached).
  assert.equal(handoffs.length, 1, "hand-off must fire before the failing judge preflight");
  assert.equal(handoffs[0].from, "responder");
  assert.equal(handoffs[0].to, "judge");
  // Only the responder endpoint was probed (1 fetch); the judge preflight
  // ran second and failed, but the hand-off preceded it.
  assert.equal(stub.seen.length, 2, "both endpoints probed (responder pass, judge fail)");
});

test("runSequentialPhases hard-rejects when a phase preflight fails (no silent fallback)", async () => {
  const m = manifest();
  // Respondent's model is missing from the endpoint → its preflight fails.
  // Judge's model is present, but the scheduler must abort at responder first.
  const stub = makeStubPreflight([m.judge.model]);
  const executed: string[] = [];

  const phases: LocalLabPhase[] = [
    {
      name: "responder",
      role: m.responder,
      execute: async () => {
        executed.push("responder");
      },
    },
    {
      name: "judge",
      role: m.judge,
      execute: async () => {
        executed.push("judge");
      },
    },
  ];

  // assert.rejects returns void — capture the rejection inside the matcher
  // so the assertions there can use the typed error directly. If the matcher
  // throws, assert.rejects surfaces the assertion failure to the test.
  await assert.rejects(
    runSequentialPhases(m, phases, {
      preflight: stub.preflightOptions,
    }),
    (e: unknown) => {
      assert.ok(e instanceof LocalLabPreflightError, "must be a LocalLabPreflightError");
      assert.equal(e.phase.name, "responder");
      assert.equal(e.phaseIndex, 0);
      assert.equal(e.preflight.ok, false);
      // The failing result carries the foundModels so the operator sees
      // what the endpoint reported (rule 51). The judge model is present
      // but the responder model is not.
      assert.equal(e.preflight.foundModels.length, 1);
      assert.equal(e.preflight.foundModels[0].id, m.judge.model);
      assert.match(e.preflight.reason, /did not report the manifest model/);
      assert.match(e.preflight.reason, new RegExp(m.responder.model));
      return true;
    },
  );

  // Subsequent phase must not have executed — preflight is a hard gate.
  assert.deepEqual(executed, [], "failing preflight must abort before execute");
});

test("runSequentialPhases invokes preflight for each phase in order before any execute", async () => {
  const m = manifest();
  const stub = makeStubPreflight([m.responder.model, m.judge.model]);
  const executeOrder: string[] = [];

  const phases: LocalLabPhase[] = [
    {
      name: "responder",
      role: m.responder,
      execute: async () => {
        executeOrder.push("responder");
      },
    },
    {
      name: "judge",
      role: m.judge,
      execute: async () => {
        executeOrder.push("judge");
      },
    },
  ];

  await runSequentialPhases(m, phases, {
    preflight: stub.preflightOptions,
  });

  // Each phase's role produced exactly one preflight call.
  assert.equal(stub.seen.length, 2);
  assert.match(stub.seen[0].url, /\/v1\/models$/, "responder uses openai-compatible /v1/models");
  assert.match(stub.seen[1].url, /\/api\/tags$/, "judge uses ollama /api/tags");
  assert.deepEqual(executeOrder, ["responder", "judge"]);
});

test("runSequentialPhases fires onPhasePreflight / onPhaseStart / onPhaseComplete in order", async () => {
  const m = manifest();
  const stub = makeStubPreflight([m.responder.model, m.judge.model]);
  const events: string[] = [];

  const phases: LocalLabPhase[] = [
    { name: "responder", role: m.responder, execute: async () => "r" },
    { name: "judge", role: m.judge, execute: async () => "j" },
  ];

  await runSequentialPhases(m, phases, {
    preflight: stub.preflightOptions,
    hooks: {
      onPhasePreflight: () => events.push("preflight"),
      onPhaseStart: () => events.push("start"),
      onPhaseComplete: () => events.push("complete"),
    },
  });

  assert.deepEqual(
    events,
    ["preflight", "start", "complete", "preflight", "start", "complete"],
  );
});

test("runSequentialPhases handles an empty phase list as a no-op", async () => {
  const m = manifest();
  const stub = makeStubPreflight([]);
  const outcomes = await runSequentialPhases(m, [], {
    preflight: stub.preflightOptions,
  });
  assert.deepEqual(outcomes, []);
});

test("formatHandoffNote prefers the manifest note when authored", () => {
  const from: LocalLabPhaseDescriptor = {
    name: "responder",
    role: {
      provider: "openai-compatible",
      baseUrl: "http://a/v1",
      model: "r",
      ctx: 1,
      temperature: 0,
      seed: 1,
    },
  };
  const to: LocalLabPhaseDescriptor = {
    name: "judge",
    role: {
      provider: "ollama",
      baseUrl: "http://b",
      model: "j",
      ctx: 1,
      temperature: 0,
      seed: 1,
    },
  };
  assert.equal(
    formatHandoffNote(from, to, "operator-authored note"),
    "operator-authored note",
  );
  // Whitespace-only note falls through to the synthesized default.
  assert.match(
    formatHandoffNote(from, to, "   "),
    /^stop responder endpoint, start judge endpoint at http:\/\/b serving model j/,
  );
  assert.match(
    formatHandoffNote(from, to, undefined),
    /^stop responder endpoint, start judge endpoint at http:\/\/b serving model j/,
  );
});
