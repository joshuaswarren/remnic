import assert from "node:assert/strict";
import test from "node:test";

import {
  isMacOsReplicationJunkBasename,
  isMacOsReplicationJunkRelativePath,
  warnIgnoredMacOsReplicationJunk,
  withoutMacOsReplicationJunk,
} from "./macos-replication-junk.js";

test("macOS replication junk is AppleDouble sidecars and .DS_Store only", () => {
  assert.equal(isMacOsReplicationJunkBasename("._project-notes.md"), true);
  assert.equal(isMacOsReplicationJunkBasename("._"), true);
  assert.equal(isMacOsReplicationJunkBasename(".DS_Store"), true);
  assert.equal(isMacOsReplicationJunkBasename("project-notes.md"), false);
  assert.equal(isMacOsReplicationJunkBasename(".gitignore"), false);
  assert.equal(isMacOsReplicationJunkBasename("DS_Store"), false);
  assert.equal(isMacOsReplicationJunkRelativePath("namespaces/lab/entities/._project-notes.md"), true);
  assert.equal(isMacOsReplicationJunkRelativePath("namespaces\\lab\\.DS_Store"), true);
  assert.equal(isMacOsReplicationJunkRelativePath("entities/project-notes.md"), false);
});

test("withoutMacOsReplicationJunk keeps real names and counts junk once", () => {
  const { kept, ignored } = withoutMacOsReplicationJunk(
    ["project-notes.md", "._project-notes.md", ".DS_Store", "correction-1.md"],
    (name) => name
  );
  assert.deepEqual(kept, ["project-notes.md", "correction-1.md"]);
  assert.equal(ignored, 2);
});

test("warnIgnoredMacOsReplicationJunk emits one summary per directory and count", () => {
  const messages: string[] = [];
  const warn = (message: string) => {
    messages.push(message);
  };
  const directory = `junk-warn-${process.pid}-${Date.now()}`;
  warnIgnoredMacOsReplicationJunk(directory, 2, warn);
  warnIgnoredMacOsReplicationJunk(directory, 2, warn);
  warnIgnoredMacOsReplicationJunk(directory, 0, warn);
  warnIgnoredMacOsReplicationJunk(directory, 3, warn);
  assert.deepEqual(messages, [
    "ignored 2 macOS replication junk file(s) (._* and .DS_Store)",
    "ignored 3 macOS replication junk file(s) (._* and .DS_Store)",
  ]);
});
