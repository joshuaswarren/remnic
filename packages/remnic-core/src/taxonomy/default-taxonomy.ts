/**
 * Default MECE taxonomy that maps every existing MemoryCategory value
 * to exactly one taxonomy category, ordered by priority.
 */

import type { Taxonomy } from "./types.js";

export const DEFAULT_TAXONOMY: Taxonomy = {
  version: 1,
  categories: [
    {
      id: "corrections",
      name: "Corrections",
      description: "Corrections to previously stored information",
      filingRules: ["Any update that supersedes a prior fact"],
      priority: 10,
      memoryCategories: ["correction"],
    },
    {
      id: "principles",
      name: "Principles",
      description: "Rules, guidelines, and recurring patterns",
      filingRules: ["A guiding principle, rule, or skill"],
      priority: 20,
      memoryCategories: ["principle", "rule", "skill"],
    },
    {
      id: "procedures",
      name: "Procedures",
      description: "Ordered multi-step workflows the user repeats",
      filingRules: ["A repeatable sequence of steps or commands for a task"],
      priority: 25,
      memoryCategories: ["procedure"],
    },
    {
      id: "entities",
      name: "Entities",
      description: "People, organizations, places, projects",
      filingRules: ["Named entity with attributes"],
      priority: 30,
      memoryCategories: ["entity", "relationship"],
    },
    {
      id: "decisions",
      name: "Decisions",
      description: "Choices made and their rationale",
      filingRules: ["A decision or commitment with reasoning"],
      priority: 35,
      memoryCategories: ["decision", "commitment"],
    },
    {
      id: "preferences",
      name: "Preferences",
      description: "User likes, dislikes, and style choices",
      filingRules: ["Anything expressing a preference or taste"],
      priority: 40,
      memoryCategories: ["preference"],
    },
    {
      id: "facts",
      name: "Facts",
      description: "Objective statements about the world",
      filingRules: ["Any factual claim or piece of information"],
      priority: 50,
      memoryCategories: ["fact"],
    },
    {
      id: "moments",
      name: "Moments",
      description: "Significant events or experiences",
      filingRules: ["A specific event worth remembering"],
      priority: 60,
      memoryCategories: ["moment"],
    },
    {
      id: "reasoning-traces",
      name: "Reasoning Traces",
      description:
        "Stored intermediate reasoning / solution chains for a problem the agent previously solved",
      filingRules: [
        "A multi-step reasoning chain or solution walkthrough the agent can replay for a similar problem",
      ],
      priority: 55,
      memoryCategories: ["reasoning_trace"],
    },
  ],
};
