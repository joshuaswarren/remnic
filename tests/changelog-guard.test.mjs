import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { validateChangelogPatch } from "../scripts/changelog-guard.mjs";

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

function changelogWithDeepUnreleasedEntry(extraLine) {
  const body = Array.from({ length: 20 }, (_, index) => `- Existing unreleased entry ${index + 1}`);
  if (extraLine) body.splice(14, 0, extraLine);

  return `# Changelog

## [Unreleased]

### Fixed
${body.join("\n")}

## [v9.3.0] - 2026-06-01

### Fixed
- Previous release entry.
`;
}

test("validateChangelogPatch accepts allowed section edits when the heading is outside the hunk", () => {
  const baseContent = changelogWithDeepUnreleasedEntry();
  const headContent = changelogWithDeepUnreleasedEntry("- Added deep unreleased fix.");
  const patch = `@@ -17,6 +17,7 @@
 - Existing unreleased entry 12
 - Existing unreleased entry 13
 - Existing unreleased entry 14
+- Added deep unreleased fix.
 - Existing unreleased entry 15
 - Existing unreleased entry 16
 - Existing unreleased entry 17`;

  assert.deepEqual(validateChangelogPatch({ patch, baseContent, headContent }), { allowed: true });
});

test("validateChangelogPatch rejects edits outside release sections", () => {
  const baseContent = `# Changelog

Intro text.

## Other Notes

- Internal maintenance.

## [Unreleased]

- Valid future entry.
`;
  const headContent = baseContent.replace("- Internal maintenance.", "- Changed internal maintenance.");
  const patch = [
    "@@ -5,7 +5,7 @@",
    " ## Other Notes",
    " ",
    "-- Internal maintenance.",
    "+- Changed internal maintenance.",
    " ",
    " ## [Unreleased]",
  ].join("\n");

  const verdict = validateChangelogPatch({ patch, baseContent, headContent });

  assert.equal(verdict.allowed, false);
  assert.deepEqual(verdict.invalidOld, [7]);
  assert.deepEqual(verdict.invalidNew, [7]);
});

test("changelog guard workflow runs from the trusted target context", async () => {
  const workflow = await readFile(".github/workflows/changelog-guard.yml", "utf8");

  assert.match(workflow, /\non:\n  pull_request_target:/);
  assert.doesNotMatch(workflow, /\n  pull_request:\n/);
  assert.doesNotMatch(workflow, /actions\/checkout/);
});

async function loadWorkflowScript() {
  const workflow = await readFile(".github/workflows/changelog-guard.yml", "utf8");
  const lines = workflow.split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim() === "script: |");
  assert.notEqual(start, -1, "workflow script block not found");

  const scriptLines = [];
  for (const line of lines.slice(start + 1)) {
    if (line.startsWith("            ")) {
      scriptLines.push(line.slice(12));
      continue;
    }
    if (line.trim() === "") {
      scriptLines.push("");
      continue;
    }
    break;
  }

  return scriptLines.join("\n");
}

async function runWorkflowScript({ patch, baseContent, headContent }) {
  const script = await loadWorkflowScript();
  const notices = [];
  let failure = "";

  const github = {
    paginate: async () => [{ filename: "CHANGELOG.md", patch }],
    rest: {
      pulls: {
        listFiles: async () => {
          throw new Error("listFiles should be called through paginate");
        },
      },
      repos: {
        compareCommitsWithBasehead: async () => ({
          data: { merge_base_commit: { sha: "merge-base-sha" } },
        }),
        getContent: async ({ path, ref }) => {
          assert.equal(path, "CHANGELOG.md");
          const content = ref === "head-sha" ? headContent : baseContent;
          return {
            data: {
              type: "file",
              content: Buffer.from(content).toString("base64"),
              encoding: "base64",
            },
          };
        },
      },
    },
  };
  const context = {
    repo: { owner: "owner", repo: "repo" },
    payload: {
      pull_request: {
        number: 123,
        labels: [],
        base: { sha: "base-sha" },
        head: { sha: "head-sha" },
      },
    },
  };
  const core = {
    notice(message) {
      notices.push(message);
    },
    setFailed(message) {
      failure = message;
    },
  };

  await AsyncFunction("github", "context", "core", "Buffer", script)(
    github,
    context,
    core,
    Buffer,
  );

  return { notices, failure };
}

test("changelog guard workflow accepts omitted-heading edits inside release sections", async () => {
  const baseContent = changelogWithDeepUnreleasedEntry();
  const headContent = changelogWithDeepUnreleasedEntry("- Added deep unreleased fix.");
  const patch = `@@ -17,6 +17,7 @@
 - Existing unreleased entry 12
 - Existing unreleased entry 13
 - Existing unreleased entry 14
+- Added deep unreleased fix.
 - Existing unreleased entry 15
 - Existing unreleased entry 16
 - Existing unreleased entry 17`;

  const result = await runWorkflowScript({ patch, baseContent, headContent });

  assert.equal(result.failure, "");
  assert.deepEqual(result.notices, [
    "CHANGELOG.md edited directly in a release section; changelog guard passed.",
  ]);
});

test("changelog guard workflow rejects edits outside release sections", async () => {
  const baseContent = `# Changelog

Intro text.

## Other Notes

- Internal maintenance.

## [Unreleased]

- Valid future entry.
`;
  const headContent = baseContent.replace("- Internal maintenance.", "- Changed internal maintenance.");
  const patch = `@@ -5,7 +5,7 @@
 ## Other Notes
 
-- Internal maintenance.
+- Changed internal maintenance.
 
 ## [Unreleased]`;

  const result = await runWorkflowScript({ patch, baseContent, headContent });

  assert.match(result.failure, /CHANGELOG\.md changes must be inside/);
  assert.deepEqual(result.notices, []);
});
