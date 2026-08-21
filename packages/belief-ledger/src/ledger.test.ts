import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { BeliefLedger } from "./ledger.js";
import { buildReflectionReport } from "./reflection.js";
import { retrievePriorClaims } from "./retrieval.js";
import type {
  LedgerChallenge,
  LedgerClaim,
  LedgerClaimDraft,
  LedgerJudgeResult,
  LedgerLlmAdapter,
  LedgerPredictionGrade,
  LedgerPredictionGradeRequest,
  LedgerStore,
} from "./types.js";

class MemoryStore implements LedgerStore {
  claims = new Map<string, any>();
  next = 1;

  async createClaim(input: any): Promise<any> {
    const id = `claim-${this.next}`;
    this.next += 1;
    const claim = { ...input, id, memoryId: id };
    this.claims.set(id, claim);
    return claim;
  }

  async getClaim(id: string): Promise<any | null> {
    return this.claims.get(id) ?? null;
  }

  async listClaims(filter: any = {}): Promise<any[]> {
    const statuses = filter.statuses ? new Set(filter.statuses) : null;
    const kinds = filter.kinds ? new Set(filter.kinds) : null;
    return [...this.claims.values()]
      .filter((claim) => !statuses || statuses.has(claim.status))
      .filter((claim) => !kinds || kinds.has(claim.kind));
  }

  async updateClaim(id: string, patch: any): Promise<any> {
    const claim = this.claims.get(id);
    if (!claim) throw new Error("missing claim");
    const updated = { ...claim, ...patch };
    this.claims.set(id, updated);
    return updated;
  }

  async supersedeClaim(priorId: string, newId: string): Promise<boolean> {
    const prior = this.claims.get(priorId);
    const next = this.claims.get(newId);
    if (!prior || !next) return false;
    this.claims.set(priorId, { ...prior, status: "superseded", supersededBy: newId });
    this.claims.set(newId, {
      ...next,
      supersedes: priorId,
      parentIds: [...new Set([...(next.parentIds ?? []), priorId])],
    });
    return true;
  }
}

class FakeLlm implements LedgerLlmAdapter {
  async extractClaim(request: any): Promise<LedgerClaimDraft> {
    if (request.text.includes("Cloud-only")) {
      return {
        statement: "Cloud-only memory tools will beat local-first memory tools by 2027.",
        kind: "prediction",
        stance: "for",
        confidence: 0.7,
        scope: { entities: ["Memory Tools"], domain: "ai memory" },
        deadline: "2027-01-01T00:00:00Z",
      };
    }
    if (request.text.includes("demo")) {
      return {
        statement: "The demo shipped by June 2026.",
        kind: "prediction",
        stance: "for",
        confidence: 0.75,
        scope: { entities: ["Demo"], domain: "shipping" },
        deadline: "2026-06-01T00:00:00Z",
      };
    }
    return {
      statement: "Local-first memory tools will beat cloud-only memory tools by 2027.",
      kind: "prediction",
      stance: "for",
      confidence: 0.8,
      scope: { entities: ["Memory Tools"], domain: "ai memory" },
      deadline: "2027-01-01T00:00:00Z",
    };
  }

  async judgeClaimPair(request: any): Promise<LedgerJudgeResult> {
    const pair = `${request.current.statement}\n${request.prior.statement}`;
    const classification = pair.includes("Cloud-only") && pair.includes("Local-first") ? "contradiction" : "unrelated";
    return {
      priorClaimId: request.prior.id,
      classification,
      confidence: 0.9,
      rationale:
        classification === "contradiction" ? "The winner is reversed under the same scope." : "Different topic.",
    };
  }

  async draftSocraticChallenge(request: any): Promise<LedgerChallenge> {
    return {
      question: `You previously said "${request.contradictions[0].claim.statement}". Which claim should stand?`,
      priorClaimIds: request.contradictions.map((item: any) => item.claim.id),
      suggestedActions: ["supersede", "split", "ignore"],
    };
  }

  async gradePrediction(_request: LedgerPredictionGradeRequest): Promise<LedgerPredictionGrade> {
    return {
      verdict: "false",
      actualConfidence: 0,
      rationale: "The supplied source says it did not ship.",
      source: "test verdict",
    };
  }
}

describe("BeliefLedger", () => {
  it("captures claims and asks a Socratic challenge for contradictions", async () => {
    const store = new MemoryStore();
    const ledger = new BeliefLedger({
      store,
      llm: new FakeLlm(),
      now: () => new Date("2026-06-03T12:00:00Z"),
    });

    const first = await ledger.capture({ text: "Cloud-only will win." });
    assert.equal(first.challenge, undefined);

    const second = await ledger.capture({ text: "Local-first will win." });
    assert.equal(second.stats.contradictions, 1);
    assert.match(second.challenge?.question ?? "", /previously said/);

    assert.equal(await ledger.supersede(first.claim.id, second.claim.id, "changed my mind"), true);
    assert.equal((await store.getClaim(first.claim.id))?.status, "superseded");
  });

  it("uses capture now for immediate cross-examination", async () => {
    const store = new MemoryStore();
    await store.createClaim(
      makeClaim({
        id: "prior",
        createdAt: "2026-05-01T00:00:00Z",
        updatedAt: "2026-05-20T00:00:00Z",
      })
    );
    const ledger = new BeliefLedger({
      store,
      llm: new FakeLlm(),
      now: () => new Date("2026-06-03T12:00:00Z"),
    });

    const result = await ledger.capture({
      text: "Local-first will win.",
      now: "2020-01-01T00:00:00Z",
    });

    assert.equal(result.candidates.length, 1);
    assert.equal(
      result.candidates[0]?.reasons.some((reason) => reason.startsWith("recency:")),
      false
    );
  });

  it("persists extracted claims when cross-examination fails", async () => {
    const store = new MemoryStore();
    await store.createClaim({
      ...makeClaim({
        id: "prior",
        createdAt: "2026-05-01T00:00:00Z",
        updatedAt: "2026-05-20T00:00:00Z",
      }),
      statement: "Cloud-only memory tools will beat local-first memory tools by 2027.",
    });
    const llm = new FakeLlm();
    llm.draftSocraticChallenge = async () => {
      throw new Error("challenge failed");
    };
    const ledger = new BeliefLedger({
      store,
      llm,
      now: () => new Date("2026-06-03T12:00:00Z"),
    });

    await assert.rejects(() => ledger.capture({ text: "Local-first will win." }), /challenge failed/);

    assert.equal(store.claims.size, 2);
    assert.ok(
      [...store.claims.values()].some(
        (claim) => claim.statement === "Local-first memory tools will beat cloud-only memory tools by 2027."
      )
    );
  });

  it("throws when split cannot supersede the prior claim", async () => {
    const store = new MemoryStore();
    const prior = await store.createClaim(
      makeClaim({
        id: "prior",
        createdAt: "2026-05-01T00:00:00Z",
        updatedAt: "2026-05-20T00:00:00Z",
      })
    );
    store.supersedeClaim = async () => false;
    const ledger = new BeliefLedger({
      store,
      llm: new FakeLlm(),
      now: () => new Date("2026-06-03T12:00:00Z"),
    });

    await assert.rejects(
      () =>
        ledger.split(prior.id, [
          {
            statement: "Narrower memory claim.",
            stance: "for",
            confidence: 0.7,
            scope: { entities: ["Memory Tools"], domain: "ai memory" },
          },
        ]),
      /could not supersede/
    );

    const replacements = [...store.claims.values()].filter((claim) => claim.parentIds?.includes(prior.id));
    assert.equal((await store.getClaim(prior.id))?.status, "active");
    assert.equal(replacements.length, 1);
    assert.equal(replacements[0]?.status, "ignored");
  });

  it("returns the linked first replacement when split succeeds", async () => {
    const store = new MemoryStore();
    const prior = await store.createClaim(
      makeClaim({
        id: "prior",
        createdAt: "2026-05-01T00:00:00Z",
        updatedAt: "2026-05-20T00:00:00Z",
      })
    );
    const ledger = new BeliefLedger({
      store,
      llm: new FakeLlm(),
      now: () => new Date("2026-06-03T12:00:00Z"),
    });

    const replacements = await ledger.split(prior.id, [
      {
        statement: "Narrower memory claim.",
        stance: "for",
        confidence: 0.7,
        scope: { entities: ["Memory Tools"], domain: "ai memory" },
      },
    ]);

    assert.equal(replacements[0]?.supersedes, prior.id);
    assert.equal(replacements[0]?.parentIds.includes(prior.id), true);
  });

  it("keeps the prior active when later split part creation fails", async () => {
    const store = new MemoryStore();
    const prior = await store.createClaim(
      makeClaim({
        id: "prior",
        createdAt: "2026-05-01T00:00:00Z",
        updatedAt: "2026-05-20T00:00:00Z",
      })
    );
    const createClaim = store.createClaim.bind(store);
    let replacementCreates = 0;
    store.createClaim = async (input: any) => {
      if (input.parentIds?.includes(prior.id)) {
        replacementCreates += 1;
        if (replacementCreates > 1) {
          throw new Error("second part failed");
        }
      }
      return createClaim(input);
    };
    const ledger = new BeliefLedger({
      store,
      llm: new FakeLlm(),
      now: () => new Date("2026-06-03T12:00:00Z"),
    });

    await assert.rejects(
      () =>
        ledger.split(prior.id, [
          {
            statement: "First narrower memory claim.",
            stance: "for",
            confidence: 0.7,
            scope: { entities: ["Memory Tools"], domain: "ai memory" },
          },
          {
            statement: "Second narrower memory claim.",
            stance: "for",
            confidence: 0.7,
            scope: { entities: ["Memory Tools"], domain: "ai memory" },
          },
        ]),
      /second part failed/
    );

    assert.equal((await store.getClaim(prior.id))?.status, "active");
    const replacements = [...store.claims.values()].filter((claim) => claim.parentIds?.includes(prior.id));
    assert.equal(replacements.length, 1);
    assert.equal(replacements[0]?.status, "ignored");
  });

  it("validates all split parts before creating replacements", async () => {
    const store = new MemoryStore();
    const prior = await store.createClaim(
      makeClaim({
        id: "prior",
        createdAt: "2026-05-01T00:00:00Z",
        updatedAt: "2026-05-20T00:00:00Z",
      })
    );
    const ledger = new BeliefLedger({
      store,
      llm: new FakeLlm(),
      now: () => new Date("2026-06-03T12:00:00Z"),
    });

    await assert.rejects(
      () =>
        ledger.split(prior.id, [
          {
            statement: "First narrower memory claim.",
            stance: "for",
            confidence: 0.7,
            scope: { entities: ["Memory Tools"], domain: "ai memory" },
          },
          {
            statement: "Invalid split part.",
            stance: "for",
            confidence: 1.7,
            scope: { entities: ["Memory Tools"], domain: "ai memory" },
          },
        ]),
      /confidence must be in \[0, 1\]/
    );

    assert.equal(store.claims.size, 1);
    assert.equal((await store.getClaim(prior.id))?.status, "active");
  });

  it("rolls back split replacements when supersession throws", async () => {
    const store = new MemoryStore();
    const prior = await store.createClaim(
      makeClaim({
        id: "prior",
        createdAt: "2026-05-01T00:00:00Z",
        updatedAt: "2026-05-20T00:00:00Z",
      })
    );
    store.supersedeClaim = async () => {
      throw new Error("supersession failed");
    };
    const ledger = new BeliefLedger({
      store,
      llm: new FakeLlm(),
      now: () => new Date("2026-06-03T12:00:00Z"),
    });

    await assert.rejects(
      () =>
        ledger.split(prior.id, [
          {
            statement: "First narrower memory claim.",
            stance: "for",
            confidence: 0.7,
            scope: { entities: ["Memory Tools"], domain: "ai memory" },
          },
          {
            statement: "Second narrower memory claim.",
            stance: "for",
            confidence: 0.7,
            scope: { entities: ["Memory Tools"], domain: "ai memory" },
          },
        ]),
      /supersession failed/
    );

    const replacements = [...store.claims.values()].filter((claim) => claim.parentIds?.includes(prior.id));
    assert.equal((await store.getClaim(prior.id))?.status, "active");
    assert.equal(replacements.length, 2);
    assert.deepEqual(
      replacements.map((claim) => claim.status),
      ["ignored", "ignored"]
    );
  });

  it("scores due predictions and reflects calibration", async () => {
    const store = new MemoryStore();
    const ledger = new BeliefLedger({
      store,
      llm: new FakeLlm(),
      now: () => new Date("2026-06-03T12:00:00Z"),
    });

    const captured = await ledger.capture({ text: "The demo shipped." });
    const scored = await ledger.scoreDuePredictions({
      now: "2026-06-03T12:00:00Z",
      verdictSources: { [captured.claim.id]: "The release notes say no demo shipped." },
    });

    assert.equal(scored.length, 1);
    assert.equal(scored[0]?.status, "resolved");
    assert.equal(scored[0]?.resolution?.brierScore, 0.5625);

    const report = await ledger.reflect({ now: "2026-06-03T12:00:00Z" });
    assert.equal(report.resolvedPredictions, 1);
    assert.equal(report.brierScore, 0.5625);
    assert.equal(report.domains[0]?.domain, "shipping");
  });

  it("scores the most overdue predictions before recently updated due predictions", async () => {
    const store = new MemoryStore();
    const ledger = new BeliefLedger({
      store,
      llm: new FakeLlm(),
      now: () => new Date("2026-06-03T12:00:00Z"),
    });
    await store.createClaim({
      ...makeClaim({
        id: "recent-deadline",
        createdAt: "2026-06-01T00:00:00Z",
        updatedAt: "2026-06-03T00:00:00Z",
      }),
      deadline: "2026-06-02T00:00:00Z",
    });
    const oldest = await store.createClaim({
      ...makeClaim({
        id: "oldest-deadline",
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-06-01T00:00:00Z",
      }),
      deadline: "2026-01-15T00:00:00Z",
    });

    const results = await ledger.scoreDuePredictions({
      now: "2026-06-03T12:00:00Z",
      limit: 1,
    });

    assert.equal(results[0]?.claim.id, oldest.id);
  });

  it("continues scoring predictions when one grader call fails", async () => {
    const store = new MemoryStore();
    const failed = await store.createClaim({
      ...makeClaim({
        id: "failed",
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-02T00:00:00Z",
      }),
      deadline: "2026-01-15T00:00:00Z",
      statement: "The January launch will ship.",
    });
    const resolved = await store.createClaim({
      ...makeClaim({
        id: "resolved",
        createdAt: "2026-02-01T00:00:00Z",
        updatedAt: "2026-02-02T00:00:00Z",
      }),
      deadline: "2026-02-15T00:00:00Z",
      statement: "The February launch will ship.",
    });
    const llm = new FakeLlm();
    llm.gradePrediction = async (request) => {
      if (request.claim.id === failed.id) {
        throw new Error("grader unavailable");
      }
      return {
        verdict: "true",
        actualConfidence: 1,
        rationale: "The supplied source confirms shipment.",
        source: "test verdict",
      };
    };
    const ledger = new BeliefLedger({
      store,
      llm,
      now: () => new Date("2026-06-03T12:00:00Z"),
    });

    const results = await ledger.scoreDuePredictions({
      now: "2026-06-03T12:00:00Z",
      verdictSources: {
        [failed.id]: "The January launch source is unavailable.",
        [resolved.id]: "The February launch shipped.",
      },
    });
    const byId = new Map(results.map((result) => [result.claim.id, result]));

    assert.equal(results.length, 2);
    assert.equal(byId.get(failed.id)?.status, "skipped");
    assert.match(byId.get(failed.id)?.reason ?? "", /grader unavailable/);
    assert.equal(byId.get(resolved.id)?.status, "resolved");
    assert.equal((await store.getClaim(failed.id))?.status, "active");
    assert.equal((await store.getClaim(resolved.id))?.status, "resolved");
  });

  it("continues scoring predictions when one resolution write fails", async () => {
    const store = new MemoryStore();
    const failed = await store.createClaim({
      ...makeClaim({
        id: "failed-write",
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-02T00:00:00Z",
      }),
      deadline: "2026-01-15T00:00:00Z",
      statement: "The January release will finish.",
    });
    const resolved = await store.createClaim({
      ...makeClaim({
        id: "resolved-write",
        createdAt: "2026-02-01T00:00:00Z",
        updatedAt: "2026-02-02T00:00:00Z",
      }),
      deadline: "2026-02-15T00:00:00Z",
      statement: "The February release will finish.",
    });
    const updateClaim = store.updateClaim.bind(store);
    store.updateClaim = async (id: string, patch: any): Promise<any> => {
      if (id === failed.id) {
        throw new Error("write failed");
      }
      return updateClaim(id, patch);
    };
    const ledger = new BeliefLedger({
      store,
      llm: new FakeLlm(),
      now: () => new Date("2026-06-03T12:00:00Z"),
    });

    const results = await ledger.scoreDuePredictions({
      now: "2026-06-03T12:00:00Z",
      verdictSources: {
        [failed.id]: "The January release verdict is available.",
        [resolved.id]: "The February release verdict is available.",
      },
    });
    const byId = new Map(results.map((result) => [result.claim.id, result]));

    assert.equal(results.length, 2);
    assert.equal(byId.get(failed.id)?.status, "skipped");
    assert.match(byId.get(failed.id)?.reason ?? "", /write failed/);
    assert.equal(byId.get(resolved.id)?.status, "resolved");
    assert.equal((await store.getClaim(failed.id))?.status, "active");
    assert.equal((await store.getClaim(resolved.id))?.status, "resolved");
  });

  it("builds reflection reports with flipped claims", () => {
    const report = buildReflectionReport(
      [
        {
          id: "a",
          memoryId: "a",
          statement: "Remote work improves output.",
          kind: "opinion",
          stance: "for",
          confidence: 0.6,
          scope: { entities: ["Remote Work"], domain: "work" },
          evidenceLinks: [],
          status: "superseded",
          createdAt: "2026-01-01T00:00:00Z",
          updatedAt: "2026-01-01T00:00:00Z",
          parentIds: [],
          supersededBy: "b",
        },
        {
          id: "b",
          memoryId: "b",
          statement: "Remote work hurts output for this team.",
          kind: "opinion",
          stance: "against",
          confidence: 0.7,
          scope: { entities: ["Remote Work"], domain: "work" },
          evidenceLinks: [],
          status: "active",
          createdAt: "2026-02-01T00:00:00Z",
          updatedAt: "2026-02-01T00:00:00Z",
          parentIds: ["a"],
          supersedes: "a",
        },
      ],
      { now: "2026-06-03T00:00:00Z", dormantAfterDays: 30 }
    );

    assert.equal(report.flippedClaims.length, 1);
    assert.equal(report.flippedClaims[0]?.flipCount, 1);
    assert.ok(report.dormantTopics.some((topic) => topic.topic === "Remote Work"));
  });

  it("normalizes reflection report timestamps before parsing", () => {
    assert.throws(
      () => buildReflectionReport([], { now: "2026-04-31T00:00:00Z" }),
      /reflection.now must be a valid ISO timestamp/
    );
    assert.throws(
      () => buildReflectionReport([], { now: "2026-06-01T09:00:00" }),
      /reflection.now must be a valid ISO timestamp/
    );
  });

  it("uses claim updates when detecting dormant topics", () => {
    const report = buildReflectionReport(
      [
        {
          id: "updated",
          memoryId: "updated",
          statement: "Remote work improves output.",
          kind: "opinion",
          stance: "for",
          confidence: 0.6,
          scope: { entities: ["Remote Work"], domain: "work" },
          evidenceLinks: [],
          status: "active",
          createdAt: "2026-01-01T00:00:00Z",
          updatedAt: "2026-06-01T00:00:00Z",
          parentIds: [],
        },
      ],
      { now: "2026-06-03T00:00:00Z", dormantAfterDays: 30 }
    );

    assert.equal(
      report.dormantTopics.some((topic) => topic.topic === "Remote Work"),
      false
    );
  });

  it("counts a claim only once when domain and entity topics match", () => {
    const report = buildReflectionReport(
      [
        {
          id: "duplicate-topic",
          memoryId: "duplicate-topic",
          statement: "Remote work needs better meeting defaults.",
          kind: "opinion",
          stance: "for",
          confidence: 0.6,
          scope: { entities: ["Remote Work"], domain: "remote work" },
          evidenceLinks: [],
          status: "active",
          createdAt: "2026-01-01T00:00:00Z",
          updatedAt: "2026-01-01T00:00:00Z",
          parentIds: [],
        },
      ],
      { now: "2026-06-03T00:00:00Z", dormantAfterDays: 30 }
    );

    assert.equal(report.dormantTopics.length, 1);
    assert.equal(report.dormantTopics[0]?.claimCount, 1);
  });

  it("scores retrieval recency against the ledger reference time", async () => {
    const store = new MemoryStore();
    const historical = await store.createClaim(
      makeClaim({
        id: "historical",
        createdAt: "2020-01-01T00:00:00Z",
        updatedAt: "2020-01-01T00:00:00Z",
      })
    );
    const future = await store.createClaim(
      makeClaim({
        id: "future",
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
      })
    );
    const query: LedgerClaim = {
      ...makeClaim({
        id: "query",
        createdAt: "2020-01-01T00:00:00Z",
        updatedAt: "2020-01-01T00:00:00Z",
      }),
      memoryId: "query",
    };

    const results = await retrievePriorClaims(query, store, {
      now: "2020-01-01T00:00:00Z",
      limit: 2,
    });

    assert.equal(results[0]?.claim.id, historical.id);
    assert.equal(results[1]?.claim.id, future.id);
  });

  it("requires topical evidence before retaining retrieval candidates", async () => {
    const store = new MemoryStore();
    const related = await store.createClaim(
      makeClaim({
        id: "related",
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
      })
    );
    const unrelated = await store.createClaim({
      ...makeClaim({
        id: "unrelated",
        createdAt: "2026-06-01T00:00:00Z",
        updatedAt: "2026-06-02T00:00:00Z",
      }),
      statement: "Coffee shops should switch to ceramic mugs.",
      stance: "against",
      scope: { entities: ["Coffee"], domain: "hospitality" },
    });
    const query: LedgerClaim = {
      ...makeClaim({
        id: "query",
        createdAt: "2026-06-03T00:00:00Z",
        updatedAt: "2026-06-03T00:00:00Z",
      }),
      memoryId: "query",
    };

    const results = await retrievePriorClaims(query, store, {
      now: "2026-06-03T00:00:00Z",
      limit: 8,
    });

    assert.ok(results.some((candidate) => candidate.claim.id === related.id));
    assert.equal(
      results.some((candidate) => candidate.claim.id === unrelated.id),
      false
    );
  });

  it("does not retrieve snoozed claims before their snooze window expires", async () => {
    const store = new MemoryStore();
    const expiredSnooze = await store.createClaim({
      ...makeClaim({
        id: "expired-snooze",
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-06-01T00:00:00Z",
      }),
      status: "snoozed",
      snoozedUntil: "2026-06-02T00:00:00Z",
    });
    const activeSnooze = await store.createClaim({
      ...makeClaim({
        id: "active-snooze",
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-06-01T00:00:00Z",
      }),
      status: "snoozed",
      snoozedUntil: "2026-06-04T00:00:00Z",
    });
    const query: LedgerClaim = {
      ...makeClaim({
        id: "query",
        createdAt: "2026-06-03T00:00:00Z",
        updatedAt: "2026-06-03T00:00:00Z",
      }),
      memoryId: "query",
    };

    const results = await retrievePriorClaims(query, store, {
      now: "2026-06-03T00:00:00Z",
      limit: 8,
    });

    assert.ok(results.some((candidate) => candidate.claim.id === expiredSnooze.id));
    assert.equal(
      results.some((candidate) => candidate.claim.id === activeSnooze.id),
      false
    );
  });

  it("uses the ledger clock when re-cross-examining claims", async () => {
    const store = new MemoryStore();
    const prior = await store.createClaim(
      makeClaim({
        id: "prior",
        createdAt: "2026-05-01T00:00:00Z",
        updatedAt: "2026-05-20T00:00:00Z",
      })
    );
    const query: LedgerClaim = {
      ...makeClaim({
        id: "query",
        createdAt: "2020-01-01T00:00:00Z",
        updatedAt: "2020-01-01T00:00:00Z",
      }),
      memoryId: "query",
    };
    const ledger = new BeliefLedger({
      store,
      llm: new FakeLlm(),
      now: () => new Date("2026-06-03T12:00:00Z"),
    });

    const result = await ledger.crossExamine(query);

    assert.equal(result.candidates[0]?.claim.id, prior.id);
    assert.ok(result.candidates[0]?.reasons.some((reason) => reason.startsWith("recency:")));
  });
});

function makeClaim(input: {
  id: string;
  createdAt: string;
  updatedAt: string;
}): Omit<LedgerClaim, "memoryId"> {
  return {
    id: input.id,
    statement: "Local-first memory tools will win.",
    kind: "prediction",
    stance: "for",
    confidence: 0.7,
    scope: { entities: ["Memory Tools"], domain: "ai memory" },
    deadline: "2027-01-01T00:00:00Z",
    evidenceLinks: [],
    status: "active",
    createdAt: input.createdAt,
    updatedAt: input.updatedAt,
    parentIds: [],
  };
}
