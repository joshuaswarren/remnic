/**
 * Coding-agent namespace overlay (issue #569 PR 2 + PR 3).
 *
 * Given a `CodingContext` (from `resolveGitContext`) and a `CodingModeConfig`,
 * returns the namespace that recall + write paths should use — or `null` when
 * no overlay should apply (coding mode disabled, no context supplied, or
 * feature flags off).
 *
 * PR 2 ships the project overlay. PR 3 will add the branch overlay; the
 * function here already handles both flags so the schema / types / plumbing
 * don't have to change a second time when branch-scope lands.
 *
 * Pure function — no orchestrator, no config side-effects. Callers keep rule
 * 42 (read + write through same namespace layer) by consulting the same
 * function on both paths.
 */

import type { CodingContext, CodingModeConfig } from "../types.js";
import { stableHash } from "./git-context.js";

export interface CodingNamespaceOverlay {
  /**
   * Effective namespace to use for this session's memory operations. When
   * `branchScope` is on, takes the form `project:<id>/branch:<b>`; otherwise
   * `project:<id>`.
   */
  namespace: string;
  /**
   * Read fallbacks — additional namespaces a caller should include in recall
   * so that, for example, a branch-scoped session still sees project-level
   * memories that were written before the branch scope was enabled.
   *
   * Writes MUST go to `namespace` only; these are read-side only.
   *
   * Introduced to carry PR 3's branch→project fallback; PR 2 returns an empty
   * array here.
   */
  readFallbacks: string[];
  /**
   * `"project"` when only project scope applies, `"branch"` when branch scope
   * is also layered on. Used for diagnostics (`remnic doctor`) and logging.
   */
  scope: "project" | "branch";
}

// ──────────────────────────────────────────────────────────────────────────
// Sanitization
// ──────────────────────────────────────────────────────────────────────────

/**
 * Normalize a projectId / branch fragment so the resulting namespace passes
 * the router's `isSafeRouteNamespace` check (`[A-Za-z0-9._-]{1,64}`).
 *
 * Namespaces are used as filesystem directory names and must not contain
 * path separators (`/`, `\`) or colons — so both `:` and `/` collapse to `-`.
 * The project-id format `origin:<8hex>` and branch names like `feat/x` both
 * flow through this helper before hitting the storage layer.
 *
 * NOT a security boundary — projectIds come from `resolveGitContext` (known
 * hex), and branch names come from local git. This defends against corrupt
 * input only.
 */
/**
 * Single-pass sanitization — each input character is visited exactly once.
 * Rewriting as an explicit loop (instead of chained `replace()` calls with
 * greedy quantifiers) closes the polynomial-backtracking surface that
 * CodeQL flagged on patterns like `-+` and `^-+|-+$`.
 */
function sanitizeFragment(input: string): string {
  if (typeof input !== "string") return "";
  const trimmed = input.trim().toLowerCase();
  let out = "";
  let prevIsDash = true; // suppress leading dashes
  for (let i = 0; i < trimmed.length; i += 1) {
    const c = trimmed[i]!;
    const cc = trimmed.charCodeAt(i);
    const isSafe =
      (cc >= 48 && cc <= 57) /* 0-9 */ ||
      (cc >= 97 && cc <= 122) /* a-z */ ||
      cc === 46 /* . */ ||
      cc === 95 /* _ */;
    if (isSafe) {
      out += c;
      prevIsDash = false;
    } else if (!prevIsDash) {
      out += "-";
      prevIsDash = true;
    }
  }
  // Strip a single trailing dash introduced by the final run of unsafe chars.
  if (out.endsWith("-")) out = out.slice(0, -1);
  return out;
}

/**
 * Cap to the router's per-namespace upper bound.
 *
 * Raw truncation alone would collapse distinct long inputs that differ near
 * the end (e.g. two `feat/...` branches with different suffixes) into the
 * same namespace — silently mixing recall/write state across branches or
 * projects. When truncation is needed, we append a short deterministic
 * hash suffix (`-<8hex>`) derived from the FULL pre-truncated value so
 * collisions only happen under true hash collisions, not simple prefix
 * overlap.
 *
 * The tail is trimmed to leave room for the separator and 8-char hash and
 * any trailing `-` introduced by the slice is stripped so the final
 * character before `-<hash>` is always alphanumeric or `.`/`_`.
 */
const MAX_NAMESPACE_LEN = 64;
const HASH_SUFFIX_LEN = 9; // "-" + 8 hex chars

function capLength(value: string): string {
  if (value.length <= MAX_NAMESPACE_LEN) return value;
  // Reuse the FNV-1a 32-bit hash from git-context — one canonical
  // implementation, one set of edge-case fixes. Uses Math.imul for
  // correct 32-bit wrap-around, which plain `*` would not guarantee
  // for the largest intermediate products.
  const hash = stableHash(value);
  // Trim trailing '-' with a linear, non-backtracking loop. A regex
  // like `-+$` is linear too, but an explicit loop keeps CodeQL happy
  // about polynomial backtracking warnings when several `\-+` patterns
  // appear in the same module.
  let end = MAX_NAMESPACE_LEN - HASH_SUFFIX_LEN;
  while (end > 0 && value.charCodeAt(end - 1) === 45 /* '-' */) end -= 1;
  return `${value.slice(0, end)}-${hash}`;
}

/**
 * Produce the project-scope namespace name. Exported for tests and for
 * `remnic doctor` to render. Guaranteed to satisfy `isSafeRouteNamespace`:
 * no `/`, no `:`, lowercase only, length-capped to 64 chars.
 */
export function projectNamespaceName(projectId: string): string {
  const frag = sanitizeFragment(projectId);
  return capLength(`project-${frag || "unknown"}`);
}

export function projectTagProjectId(projectTag: string): string {
  const trimmed = projectTag.trim();
  const frag = sanitizeFragment(trimmed);
  const disambig = trimmed.length > 0 && frag !== trimmed;
  const suffix = disambig ? `-${stableHash(trimmed)}` : "";
  return `tag:${frag || "unknown"}${suffix}`;
}

/**
 * Preserve case when sanitizing a principal-derived base namespace. The
 * router's `isSafeRouteNamespace` check accepts `[A-Za-z0-9._-]{1,64}`, so
 * upper-case characters in the principal name are safe and MUST be kept to
 * avoid colliding two otherwise-distinct principals (e.g. `Alice` vs
 * `alice`) into the same combined namespace.
 *
 * Otherwise identical to `sanitizeFragment`: single-pass, linear, no
 * polynomial-backtracking quantifiers, unsafe chars collapse to `-` with
 * leading/trailing dashes suppressed.
 */
function sanitizeBaseFragment(input: string): string {
  if (typeof input !== "string") return "";
  const trimmed = input.trim();
  let out = "";
  let prevIsDash = true;
  for (let i = 0; i < trimmed.length; i += 1) {
    const c = trimmed[i]!;
    const cc = trimmed.charCodeAt(i);
    const isSafe =
      (cc >= 48 && cc <= 57) /* 0-9 */ ||
      (cc >= 65 && cc <= 90) /* A-Z */ ||
      (cc >= 97 && cc <= 122) /* a-z */ ||
      cc === 46 /* . */ ||
      cc === 95 /* _ */;
    if (isSafe) {
      out += c;
      prevIsDash = false;
    } else if (!prevIsDash) {
      out += "-";
      prevIsDash = true;
    }
  }
  if (out.endsWith("-")) out = out.slice(0, -1);
  return out;
}

/**
 * Combine a principal-derived base namespace (e.g. `default`, `alice`) with a
 * coding-agent overlay namespace (e.g. `project-origin-abcd1234`). The result
 * is a single safe-route token that preserves principal isolation (CLAUDE.md
 * rule 42: read + write must resolve through the same namespace layer — and
 * here, through the same principal-scoped prefix) while layering project or
 * project/branch scope on top.
 *
 * Multiple principals working in the same repo thus get distinct namespaces:
 *
 *   alice + project-origin-ab12  →  alice-project-origin-ab12
 *   bob   + project-origin-ab12  →  bob-project-origin-ab12
 *   Alice + project-origin-ab12  →  Alice-project-origin-ab12 (distinct)
 *
 * The base fragment preserves case so `Alice` and `alice` remain distinct;
 * the overlay fragment is still lowercase-sanitized because it derives from
 * deterministic, pre-lowercased git hashes.
 *
 * Output is re-capped through `capLength` so a very long base + overlay
 * combination still fits inside `isSafeRouteNamespace` (≤ 64 chars). The
 * deterministic hash suffix on truncation keeps distinct inputs distinct.
 */
export function combineNamespaces(base: string, overlay: string): string {
  const baseFrag = sanitizeBaseFragment(base);
  const overlayFrag = sanitizeFragment(overlay);
  if (!baseFrag) return capLength(overlayFrag || "unknown");
  if (!overlayFrag) return capLength(baseFrag);
  return capLength(`${baseFrag}-${overlayFrag}`);
}

/**
 * Produce the branch-scope namespace name. Format:
 * `project-<id>-branch-<name>[-<hash>]`. Uses `-` as the structural separator
 * rather than `/` or `:` so the result is a single safe route-namespace
 * token that can be used directly as a filesystem directory.
 *
 * Two failure modes must not collapse distinct branches to one namespace:
 *
 *   1. Sanitization is lossy (`feat/x` and `feat-x` both sanitize to
 *      `feat-x`; `Feature` and `feature` both sanitize to `feature`). When
 *      sanitization rewrote any character, we append a short hash of the
 *      RAW branch so distinct inputs stay distinct.
 *   2. Truncation is applied when the total exceeds 64 chars. In that
 *      mode `capLength` appends its own hash of the full pre-truncated
 *      value.
 *
 * Long branches that also sanitize may receive both kinds of hashes — that
 * is acceptable: the router only requires the result be unique and
 * deterministic, and the two hashes derive from different domains so they
 * don't conflict.
 */
export function branchNamespaceName(projectId: string, branch: string): string {
  const projectFrag = sanitizeFragment(projectId);
  const trimmedBranch = branch.trim();
  const branchFrag = sanitizeFragment(trimmedBranch);
  // Lossy-sanitization disambiguator: append hash of the raw (trimmed)
  // branch when sanitization actually changed the string. Preserves
  // distinctness across `feat/x` vs `feat-x` and `Feature` vs `feature`.
  // The comparison uses the raw trimmed value (NOT `.toLowerCase()`) so
  // case-only variants are treated as lossy and receive their own hash.
  // Empty / already-safe-lowercase inputs get no hash so the common case
  // stays readable.
  const disambig = trimmedBranch.length > 0 && branchFrag !== trimmedBranch;
  const base = `project-${projectFrag || "unknown"}-branch-${branchFrag || "unknown"}`;
  const suffixed = disambig ? `${base}-${stableHash(trimmedBranch)}` : base;
  return capLength(suffixed);
}

// ──────────────────────────────────────────────────────────────────────────
// Overlay resolver
// ──────────────────────────────────────────────────────────────────────────

/**
 * Compute the namespace overlay for a session.
 *
 * Returns `null` when no overlay applies — callers should then use their
 * existing `defaultNamespaceForPrincipal(...)` result unchanged. This keeps
 * CLAUDE.md #30 (escape hatch): setting `codingMode.projectScope: false`
 * exactly restores pre-#569 behaviour at every call site.
 *
 * @param codingContext — git context from the connector
 * @param config — coding mode flags (projectScope, branchScope, globalFallback)
 * @param defaultNamespace — retained for call-site compatibility; no longer
 *   used. The global fallback is expressed as an empty-string sentinel in
 *   `readFallbacks`, which `combineNamespaces(principal, "")` resolves to the
 *   principal's own namespace at the call site.
 */
export function resolveCodingNamespaceOverlay(
  codingContext: CodingContext | null | undefined,
  config: Pick<CodingModeConfig, "projectScope" | "branchScope" | "globalFallback">,
  defaultNamespace?: string,
): CodingNamespaceOverlay | null {
  // No context supplied (session isn't in a git repo, or connector didn't
  // attach one) → no overlay.
  if (!codingContext) return null;

  // Project scope disabled → no overlay at all. Branch scope depends on
  // project scope being on; there is no branch-only mode.
  if (!config.projectScope) return null;

  // Require a non-empty projectId — defensive.
  const projectId = typeof codingContext.projectId === "string" ? codingContext.projectId.trim() : "";
  if (!projectId) return null;

  const projectNs = projectNamespaceName(projectId);

  // Root/global namespace fallback: when `globalFallback` is true, include
  // the principal's self namespace in readFallbacks so cross-project knowledge
  // remains visible. CLAUDE.md #30: the gate is `globalFallback` — set to
  // false for strict project isolation.
  //
  // The fallback value is "" (empty string), NOT the defaultNamespace name.
  // The orchestrator passes each fallback through combineNamespaces(principal, fallback),
  // and combineNamespaces(base, "") returns base unchanged — yielding the
  // principal's own namespace. Using the actual namespace name (e.g., "default")
  // would produce "default-default" after combination, missing the target.
  const includeRoot = config.globalFallback === true;

  // Branch-scope layering (PR 3):
  //   - only when config.branchScope is explicitly true
  //   - only when we actually have a branch (null in detached HEAD)
  //   - project namespace becomes a read fallback so project-level memories
  //     remain visible from any branch (deliberate asymmetry — branch writes
  //     don't leak up, but project reads leak down).
  //   - when globalFallback is on, the root namespace is also appended so
  //     globally useful memories surface in every branch.
  if (config.branchScope && typeof codingContext.branch === "string" && codingContext.branch.length > 0) {
    const branchNs = branchNamespaceName(projectId, codingContext.branch);
    const fallbacks = [projectNs];
    if (includeRoot) fallbacks.push("");
    return {
      namespace: branchNs,
      readFallbacks: fallbacks,
      scope: "branch",
    };
  }

  return {
    namespace: projectNs,
    readFallbacks: includeRoot ? [""] : [],
    scope: "project",
  };
}

// ──────────────────────────────────────────────────────────────────────────
// Diagnostics (issue #569 PR 3 + PR 8)
// ──────────────────────────────────────────────────────────────────────────

export interface CodingScopeDescription {
  /** "none" when no overlay is active; otherwise the resolved scope level. */
  scope: "none" | "project" | "branch";
  /** Project id (raw, not sanitized) when a context is attached. */
  projectId: string | null;
  /** Branch name (raw, not sanitized) when available. */
  branch: string | null;
  /** Effective namespace writes route to. `null` when no overlay applies. */
  effectiveNamespace: string | null;
  /** Read fallbacks included in recall (non-empty only when branch-scope is on). */
  readFallbacks: string[];
  /**
   * Why no overlay applies, when `scope === "none"`. One of:
   *   - `"no-context"`  — connector didn't attach a CodingContext
   *   - `"disabled"`   — codingMode.projectScope is false
   *   - `"empty-project"` — codingContext.projectId was empty/whitespace
   */
  disabledReason: "no-context" | "disabled" | "empty-project" | null;
}

/**
 * Human-readable description of the coding-agent scope that currently applies
 * for a session. Consumed by `remnic doctor` (PR 8) and by logs to surface
 * why recall routes where it does.
 *
 * Pure — callers pass the coding context + config they already have.
 */
export function describeCodingScope(
  codingContext: CodingContext | null | undefined,
  config: Pick<CodingModeConfig, "projectScope" | "branchScope" | "globalFallback">,
  defaultNamespace?: string,
): CodingScopeDescription {
  const projectId = codingContext?.projectId ?? null;
  const branch = codingContext?.branch ?? null;

  if (!codingContext) {
    return {
      scope: "none",
      projectId: null,
      branch: null,
      effectiveNamespace: null,
      readFallbacks: [],
      disabledReason: "no-context",
    };
  }
  if (!config.projectScope) {
    return {
      scope: "none",
      projectId,
      branch,
      effectiveNamespace: null,
      readFallbacks: [],
      disabledReason: "disabled",
    };
  }
  const trimmedId = typeof projectId === "string" ? projectId.trim() : "";
  if (!trimmedId) {
    return {
      scope: "none",
      projectId,
      branch,
      effectiveNamespace: null,
      readFallbacks: [],
      disabledReason: "empty-project",
    };
  }

  const overlay = resolveCodingNamespaceOverlay(codingContext, config, defaultNamespace);
  // Unreachable in practice given the guards above, but keep the return
  // shape consistent if the resolver grows new null branches later.
  if (!overlay) {
    return {
      scope: "none",
      projectId,
      branch,
      effectiveNamespace: null,
      readFallbacks: [],
      disabledReason: "disabled",
    };
  }
  return {
    scope: overlay.scope,
    projectId,
    branch,
    effectiveNamespace: overlay.namespace,
    readFallbacks: overlay.readFallbacks,
    disabledReason: null,
  };
}
