import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { parseConfig } from "./config.js";

test("externalWikis applies safe read-only defaults and expands the root directory", () => {
  const config = parseConfig({
    externalWikis: [{ id: "reading", rootDir: "~/knowledge" }],
  });

  assert.deepEqual(config.externalWikis, [
    {
      id: "reading",
      rootDir: path.join(os.homedir(), "knowledge"),
      enabled: true,
      pagesDir: "wiki",
      indexFile: "INDEX.md",
      indexInQmd: false,
      includeInDefaultRecall: false,
    },
  ]);
});

test("externalWikis preserves explicit labels, paths, and opt-in indexing", () => {
  const config = parseConfig({
    externalWikis: [
      {
        id: "operations",
        rootDir: "/srv/operations-wiki",
        enabled: false,
        label: "Operations handbook",
        pagesDir: "pages",
        indexFile: "CATALOG.md",
        indexInQmd: true,
      },
    ],
  });

  assert.deepEqual(config.externalWikis, [
    {
      id: "operations",
      rootDir: "/srv/operations-wiki",
      enabled: false,
      label: "Operations handbook",
      pagesDir: "pages",
      indexFile: "CATALOG.md",
      indexInQmd: true,
      includeInDefaultRecall: false,
    },
  ]);
});

test("externalWikis rejects default-recall inclusion", () => {
  assert.throws(
    () => parseConfig({
      externalWikis: [
        {
          id: "reading",
          rootDir: "/srv/reading-wiki",
          includeInDefaultRecall: true,
        },
      ],
    }),
    /externalWikis\[0\]\.includeInDefaultRecall=true is not supported/,
  );
});

test("externalWikis rejects ambiguous or escaping layouts", () => {
  assert.throws(
    () => parseConfig({ externalWikis: [{ id: "reading", rootDir: "relative/wiki" }] }),
    /rootDir must be an absolute path or start with ~\//,
  );
  assert.throws(
    () => parseConfig({
      externalWikis: [{ id: "reading", rootDir: "/srv/wiki", pagesDir: "../other" }],
    }),
    /pagesDir must be a relative path within rootDir/,
  );
  assert.throws(
    () => parseConfig({
      externalWikis: [
        { id: "reading", rootDir: "/srv/a" },
        { id: "reading", rootDir: "/srv/b" },
      ],
    }),
    /duplicate id "reading"/,
  );
});

test("externalWikis rejects roots inside the primary memory directory", () => {
  assert.throws(
    () => parseConfig({
      memoryDir: "/srv/remnic/memory",
      externalWikis: [
        { id: "reading", rootDir: "/srv/remnic/memory/external/reading" },
      ],
    }),
    /rootDir must be outside memoryDir/,
  );
});
