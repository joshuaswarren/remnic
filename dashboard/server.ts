import { GraphDashboardServer } from "../src/dashboard-runtime.js";
import { parseDashboardPort } from "./server-args.js";

function readArg(flag: string, fallback?: string): string | undefined {
  const idx = process.argv.findIndex((arg) => arg === flag);
  if (idx === -1) return fallback;
  const value = process.argv[idx + 1];
  if (!value || value.startsWith("--")) return fallback;
  return value;
}

async function main(): Promise<void> {
  const memoryDir = readArg("--memory-dir", process.cwd());
  const host = readArg("--host", "127.0.0.1");
  const portRaw = readArg("--port", "4319");
  const authToken = readArg("--token");
  const port = parseDashboardPort(portRaw);

  if (!memoryDir) {
    throw new Error("missing --memory-dir");
  }

  const server = new GraphDashboardServer({
    memoryDir,
    host,
    port,
    authToken,
  });
  const status = await server.start();
  // Keep this log concise; operators can use CLI status for machine-readable output.
  // eslint-disable-next-line no-console
  console.log(`dashboard running on http://${status.host}:${status.port}`);

  const shutdown = async () => {
    await server.stop();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

void main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
