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

  assert.ok(stepIndex("Bump changed workspace package versions") < stepIndex("Resolve final release metadata"));
  assert.ok(stepIndex("Resolve final release metadata") < pushMain);
  assert.ok(pushMain < stepIndex("Ensure version tag on release commit"));
  assert.ok(pushMain < stepIndex("Create GitHub release"));
  assert.ok(stepIndex("Prepare publish-order helper") < stepIndex("Checkout release source for publish"));
  assert.ok(stepIndex("Checkout release source for publish") < stepIndex("Generate workspace package publish order"));
  assert.ok(stepIndex("Install dependencies for release source") < stepIndex("Generate workspace package publish order"));
  assert.ok(stepIndex("Generate workspace package publish order") < stepIndex("Publish root package to npm"));
  assert.ok(pushMain < stepIndex("Publish root package to npm"));
  assert.ok(pushMain < stepIndex("Publish workspace packages to npm"));
  assert.ok(stepIndex("Ensure version tag on release commit") < stepIndex("Fail incomplete existing npm release"));
  assert.ok(stepIndex("Fail incomplete existing npm release") < stepIndex("Publish root package to npm"));
  assert.ok(stepIndex("Ensure version tag on release commit") < stepIndex("Publish root package to npm"));
  assert.ok(stepIndex("Ensure version tag on release commit") < stepIndex("Publish workspace packages to npm"));
  assert.ok(stepIndex("Publish workspace packages to npm") < stepIndex("Publish root package to npm"));
  assert.ok(stepIndex("Ensure version tag on release commit") < stepIndex("Publish OpenClaw plugin to ClawHub"));
  assert.ok(pushMain < stepIndex("Publish OpenClaw plugin to ClawHub"));
  assert.ok(stepIndex("Publish OpenClaw plugin to ClawHub") < stepIndex("Create GitHub release"));
});

test("release workflow tags the same commit pushed to main", () => {
  assert.match(
    workflow,
    /id: release_commit[\s\S]*echo "release_commit=\$\{RELEASE_COMMIT\}" >> "\$GITHUB_OUTPUT"/,
  );
  assert.match(workflow, /TAG_EXISTS: \$\{\{ steps\.release_metadata\.outputs\.tag_exists \}\}/);
  assert.match(
    workflow,
    /if \[ "\$\{TAG_EXISTS\}" = "true" \]; then[\s\S]*RELEASE_COMMIT="\$\(git rev-parse "refs\/tags\/\$\{TAG\}\^\{\}"\)"[\s\S]*else\s+RELEASE_COMMIT="\$\(git rev-parse HEAD\)"/,
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
  assert.match(workflow, /trap 'rm -f "\$FETCH_LOG" ~\/\.ssh\/release_deploy_key' EXIT/);
  assert.match(
    workflow,
    /TAG_TARGET="\$\(git rev-parse "refs\/tags\/\$\{TAG\}\^\{\}"\)"/,
  );
  assert.match(workflow, /\[ "\$\{TAG_TARGET\}" != "\$\{RELEASE_COMMIT\}" \]/);
  assert.match(
    workflow,
    /git push "git@github\.com:\$\{\{ github\.repository \}\}\.git" "refs\/tags\/\$\{TAG\}"/,
  );
});

test("release workflow reads annotated tag metadata without peeling to commits", () => {
  assert.match(workflow, /git cat-file -e "refs\/tags\/\$\{tag\}\^\{tag\}"/);
  assert.match(workflow, /git cat-file -p "refs\/tags\/\$\{tag\}\^\{tag\}"/);
  assert.match(workflow, /printf '%s\\n' "\$\{TAG_CONTENT\}" \| grep -Fq "source-main-sha: \$\{SOURCE_MAIN_SHA\}"/);
});

test("release workflow derives publish metadata after package bump commits", () => {
  assert.match(workflow, /- name: Resolve final release metadata[\s\S]*FINAL_VERSION="\$\(node -p "require\('\.\/package\.json'\)\.version"\)"/);
  assert.match(workflow, /NEW_VERSION: \$\{\{ steps\.release_metadata\.outputs\.new_version \}\}/);
  assert.match(workflow, /tag_name: \$\{\{ steps\.release_metadata\.outputs\.tag_name \}\}/);
  assert.match(workflow, /VERSION="\$\{\{ steps\.release_metadata\.outputs\.new_version \}\}"/);
  assert.match(workflow, /--source-ref "\$\{\{ steps\.release_metadata\.outputs\.tag_name \}\}"/);
});

test("release workflow rejects version overrides that reuse existing tags before mutation", () => {
  assert.match(workflow, /OVERRIDE_TAG="v\$\{OVERRIDE\}"/);
  assert.match(workflow, /git rev-parse -q --verify "refs\/tags\/\$\{OVERRIDE_TAG\}"/);
  assert.match(workflow, /git fetch --force origin "refs\/tags\/\$\{OVERRIDE_TAG\}:refs\/tags\/\$\{OVERRIDE_TAG\}"/);
  assert.match(workflow, /Version override tag exists/);
  assert.ok(workflow.indexOf("Version override tag exists") < workflow.indexOf("node scripts/set-release-version.mjs"));
});

test("release workflow stages Claude companion manifests during version bumps", () => {
  assert.match(workflow, /packages\/\*\/\.claude-plugin\/plugin\.json/);
  assert.match(
    workflow,
    /git add package\.json packages\/\*\/package\.json packages\/\*\/openclaw\.plugin\.json packages\/\*\/\.claude-plugin\/plugin\.json openclaw\.plugin\.json pnpm-lock\.yaml/,
  );
  assert.match(
    workflow,
    /git diff --quiet -- packages\/\*\/package\.json packages\/\*\/openclaw\.plugin\.json packages\/\*\/\.claude-plugin\/plugin\.json openclaw\.plugin\.json/,
  );
});

test("release workflow validates workspace publish order before publishing", () => {
  assert.match(
    workflow,
    /cp scripts\/publish-order\.mjs "\$\{RUNNER_TEMP\}\/publish-order\.mjs"/,
  );
  assert.match(
    workflow,
    /node "\$\{RUNNER_TEMP\}\/publish-order\.mjs" --repo-root "\$PWD" --output "\$\{RUNNER_TEMP\}\/remnic-publish-order\.txt"/,
  );
  assert.match(workflow, /mapfile -t PUBLISH_ORDER < "\$\{RUNNER_TEMP\}\/remnic-publish-order\.txt"/);
});

test("release workflow fails existing tags with incomplete npm publication", () => {
  assert.match(workflow, /- name: Fail incomplete existing npm release/);
  assert.match(workflow, /if: steps\.release_metadata\.outputs\.tag_exists == 'true'/);
  assert.match(workflow, /Incomplete tagged release/);
  assert.match(workflow, /Existing release tag .* is incomplete/);
});

test("release workflow pins publish tooling", () => {
  assert.doesNotMatch(workflow, /npm install -g npm@latest/);
  assert.doesNotMatch(workflow, /npm install -g clawhub@latest/);
  assert.match(workflow, /npm install -g npm@11\.16\.0/);
  assert.match(workflow, /npm install -g clawhub@0\.18\.0/);
});
