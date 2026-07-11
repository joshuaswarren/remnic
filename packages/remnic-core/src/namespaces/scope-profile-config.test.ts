import assert from "node:assert/strict";
import test from "node:test";

import { parseScopeProfiles, parseScopeTeams, validateScopeProfileTeamReferences } from "./scope-profile-config.js";

test("scope profile config parser preserves defaults and boolean-string coercion", () => {
  const profiles = parseScopeProfiles({
    hosted: {
      readOrder: ["userProject", "userProject", "userGlobal"],
      autoPromote: { enabled: "false" },
    },
  });

  assert.deepEqual(profiles.hosted, {
    readOrder: ["userProject", "userGlobal"],
    writeDefault: "userProject",
    promotionTargets: [],
    autoPromote: {
      enabled: false,
      targets: [],
      categories: ["fact", "correction", "decision", "preference"],
      minConfidenceTier: "explicit",
    },
  });
});

test("scope team parser preserves declared access lists", () => {
  const teams = parseScopeTeams({
    platform: {
      principals: ["agent-a"],
      read: ["agent-a", "agent-b"],
      write: ["agent-a"],
      promote: ["agent-a"],
      projectNamespaceTemplate: "team-{teamId}-{projectHash}",
    },
  });

  assert.deepEqual(teams.platform, {
    principals: ["agent-a"],
    projectNamespaceTemplate: "team-{teamId}-{projectHash}",
    read: ["agent-a", "agent-b"],
    write: ["agent-a"],
    promote: ["agent-a"],
  });
});

test("scope profile config validation rejects unknown team references", () => {
  const profiles = parseScopeProfiles({
    hosted: {
      readOrder: ["teamProject"],
      writeDefault: "teamProject",
      teamProject: { teamId: "missing" },
    },
  });

  assert.throws(
    () => validateScopeProfileTeamReferences(profiles, {}),
    /scopeProfiles\.hosted\.teamProject\.teamId references unknown team: missing/
  );
});
