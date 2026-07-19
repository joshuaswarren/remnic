/**
 * Lifecycle scenario-matrix harness (issue #1993, umbrella #1988 phase 5).
 *
 * AGENTS.md mandates a scenario matrix for stateful subsystem changes
 * (session/retrieval/cache work): the nine canonical rows a reviewer will
 * otherwise probe by hand — provider identity, sparse metadata ± remembered
 * binding, provider rebinding, restart/reload recovery, compaction flush,
 * `before_reset`, `session_end`, and dedupe/replay. Historically that matrix
 * lived only as prose (see the "Why Stateful PRs Churn" section) and nobody
 * instantiated it, so PR #1923 burned 53 review threads on exactly those
 * adjacent invariants.
 *
 * This module makes the matrix EXECUTABLE. A subsystem adapter implements
 * `LifecycleSubject<S>`; `runLifecycleMatrix` registers one named test per
 * `MATRIX_ROWS` entry. Adding a row here is a one-file change that
 * automatically extends every adopter — the whole point of the harness.
 *
 * Test-support only: this file lives under `src/testing/` (a subdirectory, so
 * tsup — which entry-points only top-level `src/*.ts` and the public exports —
 * never bundles it) and is intentionally absent from package.json `exports`.
 * It imports `node:test` and must NEVER be imported by runtime code.
 */

import test from "node:test";

/** The nine canonical AGENTS.md session/retrieval/cache matrix rows. */
export type MatrixRowId =
  | "explicit-provider-identity"
  | "sparse-metadata-with-binding"
  | "sparse-metadata-without-binding"
  | "provider-rebinding"
  | "restart-reload-recovery"
  | "compaction-flush"
  | "before-reset"
  | "session-end"
  | "dedupe-replay";

/**
 * Typed scenario axes a subject can branch on instead of re-parsing the row
 * id. These encode the real dimensions the AGENTS.md matrix probes.
 */
export interface MatrixRowDimensions {
  /** How the session's provider/identity binding is established. */
  readonly providerIdentity: "explicit" | "sparse" | "rebound" | "none";
  /** Whether a previously remembered binding is available to reuse. */
  readonly rememberedBinding: boolean;
  /** Whether the scenario exercises a fresh instance over persisted state. */
  readonly restart: boolean;
  /** The forced-flush lifecycle transition under test, if any. */
  readonly flush: "before_reset" | "session_end" | "compaction" | "none";
  /** Whether the scenario replays/duplicates content through the dedupe path. */
  readonly dedupeOrReplay: boolean;
}

export interface MatrixRow {
  readonly id: MatrixRowId;
  /** Human-readable row title (matches the AGENTS.md bullet). */
  readonly title: string;
  readonly dimensions: MatrixRowDimensions;
}

/**
 * The canonical matrix. Order and membership mirror AGENTS.md
 * "Minimum scenario matrix for session/retrieval/cache work". Frozen so an
 * adopter cannot mutate the shared set.
 */
export const MATRIX_ROWS: readonly MatrixRow[] = Object.freeze([
  {
    id: "explicit-provider-identity",
    title: "explicit provider identity",
    dimensions: {
      providerIdentity: "explicit",
      rememberedBinding: false,
      restart: false,
      flush: "none",
      dedupeOrReplay: false,
    },
  },
  {
    id: "sparse-metadata-with-binding",
    title: "sparse metadata with remembered binding",
    dimensions: {
      providerIdentity: "sparse",
      rememberedBinding: true,
      restart: false,
      flush: "none",
      dedupeOrReplay: false,
    },
  },
  {
    id: "sparse-metadata-without-binding",
    title: "sparse metadata without remembered binding",
    dimensions: {
      providerIdentity: "sparse",
      rememberedBinding: false,
      restart: false,
      flush: "none",
      dedupeOrReplay: false,
    },
  },
  {
    id: "provider-rebinding",
    title: "provider rebinding",
    dimensions: {
      providerIdentity: "rebound",
      rememberedBinding: true,
      restart: false,
      flush: "none",
      dedupeOrReplay: false,
    },
  },
  {
    id: "restart-reload-recovery",
    title: "restart/reload recovery",
    dimensions: {
      providerIdentity: "explicit",
      rememberedBinding: true,
      restart: true,
      flush: "none",
      dedupeOrReplay: false,
    },
  },
  {
    id: "compaction-flush",
    title: "compaction flush",
    dimensions: {
      providerIdentity: "explicit",
      rememberedBinding: false,
      restart: false,
      flush: "compaction",
      dedupeOrReplay: false,
    },
  },
  {
    id: "before-reset",
    title: "before_reset",
    dimensions: {
      providerIdentity: "explicit",
      rememberedBinding: false,
      restart: false,
      flush: "before_reset",
      dedupeOrReplay: false,
    },
  },
  {
    id: "session-end",
    title: "session_end",
    dimensions: {
      providerIdentity: "explicit",
      rememberedBinding: false,
      restart: false,
      flush: "session_end",
      dedupeOrReplay: false,
    },
  },
  {
    id: "dedupe-replay",
    title: "dedupe/replay behavior",
    dimensions: {
      providerIdentity: "explicit",
      rememberedBinding: false,
      restart: false,
      flush: "none",
      dedupeOrReplay: true,
    },
  },
] as const);

/**
 * A subsystem adapter. Each row runs `setup → exercise → invariants`. `setup`
 * is transactional — it cleans up its own partial state if it throws — and once
 * it returns a fixture, `teardown` always runs (even when `exercise` or
 * `invariants` throws), so a leaked temp dir or orchestrator cannot poison a
 * sibling row.
 *
 * A row a subject cannot honestly realize must NOT be faked: return a skip
 * reason from `appliesTo` and the harness registers it as an explicit skipped
 * test (a mock-only pass is a finding about the code, not the harness — #1993).
 */
export interface LifecycleSubject<S> {
  /** Build the row-specific fixture; MUST clean up its own partial state if it throws. */
  setup(row: MatrixRow): Promise<S>;
  /** Drive the behavior under test. */
  exercise(subject: S, row: MatrixRow): Promise<void>;
  /** Row-specific assertions against observable effects. */
  invariants(subject: S, row: MatrixRow): Promise<void>;
  /** Always-run cleanup. */
  teardown(subject: S, row: MatrixRow): Promise<void>;
  /**
   * Optional: return a non-empty string to SKIP a row with that reason, or
   * `false`. Omitted / `true` means the row applies. A skip is honest coverage
   * documentation, not a silent pass.
   */
  appliesTo?(row: MatrixRow): boolean | string;
}

/** Minimal test registrar seam (defaults to `node:test`), injectable for self-test. */
export type MatrixTestRegistrar = (
  name: string,
  fn: () => void | Promise<void>,
) => void;

export type MatrixSkipRegistrar = (name: string, reason: string) => void;

export interface RunLifecycleMatrixOptions {
  /** Override the test registrar (self-test injects a capturing fake). */
  readonly register?: MatrixTestRegistrar;
  /** Override the skip registrar. */
  readonly registerSkipped?: MatrixSkipRegistrar;
  /** Override the row set (self-test only; production adopters use MATRIX_ROWS). */
  readonly rows?: readonly MatrixRow[];
}

/** Deterministic, greppable test name — the coverage manifest and CI depend on it. */
export function lifecycleTestName(subjectName: string, row: MatrixRow): string {
  return `lifecycle-matrix[${subjectName}] :: ${row.id} — ${row.title}`;
}

const defaultRegister: MatrixTestRegistrar = (name, fn) => {
  test(name, fn);
};

const defaultRegisterSkipped: MatrixSkipRegistrar = (name, reason) => {
  test(name, { skip: reason }, () => {});
};

/**
 * Register one test per matrix row for `subject`, named with the row identity
 * so a failing row is unambiguous in CI output. Runs `setup → exercise →
 * invariants`; `teardown` runs whenever `setup` produced a fixture.
 */
export function runLifecycleMatrix<S>(
  subjectName: string,
  subject: LifecycleSubject<S>,
  options: RunLifecycleMatrixOptions = {},
): void {
  const register = options.register ?? defaultRegister;
  const registerSkipped = options.registerSkipped ?? defaultRegisterSkipped;
  const rows = options.rows ?? MATRIX_ROWS;

  for (const row of rows) {
    const name = lifecycleTestName(subjectName, row);
    const applicability = subject.appliesTo ? subject.appliesTo(row) : true;
    if (applicability !== true) {
      const reason =
        typeof applicability === "string" && applicability.length > 0
          ? applicability
          : "not applicable to this subsystem";
      registerSkipped(name, reason);
      continue;
    }

    register(name, async () => {
      let built: S | undefined;
      try {
        built = await subject.setup(row);
        await subject.exercise(built, row);
        await subject.invariants(built, row);
      } finally {
        // `setup` is transactional, so teardown runs whenever it produced a
        // fixture — even if exercise/invariants throw — and is skipped only
        // when setup never returned one (it cleaned up its own partial state).
        if (built !== undefined) await subject.teardown(built, row);
      }
    });
  }
}
