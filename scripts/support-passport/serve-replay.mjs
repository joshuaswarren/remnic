import path from "node:path";
import { fileURLToPath } from "node:url";
import { startSupportPassportReplayServer } from "./replay-server.mjs";

function parsePort(argv) {
  if (argv.length === 0) return 4173;
  if (argv.length !== 2 || argv[0] !== "--port")
    throw new Error("Usage: npm run demo:support-passport:replay -- [--port 4173]");
  const port = Number(argv[1]);
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error("--port must be an integer from 1 through 65535.");
  return port;
}

export async function main(argv = process.argv.slice(2)) {
  const server = await startSupportPassportReplayServer({ port: parsePort(argv) });
  console.log(`Synthetic replay: ${server.origin}/remnic/ui/what-helps-me/?mode=replay`);
  console.log("Press Ctrl+C to stop.");

  const stop = async () => {
    await server.stop();
    process.exit(0);
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
}
