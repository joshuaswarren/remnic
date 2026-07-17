import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

import { digestFixtureTree } from "./isolation.js";

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
export const RelayFixtureManifestSchema = z
  .object({
    schemaVersion: z.literal(1),
    files: z
      .array(
        z
          .object({ path: z.string().min(1), bytes: z.number().int().nonnegative(), sha256: sha256Schema })
          .strict(),
      )
      .min(1),
    rootSha256: sha256Schema,
  })
  .strict();
export type RelayFixtureManifest = z.infer<typeof RelayFixtureManifestSchema>;

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

export async function buildRelayFixtureManifest(fixtureRoot: string): Promise<RelayFixtureManifest> {
  const files = await digestFixtureTree(fixtureRoot, ["manifest.json"]);
  return RelayFixtureManifestSchema.parse({
    schemaVersion: 1,
    files,
    rootSha256: sha256(JSON.stringify(files)),
  });
}

export async function verifyRelayFixtureManifest(fixtureRoot: string): Promise<RelayFixtureManifest> {
  const manifestPath = path.join(fixtureRoot, "manifest.json");
  const committed = RelayFixtureManifestSchema.parse(JSON.parse(await readFile(manifestPath, "utf8")));
  const actual = await buildRelayFixtureManifest(fixtureRoot);
  if (JSON.stringify(committed) !== JSON.stringify(actual)) {
    throw new Error("Relay fixture integrity manifest does not match the committed synthetic inputs");
  }
  return committed;
}

async function main(): Promise<void> {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
  const fixtureRoot = path.join(repoRoot, "fixtures", "remnic-relay");
  const manifest = await buildRelayFixtureManifest(fixtureRoot);
  await writeFile(path.join(fixtureRoot, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o644,
  });
  process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
