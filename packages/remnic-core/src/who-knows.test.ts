import assert from "node:assert/strict";
import test from "node:test";

import { EngramAccessInputError } from "./access-errors.js";
import { EngramAccessService } from "./access-service.js";
import type { MemoryFile, PluginConfig } from "./types.js";
import {
  computeWhoKnows,
  handleWhoKnowsHttpQuery,
  validateWhoKnowsInput,
  type WhoKnowsEntity,
  type WhoKnowsStorage,
} from "./who-knows.js";
import { extractWhoKnowsRawArgs, parseWhoKnowsCliOptions } from "./who-knows-cli.js";

function bodyCode(body: unknown): string | undefined {
  return body && typeof body === "object" && "code" in body && typeof body.code === "string"
    ? body.code
    : undefined;
}

function mem(overrides: {
  id: string;
  content: string;
  entityRef?: string;
  updated?: string;
  importance?: number;
  confidence?: number;
  status?: string;
}): MemoryFile {
  return {
    path: `/synthetic/mem/facts/2026-08-17/${overrides.id}.md`,
    frontmatter: {
      id: overrides.id,
      category: "fact",
      created: overrides.updated ?? "2026-08-01T00:00:00Z",
      updated: overrides.updated ?? "2026-08-01T00:00:00Z",
      source: "extraction",
      confidence: overrides.confidence ?? 0.8,
      tags: [],
      ...(overrides.entityRef ? { entityRef: overrides.entityRef } : {}),
      ...(overrides.importance !== undefined ? { importance: { score: overrides.importance, reason: "test" } } : {}),
      ...(overrides.status ? { status: overrides.status } : {}),
      confidenceTier: "inferred",
    } as MemoryFile["frontmatter"],
    content: overrides.content,
  };
}

function fakeStorage(memories: MemoryFile[], entities: WhoKnowsEntity[] = []): WhoKnowsStorage & { readEntityRaw?: unknown } {
  return {
    async readAllMemories() {
      return memories;
    },
    async listEntityNames() {
      return entities.map((entity) => entity.id);
    },
    async readEntity(name) {
      const entity = entities.find((candidate) => candidate.id === name);
      return entity
        ? `---\nname: ${entity.name}\ntype: person\nupdated: 2026-08-01T00:00:00Z\naliases: [${entity.aliases.map((a) => `"${a}"`).join(", ")}]\n---\n`
        : "";
    },
  };
}

test("scoring ties: recency breaks ties, entity id is the stable final key", () => {
  const entities: WhoKnowsEntity[] = [
    { id: "person-alice", name: "Alice", aliases: [] },
    { id: "person-bob", name: "Bob", aliases: [] },
  ];
  // Equal weights: same coverage, importance, confidence — one memory each.
  const memories = [
    mem({ id: "m-alice", content: "kafka consumer group tuning notes", entityRef: "person-alice", updated: "2026-08-01T00:00:00Z" }),
    mem({ id: "m-bob", content: "kafka partition rebalance notes", entityRef: "person-bob", updated: "2026-08-10T00:00:00Z" }),
  ];
  const byRecency = computeWhoKnows({ topic: "kafka", limit: 5, memories, entities });
  assert.equal(byRecency.results[0]?.entityId, "person-bob", "newer evidence wins a score tie");
  assert.equal(byRecency.results[0]?.score, 1, "top hit normalizes to 1");
  assert.ok(byRecency.results[0]?.score >= (byRecency.results[1]?.score ?? 0));

  // Full tie (same score, same lastSeen) falls back to entity id ascending.
  const tied = computeWhoKnows({
    topic: "kafka",
    limit: 5,
    memories: [
      mem({ id: "m-bob-tie", content: "kafka partition rebalance notes", entityRef: "person-bob", updated: "2026-08-01T00:00:00Z" }),
      mem({ id: "m-alice-tie", content: "kafka consumer group tuning notes", entityRef: "person-alice", updated: "2026-08-01T00:00:00Z" }),
    ],
    entities,
  });
  assert.deepEqual(tied.results.map((hit) => hit.entityId), ["person-alice", "person-bob"]);
  // Deterministic: repeated invocations produce identical output.
  const again = computeWhoKnows({ topic: "kafka", limit: 5, memories, entities });
  assert.deepEqual(
    again.results.map((hit) => hit.entityId),
    byRecency.results.map((hit) => hit.entityId),
  );
});

test("missing entity names: entityRef without an entity file still ranks, name is null", () => {
  const memories = [mem({ id: "m-ghost", content: "kafka exactly-once semantics deep dive", entityRef: "person-ghost" })];
  const result = computeWhoKnows({ topic: "kafka", limit: 5, memories, entities: [] });
  assert.equal(result.results.length, 1);
  assert.equal(result.results[0]?.entityId, "person-ghost");
  assert.equal(result.results[0]?.entityName, null);
  assert.ok(result.results[0]?.evidence[0]?.path.endsWith("m-ghost.md"));
});

test("zero-evidence topic returns an empty list, not an error", () => {
  const memories = [mem({ id: "m-unrelated", content: "unrelated quarterly planning notes", entityRef: "person-alice" })];
  const entities: WhoKnowsEntity[] = [{ id: "person-alice", name: "Alice", aliases: [] }];
  const result = computeWhoKnows({ topic: "kubernetes", limit: 5, memories, entities });
  assert.deepEqual(result, { topic: "kubernetes", results: [] });
});

test("non-active memories are not evidence", () => {
  const entities: WhoKnowsEntity[] = [{ id: "person-alice", name: "Alice", aliases: [] }];
  const memories = [
    mem({ id: "m-sup", content: "kafka notes superseded", entityRef: "person-alice", status: "superseded" }),
    mem({ id: "m-ok", content: "kafka notes active", entityRef: "person-alice" }),
  ];
  const result = computeWhoKnows({ topic: "kafka", limit: 5, memories, entities });
  assert.equal(result.results.length, 1);
  assert.equal(result.results[0]?.evidenceCount, 1);
  assert.equal(result.results[0]?.evidence[0]?.id, "m-ok");
});

test("authorship bonus is per entity: co-mentioned entity does not get the speaker bonus", () => {
  const entities: WhoKnowsEntity[] = [
    { id: "person-alice", name: "Alice", aliases: [] },
    { id: "person-bob", name: "Bob", aliases: [] },
  ];
  const memories = [
    mem({ id: "m-attr", content: "Alice explained the kafka rebalance with Bob", updated: "2026-08-10T00:00:00Z" }),
  ];
  const result = computeWhoKnows({ topic: "kafka", limit: 5, memories, entities });
  const alice = result.results.find((hit) => hit.entityId === "person-alice");
  const bob = result.results.find((hit) => hit.entityId === "person-bob");
  assert.ok(alice && bob, "both co-mentioned entities rank");
  assert.ok((alice?.score ?? 0) > (bob?.score ?? 0), "attributed speaker outranks the co-mentioned entity");
  assert.match(alice?.rationale ?? "", /with direct attribution/);
  assert.doesNotMatch(bob?.rationale ?? "", /with direct attribution/);
});

test("empty topic and invalid limit are validation errors", () => {
  assert.throws(() => validateWhoKnowsInput("   ", 5), /whoKnows: topic is required/);
  assert.throws(() => validateWhoKnowsInput("kafka", 0), /whoKnows: limit/);
  assert.throws(() => validateWhoKnowsInput("kafka", 51), /whoKnows: limit/);
});

test("empty topic 400: HTTP helper maps missing/invalid query params to 400 without calling run", async () => {
  let runCalls = 0;
  const outcome = await handleWhoKnowsHttpQuery({
    getParam: (name) => (name === "topic" ? "  " : null),
    resolveNamespace: (namespace) => namespace,
    run: async () => {
      runCalls += 1;
      throw new Error("must not run");
    },
  });
  assert.equal(outcome.status, 400);
  assert.equal(bodyCode(outcome.body), "missing_topic");
  assert.equal(runCalls, 0);

  const badLimit = await handleWhoKnowsHttpQuery({
    getParam: (name) => (name === "topic" ? "kafka" : name === "limit" ? "abc" : null),
    resolveNamespace: (namespace) => namespace,
    run: async () => {
      runCalls += 1;
      throw new Error("must not run");
    },
  });
  assert.equal(badLimit.status, 400);
  assert.equal(bodyCode(badLimit.body), "invalid_limit");
  assert.equal(runCalls, 0);

  const happy = await handleWhoKnowsHttpQuery({
    getParam: (name) => (name === "topic" ? "kafka" : name === "limit" ? "3" : name === "namespace" ? "team" : null),
    resolveNamespace: (namespace) => namespace,
    run: async (request) => {
      runCalls += 1;
      assert.deepEqual(request, { topic: "kafka", limit: 3, namespace: "team" });
      return { topic: "kafka", results: [] };
    },
  });
  assert.equal(happy.status, 200);
  assert.equal(runCalls, 1);
});

test("namespace allow-list gate runs even when the namespace param is omitted", async () => {
  const resolved: Array<string | undefined> = [];
  const outcome = await handleWhoKnowsHttpQuery({
    getParam: (name) => (name === "topic" ? "kafka" : null),
    resolveNamespace: (namespace) => {
      resolved.push(namespace);
      return "default";
    },
    run: async (request) => {
      assert.equal(request.namespace, "default", "resolved default namespace flows into the request");
      return { topic: "kafka", results: [] };
    },
  });
  assert.equal(outcome.status, 200);
  assert.deepEqual(resolved, [undefined], "resolver (and its allow-list) ran once with the implicit namespace");
});

test("namespace restriction: storage is resolved per readable namespace and the ACL matches recall", async () => {
  const config = {
    namespacesEnabled: true,
    defaultNamespace: "default",
    namespacePolicies: [{ name: "team", readPrincipals: ["reader"], writePrincipals: ["writer"] }],
    memoryDir: "/synthetic/mem",
  } as unknown as PluginConfig;
  const getStorageNames: string[] = [];
  const teamStorage = fakeStorage(
    [mem({ id: "m-team", content: "kafka consumer tuning deep dive", entityRef: "person-alice" })],
    [{ id: "person-alice", name: "Alice", aliases: [] }],
  );
  const defaultStorage = fakeStorage([mem({ id: "m-default", content: "kafka other notes", entityRef: "person-carol" })]);
  const service = Object.create(EngramAccessService.prototype) as EngramAccessService;
  (service as unknown as { orchestrator: unknown }).orchestrator = {
    config,
    getStorage: async (namespace: string) => {
      getStorageNames.push(namespace);
      return namespace === "team" ? teamStorage : defaultStorage;
    },
  };

  const allowed = await service.whoKnows({ topic: "kafka", namespace: "team", authenticatedPrincipal: "reader" });
  assert.equal(allowed.results.length, 1);
  assert.equal(allowed.results[0]?.entityId, "person-alice");
  assert.deepEqual(getStorageNames, ["team"], "reads only the resolved namespace's storage — no cross-namespace leak");

  await assert.rejects(
    () => service.whoKnows({ topic: "kafka", namespace: "team" }),
    (err: unknown) => err instanceof EngramAccessInputError && /authentication required/.test(err.message),
    "no principal + namespaces enabled must fail closed",
  );

  await assert.rejects(
    () => service.whoKnows({ topic: "kafka", namespace: "team", authenticatedPrincipal: "nobody" }),
    (err: unknown) => err instanceof EngramAccessInputError && /not readable/.test(err.message),
    "principal outside readPrincipals must be denied",
  );
});

test("CLI parsing: empty topic, bare --limit, and unknown flags throw listed-options errors", () => {
  const { topic, options } = extractWhoKnowsRawArgs(["kafka", "tuning", "--limit", "3", "--json"]);
  const parsed = parseWhoKnowsCliOptions(topic, options);
  assert.deepEqual(parsed, { topic: "kafka tuning", limit: 3, namespace: undefined, json: true });

  assert.throws(() => parseWhoKnowsCliOptions("", {}), /topic is required/);
  assert.throws(() => extractWhoKnowsRawArgs(["kafka", "--limit"]), /--limit expects a value/);
  assert.throws(() => extractWhoKnowsRawArgs(["kafka", "--bogus"]), /unknown option/);
  assert.throws(() => parseWhoKnowsCliOptions("kafka", { limit: 0 }), /--limit expects an integer/);
});
