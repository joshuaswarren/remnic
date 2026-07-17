import path from "node:path";
import { fileURLToPath } from "node:url";

import { cleanupRelayRun, prepareRelayRunDirectories } from "./isolation.js";
import { runRelayPreflight } from "./preflight-lib.js";

interface CliOptions {
  runRoot?: string;
  keepArtifacts: boolean;
}

function parseArgs(argv: string[]): CliOptions {
  let runRoot: string | undefined;
  let keepArtifacts = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--") {
      continue;
    } else if (arg === "--run-root") {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) throw new Error("--run-root requires a path value");
      runRoot = value;
      index += 1;
    } else if (arg === "--keep-artifacts") {
      keepArtifacts = true;
    } else if (arg === "--help" || arg === "-h") {
      process.stdout.write("Usage: npm run relay:preflight -- [--run-root <empty-path>] [--keep-artifacts]\n");
      process.exit(0);
    } else {
      throw new Error(`Unknown Relay preflight argument: ${arg}`);
    }
  }
  return { ...(runRoot ? { runRoot } : {}), keepArtifacts };
}

async function main(): Promise<void> {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
  const options = parseArgs(process.argv.slice(2));
  const directories = await prepareRelayRunDirectories(repoRoot, options.runRoot);
  try {
    const result = await runRelayPreflight({
      repoRoot,
      directories,
      ledgerPath: path.join(repoRoot, ".remnic", "relay", "codex-credit-ledger.json"),
    });
    process.stdout.write(`${JSON.stringify(result.receipt, null, 2)}\n`);
  } finally {
    if (!options.keepArtifacts) await cleanupRelayRun(directories);
    else process.stderr.write(`Relay preflight artifacts retained at ${directories.root}\n`);
  }
}

main().catch((error) => {
  process.stderr.write(`Relay preflight failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
