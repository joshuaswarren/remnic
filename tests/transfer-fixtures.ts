import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

export async function writeFixtureMemoryDir(memoryDir: string): Promise<void> {
  await mkdir(path.join(memoryDir, "facts", "2026-02-11"), { recursive: true });
  await mkdir(path.join(memoryDir, "corrections"), { recursive: true });
  await mkdir(path.join(memoryDir, "state"), { recursive: true });
  await mkdir(path.join(memoryDir, "entities"), { recursive: true });

  await writeFile(
    path.join(memoryDir, "profile.md"),
    "# Profile\n\n- Prefers concise answers.\n",
    "utf-8",
  );
  await writeFile(
    path.join(memoryDir, "facts", "2026-02-11", "fact-1.md"),
    "---\nid: fact-1\ncategory: fact\ncreated: 2026-02-11T00:00:00Z\nupdated: 2026-02-11T00:00:00Z\nsource: extraction\nconfidence: 0.9\nconfidenceTier: implied\ntags: [\"test\"]\n---\n\nThe user likes pianos.\n",
    "utf-8",
  );
  await writeFile(
    path.join(memoryDir, "corrections", "correction-1.md"),
    "---\nid: correction-1\ncategory: correction\ncreated: 2026-02-11T00:00:00Z\nupdated: 2026-02-11T00:00:00Z\nsource: extraction\nconfidence: 0.98\nconfidenceTier: explicit\ntags: [\"test\"]\n---\n\nPostgres 15 is required.\n",
    "utf-8",
  );
  await writeFile(
    path.join(memoryDir, "state", "topics.json"),
    JSON.stringify({ topics: [{ topic: "db", score: 0.5 }] }, null, 2),
    "utf-8",
  );
  await writeFile(
    path.join(memoryDir, "entities", "acme-corp.md"),
    "# Acme Corp\n\n**Type:** company\n\n## Facts\n\n- Makes anvils.\n",
    "utf-8",
  );
}

export async function writeSensitiveTransferFixtureEntries(memoryDir: string): Promise<void> {
  await mkdir(path.join(memoryDir, ".secure-store"), { recursive: true });
  await mkdir(path.join(memoryDir, ".capsules"), { recursive: true });
  await mkdir(path.join(memoryDir, ".git"), { recursive: true });
  await mkdir(path.join(memoryDir, "node_modules", "pkg"), { recursive: true });

  await writeFile(path.join(memoryDir, ".secure-store", "header.json"), "{\"verifier\":\"secret\"}\n", "utf-8");
  await writeFile(path.join(memoryDir, ".capsules", "old.capsule.json.gz"), "old capsule\n", "utf-8");
  await writeFile(path.join(memoryDir, ".git", "config"), "repo config\n", "utf-8");
  await writeFile(path.join(memoryDir, "node_modules", "pkg", "index.js"), "module\n", "utf-8");
}
