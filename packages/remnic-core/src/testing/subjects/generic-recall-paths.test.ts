import assert from "node:assert/strict";

import { filterRecallCandidates, type GenericRecallPathPolicy } from "../../orchestration/generic-recall-paths.js";
import type { QmdSearchResult } from "../../types.js";
import { type LifecycleSubject, type MatrixRow, runLifecycleMatrix } from "../lifecycle-matrix.js";

interface GenericRecallPathState {
  readonly policy: GenericRecallPathPolicy;
  readonly candidates: QmdSearchResult[];
  readonly expectedPaths: string[];
  filtered?: QmdSearchResult[];
}

function candidate(path: string, score: number): QmdSearchResult {
  return { docid: path, path, score, snippet: path };
}

function excludedFirst(
  policy: GenericRecallPathPolicy,
  archivePath: string,
  activePath: string,
): GenericRecallPathState {
  return {
    policy,
    candidates: [candidate(archivePath, 1), candidate(activePath, 0.9)],
    expectedPaths: [activePath],
  };
}

function stateFor(row: MatrixRow): GenericRecallPathState {
  switch (row.id) {
    case "explicit-provider-identity":
      return excludedFirst(
        { memoryDir: "/matrix", qmdCollection: "hot" },
        "hot/archive/2026-02-23/fact.md",
        "hot/facts/active.md",
      );
    case "sparse-metadata-with-binding":
      return excludedFirst(
        { memoryDir: "/matrix", qmdCollection: "hot" },
        "hot/namespaces/alice/archive/2026-02-23/fact.md",
        "hot/namespaces/alice/facts/active.md",
      );
    case "sparse-metadata-without-binding":
      return excludedFirst(
        { memoryDir: "/matrix" },
        "/matrix/archive/2026-02-23/fact.md",
        "/matrix/facts/active.md",
      );
    case "provider-rebinding":
      return excludedFirst(
        { memoryDir: "/matrix", qmdColdCollection: "cold" },
        "cold/namespaces/team/archive/2026-02-23/fact.md",
        "cold/namespaces/team/facts/active.md",
      );
    case "restart-reload-recovery":
      return excludedFirst(
        { memoryDir: "/matrix", qmdCollection: "archive" },
        "archive/archive/2026-02-23/fact.md",
        "archive/facts/active.md",
      );
    case "compaction-flush":
      return excludedFirst(
        { memoryDir: "/matrix", qmdCollection: "namespaces" },
        "namespaces/namespaces/team/archive/2026-02-23/fact.md",
        "namespaces/facts/active.md",
      );
    case "before-reset":
      return excludedFirst(
        { memoryDir: "/matrix", qmdCollection: "hot--ns-736861726564" },
        "hot--ns-736861726564/archive/2026-02-23/fact.md",
        "hot--ns-736861726564/facts/active.md",
      );
    case "session-end": {
      const namespaceArchivePath = "namespaces/archive/facts/active.md";
      return {
        policy: { memoryDir: "/matrix", qmdCollection: "hot" },
        candidates: [candidate(namespaceArchivePath, 1)],
        expectedPaths: [namespaceArchivePath],
      };
    }
    case "dedupe-replay": {
      const nestedArchivePath = "facts/projects/archive/active.md";
      return {
        policy: { memoryDir: "/matrix", qmdCollection: "hot" },
        candidates: [candidate(nestedArchivePath, 1)],
        expectedPaths: [nestedArchivePath],
      };
    }
    default: {
      const exhaustive: never = row.id;
      throw new Error(`unhandled row ${String(exhaustive)}`);
    }
  }
}

const subject: LifecycleSubject<GenericRecallPathState> = {
  async setup(row): Promise<GenericRecallPathState> {
    return stateFor(row);
  },

  async exercise(state): Promise<void> {
    state.filtered = filterRecallCandidates(state.candidates, {
      namespacesEnabled: false,
      recallNamespaces: [],
      resolveNamespace: () => "default",
      limit: 1,
      pathPolicy: state.policy,
    });
  },

  async invariants(state): Promise<void> {
    assert.deepEqual(
      state.filtered?.map((result) => result.path),
      state.expectedPaths,
      "generic recall must exclude root archive paths before the result cap",
    );
  },

  async teardown(): Promise<void> {},
};

runLifecycleMatrix("generic-recall-paths", subject);
