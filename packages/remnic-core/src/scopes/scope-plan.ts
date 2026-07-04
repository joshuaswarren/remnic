/**
 * ScopePlan resolver (issue #1521).
 *
 * A single pure function that resolves every namespace-bearing read/write path
 * to one {@link ScopePlan} value object. Consumers (recall tiers, QMD router,
 * LCM reads, maintenance) never call the ad-hoc resolution helpers directly —
 * they receive a resolved plan and read its fields.
 *
 * The resolver DELEGATES to the existing helpers (`resolvePrincipal`,
 * `recallNamespacesForPrincipal`, `resolveCodingNamespaceOverlay`,
 * `resolveScopeProfilePlan`, `expandScopeProfileReadNamespaces`,
 * `combineNamespaces`, `lcmReadSessionIdsForNamespaces`) — no logic rewrite.
 * The ad-hoc inline resolution that previously lived in the orchestrator's
 * `recallInternal` and `enqueueDirectAnswerObservation` paths is replaced by a
 * single call to {@link resolveScopePlan}, eliminating the duplicated
 * namespace-set construction that produced the largest share of #1519's review
 * threads (scope-profile recall paths missing `readFallbacks` appends).
 *
 * Migration tranches (issue #1521 step 4):
 *  - recall tiers (this PR): the two orchestrator recall entry points consume
 *    the plan instead of building `recallNamespaces`/`observationNamespaces`
 *    inline;
 *  - QMD router calls, LCM reads, maintenance: follow-up PRs.
 *
 * CLAUDE.md rules honoured (pitfalls from the issue):
 *  - rule 42: read/write resolve through the same layer; the coding overlay is
 *    COMBINED with the principal base via `combineNamespaces`;
 *  - rule 39: feature gates identical across every path the plan feeds;
 *  - rule 22/48: LCM keys derived through `lcmSessionKeyForNamespace` (via
 *    `lcmReadSessionIdsForNamespaces`), never hardcoded `:`-joins; unscoped LCM
 *    search stays suppressed when `namespacesEnabled`.
 */

import {
  canReadNamespace,
  defaultNamespaceForPrincipal,
  recallNamespacesForPrincipal,
  resolvePrincipal,
} from "../namespaces/principal.js";
import type { ResolvedScopeProfilePlan } from "../namespaces/scope-profiles.js";
import {
  expandScopeProfileReadNamespaces,
  resolveScopeProfilePlan,
} from "../namespaces/scope-profiles.js";
import {
  combineNamespaces,
  lcmReadSessionIdsForNamespaces,
  resolveCodingNamespaceOverlay,
  type CodingNamespaceOverlay,
} from "../coding/coding-namespace.js";
import type { CodingContext, PluginConfig } from "../types.js";

/**
 * A resolved scope plan: every namespace-bearing field a read or write path
 * needs, produced by ONE call to {@link resolveScopePlan}.
 *
 * Consumers read these fields directly — they never re-resolve namespaces.
 */
export interface ScopePlan {
  /**
   * Resolved principal under which the operation runs. `undefined` only when
   * `namespacesEnabled` is false (collapses to `"default"`) or no session key
   * was supplied in single-user mode.
   */
  readonly principal: string | undefined;

  /**
   * Explicit namespace override, trimmed, when the caller supplied one AND it
   * is readable by the principal. `undefined` when no override was given or the
   * override is not readable (the plan falls through to the coding/scope-profile
   * resolution in that case, mirroring the pre-existing observe-path behavior).
   */
  readonly namespaceOverride: string | undefined;

  /**
   * Resolved base (self) namespace — the effective namespace absent an explicit
   * override. This is the principal-self namespace, optionally substituted by a
   * scope-profile write layer or a coding overlay.
   *
   * Callers that persisted this as the `selfNamespace` / response namespace
   * read it here.
   */
  readonly baseNamespace: string;

  /**
   * Ordered, deduped read-namespace set. Includes the coding overlay fallbacks
   * (branch → project → root) combined with the principal base exactly once, so
   * the #1519 miss (scope-profile path omitted `readFallbacks` appends) cannot
   * recur — the fallback appends live in ONE place.
   */
  readonly readNamespaces: string[];

  /**
   * Coding overlay fallback namespaces combined with the principal base (rule
   * 42). Empty when no coding overlay applies. These are the SAME entries
   * appended into {@link readNamespaces} for the coding-overlay branch,
   * surfaced separately so consumers that need just the fallback set (e.g.
   * LCM read-key derivation) can read them without re-deriving.
   */
  readonly readFallbacks: string[];

  /**
   * LCM read namespace set. May differ from {@link readNamespaces} for
   * read-authorization reasons: when the principal self base is NOT in the
   * readable recall set, the overlay LCM keys collapse to the default store
   * (rule 42 read/write parity; rule 48 least-privilege) even though
   * {@link readNamespaces} still searches the overlay for QMD/file recall.
   */
  readonly lcmReadNamespaces: string[];

  /**
   * LCM read `session_id` set, encoded via
   * `lcmReadSessionIdsForNamespaces` (which delegates to
   * `lcmSessionKeyForNamespace`). Ordered and deduped; the primary overlay key
   * is first. Single-user / no-overlay recall collapses to `[sessionKey]` —
   * byte-for-byte the pre-#1495 behavior.
   *
   * Empty (`[]`) when a scope-profile plan is active and no `sessionKey` was
   * supplied (mirrors the pre-existing guard).
   */
  readonly lcmReadSessionIds: ReadonlyArray<string | undefined>;

  /**
   * Resolved coding overlay, or `null` when none applies (no coding context,
   * `codingMode.projectScope` false, `namespacesEnabled` false, or an explicit
   * readable namespace override is set).
   */
  readonly codingOverlay: { readonly namespace: string; readonly readFallbacks: readonly string[] } | null;

  /**
   * Resolved scope-profile plan, or `null` when no scope profile is active.
   * Consumers that branched on "profile vs. non-profile" read this directly.
   */
  readonly scopeProfilePlan: ResolvedScopeProfilePlan | null;
}

/**
 * Options for {@link resolveScopePlan}.
 */
export interface ResolveScopePlanOptions {
  /** Plugin config (namespace policies, coding mode, default namespace, …). */
  readonly config: PluginConfig;
  /** Session key (may derive the principal and/or coding context). */
  readonly sessionKey?: string;
  /**
   * Explicit namespace override (raw — the resolver trims it). When supplied
   * AND readable by the resolved principal, it wins over every other layer.
   */
  readonly namespace?: string;
  /**
   * Authenticated principal override. Access surfaces that already resolved
   * identity at the transport layer pass it here so namespace ACL decisions
   * use the same identity the surface authorized.
   */
  readonly principalOverride?: string;
  /**
   * Coding context for the session. Callers that track this on the orchestrator
   * pass `getCodingContextForSession(sessionKey)` here; the resolver never
   * reaches back into orchestrator state.
   */
  readonly codingContext?: CodingContext | null;
}

/**
 * Resolve a {@link ScopePlan} from the inputs by delegating to the existing
 * namespace-resolution helpers. Pure — no side effects, no orchestrator state.
 *
 * The caller is responsible for authorization checks that should THROW (e.g.
 * `namespacesEnabled && !principal`, or an unreadable explicit override in the
 * recall path). The resolver computes the plan; enforcement stays at the call
 * site so error semantics are unchanged.
 */
export function resolveScopePlan(options: ResolveScopePlanOptions): ScopePlan {
  const { config, sessionKey } = options;

  const namespaceOverride = options.namespace?.trim() || undefined;

  const principal =
    typeof options.principalOverride === "string" && options.principalOverride.length > 0
      ? options.principalOverride
      : resolvePrincipal(sessionKey, config);

  // A namespace override gates the overlay/scope-profile layers. When it is
  // readable it wins; when it is NOT readable the plan falls through to the
  // coding/scope-profile/legacy branches (mirrors the observe-path behavior
  // where an unreadable override does not throw but simply does not suppress
  // the overlay). The recall path validates readability and throws BEFORE
  // calling the resolver, so a reachable override is always readable there.
  const namespaceOverrideReadable =
    namespaceOverride !== undefined && canReadNamespace(principal, namespaceOverride, config);

  const readableRecallNamespaces = recallNamespacesForPrincipal(principal, config);

  // The orchestrator's `applyCodingRecallOverlay` gates on `namespacesEnabled`
  // (returning null when disabled), so the resolver must too — otherwise
  // single-store mode would produce apparent route separation with no actual
  // storage isolation (false-isolation trap, rule 39).
  const codingOverlay: CodingNamespaceOverlay | null =
    namespaceOverrideReadable || !config.namespacesEnabled
      ? null
      : resolveCodingNamespaceOverlay(
          options.codingContext ?? null,
          config.codingMode,
          config.defaultNamespace,
        );

  const principalSelfNamespace = defaultNamespaceForPrincipal(principal, config);
  const codingSelfNamespace = codingOverlay
    ? combineNamespaces(principalSelfNamespace, codingOverlay.namespace)
    : null;

  const scopeProfilePlan = namespaceOverrideReadable
    ? null
    : resolveScopeProfilePlan({
        config,
        principal,
        codingContext: options.codingContext ?? null,
        codingOverlay,
      });

  const profileEffectiveNamespace =
    scopeProfilePlan?.writeNamespace || scopeProfilePlan?.readNamespaces[0];

  const baseNamespace = namespaceOverrideReadable
    ? namespaceOverride!
    : profileEffectiveNamespace ?? codingSelfNamespace ?? principalSelfNamespace;

  // ── Read namespace set ────────────────────────────────────────────────────
  let readNamespaces: string[];
  if (namespaceOverrideReadable) {
    readNamespaces = [namespaceOverride!];
  } else if (scopeProfilePlan) {
    readNamespaces = expandScopeProfileReadNamespaces({
      profilePlan: scopeProfilePlan,
      principalSelfNamespace: scopeProfilePlan.baseNamespace,
      config,
      principal,
      codingOverlay,
      legacyRecallNamespaces: readableRecallNamespaces,
    });
  } else if (codingOverlay && codingSelfNamespace) {
    // Substitute the principal's self namespace with the coding-scoped one, and
    // append any read fallbacks (branch → project, rule 42) combined with the
    // principal base so principal isolation is preserved on fallback entries.
    const mapped = readableRecallNamespaces.map((ns) =>
      ns === principalSelfNamespace ? codingSelfNamespace : ns,
    );
    const fallbackNs = codingOverlay.readFallbacks.map((fallback) =>
      combineNamespaces(principalSelfNamespace, fallback),
    );
    readNamespaces = Array.from(new Set<string>([...mapped, ...fallbackNs]));
  } else {
    readNamespaces = readableRecallNamespaces;
  }

  const readFallbacks = codingOverlay
    ? codingOverlay.readFallbacks.map((fb) => combineNamespaces(principalSelfNamespace, fb))
    : [];

  // ── LCM read namespace set ────────────────────────────────────────────────
  // The LCM overlay keys are `<principal>-project-*` sub-namespaces authorized
  // transitively by the principal SELF base. Include them ONLY when that base
  // is in the readable recall set (rule 42 / 48). When it is NOT readable, the
  // overlay rows are unauthorized for this reader, so the LCM read collapses to
  // the default store — exactly what QMD/file recall surfaces for such a
  // principal.
  const codingOverlaySelfReadable =
    codingOverlay !== null &&
    (scopeProfilePlan
      ? scopeProfilePlan.layers.some((layer) => layer.id === "userProject" && layer.readable)
      : readableRecallNamespaces.includes(principalSelfNamespace));

  let lcmReadNamespaces: string[];
  if (namespaceOverrideReadable) {
    lcmReadNamespaces = [namespaceOverride!];
  } else if (scopeProfilePlan) {
    // Scope profiles define a layered read stack; LCM-backed evidence uses the
    // same namespace set as QMD/file recall so team/global/shared observations
    // are not silently skipped.
    lcmReadNamespaces = readNamespaces;
  } else if (codingOverlay && codingSelfNamespace && codingOverlaySelfReadable) {
    const fallbackNs = codingOverlay.readFallbacks.map((fallback) =>
      combineNamespaces(principalSelfNamespace, fallback),
    );
    lcmReadNamespaces = [codingSelfNamespace, ...fallbackNs];
  } else {
    // No overlay, OR overlay present but self base unreadable → collapse to the
    // default store (raw sessionKey). No `<principal>-project-*` overlay key is
    // searched.
    lcmReadNamespaces = [config.defaultNamespace];
  }

  const lcmReadSessionIds =
    scopeProfilePlan && !sessionKey
      ? []
      : lcmReadSessionIdsForNamespaces(lcmReadNamespaces, sessionKey, config.defaultNamespace);

  return {
    principal,
    namespaceOverride: namespaceOverrideReadable ? namespaceOverride : undefined,
    baseNamespace,
    readNamespaces,
    readFallbacks,
    lcmReadNamespaces,
    lcmReadSessionIds,
    codingOverlay: codingOverlay
      ? { namespace: codingOverlay.namespace, readFallbacks: codingOverlay.readFallbacks }
      : null,
    scopeProfilePlan,
  };
}
