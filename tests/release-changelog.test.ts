import test from "node:test";
import assert from "node:assert/strict";
import { promoteUnreleasedChangelog } from "../src/release-changelog.ts";

test("promoteUnreleasedChangelog moves unreleased entries into a dated release section", () => {
  const input = `# Changelog

All notable changes to this project will be documented in this file.

## [Unreleased]

### Added
- Added a lifecycle ledger.

### Fixed
- Fixed a release workflow bug.

## [v9.0.0] - 2026-03-01

### Added
- Earlier release note.
`;

  const output = promoteUnreleasedChangelog(input, {
    version: "9.0.1",
    date: "2026-03-08",
  });

  assert.match(output, /## \[Unreleased\]\n\n## \[v9\.0\.1\] - 2026-03-08/);
  assert.match(output, /### Added\n- Added a lifecycle ledger\./);
  assert.match(output, /### Fixed\n- Fixed a release workflow bug\./);
  assert.match(output, /- Fixed a release workflow bug\.\n\n## \[v9\.0\.0\] - 2026-03-01/);
  assert.match(output, /## \[v9\.0\.0\] - 2026-03-01/);
});

test("promoteUnreleasedChangelog is a no-op when unreleased has no entries", () => {
  const input = `# Changelog

All notable changes to this project will be documented in this file.

## [Unreleased]

## [v9.0.0] - 2026-03-01

### Added
- Earlier release note.
`;

  const output = promoteUnreleasedChangelog(input, {
    version: "9.0.1",
    date: "2026-03-08",
  });

  assert.equal(output, input);
});

test("promoteUnreleasedChangelog normalizes a leading v prefix in version input", () => {
  const input = `# Changelog

## [Unreleased]

### Fixed
- Fixed another release workflow bug.
`;

  const output = promoteUnreleasedChangelog(input, {
    version: "v9.0.2",
    date: "2026-03-08",
  });

  assert.match(output, /## \[v9\.0\.2\] - 2026-03-08/);
  assert.doesNotMatch(output, /## \[vv9\.0\.2\]/);
});
