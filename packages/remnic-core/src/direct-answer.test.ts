import assert from "node:assert/strict";
import test from "node:test";

import {
  type DirectAnswerCandidate,
  type DirectAnswerConfig,
  FILTER_LABELS,
  isDirectAnswerEligible,
} from "./direct-answer.js";
import type { MemoryFile } from "./types.js";

const DEFAULT_CONFIG: DirectAnswerConfig = {
  enabled: true,
  tokenOverlapFloor: 0.5,
  importanceFloor: 0.7,
  ambiguityMargin: 0.15,
  eligibleTaxonomyBuckets: ["decisions", "principles", "conventions", "runbooks", "entities"],
};

function makeMemory(
  overrides: {
    id?: string;
    path?: string;
    content?: string;
    tags?: string[];
    status?: MemoryFile["frontmatter"]["status"];
    verificationState?: MemoryFile["frontmatter"]["verificationState"];
    entityRef?: string;
  } = {}
): MemoryFile {
  const id = overrides.id ?? "mem-1";
  return {
    path: overrides.path ?? `/memory/${id}.md`,
    frontmatter: {
      id,
      category: "decision",
      created: "2026-04-19T00:00:00.000Z",
      updated: "2026-04-19T00:00:00.000Z",
      source: "test",
      confidence: 0.9,
      confidenceTier: "explicit",
      tags: overrides.tags ?? [],
      status: overrides.status,
      verificationState: overrides.verificationState,
      entityRef: overrides.entityRef,
    },
    content: overrides.content ?? "",
  };
}

function makeCandidate(
  overrides: Partial<DirectAnswerCandidate> & { memory?: MemoryFile } = {}
): DirectAnswerCandidate {
  return {
    memory: overrides.memory ?? makeMemory(),
    // Use `in` so callers can pass an explicit `null` without it being
    // clobbered by the default.
    trustZone: "trustZone" in overrides ? (overrides.trustZone ?? null) : "trusted",
    taxonomyBucket: "taxonomyBucket" in overrides ? (overrides.taxonomyBucket ?? null) : "decisions",
    importanceScore: overrides.importanceScore ?? 0.9,
    matchScore: overrides.matchScore,
  };
}

// ── Gate: config.enabled ────────────────────────────────────────────────────

test("isDirectAnswerEligible returns reason=disabled when config.enabled is false", () => {
  const result = isDirectAnswerEligible({
    query: "anything",
    candidates: [makeCandidate()],
    config: { ...DEFAULT_CONFIG, enabled: false },
  });
  assert.equal(result.eligible, false);
  assert.equal(result.reason, "disabled");
  assert.deepEqual(result.filteredBy, []);
});

// ── Gate: query has no searchable tokens ────────────────────────────────────

test("isDirectAnswerEligible returns empty-query when query tokens normalize to empty", () => {
  const result = isDirectAnswerEligible({
    query: "? !!!",
    candidates: [makeCandidate()],
    config: DEFAULT_CONFIG,
  });
  assert.equal(result.reason, "empty-query");
  assert.equal(result.eligible, false);
});

// ── Gate: no candidates ──────────────────────────────────────────────────────

test("isDirectAnswerEligible returns no-candidates when candidate list is empty", () => {
  const result = isDirectAnswerEligible({
    query: "which package manager do we use for remnic",
    candidates: [],
    config: DEFAULT_CONFIG,
  });
  assert.equal(result.reason, "no-candidates");
  assert.equal(result.eligible, false);
});

// ── Filter: status must be active ────────────────────────────────────────────

test("isDirectAnswerEligible filters superseded candidates and records the filter label", () => {
  const survivor = makeCandidate({
    memory: makeMemory({
      id: "live",
      tags: ["package-manager", "remnic"],
      content: "remnic uses pnpm as its package manager",
    }),
  });
  const superseded = makeCandidate({
    memory: makeMemory({
      id: "old",
      status: "superseded",
      tags: ["package-manager", "remnic"],
      content: "remnic uses npm as its package manager",
    }),
  });
  const result = isDirectAnswerEligible({
    query: "package manager remnic",
    candidates: [superseded, survivor],
    config: DEFAULT_CONFIG,
  });
  assert.equal(result.eligible, true);
  assert.equal(result.winner?.memory.frontmatter.id, "live");
  assert.ok(result.filteredBy.includes(FILTER_LABELS.nonActiveStatus));
});

test("isDirectAnswerEligible treats undefined status as active", () => {
  const candidate = makeCandidate({
    memory: makeMemory({
      status: undefined,
      tags: ["package-manager", "remnic"],
      content: "remnic uses pnpm as its package manager",
    }),
  });
  const result = isDirectAnswerEligible({
    query: "package manager remnic",
    candidates: [candidate],
    config: DEFAULT_CONFIG,
  });
  assert.equal(result.eligible, true);
  assert.ok(!result.filteredBy.includes(FILTER_LABELS.nonActiveStatus));
});

// ── Filter: trust zone must be trusted ──────────────────────────────────────

test("isDirectAnswerEligible rejects working-zone memories", () => {
  const working = makeCandidate({
    trustZone: "working",
    memory: makeMemory({
      tags: ["package-manager"],
      content: "remnic uses pnpm",
    }),
  });
  const result = isDirectAnswerEligible({
    query: "package manager remnic",
    candidates: [working],
    config: DEFAULT_CONFIG,
  });
  assert.equal(result.eligible, false);
  assert.equal(result.reason, "no-eligible-candidates");
  assert.ok(result.filteredBy.includes(FILTER_LABELS.notTrustedZone));
});

test("isDirectAnswerEligible rejects quarantine-zone memories", () => {
  const quarantined = makeCandidate({
    trustZone: "quarantine",
    memory: makeMemory({
      tags: ["package-manager"],
      content: "remnic uses pnpm",
    }),
  });
  const result = isDirectAnswerEligible({
    query: "package manager remnic",
    candidates: [quarantined],
    config: DEFAULT_CONFIG,
  });
  assert.equal(result.eligible, false);
  assert.ok(result.filteredBy.includes(FILTER_LABELS.notTrustedZone));
});

// ── Filter: taxonomy bucket must be in allowlist ────────────────────────────

test("isDirectAnswerEligible rejects candidates whose taxonomy bucket is not eligible", () => {
  const candidate = makeCandidate({
    taxonomyBucket: "corrections",
    memory: makeMemory({
      tags: ["package-manager"],
      content: "remnic uses pnpm",
    }),
  });
  const result = isDirectAnswerEligible({
    query: "package manager remnic",
    candidates: [candidate],
    config: DEFAULT_CONFIG,
  });
  assert.equal(result.eligible, false);
  assert.ok(result.filteredBy.includes(FILTER_LABELS.ineligibleTaxonomyBucket));
});

test("isDirectAnswerEligible rejects candidates with null taxonomy bucket", () => {
  const candidate = makeCandidate({
    taxonomyBucket: null,
    memory: makeMemory({
      tags: ["package-manager"],
      content: "remnic uses pnpm",
    }),
  });
  const result = isDirectAnswerEligible({
    query: "package manager remnic",
    candidates: [candidate],
    config: DEFAULT_CONFIG,
  });
  assert.equal(result.eligible, false);
});

// ── Filter: importance floor OR user_confirmed ──────────────────────────────

test("isDirectAnswerEligible keeps user_confirmed memory below importance floor", () => {
  const candidate = makeCandidate({
    importanceScore: 0.1,
    memory: makeMemory({
      verificationState: "user_confirmed",
      tags: ["package-manager"],
      content: "remnic uses pnpm",
    }),
  });
  const result = isDirectAnswerEligible({
    query: "package manager remnic",
    candidates: [candidate],
    config: DEFAULT_CONFIG,
  });
  assert.equal(result.eligible, true);
});

test("isDirectAnswerEligible rejects memory below importance floor without user_confirmed", () => {
  const candidate = makeCandidate({
    importanceScore: 0.3,
    memory: makeMemory({
      verificationState: "unverified",
      tags: ["package-manager"],
      content: "remnic uses pnpm",
    }),
  });
  const result = isDirectAnswerEligible({
    query: "package manager remnic",
    candidates: [candidate],
    config: DEFAULT_CONFIG,
  });
  assert.equal(result.eligible, false);
  assert.ok(result.filteredBy.includes(FILTER_LABELS.belowImportanceFloor));
});

test("isDirectAnswerEligible with importanceFloor=0 keeps low-importance memories (rule 45)", () => {
  const candidate = makeCandidate({
    importanceScore: 0,
    memory: makeMemory({
      verificationState: "unverified",
      tags: ["package-manager"],
      content: "remnic uses pnpm",
    }),
  });
  const result = isDirectAnswerEligible({
    query: "package manager remnic",
    candidates: [candidate],
    config: { ...DEFAULT_CONFIG, importanceFloor: 0 },
  });
  assert.equal(result.eligible, true);
});

// ── Filter: entity ref must match when caller supplies hints ────────────────

test("isDirectAnswerEligible filters candidates whose entityRef does not match provided hints", () => {
  const match = makeCandidate({
    memory: makeMemory({
      id: "match",
      entityRef: "remnic",
      tags: ["package-manager"],
      content: "remnic uses pnpm",
    }),
  });
  const mismatch = makeCandidate({
    memory: makeMemory({
      id: "mismatch",
      entityRef: "weclone",
      tags: ["package-manager"],
      content: "weclone uses npm",
    }),
  });
  const result = isDirectAnswerEligible({
    query: "package manager remnic",
    candidates: [mismatch, match],
    config: DEFAULT_CONFIG,
    queryEntityRefs: ["remnic"],
  });
  assert.equal(result.eligible, true);
  assert.equal(result.winner?.memory.frontmatter.id, "match");
  assert.ok(result.filteredBy.includes(FILTER_LABELS.entityRefMismatch));
});

test("isDirectAnswerEligible entity hint match is case-insensitive", () => {
  const candidate = makeCandidate({
    memory: makeMemory({
      entityRef: "Remnic",
      tags: ["package-manager"],
      content: "Remnic uses pnpm",
    }),
  });
  const result = isDirectAnswerEligible({
    query: "package manager remnic",
    candidates: [candidate],
    config: DEFAULT_CONFIG,
    queryEntityRefs: ["REMNIC"],
  });
  assert.equal(result.eligible, true);
});

test("isDirectAnswerEligible allows memories with no entityRef when hints are supplied", () => {
  const candidate = makeCandidate({
    memory: makeMemory({
      entityRef: undefined,
      tags: ["package-manager"],
      content: "pnpm is the package manager",
    }),
  });
  const result = isDirectAnswerEligible({
    query: "package manager",
    candidates: [candidate],
    config: DEFAULT_CONFIG,
    queryEntityRefs: ["remnic"],
  });
  assert.equal(result.eligible, true);
});

// ── Gate: token-overlap floor ───────────────────────────────────────────────

test("isDirectAnswerEligible rejects when no candidate meets the token-overlap floor", () => {
  const candidate = makeCandidate({
    memory: makeMemory({
      tags: [],
      content: "completely unrelated prose about sailing boats",
    }),
  });
  const result = isDirectAnswerEligible({
    query: "package manager remnic",
    candidates: [candidate],
    config: DEFAULT_CONFIG,
  });
  assert.equal(result.eligible, false);
  assert.equal(result.reason, "below-token-overlap-floor");
  assert.ok(result.filteredBy.includes(FILTER_LABELS.belowTokenOverlapFloor));
});

test("isDirectAnswerEligible does not pass CJK direct answers on shared common characters", () => {
  const candidate = makeCandidate({
    memory: makeMemory({
      tags: [],
      content: "用户讨厌深色主题",
    }),
  });
  const result = isDirectAnswerEligible({
    query: "用户喜欢深色模式",
    candidates: [candidate],
    config: { ...DEFAULT_CONFIG, tokenOverlapFloor: 0.55 },
  });
  assert.equal(result.eligible, false);
  assert.equal(result.reason, "below-token-overlap-floor");
  assert.ok(result.tokenOverlap === undefined);
  assert.ok(result.filteredBy.includes(FILTER_LABELS.belowTokenOverlapFloor));
});

test("isDirectAnswerEligible does not pass short CJK direct answers on shared suffixes", () => {
  const candidate = makeCandidate({
    memory: makeMemory({
      tags: [],
      content: "用户喜欢浅色模式",
    }),
  });
  const result = isDirectAnswerEligible({
    query: "深色模式",
    candidates: [candidate],
    config: { ...DEFAULT_CONFIG, tokenOverlapFloor: 0.55 },
  });
  assert.equal(result.eligible, false);
  assert.equal(result.reason, "below-token-overlap-floor");
  assert.ok(result.filteredBy.includes(FILTER_LABELS.belowTokenOverlapFloor));
});

test("isDirectAnswerEligible does not pass CJK direct answers on shared prefixes with opposite values", () => {
  const candidate = makeCandidate({
    memory: makeMemory({
      tags: [],
      content: "用户喜欢浅色模式",
    }),
  });
  const result = isDirectAnswerEligible({
    query: "用户喜欢深色模式",
    candidates: [candidate],
    config: { ...DEFAULT_CONFIG, tokenOverlapFloor: 0.55 },
  });
  assert.equal(result.eligible, false);
  assert.equal(result.reason, "below-token-overlap-floor");
  assert.ok(result.filteredBy.includes(FILTER_LABELS.belowTokenOverlapFloor));
});

test("isDirectAnswerEligible requires every independent CJK phrase before direct answering", () => {
  const candidate = makeCandidate({
    memory: makeMemory({
      tags: [],
      content: "用户喜欢深色模式",
    }),
  });
  const result = isDirectAnswerEligible({
    query: "用户喜欢深色模式 and 客户账户升级",
    candidates: [candidate],
    config: { ...DEFAULT_CONFIG, tokenOverlapFloor: 0.55 },
  });
  assert.equal(result.eligible, false);
  assert.equal(result.reason, "below-token-overlap-floor");
  assert.ok(result.filteredBy.includes(FILTER_LABELS.belowTokenOverlapFloor));
});

test("isDirectAnswerEligible does not require punctuation-bridged CJK aggregate phrases", () => {
  const candidate = makeCandidate({
    memory: makeMemory({
      tags: [],
      content: "用户喜欢深色模式 and 客户账户升级",
    }),
  });
  const result = isDirectAnswerEligible({
    query: "用户喜欢深色模式，客户账户升级",
    candidates: [candidate],
    config: { ...DEFAULT_CONFIG, tokenOverlapFloor: 0.55 },
  });
  assert.equal(result.eligible, true);
  assert.equal(result.reason, "eligible");
  assert.ok(result.tokenOverlap !== undefined && result.tokenOverlap >= 0.55);
});

test("isDirectAnswerEligible treats space-separated long CJK clauses as independent phrases", () => {
  const candidate = makeCandidate({
    memory: makeMemory({
      tags: [],
      content: "用户喜欢深色模式 and 客户账户升级",
    }),
  });
  const result = isDirectAnswerEligible({
    query: "用户喜欢深色模式 客户账户升级",
    candidates: [candidate],
    config: { ...DEFAULT_CONFIG, tokenOverlapFloor: 0.55 },
  });
  assert.equal(result.eligible, true);
  assert.equal(result.reason, "eligible");
  assert.ok(result.tokenOverlap !== undefined && result.tokenOverlap >= 0.55);
});

test("isDirectAnswerEligible bridges short spaced CJK query chunks", () => {
  const candidate = makeCandidate({
    memory: makeMemory({
      tags: [],
      content: "用户喜欢深色模式",
    }),
  });
  const result = isDirectAnswerEligible({
    query: "用户 喜欢 深色 模式",
    candidates: [candidate],
    config: { ...DEFAULT_CONFIG, tokenOverlapFloor: 0.55 },
  });
  assert.equal(result.eligible, true);
  assert.equal(result.reason, "eligible");
  assert.ok(result.tokenOverlap !== undefined && result.tokenOverlap >= 0.55);
});

test("isDirectAnswerEligible requires ASCII discriminators in mixed CJK terms", () => {
  const candidate = makeCandidate({
    memory: makeMemory({
      tags: [],
      content: "客户erp升级",
    }),
  });
  const result = isDirectAnswerEligible({
    query: "客户crm升级",
    candidates: [candidate],
    config: { ...DEFAULT_CONFIG, tokenOverlapFloor: 0.55 },
  });
  assert.equal(result.eligible, false);
  assert.equal(result.reason, "below-token-overlap-floor");
  assert.ok(result.filteredBy.includes(FILTER_LABELS.belowTokenOverlapFloor));
});

test("isDirectAnswerEligible accepts matching ASCII discriminators in mixed CJK terms", () => {
  const candidate = makeCandidate({
    memory: makeMemory({
      tags: [],
      content: "客户crm升级",
    }),
  });
  const result = isDirectAnswerEligible({
    query: "客户crm升级",
    candidates: [candidate],
    config: { ...DEFAULT_CONFIG, tokenOverlapFloor: 0.55 },
  });
  assert.equal(result.eligible, true);
  assert.equal(result.reason, "eligible");
  assert.ok(result.tokenOverlap !== undefined && result.tokenOverlap >= 0.55);
});

test("isDirectAnswerEligible requires spaced ASCII discriminators in mixed CJK terms", () => {
  const candidate = makeCandidate({
    memory: makeMemory({
      tags: [],
      content: "客户 ERP 升级",
    }),
  });
  const result = isDirectAnswerEligible({
    query: "客户 CRM 升级",
    candidates: [candidate],
    config: { ...DEFAULT_CONFIG, tokenOverlapFloor: 0.55 },
  });
  assert.equal(result.eligible, false);
  assert.equal(result.reason, "below-token-overlap-floor");
  assert.ok(result.filteredBy.includes(FILTER_LABELS.belowTokenOverlapFloor));
});

test("isDirectAnswerEligible requires short spaced ASCII discriminators in mixed CJK terms", () => {
  const candidate = makeCandidate({
    memory: makeMemory({
      tags: [],
      content: "客户 v1 升级",
    }),
  });
  const result = isDirectAnswerEligible({
    query: "客户 v2 升级",
    candidates: [candidate],
    config: { ...DEFAULT_CONFIG, tokenOverlapFloor: 0.55 },
  });
  assert.equal(result.eligible, false);
  assert.equal(result.reason, "below-token-overlap-floor");
  assert.ok(result.filteredBy.includes(FILTER_LABELS.belowTokenOverlapFloor));
});

test("isDirectAnswerEligible accepts matching spaced ASCII discriminators in mixed CJK terms", () => {
  const candidate = makeCandidate({
    memory: makeMemory({
      tags: [],
      content: "客户 CRM 升级",
    }),
  });
  const result = isDirectAnswerEligible({
    query: "客户 CRM 升级",
    candidates: [candidate],
    config: { ...DEFAULT_CONFIG, tokenOverlapFloor: 0.55 },
  });
  assert.equal(result.eligible, true);
  assert.equal(result.reason, "eligible");
  assert.ok(result.tokenOverlap !== undefined && result.tokenOverlap >= 0.55);
});

test("isDirectAnswerEligible accepts matching short spaced ASCII discriminators in mixed CJK terms", () => {
  const candidate = makeCandidate({
    memory: makeMemory({
      tags: [],
      content: "客户 v2 升级",
    }),
  });
  const result = isDirectAnswerEligible({
    query: "客户 v2 升级",
    candidates: [candidate],
    config: { ...DEFAULT_CONFIG, tokenOverlapFloor: 0.55 },
  });
  assert.equal(result.eligible, true);
  assert.equal(result.reason, "eligible");
  assert.ok(result.tokenOverlap !== undefined && result.tokenOverlap >= 0.55);
});

test("isDirectAnswerEligible requires end-boundary ASCII discriminators in mixed CJK terms", () => {
  const candidate = makeCandidate({
    memory: makeMemory({
      tags: [],
      content: "客户 ERP",
    }),
  });
  const result = isDirectAnswerEligible({
    query: "客户 CRM",
    candidates: [candidate],
    config: { ...DEFAULT_CONFIG, tokenOverlapFloor: 0.55 },
  });
  assert.equal(result.eligible, false);
  assert.equal(result.reason, "below-token-overlap-floor");
  assert.ok(result.filteredBy.includes(FILTER_LABELS.belowTokenOverlapFloor));
});

test("isDirectAnswerEligible accepts matching end-boundary ASCII discriminators in mixed CJK terms", () => {
  const candidate = makeCandidate({
    memory: makeMemory({
      tags: [],
      content: "客户 CRM",
    }),
  });
  const result = isDirectAnswerEligible({
    query: "客户 CRM",
    candidates: [candidate],
    config: { ...DEFAULT_CONFIG, tokenOverlapFloor: 0.55 },
  });
  assert.equal(result.eligible, true);
  assert.equal(result.reason, "eligible");
  assert.ok(result.tokenOverlap !== undefined && result.tokenOverlap >= 0.55);
});

test("isDirectAnswerEligible requires start-boundary ASCII discriminators in mixed CJK terms", () => {
  const candidate = makeCandidate({
    memory: makeMemory({
      tags: [],
      content: "ERP 客户",
    }),
  });
  const result = isDirectAnswerEligible({
    query: "CRM 客户",
    candidates: [candidate],
    config: { ...DEFAULT_CONFIG, tokenOverlapFloor: 0.55 },
  });
  assert.equal(result.eligible, false);
  assert.equal(result.reason, "below-token-overlap-floor");
  assert.ok(result.filteredBy.includes(FILTER_LABELS.belowTokenOverlapFloor));
});

test("isDirectAnswerEligible requires short CJK chunks around mixed-script discriminators", () => {
  const candidate = makeCandidate({
    memory: makeMemory({
      tags: [],
      content: "客户crm降级",
    }),
  });
  const result = isDirectAnswerEligible({
    query: "客户crm升级",
    candidates: [candidate],
    config: { ...DEFAULT_CONFIG, tokenOverlapFloor: 0.55 },
  });
  assert.equal(result.eligible, false);
  assert.equal(result.reason, "below-token-overlap-floor");
  assert.ok(result.filteredBy.includes(FILTER_LABELS.belowTokenOverlapFloor));
});

test("isDirectAnswerEligible requires short contiguous ASCII discriminators in mixed CJK terms", () => {
  const candidate = makeCandidate({
    memory: makeMemory({
      tags: [],
      content: "客户v1升级",
    }),
  });
  const result = isDirectAnswerEligible({
    query: "客户v2升级",
    candidates: [candidate],
    config: { ...DEFAULT_CONFIG, tokenOverlapFloor: 0.55 },
  });
  assert.equal(result.eligible, false);
  assert.equal(result.reason, "below-token-overlap-floor");
  assert.ok(result.filteredBy.includes(FILTER_LABELS.belowTokenOverlapFloor));
});

test("isDirectAnswerEligible accepts matching short contiguous ASCII discriminators in mixed CJK terms", () => {
  const candidate = makeCandidate({
    memory: makeMemory({
      tags: [],
      content: "客户v2升级",
    }),
  });
  const result = isDirectAnswerEligible({
    query: "客户v2升级",
    candidates: [candidate],
    config: { ...DEFAULT_CONFIG, tokenOverlapFloor: 0.55 },
  });
  assert.equal(result.eligible, true);
  assert.equal(result.reason, "eligible");
  assert.ok(result.tokenOverlap !== undefined && result.tokenOverlap >= 0.55);
});

test("isDirectAnswerEligible requires non-Latin discriminators in mixed CJK terms", () => {
  const candidate = makeCandidate({
    memory: makeMemory({
      tags: [],
      content: "客户α升级",
    }),
  });
  const result = isDirectAnswerEligible({
    query: "客户β升级",
    candidates: [candidate],
    config: { ...DEFAULT_CONFIG, tokenOverlapFloor: 0.55 },
  });
  assert.equal(result.eligible, false);
  assert.equal(result.reason, "below-token-overlap-floor");
  assert.ok(result.filteredBy.includes(FILTER_LABELS.belowTokenOverlapFloor));
});

test("isDirectAnswerEligible accepts matching non-Latin discriminators in mixed CJK terms", () => {
  const candidate = makeCandidate({
    memory: makeMemory({
      tags: [],
      content: "客户β升级",
    }),
  });
  const result = isDirectAnswerEligible({
    query: "客户β升级",
    candidates: [candidate],
    config: { ...DEFAULT_CONFIG, tokenOverlapFloor: 0.55 },
  });
  assert.equal(result.eligible, true);
  assert.equal(result.reason, "eligible");
  assert.ok(result.tokenOverlap !== undefined && result.tokenOverlap >= 0.55);
});

test("isDirectAnswerEligible requires boundary non-Latin discriminators in mixed CJK terms", () => {
  const candidate = makeCandidate({
    memory: makeMemory({
      tags: [],
      content: "客户 α",
    }),
  });
  const result = isDirectAnswerEligible({
    query: "客户 β",
    candidates: [candidate],
    config: { ...DEFAULT_CONFIG, tokenOverlapFloor: 0.55 },
  });
  assert.equal(result.eligible, false);
  assert.equal(result.reason, "below-token-overlap-floor");
  assert.ok(result.filteredBy.includes(FILTER_LABELS.belowTokenOverlapFloor));
});

test("isDirectAnswerEligible requires all non-CJK Unicode query tokens before direct answering", () => {
  const candidate = makeCandidate({
    memory: makeMemory({
      tags: [],
      content: "пользователь ненавидит темный режим",
    }),
  });
  const result = isDirectAnswerEligible({
    query: "пользователь любит темный режим",
    candidates: [candidate],
    config: { ...DEFAULT_CONFIG, tokenOverlapFloor: 0.55 },
  });
  assert.equal(result.eligible, false);
  assert.equal(result.reason, "below-token-overlap-floor");
  assert.ok(result.filteredBy.includes(FILTER_LABELS.belowTokenOverlapFloor));
});

test("isDirectAnswerEligible accepts matching non-CJK Unicode query tokens", () => {
  const candidate = makeCandidate({
    memory: makeMemory({
      tags: [],
      content: "пользователь любит темный режим",
    }),
  });
  const result = isDirectAnswerEligible({
    query: "пользователь любит темный режим",
    candidates: [candidate],
    config: { ...DEFAULT_CONFIG, tokenOverlapFloor: 0.55 },
  });
  assert.equal(result.eligible, true);
  assert.equal(result.reason, "eligible");
  assert.ok(result.tokenOverlap !== undefined && result.tokenOverlap >= 0.55);
});

test("isDirectAnswerEligible requires ASCII discriminators in non-CJK Unicode queries", () => {
  const candidate = makeCandidate({
    memory: makeMemory({
      tags: [],
      content: "клиент erp режим",
    }),
  });
  const result = isDirectAnswerEligible({
    query: "клиент crm режим",
    candidates: [candidate],
    config: { ...DEFAULT_CONFIG, tokenOverlapFloor: 0.55 },
  });
  assert.equal(result.eligible, false);
  assert.equal(result.reason, "below-token-overlap-floor");
  assert.ok(result.filteredBy.includes(FILTER_LABELS.belowTokenOverlapFloor));
});

test("isDirectAnswerEligible accepts matching ASCII discriminators in non-CJK Unicode queries", () => {
  const candidate = makeCandidate({
    memory: makeMemory({
      tags: [],
      content: "клиент crm режим",
    }),
  });
  const result = isDirectAnswerEligible({
    query: "клиент crm режим",
    candidates: [candidate],
    config: { ...DEFAULT_CONFIG, tokenOverlapFloor: 0.55 },
  });
  assert.equal(result.eligible, true);
  assert.equal(result.reason, "eligible");
  assert.ok(result.tokenOverlap !== undefined && result.tokenOverlap >= 0.55);
});

test("isDirectAnswerEligible does not require English prompt words before non-CJK Unicode terms", () => {
  const candidate = makeCandidate({
    memory: makeMemory({
      tags: [],
      content: "клиент режим",
    }),
  });
  for (const promptWord of ["find", "get", "status", "include"]) {
    const result = isDirectAnswerEligible({
      query: `${promptWord} клиент режим`,
      candidates: [candidate],
      config: { ...DEFAULT_CONFIG, tokenOverlapFloor: 0.55 },
    });
    assert.equal(result.eligible, true, promptWord);
    assert.equal(result.reason, "eligible", promptWord);
    assert.ok(result.tokenOverlap !== undefined && result.tokenOverlap >= 0.55, promptWord);
  }
});

test("isDirectAnswerEligible does not require Russian prompt words before non-CJK Unicode terms", () => {
  const candidate = makeCandidate({
    memory: makeMemory({
      tags: [],
      content: "пользователь любит темный режим",
    }),
  });
  const result = isDirectAnswerEligible({
    query: "найди пользователь любит темный режим",
    candidates: [candidate],
    config: { ...DEFAULT_CONFIG, tokenOverlapFloor: 0.55 },
  });
  assert.equal(result.eligible, true);
  assert.equal(result.reason, "eligible");
  assert.ok(result.tokenOverlap !== undefined && result.tokenOverlap >= 0.55);
});

test("isDirectAnswerEligible matches CJK direct answers across inserted spaces", () => {
  const candidate = makeCandidate({
    memory: makeMemory({
      tags: [],
      content: "用户 喜欢 深色 模式",
    }),
  });
  const result = isDirectAnswerEligible({
    query: "用户喜欢深色模式",
    candidates: [candidate],
    config: { ...DEFAULT_CONFIG, tokenOverlapFloor: 0.55 },
  });
  assert.equal(result.eligible, true);
  assert.equal(result.reason, "eligible");
  assert.ok(result.tokenOverlap !== undefined && result.tokenOverlap >= 0.55);
});

test("isDirectAnswerEligible does not require English prompt words before CJK terms", () => {
  const candidate = makeCandidate({
    memory: makeMemory({
      tags: [],
      content: "用户喜欢深色模式",
    }),
  });
  const result = isDirectAnswerEligible({
    query: "what is 用户喜欢深色模式",
    candidates: [candidate],
    config: { ...DEFAULT_CONFIG, tokenOverlapFloor: 0.5 },
  });
  assert.equal(result.eligible, true);
  assert.equal(result.reason, "eligible");
  assert.ok(result.tokenOverlap !== undefined && result.tokenOverlap >= 0.5);
});

test("isDirectAnswerEligible does not require a single English prompt word before CJK terms", () => {
  const candidate = makeCandidate({
    memory: makeMemory({
      tags: [],
      content: "用户喜欢深色模式",
    }),
  });
  const result = isDirectAnswerEligible({
    query: "what 用户喜欢深色模式",
    candidates: [candidate],
    config: { ...DEFAULT_CONFIG, tokenOverlapFloor: 0.5 },
  });
  assert.equal(result.eligible, true);
  assert.equal(result.reason, "eligible");
  assert.ok(result.tokenOverlap !== undefined && result.tokenOverlap >= 0.5);
});

test("isDirectAnswerEligible does not require English recall verbs before CJK terms", () => {
  const candidate = makeCandidate({
    memory: makeMemory({
      tags: [],
      content: "用户喜欢深色模式",
    }),
  });
  for (const promptWord of ["find", "status", "include"]) {
    const result = isDirectAnswerEligible({
      query: `${promptWord} 用户喜欢深色模式`,
      candidates: [candidate],
      config: { ...DEFAULT_CONFIG, tokenOverlapFloor: 0.5 },
    });
    assert.equal(result.eligible, true, promptWord);
    assert.equal(result.reason, "eligible", promptWord);
    assert.ok(result.tokenOverlap !== undefined && result.tokenOverlap >= 0.5, promptWord);
  }
});

test("isDirectAnswerEligible with tokenOverlapFloor=0 accepts any overlap (rule 45)", () => {
  const candidate = makeCandidate({
    memory: makeMemory({
      tags: [],
      content: "tangential content with remnic mentioned once",
    }),
  });
  const result = isDirectAnswerEligible({
    query: "package manager remnic",
    candidates: [candidate],
    config: { ...DEFAULT_CONFIG, tokenOverlapFloor: 0 },
  });
  assert.equal(result.eligible, true);
});

test("isDirectAnswerEligible rejects required CJK phrase misses when tokenOverlapFloor=0", () => {
  const candidate = makeCandidate({
    memory: makeMemory({
      tags: [],
      content: "用户讨厌深色主题",
    }),
  });
  const result = isDirectAnswerEligible({
    query: "用户喜欢深色模式",
    candidates: [candidate],
    config: { ...DEFAULT_CONFIG, tokenOverlapFloor: 0 },
  });
  assert.equal(result.eligible, false);
  assert.equal(result.reason, "below-token-overlap-floor");
  assert.ok(result.filteredBy.includes(FILTER_LABELS.belowTokenOverlapFloor));
});

test("isDirectAnswerEligible rejects required mixed-script misses when tokenOverlapFloor=0", () => {
  const candidate = makeCandidate({
    memory: makeMemory({
      tags: [],
      content: "客户crm降级",
    }),
  });
  const result = isDirectAnswerEligible({
    query: "客户crm升级",
    candidates: [candidate],
    config: { ...DEFAULT_CONFIG, tokenOverlapFloor: 0 },
  });
  assert.equal(result.eligible, false);
  assert.equal(result.reason, "below-token-overlap-floor");
  assert.ok(result.filteredBy.includes(FILTER_LABELS.belowTokenOverlapFloor));
});

test("isDirectAnswerEligible rejects required non-CJK Unicode misses when tokenOverlapFloor=0", () => {
  const candidate = makeCandidate({
    memory: makeMemory({
      tags: [],
      content: "пользователь ненавидит темный режим",
    }),
  });
  const result = isDirectAnswerEligible({
    query: "пользователь любит темный режим",
    candidates: [candidate],
    config: { ...DEFAULT_CONFIG, tokenOverlapFloor: 0 },
  });
  assert.equal(result.eligible, false);
  assert.equal(result.reason, "below-token-overlap-floor");
  assert.ok(result.filteredBy.includes(FILTER_LABELS.belowTokenOverlapFloor));
});

// ── Gate: ambiguity margin ──────────────────────────────────────────────────

test("isDirectAnswerEligible defers to hybrid when top two candidates are within ambiguity margin", () => {
  const a = makeCandidate({
    memory: makeMemory({
      id: "a",
      path: "/a.md",
      tags: ["package-manager", "remnic"],
      content: "remnic uses pnpm",
    }),
    matchScore: 0.9,
  });
  const b = makeCandidate({
    memory: makeMemory({
      id: "b",
      path: "/b.md",
      tags: ["package-manager", "remnic"],
      content: "remnic uses pnpm as its package manager",
    }),
    matchScore: 0.85,
  });
  const result = isDirectAnswerEligible({
    query: "package manager remnic",
    candidates: [a, b],
    config: { ...DEFAULT_CONFIG, ambiguityMargin: 0.15 },
  });
  assert.equal(result.eligible, false);
  assert.equal(result.reason, "ambiguous");
});

test("isDirectAnswerEligible keeps top candidate when second is beyond ambiguity margin", () => {
  const top = makeCandidate({
    memory: makeMemory({
      id: "top",
      path: "/top.md",
      tags: ["package-manager", "remnic"],
      content: "remnic uses pnpm",
    }),
    matchScore: 0.9,
  });
  const weak = makeCandidate({
    memory: makeMemory({
      id: "weak",
      path: "/weak.md",
      tags: ["package-manager"],
      content: "package manager",
    }),
    matchScore: 0.3,
  });
  const result = isDirectAnswerEligible({
    query: "package manager remnic",
    candidates: [top, weak],
    config: { ...DEFAULT_CONFIG, ambiguityMargin: 0.15 },
  });
  assert.equal(result.eligible, true);
  assert.equal(result.winner?.memory.frontmatter.id, "top");
});

// ── Sort stability (CLAUDE.md rule 19) ──────────────────────────────────────

test("isDirectAnswerEligible sort falls back to path comparison when scores tie", () => {
  const a = makeCandidate({
    memory: makeMemory({
      id: "a",
      path: "/aaa.md",
      tags: ["package-manager", "remnic"],
      content: "remnic uses pnpm",
    }),
    matchScore: 0.9,
  });
  const b = makeCandidate({
    memory: makeMemory({
      id: "b",
      path: "/zzz.md",
      tags: ["package-manager", "remnic"],
      content: "remnic uses pnpm",
    }),
    matchScore: 0.9,
  });
  // Both score identically, which would normally trigger the ambiguity gate.
  // Set ambiguityMargin to 0 so ties don't auto-defer, and verify the stable
  // secondary sort returns the same winner regardless of input order.
  const forward = isDirectAnswerEligible({
    query: "package manager remnic",
    candidates: [a, b],
    config: { ...DEFAULT_CONFIG, ambiguityMargin: 0 },
  });
  const backward = isDirectAnswerEligible({
    query: "package manager remnic",
    candidates: [b, a],
    config: { ...DEFAULT_CONFIG, ambiguityMargin: 0 },
  });
  assert.equal(forward.winner?.memory.frontmatter.id, "a");
  assert.equal(backward.winner?.memory.frontmatter.id, "a");
});

// ── Happy path narrative ────────────────────────────────────────────────────

test("isDirectAnswerEligible eligible result includes narrative with bucket and overlap", () => {
  const candidate = makeCandidate({
    memory: makeMemory({
      tags: ["package-manager", "remnic"],
      content: "remnic uses pnpm as its package manager",
    }),
  });
  const result = isDirectAnswerEligible({
    query: "package manager remnic",
    candidates: [candidate],
    config: DEFAULT_CONFIG,
  });
  assert.equal(result.eligible, true);
  assert.equal(result.reason, "eligible");
  assert.ok(result.narrative.includes("decisions"));
  assert.ok(result.narrative.includes("unambiguous"));
  assert.ok(result.narrative.includes("token-overlap"));
  assert.ok(result.tokenOverlap !== undefined && result.tokenOverlap > 0);
});
