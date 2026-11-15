/** Writer-owned receipt context. Caller queue settlement never completes receipts. */
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomUUID } from "node:crypto";
import { lstat } from "node:fs/promises";
import { z } from "zod";
import { syncReceiptArtifact } from "./extraction-receipt-artifact-sync.js";
import {
  type ReceiptEffect,
  type ReceiptPlan,
  receiptHash,
  receiptMemoryDigest,
  withReceiptEffect,
} from "./extraction-receipt-provenance.js";
import {
  type RecoveredReceiptFact,
  confirmReceiptMemory,
  reconcileReceiptFacts,
} from "./extraction-receipt-reconciliation.js";
import { type ArtifactEvidence, type AttemptToken, ExtractionReceiptStore } from "./extraction-receipts.js";
import type { StorageManager } from "./storage.js";
import type { BufferTurn, ExtractionResult, MemoryFile } from "./types.js";

type Context = {
  store: ExtractionReceiptStore;
  token: AttemptToken;
  namespace: string;
  proposedKeys: Set<string>;
  providerEmpty: boolean;
  providerNonempty: boolean;
  artifacts: ArtifactEvidence[];
  blocked: boolean;
  persisted: boolean;
  empty: boolean;
  identityDigest: string;
  unresolved: boolean;
  priorPlan: boolean;
  plan?: ReceiptPlan;
  slot?: string;
  completedSlots: Set<string>;
  recoveredFacts?: Map<string, RecoveredReceiptFact>;
};
const current = new AsyncLocalStorage<Context>();
export const receiptDigest = <T>(value: T): string =>
  createHash("sha256")
    .update(JSON.stringify(value) ?? "undefined")
    .digest("hex");
export function blockReceiptCoverage(): void {
  const c = current.getStore();
  if (c) c.blocked = true;
}
const receiptPayloadSchema = z.object({
  facts: z.array(z.unknown()),
  entities: z.array(z.unknown()),
  questions: z.array(z.unknown()),
  profileUpdates: z.array(z.unknown()),
  relationships: z.array(z.unknown()).optional(),
  identityReflection: z.string().optional(),
});
export type ReceiptProviderPayload = z.input<ReturnType<typeof z.unknown>>;
const candidateSchema = z.object({
  content: z.unknown().optional(),
  name: z.unknown().optional(),
  type: z.unknown().optional(),
  facts: z.unknown().optional(),
  question: z.unknown().optional(),
  text: z.unknown().optional(),
  source: z.unknown().optional(),
  target: z.unknown().optional(),
  label: z.unknown().optional(),
});
function candidateKeys(r: z.output<typeof receiptPayloadSchema>): string[] {
  const keys: string[] = [];
  for (const field of ["facts", "entities", "questions", "profileUpdates", "relationships"] as const) {
    for (const value of r[field] ?? []) {
      const parsed = candidateSchema.safeParse(value);
      const v = parsed.success ? parsed.data : {};
      const identity =
        field === "facts"
          ? v.content
          : field === "entities"
            ? [v.name, v.type, v.facts]
            : field === "questions"
              ? (v.question ?? v.text ?? value)
              : field === "relationships"
                ? [v.source, v.target, v.label]
                : value;
      keys.push(`${field}:${receiptDigest(identity)}`);
    }
  }
  if (r.identityReflection) keys.push(`identity:${receiptDigest(r.identityReflection)}`);
  return keys;
}
/** Decode the original provider payload before normalization or filtering. */
export function receiptProviderPayload<T extends ExtractionResult>(raw: ReceiptProviderPayload, normalized: T): T {
  const c = current.getStore();
  if (!c) return normalized;
  const parsed = receiptPayloadSchema.safeParse(raw);
  if (!parsed.success) {
    c.blocked = true;
    return normalized;
  }
  const r = parsed.data;
  for (const key of candidateKeys(r)) c.proposedKeys.add(key);
  const fields = ["facts", "entities", "questions", "profileUpdates"] as const;
  const empty = fields.every((k) => r[k].length === 0) && !r.relationships?.length && !r.identityReflection;
  c.providerEmpty ||= empty;
  c.providerNonempty ||= !empty;
  if (
    fields.some((k) => r[k].length !== normalized[k].length) ||
    (r.relationships?.length ?? 0) !== (normalized.relationships?.length ?? 0)
  )
    c.blocked = true;
  return normalized;
}
export async function receiptProviderResult(result: ExtractionResult): Promise<void> {
  const c = current.getStore();
  if (!c) return;
  c.empty =
    c.providerEmpty &&
    !c.providerNonempty &&
    !result.extractionFailure &&
    !result.extractionSkippedReason &&
    [result.facts, result.entities, result.questions, result.profileUpdates].every(
      (a) => Array.isArray(a) && a.length === 0
    ) &&
    (result.relationships === undefined ||
      (Array.isArray(result.relationships) && result.relationships.length === 0)) &&
    !result.identityReflection;
  const parsed = receiptPayloadSchema.safeParse(result);
  if (!parsed.success) {
    c.blocked = true;
    return;
  }
  const actual = new Set(candidateKeys(parsed.data));
  if ([...c.proposedKeys].some((key) => !actual.has(key)) || result.extractionFailure || result.extractionSkippedReason)
    c.blocked = true;
  const plain =
    result.facts.length > 0 &&
    result.facts.every(
      (fact) => fact.category === "fact" && fact.scope !== "project" && !fact.structuredAttributes && !fact.entityRef
    ) &&
    !result.entities.length &&
    !result.questions.length &&
    !result.profileUpdates.length &&
    !result.relationships?.length &&
    !result.identityReflection;
  if (c.priorPlan && (!plain || c.blocked || !c.providerNonempty))
    throw new Error("Extraction receipt plan changed or unsupported");
  if (plain && c.providerNonempty && !c.blocked && !result.extractionFailure && !result.extractionSkippedReason) {
    const slots = result.facts.map((fact) => receiptHash(fact));
    if (new Set(slots).size !== slots.length) {
      c.blocked = true;
      return;
    }
    const members = [...c.token.members].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
    const data = { version: 1 as const, identityDigest: c.identityDigest, members, slots };
    const plan = { ...data, digest: receiptHash(data) };
    await c.store.closePlan(c.token, plan);
    c.plan = plan;
  }
}
export function receiptBoundedInput(
  before: readonly { content: string }[],
  after: readonly { content: string }[]
): void {
  if (before.length !== after.length || before.some((t, i) => t.content !== after[i]?.content)) blockReceiptCoverage();
}
export function receiptPersisted(deferred: number, pending: readonly string[]): void {
  const c = current.getStore();
  if (!c) return;
  c.persisted = true;
  if (deferred > 0 || pending.length > 0) c.blocked = true;
}
export async function withExtractionReceipt<T>(
  memoryDir: string,
  turns: readonly BufferTurn[],
  maxChars: number,
  run: () => Promise<T>
): Promise<T> {
  const proposed = turns.filter((t) => !t.extractionContextOnly).flatMap((t) => t.extractionReceiptMembers ?? []);
  if (!proposed.length) return run();
  const store = new ExtractionReceiptStore(memoryDir);
  const records = new Map<string, NonNullable<Awaited<ReturnType<ExtractionReceiptStore["get"]>>>>();
  for (const member of proposed) {
    if (!records.has(member.receiptId)) {
      const found = await store.get(member.receiptId);
      if (!found) throw new Error("Unknown extraction receipt");
      records.set(member.receiptId, found);
    }
  }
  const members = [
    ...new Map(
      proposed
        .filter((m) => {
          const state = records.get(m.receiptId)!.members.find((s) => s.memberId === m.memberId);
          return state?.status !== "durable_extracted" && state?.status !== "empty_success";
        })
        .map((m) => [JSON.stringify(m), m])
    ).values(),
  ];
  if (!members.length) return run();
  const unresolved = members.some((m) =>
    records
      .get(m.receiptId)!
      .members.find((s) => s.memberId === m.memberId)
      ?.journal.some((j) => !j.confirmed || j.artifact.disposition === "pending_review")
  );
  const token = await store.begin(members);
  const receipt = await store.get(members[0]!.receiptId);
  if (!receipt) throw new Error("Extraction receipt disappeared");
  const context: Context = {
    store,
    token,
    namespace: receipt.identity.namespace,
    proposedKeys: new Set(),
    completedSlots: new Set(),
    providerEmpty: false,
    providerNonempty: false,
    artifacts: [],
    blocked: turns.some((t) => !t.extractionContextOnly && (!t.content.trim() || t.content.trim().length > maxChars)),
    persisted: false,
    empty: false,
    unresolved,
    priorPlan: members.some(
      (m) => records.get(m.receiptId)!.members.find((s) => s.memberId === m.memberId)?.plan !== undefined
    ),
    identityDigest: receiptHash(
      [...records.values()]
        .filter((r) => members.some((m) => m.receiptId === r.receiptId))
        .map((r) => ({ receiptId: r.receiptId, identity: r.identity }))
        .sort((a, b) => a.receiptId.localeCompare(b.receiptId))
    ),
  };
  return current.run(context, async () => {
    try {
      const result = await run();
      const planComplete = !context.plan || context.plan.slots.every((slot) => context.completedSlots.has(slot));
      const durable =
        planComplete && context.persisted && !context.blocked && !context.unresolved && context.artifacts.length > 0;
      const empty = context.empty && !context.blocked && !context.unresolved && !context.artifacts.length;
      await store.finish(token, {
        status: durable ? "durable_extracted" : empty ? "empty_success" : "deferred",
        artifacts: context.artifacts,
        emptyValidated: empty,
        reason: durable || empty ? undefined : "writer_coverage_incomplete",
      });
      return result;
    } catch (error) {
      await store
        .finish(token, { status: "retry", artifacts: context.artifacts, reason: "extraction_attempt_failed" })
        .catch(() => {});
      throw error;
    }
  });
}
/** Existing effects require exact-path readback, durable files, and a stable second read. */
export async function receiptExistingMemory(
  storage: StorageManager,
  namespace: string,
  verify: () => Promise<MemoryFile | null>
): Promise<boolean> {
  const c = current.getStore();
  if (!c || namespace !== c.namespace) return false;
  await c.store.assertCurrent(c.token);
  const memory = await verify();
  if (!memory) return false;
  const effectDigest = receiptMemoryDigest(memory.frontmatter, memory.content);
  const evidence: ArtifactEvidence = {
    kind: "memory",
    namespace,
    id: memory.frontmatter.id,
    disposition: "deduplicated",
    effectDigest,
  };
  const effect = effectFor(c);
  const journal = await c.store.prepareArtifact(c.token, evidence, effect);
  if (effect) {
    const provenance = {
      ...effect,
      journalId: journal,
      effectDigest: receiptMemoryDigest(memory.frontmatter, memory.content),
    };
    const written = await c.store.withCurrent(c.token, () =>
      storage.writeMemoryFrontmatterIfUnchanged(memory, {
        extractionEffects: [...(memory.frontmatter.extractionEffects ?? []), provenance],
      })
    );
    if (!written) return false;
  }
  const before = await lstat(memory.path, { bigint: true });
  if (!(await syncReceiptArtifact(storage, "memory", evidence.id, { id: evidence.id, memory }))) return false;
  const checked = await verify();
  const after = await lstat(memory.path, { bigint: true });
  if (
    !checked ||
    receiptMemoryDigest(checked.frontmatter, checked.content) !== effectDigest ||
    before.dev !== after.dev ||
    before.ino !== after.ino ||
    before.size !== after.size ||
    before.mtimeNs !== after.mtimeNs ||
    before.ctimeNs !== after.ctimeNs
  )
    return false;
  await confirmReceiptMemory(c.store, c.token, journal, evidence, storage, checked);
  c.artifacts.push(evidence);
  if (effect) c.completedSlots.add(effect.slot);
  return true;
}
export async function receiptReconcile(storage: StorageManager): Promise<void> {
  const c = current.getStore();
  if (!c?.plan) return;
  const recovered = await reconcileReceiptFacts(c.store, c.token, c.plan, storage);
  c.artifacts.push(...recovered.artifacts);
  c.recoveredFacts = recovered.facts;
  if (!recovered.fresh) c.unresolved = !recovered.complete;
  if (recovered.complete && recovered.artifacts.length) for (const slot of c.plan.slots) c.completedSlots.add(slot);
}
/** Called after current candidate filters, before any new fact commit/event. */
export async function receiptRecoveredFact(storage: StorageManager): Promise<boolean> {
  const c = current.getStore();
  const proof = c?.slot ? c.recoveredFacts?.get(c.slot) : undefined;
  if (!c || !proof) return false;
  await confirmReceiptMemory(c.store, c.token, proof.journalId, proof.evidence, storage, proof.memory);
  return true;
}
export function receiptFactSlot(fact: ExtractionResult["facts"][number]): void {
  const c = current.getStore();
  if (c) c.slot = receiptHash(fact);
}
function effectFor(c: Context): Omit<ReceiptEffect, "journalId"> | undefined {
  if (!c.plan || !c.slot || !c.plan.slots.includes(c.slot)) return undefined;
  return {
    version: 1,
    planDigest: c.plan.digest,
    identityDigest: c.identityDigest,
    namespace: c.namespace,
    attemptId: c.token.attemptId,
    slot: c.slot,
    members: c.token.members.map((m) => ({
      ...m,
      generation: c.token.generations[JSON.stringify([m.receiptId, m.memberId])]!,
    })),
  };
}
const methods = {
  writeSealedMemory: "memory",
  writeEntity: "entity",
  writeQuestion: "question",
  writeArtifact: "artifact",
  addEntityRelationship: "relationship",
  addEntityActivity: "artifact",
  writeChunk: "artifact",
  appendToProfile: "profile",
  appendIdentityReflection: "identity",
} satisfies Record<string, ArtifactEvidence["kind"]>;
/** Each proxy is confined to one extraction call; no mutation of shared storage objects. */
export function receiptStorage<T extends StorageManager>(storage: T, namespace: string): T {
  const c = current.getStore();
  if (!c) return storage;
  return new Proxy(storage, {
    get(target, property) {
      // SAFETY: Proxy receives arbitrary property names; membership is checked before indexing writer methods.
      const value = target[property as keyof T];
      if (!(value instanceof Function)) return value;
      const kind = Object.entries(methods).find(([name]) => name === property)?.[1];
      if (!kind) return value.bind(target);
      return async (...args: unknown[]) => {
        await c.store.assertCurrent(c.token);
        // Policy may route copies elsewhere. Such runs remain incomplete until
        // cross-namespace artifact authorization/provenance can be established.
        if (namespace !== c.namespace) {
          c.blocked = true;
          return value.apply(target, args);
        }
        const generatedId = ["writeSealedMemory", "writeEntity", "writeQuestion", "writeArtifact"].includes(
          String(property)
        );
        const prepared: ArtifactEvidence = {
          kind,
          namespace,
          id: generatedId ? `pending:${randomUUID()}` : `${kind}:${receiptDigest(args)}`,
          disposition: "written",
        };
        const effect = property === "writeSealedMemory" ? effectFor(c) : undefined;
        const journalId = await c.store.prepareArtifact(c.token, prepared, effect);
        const result = effect
          ? await c.store.withCurrent(c.token, () =>
              withReceiptEffect({ ...effect, journalId }, () => value.apply(target, args))
            )
          : await value.apply(target, args);
        if (!generatedId) {
          c.blocked = true;
          return result;
        } // Void writers can silently skip; no durable proof.
        const parsedResult = z
          .union([z.string(), z.object({ id: z.string(), tombstoneBlocked: z.boolean().optional() }).passthrough()])
          .safeParse(result);
        if (!parsedResult.success) {
          c.blocked = true;
          return result;
        }
        const id = z.string().safeParse(parsedResult.data).success
          ? String(parsedResult.data)
          : z.object({ id: z.string() }).parse(parsedResult.data).id;
        if (!id || result?.tombstoneBlocked) {
          c.blocked = true;
          return result;
        }
        if (!(await syncReceiptArtifact(target, kind, id, result))) {
          c.blocked = true;
          return result;
        }
        const evidence: ArtifactEvidence = { ...prepared, id };
        if (effect) {
          const pathname = z.object({ memory: z.object({ path: z.string() }) }).parse(result).memory.path;
          const memory = await target.readMemoryByPath(pathname);
          const provenance = memory?.frontmatter.extractionEffects?.find((e) => e.journalId === journalId);
          if (
            !memory ||
            !provenance ||
            provenance.effectDigest !== receiptMemoryDigest(memory.frontmatter, memory.content)
          )
            throw new Error("Receipt write provenance mismatch");
          evidence.effectDigest = provenance.effectDigest;
          await confirmReceiptMemory(c.store, c.token, journalId, evidence, target, memory);
        } else await c.store.confirmArtifact(c.token, journalId, evidence);
        c.artifacts.push(evidence);
        if (effect) c.completedSlots.add(effect.slot);
        return result;
      };
    },
  });
}
export function receiptStorageRouter<T extends { storageFor(namespace: string): Promise<StorageManager> }>(
  router: T
): T {
  if (!current.getStore()) return router;
  return new Proxy(router, {
    get(target, property) {
      if (property === "storageFor")
        return async (namespace: string) => receiptStorage(await target.storageFor(namespace), namespace);
      // SAFETY: Proxy receives arbitrary property names; membership is checked before indexing writer methods.
      const value = target[property as keyof T];
      return value instanceof Function ? value.bind(target) : value;
    },
  });
}
