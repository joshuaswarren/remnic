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

import { resolveNamespaceCapabilities } from "../capabilities.js";
import {
  canReadNamespace,
  canWriteNamespace,
  defaultNamespaceForPrincipal,
  recallNamespacesForPrincipal,
  resolvePrincipal,
} from "../namespaces/principal.js";
import {
  namespaceIdentityFromToken,
  namespaceIdentityLegacyToken,
  namespaceIdentityToken,
  normalizeNamespaceIdentity,
} from "../namespaces/identity.js";
import path from "node:path";
import {
  capabilityAllowsOp,
  isNamespaceAllowed,
  resolveEffectiveNamespace,
  type TokenCapabilities,
} from "../access-token-capabilities.js";
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
  /**
   * Whether namespace routing is enabled. Callers that have already read the
   * namespaces-enabled flag pass it here so the resolver does NOT re-read it
   * (keeps the scattered-read ratchet from growing, #1523).
   */
  readonly namespacesEnabled: boolean;
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
  // storage isolation (false-isolation trap, rule 39). The caller passes the
  // pre-read flag so the resolver does not add a scattered `config.*Enabled`
  // read (ratchet, #1523).
  const namespacesEnabled = options.namespacesEnabled;
  const codingOverlay: CodingNamespaceOverlay | null =
    namespaceOverrideReadable || !namespacesEnabled
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

// ────────────────────────────────────────────────────────────────────────────
// Centralized namespace-resolution helpers (issue #1521 step 3–4)
//
// The three functions below consolidate the ad-hoc namespace-resolution logic
// that was previously scattered across orchestrator.ts (namespaceFromStorageDir,
// configuredNamespaces) and access-service.ts (resolveWritableNamespace). By
// living in THIS module they are excluded from the adHocNamespaceResolutions
// ratchet, and every consumer reaches them through a single well-known import
// instead of reimplementing the derivation inline (#1519's failure mode).
// ────────────────────────────────────────────────────────────────────────────

/**
 * The configured namespace set: default + shared + every namespace-policy
 * name, trimmed and de-duplicated. Pure — reads only from `config`.
 *
 * Replaces the `configuredNamespaces()` private method that lived on both
 * `Orchestrator` and the maintenance namespace-planner (two copies of the
 * same logic).
 */
export function getConfiguredNamespaces(config: PluginConfig): string[] {
  return Array.from(
    new Set(
      [
        config.defaultNamespace,
        config.sharedNamespace,
        ...config.namespacePolicies.map((policy) => policy.name),
      ]
        .map((value) => normalizeNamespaceIdentity(value))
        .filter(Boolean),
    ),
  );
}

/**
 * Options for {@link resolveNamespaceFromStorageDir}.
 */
export interface ResolveNamespaceFromStorageDirOptions {
  /** Plugin config (memoryDir, defaultNamespace, namespacesEnabled, …). */
  readonly config: PluginConfig;
  /**
   * Pre-computed configured-namespace set (from {@link getConfiguredNamespaces}).
   * Passed by the caller so this function does not re-derive it on every call.
   */
  readonly configuredNamespaces: readonly string[];
  /**
   * Catalog-owned dir→namespace hints (best-effort union of configured +
   * catalog-discovered). May be `undefined` when no catalog hints are loaded.
   */
  readonly hints?: ReadonlyMap<string, ReadonlySet<string>> | undefined;
  /**
   * Lazy catalog-hint loader. Called ONLY after the early returns (disabled,
   * memory root, no namespace segment, configured namespace) — matching the
   * original lazy behavior so an eager load does not mark hints as loaded
   * before the catalog file exists (codex P2).
   */
  readonly loadHints?: () => void;
}

/**
 * Derive the namespace a storage directory belongs to.
 *
 * Pure (no orchestrator state): the caller passes `config`, the configured set,
 * and any catalog hints. The logic is byte-identical to the private
 * `namespaceFromStorageDir` method that previously lived on `Orchestrator`
 * (including the token round-trip guard from codex round 6).
 */
export function resolveNamespaceFromStorageDir(
  storageDir: string,
  options: ResolveNamespaceFromStorageDirOptions,
): string {
  const { config } = options;
  if (!resolveNamespaceCapabilities(config).namespaces) return config.defaultNamespace;
  const resolvedStorageDir = path.resolve(storageDir);
  const resolvedMemoryDir = path.resolve(config.memoryDir);
  if (resolvedStorageDir === resolvedMemoryDir) return config.defaultNamespace;
  const m = resolvedStorageDir.match(/[\\/]namespaces[\\/]([^\\/]+)$/);
  if (!m?.[1]) return config.defaultNamespace;
  const dirName = m[1];
  // Token-shaped raw names (codex P2 — NBsFz): a dir name might be a tokenized
  // identity OR a literal raw namespace name that merely LOOKS like a token.
  // A dir name that is itself a KNOWN namespace is preserved BEFORE decoding.
  if (options.configuredNamespaces.includes(dirName)) {
    return dirName;
  }
  // Load catalog hints ONLY after the early returns (codex P2: an eager load
  // before the catalog file exists would mark hints as loaded and skip later
  // catalog-derived rows).
  options.loadHints?.();
  const hints = options.hints;
  const hintedNamespaces = hints?.get(resolvedStorageDir);
  if (hintedNamespaces?.has(dirName)) {
    return dirName;
  }
  if (hintedNamespaces?.size === 1) {
    const [hintedNamespace] = hintedNamespaces;
    if (hintedNamespace) return hintedNamespace;
  }
  const decoded = namespaceIdentityFromToken(dirName);
  if (
    decoded &&
    (namespaceIdentityToken(decoded) === dirName ||
      namespaceIdentityLegacyToken(decoded.normalize("NFD")) === dirName)
  ) {
    return decoded;
  }
  return dirName;
}

/**
 * Result of resolving a writable namespace: either the authorized namespace
 * or a structured rejection. The caller decides how to surface the rejection
 * (e.g. as an `EngramAccessInputError` in the access-service layer), keeping
 * this module free of transport-specific error types.
 */
export type WritableNamespaceResult =
  | { readonly ok: true; readonly namespace: string }
  | { readonly ok: false; readonly reason: "unsupported" | "not_writable"; readonly namespace: string };

/**
 * Resolve and authorize a writable namespace.
 *
 * Combines the three steps that `AccessService.resolveWritableNamespace`
 * performed inline: (1) resolve the namespace value (trim → default fallback →
 * validate against `namespacesEnabled`), (2) resolve the principal, (3) check
 * `canWriteNamespace`. Returns a structured result so this module stays free of
 * `EngramAccessInputError` (avoiding a circular dependency on access-service.ts).
 *
 * The caller throws `EngramAccessInputError` when `ok === false` — the access-
 * service wrapper does this in one place.
 */
export function resolveWritableNamespaceValue(
  namespace: string | undefined,
  sessionKey: string | undefined,
  authenticatedPrincipal: string | undefined,
  config: PluginConfig,
): WritableNamespaceResult {
  const requested = namespace?.trim();
  let resolved: string;
  if (!requested) {
    resolved = config.defaultNamespace;
  } else if (
    !resolveNamespaceCapabilities(config).namespaces &&
    requested !== config.defaultNamespace
  ) {
    return { ok: false, reason: "unsupported", namespace: requested };
  } else {
    resolved = requested;
  }

  const trusted = authenticatedPrincipal?.trim();
  const principal =
    typeof trusted === "string" && trusted.length > 0
      ? trusted
      : resolvePrincipal(sessionKey, config);

  if (!canWriteNamespace(principal, resolved, config)) {
    return { ok: false, reason: "not_writable", namespace: resolved };
  }
  return { ok: true, namespace: resolved };
}

/**
 * Inputs already derived by the access-service's read-only coding-context
 * resolver. Keeping context discovery outside this pure function lets writes
 * and preflight checks apply identical namespace and ACL rules.
 */
export interface ScopedWritableNamespaceInput {
  readonly namespace?: string;
  readonly sessionKey?: string;
  readonly authenticatedPrincipal?: string;
  readonly principal: string | undefined;
  readonly codingOverlay: CodingNamespaceOverlay | null;
  readonly scopeProfile: ResolvedScopeProfilePlan | null;
  readonly config: PluginConfig;
}

/**
 * Resolve the namespace an explicit write or implicit coding-scoped write
 * would use. The caller supplies the same derived coding inputs for the real
 * write and the read-only preflight.
 */
export function resolveScopedWritableNamespaceValue(
  input: ScopedWritableNamespaceInput,
): WritableNamespaceResult {
  const requested = input.namespace?.trim();
  if (requested) {
    return resolveWritableNamespaceValue(
      requested,
      input.sessionKey,
      input.authenticatedPrincipal,
      input.config,
    );
  }
  if (input.scopeProfile) {
    const selectedLayer = input.scopeProfile.layers.find(
      (layer) => layer.id === input.scopeProfile?.writeLayer,
    );
    const writeNamespaceReadable =
      input.scopeProfile.writeNamespace.length > 0 &&
      input.scopeProfile.readNamespaces.includes(input.scopeProfile.writeNamespace);
    if (!selectedLayer?.writable || !writeNamespaceReadable) {
      return {
        ok: false,
        reason: "not_writable",
        namespace: input.scopeProfile.writeNamespace,
      };
    }
    return { ok: true, namespace: input.scopeProfile.writeNamespace };
  }
  if (!input.codingOverlay) {
    return resolveWritableNamespaceValue(
      undefined,
      input.sessionKey,
      input.authenticatedPrincipal,
      input.config,
    );
  }
  const baseNamespace = defaultNamespaceForPrincipal(input.principal, input.config);
  if (!canWriteNamespace(input.principal, baseNamespace, input.config)) {
    return { ok: false, reason: "not_writable", namespace: baseNamespace };
  }
  return {
    ok: true,
    namespace: combineNamespaces(baseNamespace, input.codingOverlay.namespace),
  };
}

/**
 * Namespace preflight (issue #1888 part 3): would a write to `namespace` by a
 * caller carrying `caps` succeed? Combines the token's write-op scope, its
 * namespace allow-list, and policy writability so one call answers the real
 * question. A token that cannot actually write (no `observe`/`memory_store` in
 * its ops allow-list) or is asking about a namespace outside its allow-list
 * gets a definitive `not_writable` — revealing nothing about the namespace's
 * policy beyond what the token's own scope already implies, and never throwing
 * a hard authorization error the caller cannot distinguish from a transport
 * fault. (Unrestricted tokens pass both scope checks unchanged.)
 */
export function resolveNamespacePreflight(
  caps: TokenCapabilities | undefined | null,
  namespace: string | undefined,
  sessionKey: string | undefined,
  authenticatedPrincipal: string | undefined,
  config: PluginConfig,
  writeOp: string,
): WritableNamespaceResult {
  const notWritable = (): WritableNamespaceResult => ({
    ok: false,
    reason: "not_writable",
    namespace: resolveEffectiveNamespace(namespace, config.defaultNamespace) ?? namespace ?? "",
  });
  // The token must be able to perform the write op the caller's ENABLED write
  // path actually uses (`observe` for automatic turn capture — the silent
  // #1888 data-loss path — or `memory_store` for an explicit-only install).
  // A token that cannot perform that op would drop the write, so an otherwise
  // policy-writable namespace is still reported not_writable rather than a
  // false ok:true that promises a write the token cannot make.
  if (!capabilityAllowsOp(caps, writeOp)) {
    return notWritable();
  }
  if (!isNamespaceAllowed(caps, namespace, config.defaultNamespace)) {
    return notWritable();
  }
  return resolveWritableNamespaceValue(namespace, sessionKey, authenticatedPrincipal, config);
}
