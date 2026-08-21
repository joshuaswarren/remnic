import { TrapTaxonomyItemSchema } from "./types.js";
import type { H6TrapId, TrapTaxonomyItem } from "./types.js";

export const TRAP_TAXONOMY: TrapTaxonomyItem[] = [
  {
    trapId: "flaky-looking-test",
    name: "Flaky Looking Test",
    description:
      "Agent misdiagnoses deterministic timing/concurrency failure as test flakiness " +
      "and adds retry loops or sleeps instead of fixing the race condition.",
    trapMechanism: "Test fails intermittently under load; agent wraps test assertion in retry loop.",
    correctFix: "Synchronize state transition via explicit await / promise barrier before asserting.",
    inspiredBy: "real failure-loop pattern: retry-wrapped flaky test assertions in CI",
  },
  {
    trapId: "misleading-error-message",
    name: "Misleading Error Message",
    description:
      "Upstream error text reports the wrong cause, such as file-not-found for a parse " +
      "failure, which tempts the agent to edit the wrong path.",
    trapMechanism: "Error handler catches generic exception and throws misleading path error.",
    correctFix: "Inspect actual exception cause and handle parse/permission error at origin.",
    inspiredBy: "real failure-loop pattern: patching missing file path reported by misleading error wrapper",
  },
  {
    trapId: "wrong-layer-fix",
    name: "Wrong Layer Fix",
    description:
      "Agent patches caller or UI/API presentation layer instead of fixing core domain rule or schema validator.",
    trapMechanism: "Data validation failure at domain boundary; agent adds inline sanitization in handler.",
    correctFix: "Update domain entity schema validator to enforce invariant globally.",
    inspiredBy: "real failure-loop pattern: caller-side string sanitization bypassing core domain validator",
  },
  {
    trapId: "hidden-invariant",
    name: "Hidden Invariant",
    description:
      "Code changes can break architectural invariants not enforced by TypeScript, " +
      "including ordering, immutability, and scope-key format.",
    trapMechanism:
      "Modifying state object in-place passes local unit test but breaks downstream immutability subscriber.",
    correctFix: "Produce new immutable copy of state object during update.",
    inspiredBy: "real failure-loop pattern: in-place state mutation causing missed change notifications",
  },
  {
    trapId: "stale-cache-illusion",
    name: "Stale Cache Illusion",
    description:
      "Agent modifies calculation logic without invalidating or updating cached calculation key/result.",
    trapMechanism:
      "Calculation function returns cached result; agent edits calculation but leaves cache key unchanged.",
    correctFix:
      "Include modified calculation parameters in cache key derivation or invalidate cache on mutation.",
    inspiredBy: "real failure-loop pattern: logic refactor returning stale cached computations",
  },
  {
    trapId: "config-shadowing",
    name: "Config Shadowing",
    description:
      "Agent edits global/default configuration file while runtime environment or local override file shadows setting.",
    trapMechanism:
      "Runtime reads local/env config override file first; editing default config file has zero effect.",
    correctFix: "Update active runtime config override or consolidate config priority loader.",
    inspiredBy: "real failure-loop pattern: editing root config file while shadowed by local dev override",
  },
];

export function getTrapTaxonomyItem(trapId: H6TrapId): TrapTaxonomyItem {
  const item = TRAP_TAXONOMY.find((t) => t.trapId === trapId);
  if (!item) {
    throw new Error(`Unknown trap id: ${trapId}`);
  }
  return item;
}

for (const item of TRAP_TAXONOMY) {
  TrapTaxonomyItemSchema.parse(item);
}
