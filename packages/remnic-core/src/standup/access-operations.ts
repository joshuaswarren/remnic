import { z } from "zod";

import { defineOperation } from "../access-boundary.js";
import { buildStandup, parseStandupDate } from "./build.js";

defineOperation({
  name: "standup",
  description: "Deterministic yesterday/today/blockers standup brief.",
  fleetWide: true,
  schema: z.object({ date: z.string().optional() }).strict(),
  handler: async (input, ctx) => ({
    result: buildStandup(ctx.service.memoryDir, parseStandupDate(input.date)),
  }),
});
