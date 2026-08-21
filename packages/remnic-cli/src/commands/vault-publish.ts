/**
 * `remnic vault-publish apply --file --name --content` (#1985 CLI slice).
 *
 * Replaces a marker-managed region. Missing markers print `no_marker`.
 * Missing files are not created.
 */
import fs from "node:fs";
import { applyManagedRegion } from "@remnic/core";
import { resolveFlag } from "../cli-args.js";

export interface VaultPublishIo {
  stdout(line: string): void;
  stderr(line: string): void;
}

const defaultIo: VaultPublishIo = {
  stdout: (line) => {
    process.stdout.write(`${line}\n`);
  },
  stderr: (line) => {
    process.stderr.write(`${line}\n`);
  },
};

export function vaultPublishHelp(): string {
  return `Usage: remnic vault-publish apply --file <path> --name <region> --content <text>

  apply  Replace the marked region. Missing markers print no_marker.
`;
}

export function runVaultPublishCommand(rest: string[], io: VaultPublishIo = defaultIo): number {
  if (rest.length === 0 || rest[0] === "--help" || rest[0] === "-h" || rest[0] === "help") {
    io.stdout(vaultPublishHelp().trimEnd());
    return 0;
  }
  if (rest[0] !== "apply") {
    io.stderr(`vault-publish: unknown action "${rest[0]}".`);
    io.stderr(vaultPublishHelp().trimEnd());
    return 1;
  }

  const filePath = resolveFlag(rest, "--file");
  const name = resolveFlag(rest, "--name");
  const content = resolveFlag(rest, "--content");
  if (filePath === undefined || name === undefined || content === undefined) {
    io.stderr("vault-publish: apply requires --file <path>, --name <region>, and --content <text>");
    return 1;
  }

  let fileText: string;
  try {
    fileText = fs.readFileSync(filePath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      io.stderr("missing_file");
      return 1;
    }
    io.stderr(err instanceof Error ? err.message : String(err));
    return 1;
  }

  const applied = applyManagedRegion(fileText, { strategy: "markers", name, content });
  if (!applied.ok) {
    io.stderr(applied.reason);
    return 1;
  }
  if (applied.text !== fileText) fs.writeFileSync(filePath, applied.text);
  io.stdout("ok");
  return 0;
}

export async function runVaultPublishBinaryCommand(rest: string[]): Promise<void> {
  const code = runVaultPublishCommand(rest);
  if (code !== 0) process.exitCode = code;
}
