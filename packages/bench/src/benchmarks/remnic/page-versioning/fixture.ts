export interface PageVersioningExpectation {
  versionIds: string[];
  currentVersion: string;
  pageContent: string;
  observed: string;
}

export type PageVersioningScenario =
  | "revert-flow"
  | "prune-window"
  | "diff-output";

export interface PageVersioningCase {
  id: string;
  title: string;
  scenario: PageVersioningScenario;
  expected: PageVersioningExpectation;
}

export const PAGE_VERSIONING_FIXTURE: PageVersioningCase[] = [
  {
    id: "revert-restores-content",
    title: "Revert restores the earlier page and snapshots the replaced content",
    scenario: "revert-flow",
    expected: {
      versionIds: ["1", "2", "3"],
      currentVersion: "3",
      pageContent: "original content",
      observed: "modified content",
    },
  },
  {
    id: "prune-retains-latest-window",
    title: "Pruning keeps only the newest page versions in the sidecar manifest",
    scenario: "prune-window",
    expected: {
      versionIds: ["3", "4"],
      currentVersion: "4",
      pageContent: "content v4",
      observed: "pruned:1,2",
    },
  },
  {
    id: "diff-captures-line-edits",
    title: "Diff output reflects the inserted and replaced lines between versions",
    scenario: "diff-output",
    expected: {
      versionIds: ["1", "2"],
      currentVersion: "2",
      pageContent: "line 1\nline 2 changed\nline 3\nline 4",
      observed: "-line 2|+line 2 changed|+line 4",
    },
  },
];

export const PAGE_VERSIONING_SMOKE_FIXTURE = PAGE_VERSIONING_FIXTURE;
