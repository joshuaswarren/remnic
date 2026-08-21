/**
 * Gold graph for the synthetic project-folder fixture.
 *
 * All entities, names, and content are entirely fictional.
 */

import type { GoldGraph } from "../../ingestion-types.js";

export const PROJECT_FOLDER_GOLD_GRAPH: GoldGraph = {
  entities: [
    // Project
    { id: "project-atlas-platform", name: "Atlas Platform", type: "project", aliases: ["Atlas"] },
    // People
    { id: "person-lin-zhang", name: "Lin Zhang", type: "person", aliases: ["Lin"] },
    { id: "person-raj-patel", name: "Raj Patel", type: "person", aliases: ["Raj"] },
    { id: "person-sofia-martinez", name: "Sofia Martinez", type: "person", aliases: ["Sofia"] },
    { id: "person-omar-hassan", name: "Omar Hassan", type: "person", aliases: ["Omar"] },
    // Milestones
    { id: "milestone-core-api", name: "Core API", type: "event", aliases: ["Core API milestone"] },
    { id: "milestone-dashboard", name: "Dashboard", type: "event", aliases: ["Dashboard milestone"] },
    // Topics
    { id: "topic-auth", name: "Authentication System", type: "topic", aliases: ["Auth", "authentication"] },
    { id: "topic-pipeline", name: "Data Pipeline", type: "topic", aliases: ["pipeline"] },
    { id: "topic-monitoring", name: "Monitoring", type: "topic", aliases: ["observability"] },
  ],
  links: [
    { source: "Lin Zhang", target: "Atlas Platform", relation: "leads", bidirectional: false },
    { source: "Raj Patel", target: "Atlas Platform", relation: "contributes-to", bidirectional: false },
    { source: "Sofia Martinez", target: "Atlas Platform", relation: "contributes-to", bidirectional: false },
    { source: "Omar Hassan", target: "Atlas Platform", relation: "contributes-to", bidirectional: false },
    { source: "Atlas Platform", target: "Core API", relation: "has-milestone", bidirectional: false },
    { source: "Atlas Platform", target: "Dashboard", relation: "has-milestone", bidirectional: false },
    { source: "Raj Patel", target: "Authentication System", relation: "owns", bidirectional: false },
    { source: "Sofia Martinez", target: "Data Pipeline", relation: "owns", bidirectional: false },
    { source: "Omar Hassan", target: "Monitoring", relation: "owns", bidirectional: false },
  ],
  pages: [
    {
      title: "Atlas Platform",
      requiredFields: ["title", "type", "state", "created"],
      expectTimeline: true,
      expectExecSummary: true,
      expectSeeAlso: ["Lin Zhang", "Core API", "Dashboard"],
    },
  ],
};
