import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const workflow = readFileSync(".github/workflows/release-and-publish.yml", "utf8");

function stepIndex(name: string): number {
  const index = workflow.indexOf(`- name: ${name}`);
  assert.notEqual(index, -1, `missing workflow step: ${name}`);
  return index;
}

test("release workflow pushes release commits before public publication", () => {
  const pushMain = stepIndex("Push release commits to main");

  assert.ok(pushMain < stepIndex("Ensure version tag on release commit"));
  assert.ok(pushMain < stepIndex("Create GitHub release"));
  assert.ok(pushMain < stepIndex("Publish root package to npm"));
  assert.ok(pushMain < stepIndex("Publish workspace packages to npm"));
  assert.ok(pushMain < stepIndex("Publish OpenClaw plugin to ClawHub"));
});

test("release workflow tags the same commit pushed to main", () => {
  assert.match(
    workflow,
    /id: release_commit[\s\S]*echo "release_commit=\$\{RELEASE_COMMIT\}" >> "\$GITHUB_OUTPUT"/,
  );
  assert.match(
    workflow,
    /git tag -a "\$\{TAG\}" \\\s+"\$\{RELEASE_COMMIT\}"/,
  );
});

test("release workflow verifies existing tags before publishing", () => {
  assert.match(
    workflow,
    /git fetch --force origin "refs\/tags\/\$\{TAG\}:refs\/tags\/\$\{TAG\}"/,
  );
  assert.match(workflow, /trap 'rm -f "\$FETCH_LOG"' EXIT/);
  assert.match(
    workflow,
    /TAG_TARGET="\$\(git rev-parse "refs\/tags\/\$\{TAG\}\^\{\}"\)"/,
  );
  assert.match(workflow, /\[ "\$\{TAG_TARGET\}" != "\$\{RELEASE_COMMIT\}" \]/);
  assert.match(workflow, /git push origin "refs\/tags\/\$\{TAG\}"/);
});

test("release workflow reads annotated tag metadata without peeling to commits", () => {
  assert.match(workflow, /git cat-file -e "refs\/tags\/\$\{tag\}\^\{tag\}"/);
  assert.match(workflow, /git cat-file -p "refs\/tags\/\$\{tag\}\^\{tag\}"/);
  assert.match(workflow, /printf '%s\\n' "\$\{TAG_CONTENT\}" \| grep -Fq "source-main-sha: \$\{SOURCE_MAIN_SHA\}"/);
});
