export const BENCH_RECALL_SECTION_TITLES = [
  "Explicit Cue Evidence",
  "Remnic recall pipeline",
  "Search evidence",
  "Raw messages",
] as const;

export const BENCH_RECALL_SECTION_TITLE_SET = new Set<string>(
  BENCH_RECALL_SECTION_TITLES,
);

export const TRAJECTORY_RETRY_SECTION_TITLES = [
  "Explicit Cue Evidence",
  "Remnic recall pipeline",
] as const;

export const TRAJECTORY_RETRY_SECTION_TITLE_SET = new Set<string>(
  TRAJECTORY_RETRY_SECTION_TITLES,
);
