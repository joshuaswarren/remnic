import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ControlledResponsesDriver,
  createControlledResponsesAgentDriver,
  type ControlledResponsesTransport,
  type ControlledResponsesToolDefinition,
  type RepeatedFailureLocalToolHost,
  type ResponsesApiRequest,
  type ResponsesApiResponse,
} from "./repeated-failure-responses-driver.js";

const MODEL = "test-profile-model";

const TOOL: ControlledResponsesToolDefinition = {
  name: "run_command",
  description: "Run an offline command in the fixture repository.",
  gateEligible: true,
  inputSchema: {
    type: "object",
    properties: {
      command: { type: "string" },
      timeoutMs: { type: "integer" },
    },
    required: ["command", "timeoutMs"],
    additionalProperties: false,
  },
};

const READ_TOOL: ControlledResponsesToolDefinition = {
  name: "read_file",
  description: "Read one repository-relative file.",
  gateEligible: false,
  inputSchema: {
    type: "object",
    properties: { path: { type: "string" } },
    required: ["path"],
    additionalProperties: false,
  },
};

interface FakeTransport {
  transport: ControlledResponsesTransport;
  requests: ResponsesApiRequest[];
  options: Array<{ maxAttempts?: number; timeoutMs?: number; signal?: AbortSignal }>;
  urls: string[];
  authorizations: Array<string | null>;
}

function response(
  id: string,
  output: ResponsesApiResponse["output"],
  usage: ResponsesApiResponse["usage"] = {
    input_tokens: 10,
    output_tokens: 4,
    total_tokens: 14,
    input_tokens_details: { cached_tokens: 3 },
    output_tokens_details: { reasoning_tokens: 2 },
  },
): ResponsesApiResponse {
  return {
    id,
    model: MODEL,
    status: "completed",
    output,
    usage,
  };
}

function call(callId: string, args: Record<string, unknown> = { command: "npm test", timeoutMs: 1000 }) {
  return {
    type: "function_call" as const,
    id: `item-${callId}`,
    call_id: callId,
    name: TOOL.name,
    arguments: JSON.stringify(args),
    status: "completed",
  };
}

function message(text: string) {
  return {
    type: "message" as const,
    id: `msg-${text}`,
    role: "assistant" as const,
    status: "completed",
    content: [{ type: "output_text" as const, text }],
  };
}

function reasoning(id: string) {
  return {
    type: "reasoning" as const,
    id,
    summary: [{ type: "summary_text" as const, text: "private chain summary" }],
    encrypted_content: "opaque-reasoning-state",
  };
}

function fakeTransport(responses: readonly ResponsesApiResponse[]): FakeTransport {
  const requests: ResponsesApiRequest[] = [];
  const options: FakeTransport["options"] = [];
  const urls: string[] = [];
  const authorizations: Array<string | null> = [];
  let index = 0;
  return {
    requests,
    options,
    urls,
    authorizations,
    transport: async (url, init, retryOptions) => {
      requests.push(JSON.parse(String(init.body)) as ResponsesApiRequest);
      options.push({
        maxAttempts: retryOptions.maxAttempts,
        timeoutMs: retryOptions.timeoutMs,
        signal: init.signal as AbortSignal | undefined,
      });
      urls.push(url);
      authorizations.push(new Headers(init.headers).get("authorization"));
      const next = responses[index++];
      if (!next) throw new Error("unexpected request");
      return new Response(JSON.stringify(next), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  };
}

function host(
  executed: string[],
  tools: readonly ControlledResponsesToolDefinition[] = [TOOL],
): RepeatedFailureLocalToolHost {
  return {
    tools,
    async execute(action) {
      executed.push(action.callId);
      return {
        status: "completed",
        output: { exitCode: 0, stdout: "ok", stderr: "" },
      };
    },
    async captureFinalEvidence() {
      return {
        repoHash: "repo-sha256",
        checkResult: "FIXED",
        changedFiles: ["src/cache.ts"],
      };
    },
  };
}

function createDriver(
  responses: readonly ResponsesApiResponse[],
  gateStatus: "NO_MATCH" | "MATCH_WARN" | "ERROR_FAIL_OPEN",
  executed: string[] = [],
) {
  const fake = fakeTransport(responses);
  let evaluations = 0;
  const driver = new ControlledResponsesDriver({
    model: MODEL,
    apiKey: "test-secret-never-recorded",
    transport: fake.transport,
    toolHost: host(executed),
    evaluator: {
      async evaluate() {
        evaluations += 1;
        return {
          status: gateStatus,
          fingerprintHash: "gate-fingerprint",
          ...(gateStatus === "MATCH_WARN"
            ? { advisoryText: "This action matches a prior failure. Reconsider before acting." }
            : {}),
          ...(gateStatus === "ERROR_FAIL_OPEN" ? { faultCode: "STORE_UNREADABLE" } : {}),
        };
      },
    },
  });
  return { driver, fake, executed, evaluations: () => evaluations };
}

const BASE_RUN = {
  prompt: "Fix the failing offline fixture.",
  caps: {
    maxTurns: 6,
    maxToolCalls: 4,
    maxTotalTokens: 1000,
    maxDurationMs: 10_000,
    requestTimeoutMs: 1000,
  },
} as const;

test("NO_MATCH executes the pending action and records normalized evidence", async () => {
  const executed: string[] = [];
  const setup = createDriver(
    [response("resp-1", [reasoning("reason-1"), call("call-1")]), response("resp-2", [message("done")])],
    "NO_MATCH",
    executed,
  );

  const result = await setup.driver.runEpisode(BASE_RUN);

  assert.deepEqual(executed, ["call-1"]);
  assert.equal(setup.evaluations(), 1);
  assert.equal(result.status, "COMPLETED");
  assert.equal(result.disposition, "EXECUTED");
  assert.equal(result.originalCallId, undefined);
  assert.equal(result.replacementCallId, undefined);
  assert.equal(result.responses[0]?.status, "completed");
  assert.equal(result.responses[0]?.model, MODEL);
  assert.deepEqual(result.finalRepoEvidence, {
    repoHash: "repo-sha256",
    checkResult: "FIXED",
    changedFiles: ["src/cache.ts"],
  });
  assert.equal(JSON.stringify(result).includes("private chain summary"), false);
  assert.equal(JSON.stringify(result).includes("test-secret-never-recorded"), false);
  assert.equal(setup.fake.urls[0], "https://api.openai.com/v1/responses");
  assert.equal(setup.fake.authorizations[0], "Bearer test-secret-never-recorded");
});

test("gate checks each eligible proposal until warning and records that call as original", async () => {
  const fake = fakeTransport([
    response("resp-1", [call("first-action", { command: "npm test", timeoutMs: 1000 })]),
    response("resp-2", [call("warned-action", { command: "npm run fix", timeoutMs: 1000 })]),
    response("resp-3", [call("replacement", { command: "npm run fix", timeoutMs: 1000 })]),
    response("resp-4", [message("done")]),
  ]);
  const executed: string[] = [];
  const decisions = ["NO_MATCH", "MATCH_WARN"] as const;
  let evaluations = 0;
  const driver = new ControlledResponsesDriver({
    model: MODEL,
    transport: fake.transport,
    toolHost: host(executed),
    evaluator: {
      async evaluate() {
        const status = decisions[evaluations++] ?? "NO_MATCH";
        return {
          status,
          fingerprintHash: `gate-${evaluations}`,
          ...(status === "MATCH_WARN" ? { advisoryText: "Reconsider this action." } : {}),
        };
      },
    },
  });

  const result = await driver.runEpisode(BASE_RUN);

  assert.deepEqual(executed, ["first-action", "replacement"]);
  assert.equal(evaluations, 2);
  assert.equal(result.originalCallId, "warned-action");
  assert.equal(result.replacementCallId, "replacement");
  assert.equal(result.disposition, "RESUBMITTED");
  assert.deepEqual(result.gateEvents.map((event) => event.status), ["NO_MATCH", "MATCH_WARN"]);
});

test("noneligible tools neither invoke the gate nor consume post-warning replacement", async () => {
  const readBefore = {
    ...call("read-before", { path: "src/cache.ts" }),
    name: READ_TOOL.name,
  };
  const readAfter = {
    ...call("read-after", { path: "src/cache.ts" }),
    name: READ_TOOL.name,
  };
  const fake = fakeTransport([
    response("resp-1", [readBefore]),
    response("resp-2", [call("warned-action")]),
    response("resp-3", [readAfter]),
    response("resp-4", [call("replacement")]),
    response("resp-5", [message("done")]),
  ]);
  const executed: string[] = [];
  let evaluations = 0;
  const driver = new ControlledResponsesDriver({
    model: MODEL,
    transport: fake.transport,
    toolHost: host(executed, [READ_TOOL, TOOL]),
    evaluator: {
      async evaluate() {
        evaluations += 1;
        return {
          status: "MATCH_WARN",
          fingerprintHash: "gate-warning",
          advisoryText: "Reconsider this action.",
        };
      },
    },
  });

  const result = await driver.runEpisode(BASE_RUN);

  assert.deepEqual(executed, ["read-before", "read-after", "replacement"]);
  assert.equal(evaluations, 1);
  assert.equal(result.originalCallId, "warned-action");
  assert.equal(result.replacementCallId, "replacement");
  assert.equal(result.disposition, "RESUBMITTED");
});

test("noneligible-only episodes keep disposition NONE and never invoke the gate", async () => {
  const readOnlyCall = {
    ...call("read-only", { path: "src/cache.ts" }),
    name: READ_TOOL.name,
  };
  const fake = fakeTransport([
    response("resp-1", [readOnlyCall]),
    response("resp-2", [message("done")]),
  ]);
  const executed: string[] = [];
  let evaluations = 0;
  const driver = new ControlledResponsesDriver({
    model: MODEL,
    transport: fake.transport,
    toolHost: host(executed, [READ_TOOL]),
    evaluator: {
      async evaluate() {
        evaluations += 1;
        return { status: "MATCH_WARN", fingerprintHash: "unexpected" };
      },
    },
  });

  const result = await driver.runEpisode(BASE_RUN);

  assert.deepEqual(executed, ["read-only"]);
  assert.equal(evaluations, 0);
  assert.equal(result.disposition, "NONE");
  assert.deepEqual(result.gateEvents, []);
});

test("agent-driver factory validates profile identity and forwards run controls", async () => {
  assert.throws(
    () =>
      createControlledResponsesAgentDriver({
        model: MODEL,
        modelProfileId: "",
        modelProfileHash: "a".repeat(64),
        transport: fakeTransport([]).transport,
      }),
    /modelProfileId/i,
  );

  const fake = fakeTransport([
    response("resp-1", [call("call-1")]),
    response("resp-2", [message("done")]),
  ]);
  const driver = createControlledResponsesAgentDriver({
    model: MODEL,
    modelProfileId: "profile-a",
    modelProfileHash: "a".repeat(64),
    seedCapability: { kind: "request_parameter", requestField: "seed" },
    baseUrl: "http://localhost:11434/v1",
    maxOutputTokens: 64,
    temperature: 0,
    reasoningEffort: "high",
    transport: fake.transport,
  });
  const identity = {
    suiteVersion: "suite-v1",
    taskId: "task-1",
    variantId: "variant-1",
    modelProfileId: "profile-a",
    modelProfileHash: "a".repeat(64),
    seed: 1,
    arm: "PRE_ACTION_FAILURE" as const,
  };
  const result = await driver.runEpisode({
    identity,
    prompt: BASE_RUN.prompt,
    caps: { ...BASE_RUN.caps, requestTimeoutMs: 17 },
    toolHost: host([]),
    evaluator: { evaluate: async () => ({ status: "NO_MATCH", fingerprintHash: "unused" }) },
  });

  assert.equal(driver.modelProfileId, "profile-a");
  assert.equal(driver.modelProfileHash, "a".repeat(64));
  assert.equal(result.status, "COMPLETED");
  assert.equal(fake.options[0]?.timeoutMs, 17);
  assert.equal(fake.requests[0]?.max_output_tokens, 64);
  assert.deepEqual(fake.requests.map((request) => request.seed), [identity.seed, identity.seed]);
  assert.equal(fake.requests[0]?.temperature, 0);
  assert.deepEqual(fake.requests[0]?.reasoning, { effort: "high" });

  const controller = new AbortController();
  controller.abort();
  const aborted = await driver.runEpisode({
    identity,
    prompt: BASE_RUN.prompt,
    caps: BASE_RUN.caps,
    toolHost: host([]),
    evaluator: { evaluate: async () => ({ status: "NO_MATCH", fingerprintHash: "unused" }) },
    signal: controller.signal,
  });
  assert.equal(aborted.invalidReason, "ABORTED");
});

test("agent-driver factory refuses profiles without registered seed capability", () => {
  assert.throws(
    () => createControlledResponsesAgentDriver({
      model: MODEL,
      modelProfileId: "unseeded-profile",
      modelProfileHash: "b".repeat(64),
      transport: fakeTransport([]).transport,
    }),
    /requires registered seed capability/i,
  );
});

test("official Responses endpoint cannot claim unsupported seed control", () => {
  assert.throws(
    () => createControlledResponsesAgentDriver({
      model: MODEL,
      modelProfileId: "official-profile",
      modelProfileHash: "c".repeat(64),
      seedCapability: { kind: "request_parameter", requestField: "seed" },
      transport: fakeTransport([]).transport,
    }),
    /official Responses endpoint does not support registered seed control/i,
  );
});

test("ERROR_FAIL_OPEN records the gate fault and executes", async () => {
  const setup = createDriver(
    [response("resp-1", [call("call-1")]), response("resp-2", [message("done")])],
    "ERROR_FAIL_OPEN",
  );

  const result = await setup.driver.runEpisode(BASE_RUN);

  assert.deepEqual(setup.executed, ["call-1"]);
  assert.equal(result.gate?.status, "ERROR_FAIL_OPEN");
  assert.equal(result.gate?.faultCode, "STORE_UNREADABLE");
  assert.equal(result.faults.length, 0);
});

test("a throwing evaluator fails open and the action still executes", async () => {
  const fake = fakeTransport([
    response("resp-1", [call("call-1")]),
    response("resp-2", [message("done")]),
  ]);
  const executed: string[] = [];
  const driver = new ControlledResponsesDriver({
    model: MODEL,
    transport: fake.transport,
    toolHost: host(executed),
    evaluator: {
      async evaluate() {
        throw new Error("private evaluator detail");
      },
    },
  });

  const result = await driver.runEpisode(BASE_RUN);

  assert.deepEqual(executed, ["call-1"]);
  assert.equal(result.status, "COMPLETED");
  assert.equal(result.gate?.status, "ERROR_FAIL_OPEN");
  assert.equal(result.gate?.faultCode, "EVALUATOR_ERROR");
  assert.equal(JSON.stringify(result).includes("private evaluator detail"), false);
});

test("gate wait expiry is exposed even though evaluation fails open and execution continues", async () => {
  const fake = fakeTransport([
    response("resp-1", [call("call-1")]),
    response("resp-2", [message("done")]),
  ]);
  const executed: string[] = [];
  const driver = new ControlledResponsesDriver({
    model: MODEL,
    gateWaitTimeoutMs: 5,
    transport: fake.transport,
    toolHost: host(executed),
    evaluator: {
      evaluate(_action, context) {
        const { promise, resolve } = Promise.withResolvers<{
          status: "ERROR_FAIL_OPEN";
          fingerprintHash: string;
        }>();
        context.signal.addEventListener("abort", () => {
          resolve({ status: "ERROR_FAIL_OPEN", fingerprintHash: "late" });
        }, { once: true });
        return promise;
      },
    },
  });

  const result = await driver.runEpisode(BASE_RUN);

  assert.deepEqual(executed, ["call-1"]);
  assert.equal(result.status, "COMPLETED");
  assert.equal(result.gate?.status, "ERROR_FAIL_OPEN");
  assert.equal(result.gate?.faultCode, "GATE_WAIT_EXPIRED");
});

test("production gate advisory timeout is normalized as wait expiry", async () => {
  const fake = fakeTransport([
    response("resp-1", [call("call-1")]),
    response("resp-2", [message("done")]),
  ]);
  const executed: string[] = [];
  const driver = new ControlledResponsesDriver({
    model: MODEL,
    transport: fake.transport,
    toolHost: host(executed),
    evaluator: {
      async evaluate() {
        return {
          status: "ERROR_FAIL_OPEN",
          fingerprintHash: "gate-timeout",
          faultCode: "INVALID_CODE",
          waitExpired: true,
        };
      },
    },
  });

  const result = await driver.runEpisode(BASE_RUN);

  assert.deepEqual(executed, ["call-1"]);
  assert.equal(result.gate?.status, "ERROR_FAIL_OPEN");
  assert.equal(result.gate?.faultCode, "GATE_WAIT_EXPIRED");
});

test("non-success Responses status is a normalized one-attempt transport fault", async () => {
  let attempts = 0;
  const driver = new ControlledResponsesDriver({
    model: MODEL,
    transport: async (_url, _init, options) => {
      attempts += 1;
      assert.equal(options.maxAttempts, 1);
      return new Response("rate limited", { status: 429 });
    },
    toolHost: host([]),
    evaluator: { evaluate: async () => ({ status: "NO_MATCH", fingerprintHash: "x" }) },
  });

  const result = await driver.runEpisode(BASE_RUN);

  assert.equal(attempts, 1);
  assert.equal(result.status, "INVALID");
  assert.equal(result.faults[0]?.code, "HTTP_429");
  assert.equal(JSON.stringify(result).includes("rate limited"), false);
});

test("MATCH_WARN closes the original call and executes a fresh resubmission", async () => {
  const setup = createDriver(
    [
      response("resp-1", [reasoning("reason-1"), call("original")]),
      response("resp-2", [reasoning("reason-2"), call("replacement")]),
      response("resp-3", [message("fixed")]),
    ],
    "MATCH_WARN",
  );

  const result = await setup.driver.runEpisode(BASE_RUN);

  assert.deepEqual(setup.executed, ["replacement"]);
  assert.equal(setup.evaluations(), 1);
  assert.equal(result.disposition, "RESUBMITTED");
  assert.equal(result.originalCallId, "original");
  assert.equal(result.replacementCallId, "replacement");
  assert.equal(result.originalFingerprint, result.replacementFingerprint);
  const warningOutput = setup.fake.requests[1]?.input.at(-1);
  assert.deepEqual(warningOutput, {
    type: "function_call_output",
    call_id: "original",
    output: JSON.stringify({
      status: "not_executed",
      disposition: "advisory",
      advisory: "This action matches a prior failure. Reconsider before acting.",
    }),
  });
});

test("MATCH_WARN records a changed replacement", async () => {
  const setup = createDriver(
    [
      response("resp-1", [call("original")]),
      response("resp-2", [call("replacement", { command: "npm run check:cache", timeoutMs: 1000 })]),
      response("resp-3", [message("fixed")]),
    ],
    "MATCH_WARN",
  );

  const result = await setup.driver.runEpisode(BASE_RUN);

  assert.deepEqual(setup.executed, ["replacement"]);
  assert.equal(result.disposition, "CHANGED");
  assert.notEqual(result.originalFingerprint, result.replacementFingerprint);
});

test("MATCH_WARN records abandonment without executing the warned call", async () => {
  const setup = createDriver(
    [response("resp-1", [call("original")]), response("resp-2", [message("I will not make that change.")])],
    "MATCH_WARN",
  );

  const result = await setup.driver.runEpisode(BASE_RUN);

  assert.deepEqual(setup.executed, []);
  assert.equal(result.disposition, "ABANDONED");
  assert.equal(result.status, "COMPLETED");
});

test("every response output item is replayed verbatim with store disabled", async () => {
  const firstReasoning = reasoning("reason-1");
  const firstCall = call("call-1");
  const setup = createDriver(
    [response("resp-1", [firstReasoning, firstCall]), response("resp-2", [message("done")])],
    "NO_MATCH",
  );

  await setup.driver.runEpisode(BASE_RUN);

  assert.equal(setup.fake.requests[0]?.store, false);
  assert.deepEqual(setup.fake.requests[0]?.include, ["reasoning.encrypted_content"]);
  assert.equal(setup.fake.requests[0]?.stream, false);
  assert.equal(setup.fake.requests[0]?.parallel_tool_calls, false);
  assert.equal("previous_response_id" in (setup.fake.requests[1] ?? {}), false);
  assert.deepEqual(setup.fake.requests[1]?.input.slice(1, 3), [firstReasoning, firstCall]);
  assert.equal(setup.fake.options.every((value) => value.maxAttempts === 1), true);
});

test("strict custom tools are sent and malformed arguments never execute", async () => {
  const malformed = { ...call("bad"), arguments: "{" };
  const setup = createDriver([response("resp-1", [malformed])], "NO_MATCH");

  const result = await setup.driver.runEpisode(BASE_RUN);

  assert.deepEqual(setup.fake.requests[0]?.tools, [
    {
      type: "function",
      name: TOOL.name,
      description: TOOL.description,
      parameters: TOOL.inputSchema,
      strict: true,
    },
  ]);
  assert.deepEqual(setup.executed, []);
  assert.equal(result.status, "INVALID");
  assert.equal(result.faults[0]?.code, "MALFORMED_TOOL_CALL");
});

test("constructor requires gate marker, strict schemas, and unique tool names", () => {
  const invalidTool = {
    ...TOOL,
    inputSchema: {
      ...TOOL.inputSchema,
      required: ["command"],
    },
  };
  assert.throws(
    () =>
      new ControlledResponsesDriver({
        model: MODEL,
        transport: fakeTransport([]).transport,
        toolHost: { ...host([]), tools: [invalidTool] },
        evaluator: { evaluate: async () => ({ status: "NO_MATCH", fingerprintHash: "x" }) },
      }),
    /strict schema/i,
  );
  const unsupportedUnionTool = {
    ...TOOL,
    inputSchema: {
      ...TOOL.inputSchema,
      properties: {
        command: { type: ["string", "null"] },
        timeoutMs: { type: "integer" },
      },
    },
  };
  assert.throws(
    () =>
      new ControlledResponsesDriver({
        model: MODEL,
        transport: fakeTransport([]).transport,
        toolHost: { ...host([]), tools: [unsupportedUnionTool] },
        evaluator: { evaluate: async () => ({ status: "NO_MATCH", fingerprintHash: "x" }) },
      }),
    /unsupported strict schema type/i,
  );
  const missingGateMarker = {
    ...TOOL,
    gateEligible: undefined as unknown as boolean,
  };
  assert.throws(
    () =>
      new ControlledResponsesDriver({
        model: MODEL,
        transport: fakeTransport([]).transport,
        toolHost: { ...host([]), tools: [missingGateMarker] },
        evaluator: { evaluate: async () => ({ status: "NO_MATCH", fingerprintHash: "x" }) },
      }),
    /must declare gateEligible/i,
  );
  assert.throws(
    () =>
      new ControlledResponsesDriver({
        model: MODEL,
        transport: fakeTransport([]).transport,
        toolHost: { ...host([]), tools: [TOOL, TOOL] },
        evaluator: { evaluate: async () => ({ status: "NO_MATCH", fingerprintHash: "x" }) },
      }),
    /duplicate tool/i,
  );
});

test("unknown, schema-invalid, multiple, and reused call IDs fail closed", async () => {
  const cases: Array<{ output: ResponsesApiResponse["output"]; code: string }> = [
    { output: [{ ...call("unknown"), name: "missing_tool" }], code: "UNKNOWN_TOOL" },
    {
      output: [call("invalid", { command: "npm test", timeoutMs: "soon" })],
      code: "INVALID_TOOL_ARGUMENTS",
    },
    { output: [call("one"), call("two")], code: "MULTIPLE_TOOL_CALLS" },
  ];
  for (const item of cases) {
    const setup = createDriver([response("resp-1", item.output)], "NO_MATCH");
    const result = await setup.driver.runEpisode(BASE_RUN);
    assert.equal(result.status, "INVALID");
    assert.equal(result.faults[0]?.code, item.code);
    assert.deepEqual(setup.executed, []);
  }

  const duplicate = createDriver(
    [response("resp-1", [call("same")]), response("resp-2", [call("same")])],
    "MATCH_WARN",
  );
  const duplicateResult = await duplicate.driver.runEpisode(BASE_RUN);
  assert.equal(duplicateResult.status, "INVALID");
  assert.equal(duplicateResult.faults[0]?.code, "DUPLICATE_CALL_ID");
  assert.deepEqual(duplicate.executed, []);
});

test("usage preserves every provider dimension per turn and in totals", async () => {
  const setup = createDriver(
    [
      response("resp-1", [call("call-1")]),
      response("resp-2", [message("done")], {
        input_tokens: 8,
        output_tokens: 2,
        total_tokens: 10,
        input_tokens_details: { cached_tokens: 5, cache_write_tokens: 4 },
        output_tokens_details: { reasoning_tokens: 1 },
      }),
    ],
    "NO_MATCH",
  );

  const result = await setup.driver.runEpisode(BASE_RUN);

  assert.deepEqual(result.responses.map((item) => item.usage), [
    {
      input: 10,
      output: 4,
      total: 14,
      cachedInput: 3,
      cacheWriteInput: 0,
      reasoningOutput: 2,
    },
    {
      input: 8,
      output: 2,
      total: 10,
      cachedInput: 5,
      cacheWriteInput: 4,
      reasoningOutput: 1,
    },
  ]);
  assert.deepEqual(result.usage, {
    input: 18,
    output: 6,
    total: 24,
    cachedInput: 8,
    cacheWriteInput: 4,
    reasoningOutput: 3,
  });
});

test("usage derives absent totals and rejects inconsistent or non-finite provider counts", async () => {
  const derived = createDriver(
    [response("resp-1", [message("done")], {
      input_tokens: 7,
      output_tokens: 3,
    })],
    "NO_MATCH",
  );
  const derivedResult = await derived.driver.runEpisode(BASE_RUN);
  assert.deepEqual(derivedResult.usage, {
    input: 7,
    output: 3,
    total: 10,
    cachedInput: 0,
    cacheWriteInput: 0,
    reasoningOutput: 0,
  });

  const invalidUsages: ResponsesApiResponse["usage"][] = [
    { input_tokens: 7, output_tokens: 3, total_tokens: 11 },
    { input_tokens: Number.NaN, output_tokens: 3, total_tokens: 3 },
    {
      input_tokens: 7,
      output_tokens: 3,
      total_tokens: 10,
      input_tokens_details: { cache_write_tokens: Number.POSITIVE_INFINITY },
    },
  ];
  for (const usage of invalidUsages) {
    const invalid = createDriver([response("resp-1", [message("done")], usage)], "NO_MATCH");
    const invalidResult = await invalid.driver.runEpisode(BASE_RUN);
    assert.equal(invalidResult.status, "INVALID");
    assert.equal(invalidResult.faults[0]?.code, "MALFORMED_RESPONSE");
    assert.deepEqual(invalidResult.usage, {
      input: 0,
      output: 0,
      total: 0,
      cachedInput: 0,
      cacheWriteInput: 0,
      reasoningOutput: 0,
    });
  }
});

test("token, turn, and tool caps invalidate before another tool execution", async () => {
  const tokenSetup = createDriver([response("resp-1", [call("call-1")])], "NO_MATCH");
  const tokenResult = await tokenSetup.driver.runEpisode({
    ...BASE_RUN,
    caps: { ...BASE_RUN.caps, maxTotalTokens: 5 },
  });
  assert.equal(tokenResult.status, "INVALID");
  assert.equal(tokenResult.invalidReason, "CAP_EXCEEDED");
  assert.deepEqual(tokenSetup.executed, []);

  const toolSetup = createDriver(
    [response("resp-1", [call("call-1")]), response("resp-2", [call("call-2")])],
    "NO_MATCH",
  );
  const toolResult = await toolSetup.driver.runEpisode({
    ...BASE_RUN,
    caps: { ...BASE_RUN.caps, maxToolCalls: 1 },
  });
  assert.equal(toolResult.status, "INVALID");
  assert.deepEqual(toolSetup.executed, ["call-1"]);

  const turnSetup = createDriver([response("resp-1", [call("call-1")])], "NO_MATCH");
  const turnResult = await turnSetup.driver.runEpisode({
    ...BASE_RUN,
    caps: { ...BASE_RUN.caps, maxTurns: 1 },
  });
  assert.equal(turnResult.status, "INVALID");
  assert.deepEqual(turnSetup.executed, ["call-1"]);
});

test("caller abort reaches the one-attempt transport and records an abort fault", async () => {
  let attempts = 0;
  let observedSignal: AbortSignal | undefined;
  const transport: ControlledResponsesTransport = async (_url, init, options) => {
    attempts += 1;
    assert.equal(options.maxAttempts, 1);
    observedSignal = init.signal as AbortSignal;
    await new Promise<void>((_resolve, reject) => {
      observedSignal?.addEventListener(
        "abort",
        () => reject(new DOMException("aborted", "AbortError")),
        { once: true },
      );
    });
    throw new Error("unreachable");
  };
  const driver = new ControlledResponsesDriver({
    model: MODEL,
    transport,
    toolHost: host([]),
    evaluator: { evaluate: async () => ({ status: "NO_MATCH", fingerprintHash: "x" }) },
  });
  const controller = new AbortController();
  const pending = driver.runEpisode({ ...BASE_RUN, signal: controller.signal });
  controller.abort();
  const result = await pending;

  assert.equal(attempts, 1);
  assert.equal(observedSignal?.aborted, true);
  assert.equal(result.status, "INVALID");
  assert.equal(result.invalidReason, "ABORTED");
  assert.equal(result.faults[0]?.code, "ABORTED");
});

test("episode duration cap aborts a hanging transport and records cap invalidation", async () => {
  let attempts = 0;
  const transport: ControlledResponsesTransport = async (_url, init) => {
    attempts += 1;
    const signal = init.signal as AbortSignal;
    await new Promise<void>((_resolve, reject) => {
      signal.addEventListener(
        "abort",
        () => reject(new DOMException("duration expired", "AbortError")),
        { once: true },
      );
    });
    throw new Error("unreachable");
  };
  const driver = new ControlledResponsesDriver({
    model: MODEL,
    transport,
    toolHost: host([]),
    evaluator: { evaluate: async () => ({ status: "NO_MATCH", fingerprintHash: "x" }) },
  });

  const result = await driver.runEpisode({
    ...BASE_RUN,
    caps: { ...BASE_RUN.caps, maxDurationMs: 10, requestTimeoutMs: 1000 },
  });

  assert.equal(attempts, 1);
  assert.equal(result.status, "INVALID");
  assert.equal(result.invalidReason, "CAP_EXCEEDED");
  assert.equal(result.faults.at(-1)?.code, "DURATION_CAP");
});

test("request timeout is configured for one transport attempt", async () => {
  const setup = createDriver([response("resp-1", [message("done")])], "NO_MATCH");

  await setup.driver.runEpisode({
    ...BASE_RUN,
    caps: { ...BASE_RUN.caps, requestTimeoutMs: 17 },
  });

  assert.equal(setup.fake.options.length, 1);
  assert.equal(setup.fake.options[0]?.maxAttempts, 1);
  assert.equal(setup.fake.options[0]?.timeoutMs, 17);
});

test("request timeout aborts a hanging injected transport without retry", async () => {
  let attempts = 0;
  const transport: ControlledResponsesTransport = async (_url, init, options) => {
    attempts += 1;
    assert.equal(options.maxAttempts, 1);
    const signal = init.signal as AbortSignal;
    await new Promise<void>((_resolve, reject) => {
      signal.addEventListener(
        "abort",
        () => reject(new DOMException("timed out", "AbortError")),
        { once: true },
      );
    });
    throw new Error("unreachable");
  };
  const driver = new ControlledResponsesDriver({
    model: MODEL,
    transport,
    toolHost: host([]),
    evaluator: { evaluate: async () => ({ status: "NO_MATCH", fingerprintHash: "x" }) },
  });

  const result = await driver.runEpisode({
    ...BASE_RUN,
    caps: { ...BASE_RUN.caps, requestTimeoutMs: 10 },
  });

  assert.equal(attempts, 1);
  assert.equal(result.status, "INVALID");
  assert.equal(result.invalidReason, "FAULT");
  assert.equal(result.faults[0]?.code, "REQUEST_TIMEOUT");
});

test("absolute final evidence paths are rejected and raw tool logs are not returned", async () => {
  const fake = fakeTransport([
    response("resp-1", [call("call-1")]),
    response("resp-2", [message("done")]),
  ]);
  const driver = new ControlledResponsesDriver({
    model: MODEL,
    transport: fake.transport,
    toolHost: {
      tools: [TOOL],
      async execute() {
        return { status: "completed", output: { stdout: "x".repeat(50_000) } };
      },
      async captureFinalEvidence() {
        return {
          repoHash: "repo-sha256",
          checkResult: "FIXED",
          changedFiles: ["/workspace/repo/secret.ts"],
        };
      },
    },
    evaluator: { evaluate: async () => ({ status: "NO_MATCH", fingerprintHash: "x" }) },
  });

  const result = await driver.runEpisode(BASE_RUN);

  assert.equal(result.status, "INVALID");
  assert.equal(result.faults.at(-1)?.code, "INVALID_FINAL_EVIDENCE");
  assert.equal(JSON.stringify(result).includes("x".repeat(1000)), false);
});
