/**
 * Gold graph for the synthetic chat fixture.
 *
 * All entities, names, and content are entirely fictional.
 */

import type { GoldGraph } from "../../ingestion-types.js";

export const CHAT_GOLD_GRAPH: GoldGraph = {
  entities: [
    // People
    { id: "person-alex-rivera", name: "Alex Rivera", type: "person", aliases: ["Alex"] },
    { id: "person-sam-okonkwo", name: "Sam Okonkwo", type: "person", aliases: ["Sam"] },
    { id: "person-jo-park", name: "Jo Park", type: "person", aliases: ["Jo"] },
    { id: "person-lee-andersen", name: "Lee Andersen", type: "person", aliases: ["Lee"] },
    // Channels / topics
    { id: "topic-general", name: "#general", type: "topic", aliases: ["general"] },
    { id: "topic-engineering", name: "#engineering", type: "topic", aliases: ["engineering"] },
    { id: "topic-releases", name: "#releases", type: "topic", aliases: ["releases"] },
    // Project
    { id: "project-v2-migration", name: "v2 Migration", type: "project", aliases: ["v2", "migration"] },
    // Technical topic
    { id: "topic-ci-pipeline", name: "CI Pipeline", type: "topic", aliases: ["CI", "pipeline"] },
  ],
  links: [
    { source: "Alex Rivera", target: "v2 Migration", relation: "leads", bidirectional: false },
    { source: "Sam Okonkwo", target: "v2 Migration", relation: "contributes-to", bidirectional: false },
    { source: "Jo Park", target: "CI Pipeline", relation: "owns", bidirectional: false },
    { source: "Lee Andersen", target: "v2 Migration", relation: "contributes-to", bidirectional: false },
    { source: "Alex Rivera", target: "Sam Okonkwo", relation: "collaborates-with", bidirectional: true },
  ],
  pages: [
    {
      title: "v2 Migration",
      requiredFields: ["title", "type", "state", "created"],
      expectTimeline: true,
      expectExecSummary: true,
      expectSeeAlso: ["Alex Rivera", "CI Pipeline"],
    },
  ],
};
