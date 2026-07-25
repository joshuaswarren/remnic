import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { StorageManager } from "./storage.js";

const WRITE_TIME = "2030-01-02T03:04:05.000Z";
const STALE_HEADER = "*Last updated: 2024-01-02T03:04:05.000Z*";
const FRESH_HEADER = `*Last updated: ${WRITE_TIME}*`;

async function withMemoryDir(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-profile-timestamp-"));
  try {
    await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("writeProfile refreshes a stale header at the write time", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse(WRITE_TIME) });
  try {
    await withMemoryDir(async (dir) => {
      const storage = new StorageManager(dir);
      const staleProfile = [
        "# Behavioral Profile",
        "",
        STALE_HEADER,
        "",
        "- Prefers concise status updates.",
        "",
      ].join("\n");

      await storage.writeProfile(staleProfile);

      assert.equal(
        await storage.readProfile(),
        staleProfile.replace(STALE_HEADER, FRESH_HEADER),
      );
    });
  } finally {
    t.mock.timers.reset();
  }
});

test("writeProfile adds one canonical header when content has none", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse(WRITE_TIME) });
  try {
    await withMemoryDir(async (dir) => {
      const storage = new StorageManager(dir);

      await storage.writeProfile("# Behavioral Profile\n\n- Values direct communication.\n");

      assert.equal(
        await storage.readProfile(),
        `# Behavioral Profile\n\n${FRESH_HEADER}\n\n- Values direct communication.\n`,
      );
    });
  } finally {
    t.mock.timers.reset();
  }
});
test("writeProfile handles a title-only profile without a trailing newline", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse(WRITE_TIME) });
  try {
    await withMemoryDir(async (dir) => {
      const storage = new StorageManager(dir);

      await storage.writeProfile("# Behavioral Profile");

      assert.equal(await storage.readProfile(), `# Behavioral Profile\n${FRESH_HEADER}\n\n`);
    });
  } finally {
    t.mock.timers.reset();
  }
});
test("writeProfile preserves compound emphasis instead of replacing it", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse(WRITE_TIME) });
  try {
    await withMemoryDir(async (dir) => {
      const storage = new StorageManager(dir);
      const compoundHeader = "*Last updated: source value* and *status: active*";
      const profile = [
        "# Behavioral Profile",
        "",
        compoundHeader,
        "",
        "- Keeps compound metadata.",
        "",
      ].join("\n");

      await storage.writeProfile(profile);

      assert.equal(
        await storage.readProfile(),
        [
          "# Behavioral Profile",
          "",
          FRESH_HEADER,
          "",
          compoundHeader,
          "",
          "- Keeps compound metadata.",
          "",
        ].join("\n"),
      );
    });
  } finally {
    t.mock.timers.reset();
  }
});

test("writeProfile recognizes an indented profile title", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse(WRITE_TIME) });
  try {
    await withMemoryDir(async (dir) => {
      const storage = new StorageManager(dir);
      const profile = [
        "  # Behavioral Profile",
        "",
        "- Keeps the title boundary.",
        "",
      ].join("\n");

      await storage.writeProfile(profile);

      assert.equal(
        await storage.readProfile(),
        [
          "  # Behavioral Profile",
          "",
          FRESH_HEADER,
          "",
          "- Keeps the title boundary.",
          "",
        ].join("\n"),
      );
    });
  } finally {
    t.mock.timers.reset();
  }
});

test("writeProfile recognizes raw HTML terminators with trailing text", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse(WRITE_TIME) });
  try {
    await withMemoryDir(async (dir) => {
      const storage = new StorageManager(dir);
      const profile = [
        "# Behavioral Profile",
        "",
        "<pre>",
        "Literal preformatted content.",
        "code</pre> trailing text",
        STALE_HEADER,
        "",
        "- Keeps metadata after raw HTML.",
        "",
      ].join("\n");

      await storage.writeProfile(profile);

      assert.equal(await storage.readProfile(), profile.replace(STALE_HEADER, FRESH_HEADER));
    });
  } finally {
    t.mock.timers.reset();
  }
});
test("writeProfile does not treat URI or email autolinks as HTML blocks", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse(WRITE_TIME) });
  try {
    await withMemoryDir(async (dir) => {
      const storage = new StorageManager(dir);
      const profile = [
        "<https://example.com>",
        "<user@example.com>",
        "# Behavioral Profile",
        "",
        STALE_HEADER,
        "",
        "- Keeps autolinks as prose.",
        "",
      ].join("\n");

      await storage.writeProfile(profile);

      assert.equal(await storage.readProfile(), profile.replace(STALE_HEADER, FRESH_HEADER));
    });
  } finally {
    t.mock.timers.reset();
  }
});
test("writeProfile preserves case-sensitive CDATA block detection", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse(WRITE_TIME) });
  try {
    await withMemoryDir(async (dir) => {
      const storage = new StorageManager(dir);
      const profile = [
        "<![cdata[",
        "# Behavioral Profile",
        "",
        STALE_HEADER,
        "",
        "- Keeps lowercase CDATA-like text as prose.",
        "",
      ].join("\n");

      await storage.writeProfile(profile);

      assert.equal(await storage.readProfile(), profile.replace(STALE_HEADER, FRESH_HEADER));
    });
  } finally {
    t.mock.timers.reset();
  }
});
test("writeProfile recognizes thematic breaks as metadata boundaries", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse(WRITE_TIME) });
  try {
    await withMemoryDir(async (dir) => {
      const storage = new StorageManager(dir);
      const profile = [
        "# Behavioral Profile",
        "",
        "***",
        STALE_HEADER,
        "",
        "- Keeps thematic-break metadata compact.",
        "",
      ].join("\n");

      await storage.writeProfile(profile);

      assert.equal(await storage.readProfile(), profile.replace(STALE_HEADER, FRESH_HEADER));
    });
  } finally {
    t.mock.timers.reset();
  }
});
test("writeProfile keeps an inserted header standalone", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse(WRITE_TIME) });
  try {
    await withMemoryDir(async (dir) => {
      const storage = new StorageManager(dir);
      await storage.writeProfile("# Behavioral Profile\n- Values direct communication.\n");

      const firstWrite = await storage.readProfile();
      await storage.writeProfile(firstWrite);

      assert.equal(await storage.readProfile(), firstWrite);
    });
  } finally {
    t.mock.timers.reset();
  }
});

test("writeProfile preserves CRLF line endings", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse(WRITE_TIME) });
  try {
    await withMemoryDir(async (dir) => {
      const storage = new StorageManager(dir);

      await storage.writeProfile("# Behavioral Profile\r\n\r\n- Values direct communication.\r\n");

      assert.equal(
        await storage.readProfile(),
        `# Behavioral Profile\r\n\r\n${FRESH_HEADER}\r\n\r\n- Values direct communication.\r\n`,
      );
    });
  } finally {
    t.mock.timers.reset();
  }
});
test("writeProfile preserves mixed existing line endings", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse(WRITE_TIME) });
  try {
    await withMemoryDir(async (dir) => {
      const storage = new StorageManager(dir);
      const profile = `# Behavioral Profile\r\n\n${STALE_HEADER}\r\n\n- Keeps original separators.\r\n`;

      await storage.writeProfile(profile);

      assert.equal(await storage.readProfile(), profile.replace(STALE_HEADER, FRESH_HEADER));
    });
  } finally {
    t.mock.timers.reset();
  }
});

test("writeProfile preserves standalone carriage-return line endings", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse(WRITE_TIME) });
  try {
    await withMemoryDir(async (dir) => {
      const storage = new StorageManager(dir);
      const profile = `# Behavioral Profile\r\r${STALE_HEADER}\r\r- Keeps original separators.\r`;

      await storage.writeProfile(profile);

      assert.equal(await storage.readProfile(), profile.replace(STALE_HEADER, FRESH_HEADER));
    });
  } finally {
    t.mock.timers.reset();
  }
});

test("writeProfile ignores HTML comment markers inside fenced code", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse(WRITE_TIME) });
  try {
    await withMemoryDir(async (dir) => {
      const storage = new StorageManager(dir);
      const profile = [
        "```markdown",
        "<!--",
        "*Last updated: literal example*",
        "```",
        "",
        "# Behavioral Profile",
        "",
        STALE_HEADER,
        "",
        "- Keeps fenced literal content.",
        "",
      ].join("\n");

      await storage.writeProfile(profile);

      assert.equal(await storage.readProfile(), profile.replace(STALE_HEADER, FRESH_HEADER));
    });
  } finally {
    t.mock.timers.reset();
  }
});

test("writeProfile preserves timestamp-shaped ordinary HTML blocks", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse(WRITE_TIME) });
  try {
    await withMemoryDir(async (dir) => {
      const storage = new StorageManager(dir);
      for (const tag of ["div", "table"]) {
        const profile = [
          "# Behavioral Profile",
          "",
          `<${tag}>`,
          "*Last updated: literal example*",
          `</${tag}>`,
          "",
          "- Keeps HTML examples.",
          "",
        ].join("\n");

        await storage.writeProfile(profile);

        assert.equal(
          await storage.readProfile(),
          profile.replace(`\n\n<${tag}>`, `\n\n${FRESH_HEADER}\n\n<${tag}>`),
        );
      }
    });
  } finally {
    t.mock.timers.reset();
  }
});

test("writeProfile preserves timestamp-shaped nested list content", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse(WRITE_TIME) });
  try {
    await withMemoryDir(async (dir) => {
      const storage = new StorageManager(dir);
      const profile = [
        "# Behavioral Profile",
        "",
        "  *Last updated: literal example*",
        "",
        "- Keeps list content.",
        "",
      ].join("\n");

      await storage.writeProfile(profile);

      assert.equal(
        await storage.readProfile(),
        [
          "# Behavioral Profile",
          "",
          FRESH_HEADER,
          "",
          "  *Last updated: literal example*",
          "",
          "- Keeps list content.",
          "",
        ].join("\n"),
      );
    });
  } finally {
    t.mock.timers.reset();
  }
});

test("writeProfile ends a one-line HTML declaration before finding the title", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse(WRITE_TIME) });
  try {
    await withMemoryDir(async (dir) => {
      const storage = new StorageManager(dir);
      const profile = [
        "<!DOCTYPE html>",
        "# Behavioral Profile",
        "",
        "- Keeps declaration content.",
        "",
      ].join("\n");

      await storage.writeProfile(profile);

      assert.equal(
        await storage.readProfile(),
        [
          "<!DOCTYPE html>",
          "# Behavioral Profile",
          "",
          FRESH_HEADER,
          "",
          "- Keeps declaration content.",
          "",
        ].join("\n"),
      );
    });
  } finally {
    t.mock.timers.reset();
  }
});

test("writeProfile keeps nested same-name HTML blocks opaque", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse(WRITE_TIME) });
  try {
    await withMemoryDir(async (dir) => {
      const storage = new StorageManager(dir);
      const profile = [
        "# Behavioral Profile",
        "",
        "<div>",
        "<div></div>",
        "*Last updated: literal example*",
        "</div>",
        "",
        "- Keeps nested HTML.",
        "",
      ].join("\n");

      await storage.writeProfile(profile);

      assert.equal(
        await storage.readProfile(),
        [
          "# Behavioral Profile",
          "",
          FRESH_HEADER,
          "",
          "<div>",
          "<div></div>",
          "*Last updated: literal example*",
          "</div>",
          "",
          "- Keeps nested HTML.",
          "",
        ].join("\n"),
      );
    });
  } finally {
    t.mock.timers.reset();
  }
});

test("writeProfile ignores invalid backtick fence openers", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse(WRITE_TIME) });
  try {
    await withMemoryDir(async (dir) => {
      const storage = new StorageManager(dir);
      const profile = [
        "```markdown`invalid",
        "# Behavioral Profile",
        "",
        STALE_HEADER,
        "",
        "- Keeps ordinary Markdown visible.",
        "",
      ].join("\n");

      await storage.writeProfile(profile);

      assert.equal(await storage.readProfile(), profile.replace(STALE_HEADER, FRESH_HEADER));
    });
  } finally {
    t.mock.timers.reset();
  }
});

test("writeProfile exits an ordinary HTML block at its closing tag", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse(WRITE_TIME) });
  try {
    await withMemoryDir(async (dir) => {
      const storage = new StorageManager(dir);
      const profile = [
        "<div>",
        "*Last updated: literal example*",
        "</div>",
        "# Behavioral Profile",
        "",
        STALE_HEADER,
        "",
        "- Keeps metadata after HTML.",
        "",
      ].join("\n");

      await storage.writeProfile(profile);

      assert.equal(await storage.readProfile(), profile.replace(STALE_HEADER, FRESH_HEADER));
    });
  } finally {
    t.mock.timers.reset();
  }
});

test("writeProfile preserves HTML blocks with multiline open tags", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse(WRITE_TIME) });
  try {
    await withMemoryDir(async (dir) => {
      const storage = new StorageManager(dir);
      const profile = [
        "# Behavioral Profile",
        "",
        "<div",
        '  class="example">',
        "*Last updated: literal example*",
        "</div>",
        "",
        "- Keeps multiline HTML.",
        "",
      ].join("\n");

      await storage.writeProfile(profile);

      assert.equal(
        await storage.readProfile(),
        profile.replace("\n\n<div", `\n\n${FRESH_HEADER}\n\n<div`),
      );
    });
  } finally {
    t.mock.timers.reset();
  }
});

test("writeProfile closes an active HTML block before skipping indented code", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse(WRITE_TIME) });
  try {
    await withMemoryDir(async (dir) => {
      const storage = new StorageManager(dir);
      const profile = [
        "<pre>",
        "*Last updated: literal example*",
        "    </pre>",
        "# Behavioral Profile",
        "",
        STALE_HEADER,
        "",
        "- Keeps metadata after HTML.",
        "",
      ].join("\n");

      await storage.writeProfile(profile);

      assert.equal(await storage.readProfile(), profile.replace(STALE_HEADER, FRESH_HEADER));
    });
  } finally {
    t.mock.timers.reset();
  }
});


test("writeProfile preserves timestamp-shaped generic HTML blocks", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse(WRITE_TIME) });
  try {
    await withMemoryDir(async (dir) => {
      const storage = new StorageManager(dir);
      const profile = [
        "# Behavioral Profile",
        "",
        "<custom-widget>",
        "*Last updated: literal example*",
        "</custom-widget>",
        "",
        "- Keeps custom HTML.",
        "",
      ].join("\n");

      await storage.writeProfile(profile);

      assert.equal(
        await storage.readProfile(),
        profile.replace("\n\n<custom-widget>", `\n\n${FRESH_HEADER}\n\n<custom-widget>`),
      );
    });
  } finally {
    t.mock.timers.reset();
  }
});

test("writeProfile keeps inline HTML blocks opaque until a blank line", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse(WRITE_TIME) });
  try {
    await withMemoryDir(async (dir) => {
      const storage = new StorageManager(dir);
      const profile = [
        "# Behavioral Profile",
        "",
        "<div>example</div>",
        STALE_HEADER,
        "",
        "- Keeps inline HTML opaque.",
        "",
      ].join("\n");

      await storage.writeProfile(profile);

      assert.equal(
        await storage.readProfile(),
        profile.replace("\n\n<div>example</div>", `\n\n${FRESH_HEADER}\n\n<div>example</div>`),
      );
    });
  } finally {
    t.mock.timers.reset();
  }
});

test("writeProfile keeps the post-title header when duplicate headers exist", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse(WRITE_TIME) });
  try {
    await withMemoryDir(async (dir) => {
      const storage = new StorageManager(dir);
      const preTitleHeader = "*Last updated: 2023-01-02T03:04:05.000Z*";
      const profile = [
        preTitleHeader,
        "",
        "# Behavioral Profile",
        "",
        STALE_HEADER,
        "",
        "- Keeps the canonical header after the title.",
        "",
      ].join("\n");

      await storage.writeProfile(profile);

      const updated = await storage.readProfile();
      assert.equal((updated.match(/^\*Last updated: .*$/gm) ?? []).length, 1);
      assert.equal(updated.includes(preTitleHeader), false);
      assert.ok(updated.includes(`# Behavioral Profile\n\n${FRESH_HEADER}`));
    });
  } finally {
    t.mock.timers.reset();
  }
});
test("writeProfile retains a BOM when removing a duplicate pre-title header", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse(WRITE_TIME) });
  try {
    await withMemoryDir(async (dir) => {
      const storage = new StorageManager(dir);
      const profile = [
        `\uFEFF${STALE_HEADER}`,
        "# Behavioral Profile",
        "",
        STALE_HEADER,
        "",
        "- Keeps the file marker.",
        "",
      ].join("\n");

      await storage.writeProfile(profile);

      assert.equal(
        await storage.readProfile(),
        [
          "\uFEFF# Behavioral Profile",
          "",
          FRESH_HEADER,
          "",
          "- Keeps the file marker.",
          "",
        ].join("\n"),
      );
    });
  } finally {
    t.mock.timers.reset();
  }
});

test("writeProfile recognizes heading and list metadata boundaries", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse(WRITE_TIME) });
  try {
    await withMemoryDir(async (dir) => {
      const storage = new StorageManager(dir);
      const profiles = [
        [
          "# Behavioral Profile",
          "",
          "## Notes",
          STALE_HEADER,
          "",
          "- Keeps heading metadata.",
          "",
        ].join("\n"),
        [
          "# Behavioral Profile",
          "",
          "- Existing note.",
          STALE_HEADER,
          "",
          "- Keeps list metadata.",
          "",
        ].join("\n"),
      ];

      for (const profile of profiles) {
        await storage.writeProfile(profile);
        assert.equal(await storage.readProfile(), profile.replace(STALE_HEADER, FRESH_HEADER));
      }
    });
  } finally {
    t.mock.timers.reset();
  }
});

test("writeProfile recognizes raw HTML terminators as metadata boundaries", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse(WRITE_TIME) });
  try {
    await withMemoryDir(async (dir) => {
      const storage = new StorageManager(dir);
      const profile = [
        "# Behavioral Profile",
        "",
        "<pre>",
        "Literal preformatted content.",
        "</pre>",
        STALE_HEADER,
        "",
        "- Keeps metadata after raw HTML.",
        "",
      ].join("\n");

      await storage.writeProfile(profile);

      assert.equal(await storage.readProfile(), profile.replace(STALE_HEADER, FRESH_HEADER));
    });
  } finally {
    t.mock.timers.reset();
  }
});

test("writeProfile removes duplicate stale headers", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse(WRITE_TIME) });
  try {
    await withMemoryDir(async (dir) => {
      const storage = new StorageManager(dir);
      await storage.writeProfile([
        "# Behavioral Profile",
        "",
        STALE_HEADER,
        "",
        "*Last updated: 2023-01-02T03:04:05.000Z*",
        "",
        "- Keeps decisions short.",
        "",
      ].join("\n"));

      const profile = await storage.readProfile();
      assert.deepEqual(profile.match(/^\*Last updated:.*\*$/gm), [FRESH_HEADER]);
      assert.match(profile, /- Keeps decisions short\./);
    });
  } finally {
    t.mock.timers.reset();
  }
});

test("writeProfile replaces a noncanonical metadata header", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse(WRITE_TIME) });
  try {
    await withMemoryDir(async (dir) => {
      const storage = new StorageManager(dir);
      const profile = [
        "# Behavioral Profile",
        "",
        "*Last updated: before launch*",
        "",
        "- Keeps decisions short.",
        "",
      ].join("\n");

      await storage.writeProfile(profile);

      assert.equal(
        await storage.readProfile(),
        profile.replace("*Last updated: before launch*", FRESH_HEADER),
      );
    });
  } finally {
    t.mock.timers.reset();
  }
});
test("writeProfile preserves timestamp-shaped prose continuations", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse(WRITE_TIME) });
  try {
    await withMemoryDir(async (dir) => {
      const storage = new StorageManager(dir);
      const profile = [
        "# Behavioral Profile",
        "",
        "This example displays the following label",
        "*Last updated: literal example*",
        "",
        "- Keeps prose content.",
        "",
      ].join("\n");

      await storage.writeProfile(profile);

      assert.equal(
        await storage.readProfile(),
        profile.replace(
          "\n\nThis example displays",
          `\n\n${FRESH_HEADER}\n\nThis example displays`,
        ),
      );
    });
  } finally {
    t.mock.timers.reset();
  }
});
test("writeProfile refreshes compact title metadata", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse(WRITE_TIME) });
  try {
    await withMemoryDir(async (dir) => {
      const storage = new StorageManager(dir);
      const profile = [
        "# Behavioral Profile",
        STALE_HEADER,
        "*Last updated: 2023-01-02T03:04:05.000Z*",
        "",
        "- Keeps compact metadata.",
        "",
      ].join("\n");

      await storage.writeProfile(profile);

      assert.equal(
        await storage.readProfile(),
        `# Behavioral Profile\n${FRESH_HEADER}\n\n- Keeps compact metadata.\n`,
      );
    });
  } finally {
    t.mock.timers.reset();
  }
});
test("writeProfile recognizes heading and fence metadata boundaries", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse(WRITE_TIME) });
  try {
    await withMemoryDir(async (dir) => {
      const storage = new StorageManager(dir);
      const profiles = [
        [STALE_HEADER, "# Behavioral Profile", "", "- Keeps leading metadata.", ""].join("\n"),
        [
          "# Behavioral Profile",
          "",
          "```",
          "- Keeps fenced content.",
          "```",
          STALE_HEADER,
          "",
          "- Keeps trailing metadata.",
          "",
        ].join("\n"),
      ];

      for (const profile of profiles) {
        await storage.writeProfile(profile);
        assert.equal(await storage.readProfile(), profile.replace(STALE_HEADER, FRESH_HEADER));
      }
    });
  } finally {
    t.mock.timers.reset();
  }
});

test("writeProfile recognizes whitespace-only metadata gaps", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse(WRITE_TIME) });
  try {
    await withMemoryDir(async (dir) => {
      const storage = new StorageManager(dir);
      const profile = [
        "# Behavioral Profile",
        " \t",
        STALE_HEADER,
        "",
        "- Keeps decisions short.",
        "",
      ].join("\n");

      await storage.writeProfile(profile);

      assert.equal(await storage.readProfile(), profile.replace(STALE_HEADER, FRESH_HEADER));
    });
  } finally {
    t.mock.timers.reset();
  }
});

test("writeProfile finds a title after a preamble", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse(WRITE_TIME) });
  try {
    await withMemoryDir(async (dir) => {
      const storage = new StorageManager(dir);
      const profile = [
        "Generated by the profile importer.",
        "",
        "# Behavioral Profile",
        "",
        STALE_HEADER,
        "",
        "- Keeps decisions short.",
        "",
      ].join("\n");

      await storage.writeProfile(profile);

      assert.equal(await storage.readProfile(), profile.replace(STALE_HEADER, FRESH_HEADER));
    });
  } finally {
    t.mock.timers.reset();
  }
});

test("writeProfile does not treat fenced headings as a profile title", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse(WRITE_TIME) });
  try {
    await withMemoryDir(async (dir) => {
      const storage = new StorageManager(dir);
      const profile = ["```shell", "# install dependencies", "```", ""].join("\n");

      await storage.writeProfile(profile);

      assert.equal(await storage.readProfile(), `${FRESH_HEADER}\n\n${profile}`);
    });
  } finally {
    t.mock.timers.reset();
  }
});

test("writeProfile keeps nested fences from exposing code headings", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse(WRITE_TIME) });
  try {
    await withMemoryDir(async (dir) => {
      const storage = new StorageManager(dir);
      const profile = [
        "````markdown",
        "```",
        "# install dependencies",
        "```",
        "````",
        "",
      ].join("\n");

      await storage.writeProfile(profile);

      assert.equal(await storage.readProfile(), `${FRESH_HEADER}\n\n${profile}`);
    });
  } finally {
    t.mock.timers.reset();
  }
});

test("writeProfile refreshes an off-slot header outside fenced code", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse(WRITE_TIME) });
  try {
    await withMemoryDir(async (dir) => {
      const storage = new StorageManager(dir);
      const profile = [
        "# Behavioral Profile",
        "",
        "- Keeps decisions short.",
        "",
        "## Notes",
        "",
        STALE_HEADER,
        "",
      ].join("\n");

      await storage.writeProfile(profile);

      assert.equal(await storage.readProfile(), profile.replace(STALE_HEADER, FRESH_HEADER));
    });
  } finally {
    t.mock.timers.reset();
  }
});

test("writeProfile keeps fence lines with language text inside code", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse(WRITE_TIME) });
  try {
    await withMemoryDir(async (dir) => {
      const storage = new StorageManager(dir);
      const profile = [
        "```markdown",
        "```js",
        "# install dependencies",
        "```",
        "",
      ].join("\n");

      await storage.writeProfile(profile);

      assert.equal(await storage.readProfile(), `${FRESH_HEADER}\n\n${profile}`);
    });
  } finally {
    t.mock.timers.reset();
  }
});

test("writeProfile preserves a leading BOM before the title", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse(WRITE_TIME) });
  try {
    await withMemoryDir(async (dir) => {
      const storage = new StorageManager(dir);
      const profile = `\uFEFF# Behavioral Profile\n\n${STALE_HEADER}\n\n- Keeps decisions short.\n`;

      await storage.writeProfile(profile);

      assert.equal(await storage.readProfile(), profile.replace(STALE_HEADER, FRESH_HEADER));
    });
  } finally {
    t.mock.timers.reset();
  }
});
test("writeProfile refreshes a BOM-prefixed header before the title", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse(WRITE_TIME) });
  try {
    await withMemoryDir(async (dir) => {
      const storage = new StorageManager(dir);
      const profile = `\uFEFF${STALE_HEADER}\n# Behavioral Profile\n\n- Keeps metadata.\n`;

      await storage.writeProfile(profile);

      assert.equal(await storage.readProfile(), `\uFEFF${FRESH_HEADER}\n# Behavioral Profile\n\n- Keeps metadata.\n`);
    });
  } finally {
    t.mock.timers.reset();
  }
});
test("writeProfile preserves a BOM-prefixed fenced example", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse(WRITE_TIME) });
  try {
    await withMemoryDir(async (dir) => {
      const storage = new StorageManager(dir);
      const profile = [
        "\uFEFF```markdown",
        "# Literal example",
        "```",
        "",
        "- Keeps fenced content.",
        "",
      ].join("\n");

      await storage.writeProfile(profile);

      assert.equal(await storage.readProfile(), `\uFEFF${FRESH_HEADER}\n\n${profile.slice(1)}`);
    });
  } finally {
    t.mock.timers.reset();
  }
});

test("writeProfile preserves timestamp-shaped indented code", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse(WRITE_TIME) });
  try {
    await withMemoryDir(async (dir) => {
      const storage = new StorageManager(dir);
      const profile = [
        "# Behavioral Profile",
        "",
        "## Notes",
        "",
        "    *Last updated: literal example*",
        "",
      ].join("\n");

      await storage.writeProfile(profile);

      assert.equal(
        await storage.readProfile(),
        profile.replace("\n\n## Notes", `\n\n${FRESH_HEADER}\n\n## Notes`),
      );
    });
  } finally {
    t.mock.timers.reset();
  }
});

test("writeProfile keeps four-space fence-like lines inside code", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse(WRITE_TIME) });
  try {
    await withMemoryDir(async (dir) => {
      const storage = new StorageManager(dir);
      const profile = [
        "```markdown",
        "    ```",
        "# install dependencies",
        "```",
        "",
      ].join("\n");

      await storage.writeProfile(profile);

      assert.equal(await storage.readProfile(), `${FRESH_HEADER}\n\n${profile}`);
    });
  } finally {
    t.mock.timers.reset();
  }
});

test("writeProfile keeps leading frontmatter before a header", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse(WRITE_TIME) });
  try {
    await withMemoryDir(async (dir) => {
      const storage = new StorageManager(dir);
      const profile = ["---", "source: importer", "---", "", "- Keeps decisions short.", ""].join("\n");

      await storage.writeProfile(profile);

      assert.equal(
        await storage.readProfile(),
        `---\nsource: importer\n---\n\n${FRESH_HEADER}\n\n- Keeps decisions short.\n`,
      );
    });
  } finally {
    t.mock.timers.reset();
  }
});
test("writeProfile keeps YAML block-scalar delimiters inside frontmatter", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse(WRITE_TIME) });
  try {
    await withMemoryDir(async (dir) => {
      const storage = new StorageManager(dir);
      const profile = [
        "---",
        "description: |",
        "  ---",
        "  ...",
        "---",
        "",
        "- Keeps decisions short.",
        "",
      ].join("\n");

      await storage.writeProfile(profile);

      assert.equal(
        await storage.readProfile(),
        `---\ndescription: |\n  ---\n  ...\n---\n\n${FRESH_HEADER}\n\n- Keeps decisions short.\n`,
      );
    });
  } finally {
    t.mock.timers.reset();
  }
});

test("writeProfile preserves timestamp-shaped HTML preformatted code", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse(WRITE_TIME) });
  try {
    await withMemoryDir(async (dir) => {
      const storage = new StorageManager(dir);
      const profile = [
        "# Behavioral Profile",
        "",
        "<pre>",
        "*Last updated: literal example*",
        "</pre>",
        "",
        "- Keeps code examples.",
        "",
      ].join("\n");

      await storage.writeProfile(profile);

      assert.equal(
        await storage.readProfile(),
        profile.replace("\n\n<pre>", `\n\n${FRESH_HEADER}\n\n<pre>`),
      );
    });
  } finally {
    t.mock.timers.reset();
  }
});
test("writeProfile preserves timestamp-shaped raw HTML blocks", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse(WRITE_TIME) });
  try {
    await withMemoryDir(async (dir) => {
      const storage = new StorageManager(dir);
      for (const tag of ["textarea", "script", "style", "xmp"]) {
        const profile = [
          "# Behavioral Profile",
          "",
          `<${tag}>`,
          "*Last updated: literal example*",
          `</${tag}>`,
          "",
          "- Keeps code examples.",
          "",
        ].join("\n");

        await storage.writeProfile(profile);

        assert.equal(
          await storage.readProfile(),
          profile.replace(`\n\n<${tag}>`, `\n\n${FRESH_HEADER}\n\n<${tag}>`),
        );
      }
    });
  } finally {
    t.mock.timers.reset();
  }
});
test("writeProfile closes same-line raw HTML blocks", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse(WRITE_TIME) });
  try {
    await withMemoryDir(async (dir) => {
      const storage = new StorageManager(dir);
      const profile = [
        "# Behavioral Profile",
        "",
        "<pre>inline </pre>",
        "# Notes",
        "",
        STALE_HEADER,
        "",
        "- Keeps metadata after inline code.",
        "",
      ].join("\n");

      await storage.writeProfile(profile);

      assert.equal(await storage.readProfile(), profile.replace(STALE_HEADER, FRESH_HEADER));
    });
  } finally {
    t.mock.timers.reset();
  }
});
test("writeProfile closes raw HTML blocks after inline content", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse(WRITE_TIME) });
  try {
    await withMemoryDir(async (dir) => {
      const storage = new StorageManager(dir);
      const profile = [
        "# Behavioral Profile",
        "",
        "<pre>",
        "code</pre>",
        "# Notes",
        "",
        STALE_HEADER,
        "",
        "- Keeps metadata after inline code.",
        "",
      ].join("\n");

      await storage.writeProfile(profile);

      assert.equal(await storage.readProfile(), profile.replace(STALE_HEADER, FRESH_HEADER));
    });
  } finally {
    t.mock.timers.reset();
  }
});
test("writeProfile closes raw HTML blocks before sibling markup", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse(WRITE_TIME) });
  try {
    await withMemoryDir(async (dir) => {
      const storage = new StorageManager(dir);
      const profile = [
        "# Behavioral Profile",
        "",
        "<pre>",
        "code</pre><div>",
        "# Notes",
        "",
        STALE_HEADER,
        "",
        "- Keeps metadata after sibling markup.",
        "",
      ].join("\n");

      await storage.writeProfile(profile);

      assert.equal(await storage.readProfile(), profile.replace(STALE_HEADER, FRESH_HEADER));
    });
  } finally {
    t.mock.timers.reset();
  }
});
test("writeProfile keeps self-closing raw HTML blocks opaque", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse(WRITE_TIME) });
  try {
    await withMemoryDir(async (dir) => {
      const storage = new StorageManager(dir);
      const profile = [
        "# Behavioral Profile",
        "",
        "<pre/>",
        "*Last updated: literal example*",
        "",
        "- Keeps self-closing raw HTML opaque.",
        "",
      ].join("\n");

      await storage.writeProfile(profile);

      assert.equal(
        await storage.readProfile(),
        profile.replace("\n\n<pre/>", `\n\n${FRESH_HEADER}\n\n<pre/>`),
      );
    });
  } finally {
    t.mock.timers.reset();
  }
});
test("writeProfile keeps raw HTML closing substrings inside content", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse(WRITE_TIME) });
  try {
    await withMemoryDir(async (dir) => {
      const storage = new StorageManager(dir);
      const profile = [
        "# Behavioral Profile",
        "",
        "<pre>",
        "literal </pre> remains content",
        "*Last updated: literal example*",
        "</pre>",
        "",
        "- Keeps raw HTML content.",
        "",
      ].join("\n");

      await storage.writeProfile(profile);

      assert.equal(
        await storage.readProfile(),
        profile.replace("\n\n<pre>", `\n\n${FRESH_HEADER}\n\n<pre>`),
      );
    });
  } finally {
    t.mock.timers.reset();
  }
});
test("writeProfile keeps HTML closing marker substrings inside content", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse(WRITE_TIME) });
  try {
    await withMemoryDir(async (dir) => {
      const storage = new StorageManager(dir);
      const profile = [
        "# Behavioral Profile",
        "",
        "<!--",
        "literal --> remains content",
        "*Last updated: literal example*",
        "-->",
        "",
        "- Keeps HTML comment content.",
        "",
      ].join("\n");

      await storage.writeProfile(profile);

      assert.equal(
        await storage.readProfile(),
        profile.replace("\n\n<!--", `\n\n${FRESH_HEADER}\n\n<!--`),
      );
    });
  } finally {
    t.mock.timers.reset();
  }
});

test("writeProfile preserves timestamp-shaped generic HTML blocks", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse(WRITE_TIME) });
  try {
    await withMemoryDir(async (dir) => {
      const storage = new StorageManager(dir);
      for (const tagLine of ["</custom-widget>", "<custom-widget />"]) {
        const profile = [
          "# Behavioral Profile",
          "",
          tagLine,
          STALE_HEADER,
          "",
          "- Keeps custom HTML opaque.",
          "",
        ].join("\n");

        await storage.writeProfile(profile);

        assert.equal(
          await storage.readProfile(),
          profile.replace(`\n\n${tagLine}`, `\n\n${FRESH_HEADER}\n\n${tagLine}`),
        );
      }
    });
  } finally {
    t.mock.timers.reset();
  }
});
test("writeProfile keeps self-closing built-in HTML blocks opaque", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse(WRITE_TIME) });
  try {
    await withMemoryDir(async (dir) => {
      const storage = new StorageManager(dir);
      const profile = [
        "# Behavioral Profile",
        "",
        "<div/>",
        "*Last updated: literal example*",
        "",
        "- Keeps self-closing HTML opaque.",
        "",
      ].join("\n");

      await storage.writeProfile(profile);

      assert.equal(
        await storage.readProfile(),
        profile.replace("\n\n<div/>", `\n\n${FRESH_HEADER}\n\n<div/>`),
      );
    });
  } finally {
    t.mock.timers.reset();
  }
});

test("writeProfile preserves timestamp-shaped HTML comments", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse(WRITE_TIME) });
  try {
    await withMemoryDir(async (dir) => {
      const storage = new StorageManager(dir);
      const profile = [
        "<!--",
        "# example",
        "*Last updated: literal example*",
        "-->",
        "",
        "# Behavioral Profile",
        "",
        "- Keeps comments.",
        "",
      ].join("\n");

      await storage.writeProfile(profile);

      assert.equal(
        await storage.readProfile(),
        profile.replace("# Behavioral Profile\n\n", `# Behavioral Profile\n\n${FRESH_HEADER}\n\n`),
      );
    });
  } finally {
    t.mock.timers.reset();
  }
});

test("writeProfile preserves code examples that mention Last updated", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse(WRITE_TIME) });
  try {
    await withMemoryDir(async (dir) => {
      const storage = new StorageManager(dir);
      const profile = [
        "# Behavioral Profile",
        "",
        "## Notes",
        "",
        "    Last updated: database field",
        "",
        "- Uses markdown code examples.",
        "",
      ].join("\n");

      await storage.writeProfile(profile);

      assert.equal(
        await storage.readProfile(),
        profile.replace("\n\n## Notes", `\n\n${FRESH_HEADER}\n\n## Notes`),
      );
    });
  } finally {
    t.mock.timers.reset();
  }
});

test("appendToProfile preserves timestamp-shaped fenced code", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse(WRITE_TIME) });
  try {
    await withMemoryDir(async (dir) => {
      const storage = new StorageManager(dir);
      const profile = [
        "# Behavioral Profile",
        "",
        "## Notes",
        "",
        "```markdown",
        STALE_HEADER,
        "```",
        "",
        "- Uses markdown code examples.",
        "",
      ].join("\n");
      await writeFile(path.join(dir, "profile.md"), profile, "utf8");

      await storage.appendToProfile(["Adds durable details."]);

      assert.equal(
        await storage.readProfile(),
        profile.replace("\n\n## Notes", `\n\n${FRESH_HEADER}\n\n## Notes`).trimEnd() +
          "\n- Adds durable details.\n",
      );
    });
  } finally {
    t.mock.timers.reset();
  }
});

test("readProfile does not rewrite a stale header", async () => {
  await withMemoryDir(async (dir) => {
    const storage = new StorageManager(dir);
    const staleProfile = `# Behavioral Profile\n\n${STALE_HEADER}\n\n- Reads are side-effect free.\n`;
    const profilePath = path.join(dir, "profile.md");
    await writeFile(profilePath, staleProfile, "utf8");

    assert.equal(await storage.readProfile(), staleProfile);
    assert.equal(await readFile(profilePath, "utf8"), staleProfile);
  });
});
