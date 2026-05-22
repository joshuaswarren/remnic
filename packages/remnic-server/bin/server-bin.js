export function shouldPrintHelpWithoutCli(argv) {
  return argv.length === 1 && (argv[0] === "--help" || argv[0] === "-h");
}

export async function runServerBin(commandName, options = {}) {
  const argv = options.argv ?? process.argv.slice(2);
  const help = `
${commandName} - Standalone Remnic memory server

Usage:
  ${commandName} [options]

Options:
  --config <path>     Path to config file (default: remnic.config.json)
  --host <addr>       Bind address (default: 127.0.0.1)
  --port <number>     Port number (default: 4318)
  --auth-token <tok>  Bearer token for auth (or set REMNIC_AUTH_TOKEN)
  --help              Show this help

Environment:
  REMNIC_CONFIG_PATH   Config file path (ENGRAM_CONFIG_PATH also supported)
  REMNIC_PORT          Server port (ENGRAM_PORT also supported)
  REMNIC_HOST          Bind address (ENGRAM_HOST also supported)
  REMNIC_AUTH_TOKEN    Auth bearer token (ENGRAM_AUTH_TOKEN also supported)
  REMNIC_MEMORY_DIR    Override memory directory (ENGRAM_MEMORY_DIR also supported)
  OPENAI_API_KEY       OpenAI API key for extraction; ignored when config sets openaiApiKey=false
`;

  if (shouldPrintHelpWithoutCli(argv)) {
    (options.stdout ?? console.log)(help);
    return;
  }

  const loadCliMain = options.loadCliMain ?? (() => import("../dist/index.js"));
  const { cliMain } = await loadCliMain();

  await cliMain(argv).catch((err) => {
    (options.stderr ?? process.stderr.write.bind(process.stderr))(`Fatal: ${err instanceof Error ? err.message : String(err)}\n`);
    (options.exit ?? process.exit)(1);
  });
}
