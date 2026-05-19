import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { lstat, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { RoutingRulesStore } from "../src/routing/store.ts";
import type { RouteRule } from "../src/routing/engine.ts";

function sampleRule(overrides: Partial<RouteRule> = {}): RouteRule {
  return {
    id: overrides.id ?? "rule-1",
    patternType: overrides.patternType ?? "keyword",
    pattern: overrides.pattern ?? "incident",
    priority: overrides.priority ?? 5,
    target: overrides.target ?? { category: "fact", namespace: "default" },
    enabled: overrides.enabled ?? true,
  };
}

test("routing store round-trips valid rules", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-routing-store-"));
  try {
    const store = new RoutingRulesStore(memoryDir);
    await store.write([sampleRule()]);

    const rules = await store.read();
    assert.equal(rules.length, 1);
    assert.equal(rules[0].id, "rule-1");
    assert.equal(rules[0].target.namespace, "default");
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("routing store fail-opens malformed file", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-routing-store-malformed-"));
  try {
    const statePath = path.join(memoryDir, "state", "routing-rules.json");
    await mkdir(path.dirname(statePath), { recursive: true });
    await writeFile(statePath, "{bad-json", "utf-8");
    const store = new RoutingRulesStore(memoryDir);
    const rules = await store.read();
    assert.deepEqual(rules, []);
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("routing store upsert rejects malformed state without overwriting it", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-routing-store-malformed-upsert-"));
  try {
    const statePath = path.join(memoryDir, "state", "routing-rules.json");
    await mkdir(path.dirname(statePath), { recursive: true });
    await writeFile(statePath, "{bad-json", "utf-8");

    const store = new RoutingRulesStore(memoryDir);
    await assert.rejects(
      async () => store.upsert(sampleRule({ id: "new-rule", pattern: "new incident" })),
      /failed to parse routing rules state/,
    );

    assert.equal(await readFile(statePath, "utf-8"), "{bad-json");
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("routing store write rejects malformed state without overwriting", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-routing-store-write-malformed-"));
  try {
    const statePath = path.join(memoryDir, "state", "routing-rules.json");
    await mkdir(path.dirname(statePath), { recursive: true });
    await writeFile(statePath, "{bad-json", "utf-8");
    const store = new RoutingRulesStore(memoryDir);

    await assert.rejects(
      async () => store.write([sampleRule({ id: "replacement-rule" })]),
      /failed to parse routing rules state/,
    );

    const raw = await readFile(statePath, "utf-8");
    assert.equal(raw, "{bad-json");
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("routing store upsert rejects invalid state shape without overwriting it", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-routing-store-invalid-shape-upsert-"));
  try {
    const statePath = path.join(memoryDir, "state", "routing-rules.json");
    await mkdir(path.dirname(statePath), { recursive: true });
    const invalidState = JSON.stringify({ version: 1, updatedAt: new Date().toISOString() }, null, 2);
    await writeFile(statePath, invalidState, "utf-8");

    const store = new RoutingRulesStore(memoryDir);

    await assert.rejects(
      async () => store.upsert(sampleRule({ id: "new-rule", pattern: "new incident" })),
      /rules must be an array/,
    );

    assert.equal(await readFile(statePath, "utf-8"), invalidState);
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("routing store upsert creates state when file is missing", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-routing-store-upsert-missing-"));
  try {
    const store = new RoutingRulesStore(memoryDir);
    await store.upsert(sampleRule({ id: "new-rule" }));

    const rules = await store.read();
    assert.equal(rules.length, 1);
    assert.equal(rules[0].id, "new-rule");

    const raw = await readFile(path.join(memoryDir, "state", "routing-rules.json"), "utf-8");
    assert.match(raw, /"new-rule"/);
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("routing store skips invalid rule entries on read", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-routing-store-invalid-"));
  try {
    const statePath = path.join(memoryDir, "state", "routing-rules.json");
    await mkdir(path.dirname(statePath), { recursive: true });
    await writeFile(
      statePath,
      JSON.stringify(
        {
          version: 1,
          updatedAt: new Date().toISOString(),
          rules: [
            sampleRule({ id: "good" }),
            { id: "bad-1", patternType: "regex", pattern: "x", priority: 1, target: null },
            { id: "bad-2", patternType: "unknown", pattern: "x", priority: 1, target: { category: "fact" } },
          ],
        },
        null,
        2,
      ),
      "utf-8",
    );

    const store = new RoutingRulesStore(memoryDir);
    const rules = await store.read();
    assert.equal(rules.length, 1);
    assert.equal(rules[0].id, "good");
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("routing store upsert replaces by id", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-routing-store-upsert-"));
  try {
    const store = new RoutingRulesStore(memoryDir);
    await store.write([sampleRule({ id: "r1", pattern: "incident" })]);
    await store.upsert(sampleRule({ id: "r1", pattern: "outage", priority: 9 }));

    const rules = await store.read();
    assert.equal(rules.length, 1);
    assert.equal(rules[0].pattern, "outage");
    assert.equal(rules[0].priority, 9);
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("routing store upsert treats missing state file as empty", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-routing-store-upsert-missing-"));
  try {
    const store = new RoutingRulesStore(memoryDir);
    const rules = await store.upsert(sampleRule({ id: "r1", pattern: "incident" }));
    assert.equal(rules.length, 1);
    assert.equal(rules[0].id, "r1");

    const raw = await readFile(path.join(memoryDir, "state", "routing-rules.json"), "utf-8");
    assert.match(raw, /"incident"/);
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("routing store removeByPattern persists removal", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-routing-store-remove-"));
  try {
    const store = new RoutingRulesStore(memoryDir);
    await store.write([
      sampleRule({ id: "r1", pattern: "incident" }),
      sampleRule({ id: "r2", pattern: "outage" }),
    ]);

    await store.removeByPattern("incident");
    const rules = await store.read();
    assert.equal(rules.length, 1);
    assert.equal(rules[0].id, "r2");

    const raw = await readFile(path.join(memoryDir, "state", "routing-rules.json"), "utf-8");
    assert.match(raw, /"outage"/);
    assert.doesNotMatch(raw, /"incident"/);
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("routing store dedupes stable ids from normalized rule content", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-routing-store-stable-id-"));
  try {
    const store = new RoutingRulesStore(memoryDir);
    const rules = await store.write([
      {
        ...sampleRule({ id: " " as unknown as string, priority: 5.7 }),
        target: { category: "fact", namespace: "default", extra: true } as unknown as RouteRule["target"],
      },
      {
        ...sampleRule({ id: "" as unknown as string, priority: 5 }),
        target: { category: "fact", namespace: "default" },
      },
    ]);

    assert.equal(rules.length, 1);
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("routing store keeps state file scoped under memoryDir", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-routing-store-path-scope-"));
  const outsideDir = await mkdtemp(path.join(os.tmpdir(), "engram-routing-store-path-outside-"));
  try {
    const outsidePath = path.join(outsideDir, "outside.json");
    const store = new RoutingRulesStore(memoryDir, "../outside.json");
    await store.write([sampleRule()]);

    await assert.rejects(async () => readFile(outsidePath, "utf-8"));
    const scopedRaw = await readFile(path.join(memoryDir, "state", "routing-rules.json"), "utf-8");
    assert.match(scopedRaw, /\"rules\"/);
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
    await rm(outsideDir, { recursive: true, force: true });
  }
});

test("routing store serializes concurrent upserts without lost updates", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-routing-store-concurrent-"));
  try {
    const store = new RoutingRulesStore(memoryDir);
    await Promise.all([
      store.upsert(sampleRule({ id: "r1", pattern: "one" })),
      store.upsert(sampleRule({ id: "r2", pattern: "two" })),
    ]);

    const rules = await store.read();
    const ids = new Set(rules.map((r) => r.id));
    assert.equal(ids.has("r1"), true);
    assert.equal(ids.has("r2"), true);
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("routing store serializes concurrent upserts across separate instances", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-routing-store-cross-instance-"));
  try {
    const storeA = new RoutingRulesStore(memoryDir);
    const storeB = new RoutingRulesStore(memoryDir);
    await Promise.all([
      storeA.upsert(sampleRule({ id: "ra", pattern: "alpha" })),
      storeB.upsert(sampleRule({ id: "rb", pattern: "beta" })),
    ]);

    const rules = await storeA.read();
    const ids = new Set(rules.map((r) => r.id));
    assert.equal(ids.has("ra"), true);
    assert.equal(ids.has("rb"), true);
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("routing store blocks symlink-based state path escapes", async () => {
  if (process.platform === "win32") return;

  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-routing-store-symlink-root-"));
  const outsideDir = await mkdtemp(path.join(os.tmpdir(), "engram-routing-store-symlink-outside-"));
  try {
    const linkDir = path.join(memoryDir, "state-link");
    await symlink(outsideDir, linkDir);

    const store = new RoutingRulesStore(memoryDir, "state-link/routing-rules.json");
    await assert.rejects(async () => store.write([sampleRule()]));

    await assert.rejects(async () => readFile(path.join(outsideDir, "routing-rules.json"), "utf-8"));
    const rules = await store.read();
    assert.deepEqual(rules, []);
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
    await rm(outsideDir, { recursive: true, force: true });
  }
});

test("routing store blocks final state-file symlink escapes", async () => {
  if (process.platform === "win32") return;

  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-routing-store-file-symlink-root-"));
  const outsideDir = await mkdtemp(path.join(os.tmpdir(), "engram-routing-store-file-symlink-outside-"));
  try {
    const outsideFile = path.join(outsideDir, "outside.json");
    await writeFile(outsideFile, "{}", "utf-8");

    const stateDir = path.join(memoryDir, "state");
    await mkdir(stateDir, { recursive: true });
    await symlink(outsideFile, path.join(stateDir, "routing-rules.json"));

    const store = new RoutingRulesStore(memoryDir);
    await assert.rejects(async () => store.write([sampleRule()]));

    const outsideRaw = await readFile(outsideFile, "utf-8");
    assert.equal(outsideRaw, "{}");
    const rules = await store.read();
    assert.deepEqual(rules, []);
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
    await rm(outsideDir, { recursive: true, force: true });
  }
});

test("routing store reset rejects in-scope state-file symlinks without touching the target", async () => {
  if (process.platform === "win32") return;

  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-routing-store-file-symlink-inside-"));
  try {
    const targetFile = path.join(memoryDir, "state", "linked-target.json");
    const statePath = path.join(memoryDir, "state", "routing-rules.json");
    await mkdir(path.dirname(statePath), { recursive: true });
    await writeFile(targetFile, "keep me", "utf-8");
    await symlink(targetFile, statePath);

    const store = new RoutingRulesStore(memoryDir);
    await assert.rejects(
      async () => store.reset(),
      /routing rules state path must not be a symlink/,
    );

    assert.equal(await readFile(targetFile, "utf-8"), "keep me");
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("routing store write rejects in-scope state-file symlinks without replacing the symlink", async () => {
  if (process.platform === "win32") return;

  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-routing-store-write-symlink-inside-"));
  try {
    const targetFile = path.join(memoryDir, "state", "linked-target.json");
    const statePath = path.join(memoryDir, "state", "routing-rules.json");
    await mkdir(path.dirname(statePath), { recursive: true });
    await writeFile(targetFile, "keep me", "utf-8");
    await symlink(targetFile, statePath);

    const store = new RoutingRulesStore(memoryDir);
    await assert.rejects(
      async () => store.write([sampleRule()]),
      /routing rules state path must not be a symlink/,
    );

    assert.equal(await readFile(targetFile, "utf-8"), "keep me");
    const linkStat = await lstat(statePath);
    assert.equal(linkStat.isSymbolicLink(), true);
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("routing store falls back when state file resolves to memoryDir root", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-routing-store-root-fallback-"));
  try {
    const store = new RoutingRulesStore(memoryDir, ".");
    await store.write([sampleRule()]);
    const raw = await readFile(path.join(memoryDir, "state", "routing-rules.json"), "utf-8");
    assert.match(raw, /"rules"/);
    const rules = await store.read();
    assert.equal(rules.length, 1);
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("routing store upsert with narrow options preserves unrelated persisted rules", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-routing-store-upsert-preserve-"));
  try {
    const store = new RoutingRulesStore(memoryDir);
    await store.write([
      sampleRule({ id: "default-rule", target: { category: "fact", namespace: "default" } }),
      sampleRule({ id: "team-rule", target: { category: "fact", namespace: "team" } }),
    ]);

    await store.upsert(
      sampleRule({ id: "default-rule", pattern: "incident-updated" }),
      { allowedNamespaces: ["default"] },
    );

    const all = await store.read();
    const ids = new Set(all.map((rule) => rule.id));
    assert.equal(ids.has("default-rule"), true);
    assert.equal(ids.has("team-rule"), true);
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("routing store does not create out-of-root directories before scope rejection", async () => {
  if (process.platform === "win32") return;

  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-routing-store-parent-symlink-root-"));
  const outsideDir = await mkdtemp(path.join(os.tmpdir(), "engram-routing-store-parent-symlink-outside-"));
  try {
    await symlink(outsideDir, path.join(memoryDir, "state-link"));
    const store = new RoutingRulesStore(memoryDir, "state-link/sub/routing-rules.json");
    const rules = await store.read();
    assert.deepEqual(rules, []);

    await assert.rejects(async () => stat(path.join(outsideDir, "sub")));
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
    await rm(outsideDir, { recursive: true, force: true });
  }
});

test("routing store write does not create out-of-root lock directories", async () => {
  if (process.platform === "win32") return;

  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-routing-store-lock-symlink-root-"));
  const outsideDir = await mkdtemp(path.join(os.tmpdir(), "engram-routing-store-lock-symlink-outside-"));
  try {
    await symlink(outsideDir, path.join(memoryDir, "state-link"));
    const store = new RoutingRulesStore(memoryDir, "state-link/sub/routing-rules.json");
    await assert.rejects(async () => store.write([sampleRule()]));
    await assert.rejects(async () => stat(path.join(outsideDir, "sub")));
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
    await rm(outsideDir, { recursive: true, force: true });
  }
});
