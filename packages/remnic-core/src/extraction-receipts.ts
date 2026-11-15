/** Durable extraction provenance. No transcript content belongs in this store.
 *
 * Coverage is an all-members decision, distinct from a successful attempt.
 * Artifact preparation is a WAL, not proof that the artifact exists. Callers
 * must confirm persistence before finish; restart never auto-confirms a WAL.
 * Cross-receipt finishes stage records before an atomic commit marker, so a
 * partial write cannot expose partial coverage. The marker is authoritative.
 */
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, rename, rm } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { isErrnoCode } from "./utils/errno.js";
import { serializeMutations, withHeldFileLock } from "./utils/serialize-mutations.js";

export interface ReceiptIdentity {
  principal: string;
  namespace: string;
  sessionKey: string;
  scopeHash: string;
  sourceDigest: string;
  chunkStart: number;
  chunkEnd: number;
  chunkVersion: string;
  messagesHash: string;
}
export interface ReceiptMember {
  receiptId: string;
  memberId: string;
}
export interface ArtifactEvidence {
  kind: "memory" | "entity" | "question" | "relationship" | "profile" | "identity" | "artifact";
  namespace: string;
  id: string;
  disposition: "written" | "deduplicated" | "pending_review";
  /** Digest of the read-back effect; contains no source text. */
  effectDigest?: string;
}
export type ReceiptOutcome = "durable_extracted" | "empty_success" | "failed" | "deferred" | "retry";
export interface ArtifactJournal {
  journalId: string;
  artifact: ArtifactEvidence;
  confirmed: boolean;
  proposedArtifact?: ArtifactEvidence;
}
export interface ReceiptMemberState {
  memberId: string;
  generation: number;
  attemptId?: string;
  status: ReceiptOutcome | "pending" | "extracting";
  artifacts: ArtifactEvidence[];
  journal: ArtifactJournal[];
  reason?: string;
}
export interface Receipt {
  version: 1;
  receiptId: string;
  identity: ReceiptIdentity;
  members: ReceiptMemberState[];
  status: ReceiptMemberState["status"];
  coverageComplete: boolean;
  artifacts: ArtifactEvidence[];
  journal: ArtifactJournal[];
}
export interface AttemptToken {
  attemptId: string;
  members: ReceiptMember[];
  /** Keys are JSON.stringify([receiptId, memberId]), never a lossy concatenation. */
  generations: Record<string, number>;
}
export interface FinishOutcome {
  status: ReceiptOutcome;
  artifacts: ArtifactEvidence[];
  reason?: string;
  emptyValidated?: boolean;
}
interface RecordState {
  version: 1;
  receiptId: string;
  identity: ReceiptIdentity;
  members: ReceiptMemberState[];
  pendingFinish?: { transactionId: string; members: ReceiptMemberState[] };
}
const identitySchema = z.object({
  principal: z.string(),
  namespace: z.string(),
  sessionKey: z.string(),
  scopeHash: z.string(),
  sourceDigest: z.string(),
  chunkStart: z.number(),
  chunkEnd: z.number(),
  chunkVersion: z.string(),
  messagesHash: z.string(),
});
const artifactSchema = z.object({
  kind: z.enum(["memory", "entity", "question", "relationship", "profile", "identity", "artifact"]),
  namespace: z.string(),
  id: z.string(),
  disposition: z.enum(["written", "deduplicated", "pending_review"]),
  effectDigest: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
});
const memberSchema = z.object({
  memberId: z.string(),
  generation: z.number(),
  attemptId: z.string().optional(),
  status: z.enum(["pending", "extracting", "durable_extracted", "empty_success", "failed", "deferred", "retry"]),
  artifacts: z.array(artifactSchema),
  journal: z.array(
    z.object({
      journalId: z.string(),
      artifact: artifactSchema,
      confirmed: z.boolean(),
      proposedArtifact: artifactSchema.optional(),
    })
  ),
  reason: z.string().optional(),
});
const recordSchema = z.object({
  version: z.literal(1),
  receiptId: z.string(),
  identity: identitySchema,
  members: z.array(memberSchema),
  pendingFinish: z.object({ transactionId: z.string(), members: z.array(memberSchema) }).optional(),
});
const commitSchema = z.object({ receiptIds: z.array(z.string()) });
type CommitRecord = z.infer<typeof commitSchema>;
/** Serialized records accepted by the atomic disk boundary. */
export type ReceiptDiskPayload = RecordState | CommitRecord;
const kinds = new Set(["memory", "entity", "question", "relationship", "profile", "identity", "artifact"]);
const dispositions = new Set(["written", "deduplicated", "pending_review"]);
const statuses = new Set([
  "pending",
  "extracting",
  "durable_extracted",
  "empty_success",
  "failed",
  "deferred",
  "retry",
]);
const key = (m: ReceiptMember): string => JSON.stringify([m.receiptId, m.memberId]);
const terminal = (m: ReceiptMemberState): boolean => m.status === "durable_extracted" || m.status === "empty_success";
function required<T>(value: T | undefined | null): T {
  if (value === undefined || value === null) throw new Error("Missing receipt state");
  return value;
}
function text(value: string, name: string): void {
  if (
    !z
      .string()
      .min(1)
      .refine((v) => !!v.trim() && !v.includes("\0"))
      .safeParse(value).success
  )
    throw new Error(`Invalid ${name}`);
}
function identityValue(input: ReceiptIdentity): ReceiptIdentity {
  const i = identitySchema.parse(input);
  for (const k of [
    "principal",
    "namespace",
    "sessionKey",
    "scopeHash",
    "sourceDigest",
    "chunkVersion",
    "messagesHash",
  ] as const)
    text(i[k], k);
  if (
    !Number.isSafeInteger(i.chunkStart) ||
    !Number.isSafeInteger(i.chunkEnd) ||
    i.chunkStart < 0 ||
    i.chunkEnd < i.chunkStart
  )
    throw new Error("Invalid chunk bounds");
  return {
    principal: i.principal,
    namespace: i.namespace,
    sessionKey: i.sessionKey,
    scopeHash: i.scopeHash,
    sourceDigest: i.sourceDigest,
    chunkStart: i.chunkStart,
    chunkEnd: i.chunkEnd,
    chunkVersion: i.chunkVersion,
    messagesHash: i.messagesHash,
  };
}
function receiptId(i: ReceiptIdentity): string {
  return createHash("sha256")
    .update(JSON.stringify(identityValue(i)))
    .digest("hex");
}
function artifactValue(a: ArtifactEvidence): ArtifactEvidence {
  if (!a || !kinds.has(a.kind) || !dispositions.has(a.disposition)) throw new Error("Invalid artifact evidence");
  text(a.id, "artifact id");
  text(a.namespace, "artifact namespace");
  if (a.effectDigest !== undefined && !/^[a-f0-9]{64}$/.test(a.effectDigest)) throw new Error("Invalid effect digest");
  const evidence: ArtifactEvidence = {
    kind: a.kind,
    namespace: a.namespace,
    id: a.id,
    disposition: a.disposition,
  };
  if (a.effectDigest !== undefined) evidence.effectDigest = a.effectDigest;
  return evidence;
}
function artifactKey(a: ArtifactEvidence): string {
  return JSON.stringify([a.kind, a.namespace, a.id]);
}
function uniqueArtifacts(items: ArtifactEvidence[]): ArtifactEvidence[] {
  return [...new Map(items.map((a) => [artifactKey(a), a])).values()];
}
function present(r: RecordState): Receipt {
  const complete = r.members.length > 0 && r.members.every(terminal);
  const status = complete
    ? r.members.some((m) => m.status === "durable_extracted")
      ? "durable_extracted"
      : "empty_success"
    : (r.members.find((m) => !terminal(m))?.status ?? "pending");
  return {
    version: 1,
    receiptId: r.receiptId,
    identity: r.identity,
    members: r.members,
    status,
    coverageComplete: complete,
    artifacts: uniqueArtifacts(r.members.flatMap((m) => m.artifacts)),
    journal: r.members.flatMap((m) => m.journal),
  };
}

export class ExtractionReceiptStore {
  private readonly directory: string;
  constructor(memoryDir: string) {
    text(memoryDir, "memoryDir");
    this.directory = path.resolve(memoryDir, "state", "extraction-receipts");
  }
  private async directoryReady(): Promise<void> {
    // Check every existing component, including a symlinked caller root.
    const parsed = path.parse(this.directory);
    let current = parsed.root;
    for (const part of this.directory.slice(parsed.root.length).split(path.sep)) {
      current = path.join(current, part);
      try {
        await mkdir(current, { mode: 0o700 });
      } catch (e) {
        if (!isErrnoCode(e, "EEXIST")) throw e;
      }
      const st = await lstat(current);
      if (!st.isDirectory() || st.isSymbolicLink()) throw new Error("Receipt directory must not traverse symlinks");
    }
  }
  private async locked<T>(task: (refresh: () => Promise<boolean>) => Promise<T>): Promise<T> {
    return serializeMutations(this.directory, async () => {
      await this.directoryReady();
      return withHeldFileLock(
        path.join(this.directory, "mutation.lock"),
        { staleMs: 60_000, maxWaitMs: 5_000 },
        async (acquired, lock) => {
          if (!acquired) throw new Error("Receipt mutation lock unavailable");
          return task(() => lock.refresh());
        }
      );
    });
  }
  private filename(id: string): string {
    if (!/^[a-f0-9]{64}$/.test(id)) throw new Error("Invalid receipt id");
    return path.join(this.directory, `${id}.json`);
  }
  private async readJSON<T>(file: string, schema: z.ZodType<T>): Promise<T | null> {
    let h: Awaited<ReturnType<typeof open>> | undefined;
    try {
      h = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
      return schema.parse(JSON.parse(await h.readFile("utf8")));
    } catch (e) {
      if (isErrnoCode(e, "ENOENT")) return null;
      throw e;
    } finally {
      await h?.close();
    }
  }
  private async writeJSON(file: string, data: ReceiptDiskPayload, refresh: () => Promise<boolean>): Promise<void> {
    const temp = `${file}.${randomUUID()}.tmp`;
    let h: Awaited<ReturnType<typeof open>> | undefined;
    try {
      h = await open(temp, "wx", 0o600);
      await h.writeFile(JSON.stringify(data));
      await h.sync();
      await h.close();
      h = undefined;
      if (!(await refresh())) throw new Error("Receipt mutation lock lost");
      await rename(temp, file);
      const dir = await open(this.directory, "r");
      try {
        await dir.sync();
      } finally {
        await dir.close();
      }
    } catch (e) {
      await h?.close();
      await rm(temp, { force: true }).catch(() => undefined);
      throw e;
    }
  }
  private async load(id: string): Promise<RecordState | null> {
    const raw = await this.readJSON(this.filename(id), recordSchema);
    if (!raw) return null;
    const r: RecordState = raw;
    if (
      r.version !== 1 ||
      r.receiptId !== id ||
      receiptId(r.identity) !== id ||
      !Array.isArray(r.members) ||
      !r.members.length
    )
      throw new Error("Receipt identity or schema mismatch");
    if (r.pendingFinish) {
      if (!/^[a-f0-9-]{36}$/.test(r.pendingFinish.transactionId)) throw new Error("Invalid receipt transaction");
      const commit = await this.readJSON(
        path.join(this.directory, `commit-${r.pendingFinish.transactionId}.json`),
        commitSchema
      );
      if (commit?.receiptIds?.includes(id)) r.members = r.pendingFinish.members;
      r.pendingFinish = undefined;
    }
    const seen = new Set<string>();
    for (const m of r.members) {
      text(m.memberId, "member id");
      if (
        seen.has(m.memberId) ||
        !Number.isSafeInteger(m.generation) ||
        m.generation < 0 ||
        !statuses.has(m.status) ||
        !Array.isArray(m.artifacts) ||
        !Array.isArray(m.journal)
      )
        throw new Error("Invalid receipt member");
      seen.add(m.memberId);
      for (const a of [...m.artifacts, ...m.journal.map((j) => j.artifact)]) {
        artifactValue(a);
        if (a.namespace !== r.identity.namespace) throw new Error("Artifact scope mismatch");
      }
      for (const j of m.journal) {
        text(j.journalId, "journal id");

        if (j.proposedArtifact) {
          artifactValue(j.proposedArtifact);
          if (j.proposedArtifact.namespace !== r.identity.namespace) throw new Error("Artifact scope mismatch");
        }
      }
      if (
        m.status === "durable_extracted" &&
        (!m.artifacts.length ||
          m.artifacts.some(
            (a) =>
              a.disposition === "pending_review" ||
              a.id.startsWith("pending:") ||
              !m.journal.some((j) => j.confirmed && JSON.stringify(j.artifact) === JSON.stringify(a))
          ) ||
          m.journal.some((j) => !j.confirmed || j.artifact.disposition === "pending_review"))
      )
        throw new Error("Invalid terminal artifact evidence");
      if (m.status === "empty_success" && (m.artifacts.length || m.journal.length))
        throw new Error("Invalid empty success");
    }
    return r;
  }
  async admit(identity: ReceiptIdentity, memberIds: string[]): Promise<Receipt> {
    const i = identityValue(identity);
    const id = receiptId(i);
    if (!Array.isArray(memberIds) || !memberIds.length) throw new Error("Receipt requires members");
    for (const member of memberIds) text(member, "member id");
    if (new Set(memberIds).size !== memberIds.length) throw new Error("Duplicate receipt members");
    return this.locked(async (refresh) => {
      const r = (await this.load(id)) ?? { version: 1 as const, receiptId: id, identity: i, members: [] };
      // Membership is immutable: a truncated/resegmented replay cannot inherit coverage.
      if (
        r.members.length &&
        JSON.stringify(r.members.map((m) => m.memberId).sort()) !== JSON.stringify([...memberIds].sort())
      )
        throw new Error("Receipt membership mismatch");
      if (!r.members.length) {
        r.members = memberIds.map((memberId) => ({
          memberId,
          generation: 0,
          status: "pending",
          artifacts: [],
          journal: [],
        }));
        await this.writeJSON(this.filename(id), r, refresh);
      }
      return present(r);
    });
  }
  async get(id: string): Promise<Receipt | null> {
    this.filename(id);
    return this.locked(async () => {
      const r = await this.load(id);
      return r ? present(r) : null;
    });
  }
  private async selected(members: ReceiptMember[]): Promise<Map<string, RecordState>> {
    if (!Array.isArray(members) || !members.length) throw new Error("Attempt requires members");
    const records = new Map<string, RecordState>();
    const seen = new Set<string>();
    let scope: string | undefined;
    for (const m of members) {
      text(m.memberId, "member id");
      if (seen.has(key(m))) throw new Error("Duplicate attempt member");
      seen.add(key(m));
      let r = records.get(m.receiptId);
      if (!r) {
        r = (await this.load(m.receiptId)) ?? undefined;
        if (!r) throw new Error("Unknown receipt");
        records.set(m.receiptId, r);
      }
      if (!r.members.some((x) => x.memberId === m.memberId)) throw new Error("Unknown receipt member");
      const current = JSON.stringify([
        r.identity.principal,
        r.identity.namespace,
        r.identity.sessionKey,
        r.identity.scopeHash,
      ]);
      if (scope !== undefined && scope !== current) throw new Error("Attempt scope mismatch");
      scope = current;
    }
    return records;
  }
  private async active(token: AttemptToken): Promise<Map<string, RecordState>> {
    text(token?.attemptId, "attempt id");
    const records = await this.selected(token.members);
    for (const m of token.members) {
      const state = required(required(records.get(m.receiptId)).members.find((x) => x.memberId === m.memberId));
      if (
        state.attemptId !== token.attemptId ||
        state.generation !== token.generations?.[key(m)] ||
        state.status !== "extracting"
      )
        throw new Error("Stale extraction attempt");
    }
    return records;
  }
  async assertCurrent(token: AttemptToken): Promise<void> {
    await this.locked(async () => {
      await this.active(token);
    });
  }
  async begin(members: ReceiptMember[]): Promise<AttemptToken> {
    return this.locked(async (refresh) => {
      const records = await this.selected(members);
      const token: AttemptToken = { attemptId: randomUUID(), members: structuredClone(members), generations: {} };
      for (const m of members) {
        const state = required(required(records.get(m.receiptId)).members.find((x) => x.memberId === m.memberId));
        if (terminal(state)) throw new Error("Receipt member already covered");
        state.generation++;
        state.attemptId = token.attemptId;
        state.status = "extracting";
        token.generations[key(m)] = state.generation;
      }
      for (const r of records.values()) await this.writeJSON(this.filename(r.receiptId), r, refresh);
      return token;
    });
  }
  async prepareArtifact(token: AttemptToken, artifact: ArtifactEvidence): Promise<string> {
    const a = artifactValue(artifact);
    return this.locked(async (refresh) => {
      const records = await this.active(token);
      const journalId = randomUUID();
      for (const m of token.members) {
        const r = required(records.get(m.receiptId));
        if (a.namespace !== r.identity.namespace) throw new Error("Artifact scope mismatch");
        required(r.members.find((x) => x.memberId === m.memberId)).journal.push({
          journalId,
          artifact: a,
          confirmed: false,
        });
      }
      for (const r of records.values()) await this.writeJSON(this.filename(r.receiptId), r, refresh);
      return journalId;
    });
  }
  async confirmArtifact(token: AttemptToken, journalId: string, evidence: ArtifactEvidence): Promise<void> {
    text(journalId, "journal id");
    const a = artifactValue(evidence);
    return this.locked(async (refresh) => {
      const records = await this.active(token);
      for (const m of token.members) {
        const r = required(records.get(m.receiptId));
        const state = required(r.members.find((x) => x.memberId === m.memberId));
        const j = state.journal.find((x) => x.journalId === journalId);
        const pendingReplacement =
          j &&
          !j.confirmed &&
          /^pending:[a-f0-9-]{36}$/.test(j.artifact.id) &&
          j.artifact.kind === a.kind &&
          j.artifact.namespace === a.namespace &&
          !a.id.startsWith("pending:");
        if (
          !j ||
          (artifactKey(j.artifact) !== artifactKey(a) && !pendingReplacement) ||
          a.namespace !== r.identity.namespace
        )
          throw new Error("Artifact journal mismatch");
        j.proposedArtifact ??= j.artifact;
        j.confirmed = true;
        j.artifact = a;
        state.artifacts = uniqueArtifacts([...state.artifacts, a]);
      }
      for (const r of records.values()) await this.writeJSON(this.filename(r.receiptId), r, refresh);
    });
  }
  async finish(token: AttemptToken, outcome: FinishOutcome): Promise<void> {
    if (
      !outcome ||
      !["durable_extracted", "empty_success", "failed", "deferred", "retry"].includes(outcome.status) ||
      !Array.isArray(outcome.artifacts)
    )
      throw new Error("Invalid receipt outcome");
    const artifacts = outcome.artifacts.map(artifactValue);
    if (outcome.reason !== undefined) text(outcome.reason, "outcome reason");
    return this.locked(async (refresh) => {
      const records = await this.active(token);
      for (const m of token.members) {
        const r = required(records.get(m.receiptId));
        const state = required(r.members.find((x) => x.memberId === m.memberId));
        if (artifacts.some((a) => a.namespace !== r.identity.namespace)) throw new Error("Artifact scope mismatch");
        if (
          outcome.status === "empty_success" &&
          (outcome.emptyValidated !== true || artifacts.length || state.artifacts.length || state.journal.length)
        )
          throw new Error("Empty success cannot contain artifacts or journals");
        if (outcome.status === "durable_extracted") {
          const allArtifacts = uniqueArtifacts([...state.artifacts, ...artifacts]);
          if (
            !artifacts.length ||
            allArtifacts.some((a) => a.disposition === "pending_review" || a.id.startsWith("pending:")) ||
            state.journal.some((j) => !j.confirmed || j.artifact.disposition === "pending_review")
          )
            throw new Error("Durable extraction requires confirmed evidence");
          if (
            allArtifacts.some(
              (a) => !state.journal.some((j) => j.confirmed && JSON.stringify(j.artifact) === JSON.stringify(a))
            )
          )
            throw new Error("Artifact evidence is not confirmed");
        }
        state.artifacts = uniqueArtifacts([...state.artifacts, ...artifacts]);
        state.status = outcome.status;
        state.reason = outcome.reason;
        state.attemptId = undefined;
      }
      const transactionId = randomUUID();
      // Stage only: the base state remains nonterminal until ALL records are durable.
      for (const r of records.values()) {
        const base = await this.load(r.receiptId);
        if (!base) throw new Error("Missing receipt during commit");
        base.pendingFinish = { transactionId, members: r.members };
        await this.writeJSON(this.filename(r.receiptId), base, refresh);
      }
      await this.writeJSON(
        path.join(this.directory, `commit-${transactionId}.json`),
        { receiptIds: [...records.keys()] },
        refresh
      );
    });
  }
}
