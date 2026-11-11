/**
 * Request-local prototype injection and post-parse namespace authorization
 * (issue #3225 B1).
 *
 * A JSON body can carry an own `__proto__` member (JSON.parse defines it as a
 * real own property). The null-strip preprocessors used to copy that member
 * into a plain `{}` accumulator, whose setter switched the accumulator's
 * prototype, so an inherited `namespace` became an ordinary parsed field
 * AFTER the transports had authorized the raw arguments. These tests drive
 * the real registered boundary operations with JSON-decoded input and assert
 * that reserved keys are rejected and that a parsed explicit namespace still
 * passes the token namespace allow-list before the handler runs.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { getOperation, type BoundOperation } from "./access-boundary.js";
import {
  EngramAccessInputError,
  type EngramAccessRecallRequest,
  type EngramAccessRecallResponse,
  type EngramAccessService,
} from "./access-service.js";
import { validateRequest, type RecallRequest } from "./access-schema.js";
import type { RecallNavigationResult } from "./recall-navigation.js";
import { EngramAccessForbiddenError } from "./access-errors.js";
import { tokenCapabilityStore } from "./access-token-capabilities.js";
import "./access-operations-batch.js";
import "./recall-navigation-operations.js";

function makeService(handlers: Partial<EngramAccessService>): EngramAccessService {
  // SAFETY: the operations under test dispatch only through the handlers supplied here.
  return handlers as EngramAccessService;
}

function mustBeRegistered(name: Parameters<typeof getOperation>[0]): BoundOperation {
  const op = getOperation(name);
  assert.ok(op, `${name} must be registered`);
  return op;
}

test("own __proto__ member cannot smuggle a namespace into memory_profile", async () => {
  let handlerCalls = 0;
  const service = makeService({
    memoryProfile: async () => {
      handlerCalls += 1;
      throw new Error("handler must not run for a prototype-injection attempt");
    },
  });
  const exploit = JSON.parse('{"__proto__":{"namespace":"other"}}');
  const op = mustBeRegistered("memory_profile");
  await assert.rejects(
    () =>
      tokenCapabilityStore.run(
        { version: 1, namespaces: ["default"], ops: ["memory_profile"] },
        () => op.run(exploit, { service }),
      ),
    EngramAccessInputError,
  );
  assert.equal(handlerCalls, 0, "handler must not run for a prototype-injection attempt");
});

test("own __proto__ member cannot smuggle a namespace into recall", async () => {
  let handlerCalls = 0;
  const service = makeService({
    recall: async () => {
      handlerCalls += 1;
      throw new Error("handler must not run for a prototype-injection attempt");
    },
  });
  const exploit = JSON.parse('{"__proto__":{"namespace":"other"},"query":"hello"}');
  const op = mustBeRegistered("recall");
  await assert.rejects(
    () =>
      tokenCapabilityStore.run(
        { version: 1, namespaces: ["default"], ops: ["recall"] },
        () => op.run(exploit, { service }),
      ),
    EngramAccessInputError,
  );
  assert.equal(handlerCalls, 0, "handler must not run for a prototype-injection attempt");
});

test("reserved constructor and prototype keys are rejected on both null-strip paths", async () => {
  const profileService = makeService({
    memoryProfile: async () => {
      throw new Error("handler must not run for a reserved-key argument");
    },
  });
  const profileOp = mustBeRegistered("memory_profile");
  await assert.rejects(
    () =>
      tokenCapabilityStore.run(
        { version: 1, namespaces: ["default"], ops: ["memory_profile"] },
        () => profileOp.run(JSON.parse('{"constructor":{"namespace":"other"}}'), { service: profileService }),
      ),
    EngramAccessInputError,
  );
  await assert.rejects(
    () =>
      tokenCapabilityStore.run(
        { version: 1, namespaces: ["default"], ops: ["memory_profile"] },
        () => profileOp.run(JSON.parse('{"prototype":{"namespace":"other"}}'), { service: profileService }),
      ),
    EngramAccessInputError,
  );
  const recallService = makeService({
    recall: async () => {
      throw new Error("handler must not run for a reserved-key argument");
    },
  });
  const recallOp = mustBeRegistered("recall");
  await assert.rejects(
    () =>
      tokenCapabilityStore.run(
        { version: 1, namespaces: ["default"], ops: ["recall"] },
        () => recallOp.run(JSON.parse('{"query":"q","constructor":{"namespace":"other"}}'), { service: recallService }),
      ),
    EngramAccessInputError,
  );
});

test("navigation null-strip rejects an own __proto__ member (memory_expand)", async () => {
  let handlerCalls = 0;
  const service = makeService({
    recallNavigate: async () => {
      handlerCalls += 1;
      throw new Error("handler must not run for a prototype-injection attempt");
    },
  });
  const exploit = JSON.parse(
    '{"__proto__":{"namespace":"other"},"memoryId":"m1","sessionKey":"s1"}',
  );
  const op = mustBeRegistered("memory_expand");
  await assert.rejects(
    () =>
      tokenCapabilityStore.run(
        { version: 1, namespaces: ["default"], ops: ["memory_expand"] },
        () => op.run(exploit, { service }),
      ),
    EngramAccessInputError,
  );
  assert.equal(handlerCalls, 0, "handler must not run for a prototype-injection attempt");
});

test("a parsed explicit namespace outside the token allow-list is rejected before the handler", async () => {
  let handlerCalls = 0;
  let capturedNamespace: string | undefined;
  const service = makeService({
    memoryProfile: async (namespace) => {
      handlerCalls += 1;
      capturedNamespace = namespace;
      throw new Error("handler must not run for a denied namespace");
    },
  });
  const op = mustBeRegistered("memory_profile");
  await assert.rejects(
    () =>
      tokenCapabilityStore.run(
        { version: 1, namespaces: ["default"], ops: ["memory_profile"] },
        () => op.run({ namespace: "other" }, { service }),
      ),
    EngramAccessForbiddenError,
  );
  assert.equal(handlerCalls, 0, "handler must not run for a denied namespace");
  assert.equal(capturedNamespace, undefined);
});

test("an allowed explicit namespace still reaches the handler", async () => {
  let profileCalls = 0;
  let profileNamespace: string | undefined;
  const profileService = makeService({
    memoryProfile: async (namespace) => {
      profileCalls += 1;
      profileNamespace = namespace;
      return {};
    },
  });
  const profileOp = mustBeRegistered("memory_profile");
  await tokenCapabilityStore.run(
    { version: 1, namespaces: ["default", "other"], ops: ["memory_profile"] },
    () => profileOp.run({ namespace: "other" }, { service: profileService }),
  );
  assert.equal(profileCalls, 1);
  assert.equal(profileNamespace, "other");

  let recallCalls = 0;
  let recallNamespace: string | undefined;
  const recallResponse: EngramAccessRecallResponse = {
    query: "hello",
    namespace: "other",
    context: "",
    count: 0,
    memoryIds: [],
    results: [],
    fallbackUsed: false,
    sourcesUsed: [],
    disclosure: "chunk",
  };
  const recallService = makeService({
    recall: async (input) => {
      recallCalls += 1;
      recallNamespace = input.namespace;
      return recallResponse;
    },
  });
  const recallOp = mustBeRegistered("recall");
  await tokenCapabilityStore.run(
    { version: 1, namespaces: ["default", "other"], ops: ["recall"] },
    () => recallOp.run({ query: "hello", namespace: "other" }, { service: recallService }),
  );
  assert.equal(recallCalls, 1);
  assert.equal(recallNamespace, "other");
});

test("an absent namespace is not defaulted at the boundary", async () => {
  let profileNamespace: string | undefined;
  const service = makeService({
    memoryProfile: async (namespace) => {
      profileNamespace = namespace;
      return {};
    },
  });
  const op = mustBeRegistered("memory_profile");
  await tokenCapabilityStore.run(
    { version: 1, namespaces: ["default"], ops: ["memory_profile"] },
    () => op.run({}, { service }),
  );
  assert.equal(profileNamespace, undefined, "the boundary must not invent a namespace");
});

test("codingContext null clearing still works through recall", async () => {
  let capturedInput: EngramAccessRecallRequest | undefined;
  const recallResponse: EngramAccessRecallResponse = {
    query: "q",
    namespace: "default",
    context: "",
    count: 0,
    memoryIds: [],
    results: [],
    fallbackUsed: false,
    sourcesUsed: [],
    disclosure: "chunk",
  };
  const service = makeService({
    recall: async (input) => {
      capturedInput = input;
      return recallResponse;
    },
  });
  const op = mustBeRegistered("recall");
  await tokenCapabilityStore.run(
    { version: 1, namespaces: ["default"], ops: ["recall"] },
    () => op.run(JSON.parse('{"query":"q","codingContext":null}'), { service }),
  );
  assert.ok(capturedInput, "recall handler must run");
  assert.ok(Object.hasOwn(capturedInput, "codingContext"), "codingContext must survive the null strip");
  assert.equal(capturedInput.codingContext, null);
});

test("an allowed explicit namespace reaches the memory_expand handler", async () => {
  let capturedNamespace: string | undefined;
  const navigationResult: RecallNavigationResult = {
    ok: false,
    action: "expand",
    error: "disabled",
    message: "",
    rendered: "",
  };
  const service = makeService({
    recallNavigate: async (input) => {
      capturedNamespace = input.namespace;
      return navigationResult;
    },
  });
  const op = mustBeRegistered("memory_expand");
  await tokenCapabilityStore.run(
    { version: 1, namespaces: ["ns2"], ops: ["memory_expand"] },
    () =>
      op.run({ memoryId: "m1", sessionKey: "s1", namespace: "ns2" }, { service }),
  );
  assert.equal(capturedNamespace, "ns2");
});

test("own __proto__ member cannot smuggle a namespace through the wire request parse", () => {
  // validateRequest is the shared entry the HTTP REST body reader
  // (readValidatedBody) and the MCP wire-schema parse (parseMcpRequest) run.
  const recallExploit = JSON.parse('{"__proto__":{"namespace":"other"},"query":"hello"}');
  assert.throws(
    () => validateRequest<RecallRequest>("recall", recallExploit),
    EngramAccessInputError,
  );
  const observeExploit = JSON.parse('{"__proto__":{"namespace":"other"}}');
  assert.throws(() => validateRequest("observe", observeExploit), EngramAccessInputError);
});

test("wire request parse still preserves codingContext null clearing", () => {
  const result = validateRequest<RecallRequest>("recall", JSON.parse('{"query":"q","codingContext":null}'));
  assert.ok(result.success, "a codingContext null clear must parse");
  if (result.success) {
    assert.ok(Object.hasOwn(result.data, "codingContext"), "codingContext must survive the wire null strip");
    assert.equal(result.data.codingContext, null);
  }
});
