import assert from "node:assert/strict";
import test from "node:test";

import { withBriefingFollowupTimeout } from "./briefing-followup-timeout.js";

test("#3086 briefing follow-up timeout rejects so briefing can degrade", async () => {
  await assert.rejects(
    withBriefingFollowupTimeout(new Promise(() => {}), 20),
    /briefing follow-up timeout/,
  );
});

test("#3086 briefing follow-up timeout returns the work when it finishes", async () => {
  assert.equal(await withBriefingFollowupTimeout(Promise.resolve("ok"), 50), "ok");
});
