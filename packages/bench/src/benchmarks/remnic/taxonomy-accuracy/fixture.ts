import type { MemoryCategory } from "@remnic/core";
import type { Taxonomy } from "@remnic/core";

export interface TaxonomyAccuracyCase {
  id: string;
  content: string;
  memoryCategory: MemoryCategory;
  expectedCategoryId: string;
}

export const TAXONOMY_ACCURACY_TAXONOMY: Taxonomy = {
  version: 1,
  categories: [
    {
      id: "corrections",
      name: "Corrections",
      description: "Corrections to previously stored information.",
      filingRules: ["correction update supersedes previous value"],
      priority: 10,
      memoryCategories: ["correction"],
    },
    {
      id: "preferences",
      name: "Preferences",
      description: "Stable user likes, dislikes, and style choices.",
      filingRules: ["prefer dislike style favorite habit taste"],
      priority: 20,
      memoryCategories: ["preference"],
    },
    {
      id: "api-facts",
      name: "API Facts",
      description: "Facts about APIs, endpoints, auth, and protocols.",
      filingRules: ["api endpoint auth token bearer request response version"],
      priority: 30,
      memoryCategories: ["fact"],
    },
    {
      id: "people-facts",
      name: "People Facts",
      description: "Facts about people, roles, and relationships.",
      filingRules: ["person teammate manager founder employee works with named"],
      priority: 40,
      memoryCategories: ["fact"],
    },
    {
      id: "project-facts",
      name: "Project Facts",
      description: "Facts about releases, projects, packages, and CI.",
      filingRules: ["project release package benchmark migration ci roadmap"],
      priority: 50,
      memoryCategories: ["fact", "decision"],
    },
    {
      id: "general-facts",
      name: "General Facts",
      description: "Fallback bucket for factual content.",
      filingRules: ["general fact fallback"],
      priority: 60,
      memoryCategories: ["fact"],
    },
  ],
};

export const TAXONOMY_ACCURACY_FIXTURE: TaxonomyAccuracyCase[] = [
  {
    id: "api-token-expiry",
    content: "The API bearer token expires after 60 minutes.",
    memoryCategory: "fact",
    expectedCategoryId: "api-facts",
  },
  {
    id: "api-version",
    content: "Version 3 of the API removed the legacy /v2/agents endpoint.",
    memoryCategory: "fact",
    expectedCategoryId: "api-facts",
  },
  {
    id: "founder-fact",
    content: "Alice is the founder and works with Ben on the memory project.",
    memoryCategory: "fact",
    expectedCategoryId: "people-facts",
  },
  {
    id: "manager-fact",
    content: "Riley is the manager for the platform team.",
    memoryCategory: "fact",
    expectedCategoryId: "people-facts",
  },
  {
    id: "release-fact",
    content: "The benchmark package ships JSON exports for the CI gate.",
    memoryCategory: "fact",
    expectedCategoryId: "project-facts",
  },
  {
    id: "roadmap-decision",
    content: "The project roadmap prioritizes the benchmark dashboard before publish automation.",
    memoryCategory: "decision",
    expectedCategoryId: "project-facts",
  },
  {
    id: "general-fact",
    content: "The office is in Chicago and opens at 9 AM.",
    memoryCategory: "fact",
    expectedCategoryId: "general-facts",
  },
  {
    id: "user-preference",
    content: "I prefer concise status updates with exact commands.",
    memoryCategory: "preference",
    expectedCategoryId: "preferences",
  },
  {
    id: "correction",
    content: "Actually the daemon port is 4318, not 4317.",
    memoryCategory: "correction",
    expectedCategoryId: "corrections",
  },
  {
    id: "release-checklist",
    content: "The release checklist is ready for the package cut.",
    memoryCategory: "fact",
    expectedCategoryId: "project-facts",
  },
];

const TAXONOMY_ACCURACY_SMOKE_CASE_IDS = [
  "api-token-expiry",
  "founder-fact",
  "release-fact",
  "roadmap-decision",
  "general-fact",
  "user-preference",
  "correction",
];

function taxonomyCaseById(id: string): TaxonomyAccuracyCase {
  const found = TAXONOMY_ACCURACY_FIXTURE.find((sample) => sample.id === id);
  if (!found) {
    throw new Error(`taxonomy-accuracy smoke fixture references unknown case ${id}`);
  }
  return found;
}

export const TAXONOMY_ACCURACY_SMOKE_FIXTURE = TAXONOMY_ACCURACY_SMOKE_CASE_IDS.map(taxonomyCaseById);
