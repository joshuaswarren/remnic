import { launchProcessSync } from "./child-process.js";
import { mergeEnv } from "./env.js";
import { httpProtocolForHost } from "./http-transport.js";

const HEALTH_EXIT_OK = 0;
const HEALTH_EXIT_UNAUTHORIZED = 2;

export function checkDaemonHealth(
  host: string,
  port: number,
  authToken?: string,
  allowInsecureHttp = false,
): boolean {
  try {
    const safePort = Math.trunc(Number(port));
    if (!Number.isFinite(safePort) || safePort < 1 || safePort > 65535) return false;

    const bareHost = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
    // One 3 s aggregate budget: /engram/v1/live, and only a 404 (daemon older
    // than the live route) retries the legacy diagnostic path with the
    // remaining time. 401/503/other statuses are final answers, never re-probed.
    const script = [
      "const env = process['env'];",
      "const protocol = env.REMNIC_HEALTH_PROTOCOL;",
      "if (protocol !== 'http' && protocol !== 'https') process.exit(1);",
      "const transport = require(protocol);",
      "const headers = {};",
      "if (env.REMNIC_HEALTH_TOKEN) headers['authorization'] = 'Bearer ' + env.REMNIC_HEALTH_TOKEN;",
      "const exitFor = (status) => process.exit(status === 200 ? 0 : status === 401 ? 2 : 1);",
      "const attempt = (path, timeoutMs, onStatus) => {",
      "  const req = transport.get({",
      "    host: env.REMNIC_HEALTH_HOST,",
      "    port: parseInt(env.REMNIC_HEALTH_PORT, 10),",
      "    path, headers, timeout: timeoutMs,",
      "  }, (res) => { res.resume(); onStatus(res.statusCode); });",
      "  req.on('error', () => process.exit(1));",
      "  req.on('timeout', () => { req.destroy(); process.exit(1); });",
      "};",
      "const deadline = Date.now() + 3000;",
      "attempt('/engram/v1/live', 3000, (status) => {",
      "  if (status !== 404) exitFor(status);",
      "  const remaining = deadline - Date.now();",
      "  if (remaining <= 0) process.exit(1);",
      "  attempt('/engram/v1/health', remaining, exitFor);",
      "});",
    ].join("\n");
    const env: NodeJS.ProcessEnv = mergeEnv({
      REMNIC_HEALTH_HOST: bareHost,
      REMNIC_HEALTH_PORT: String(safePort),
      REMNIC_HEALTH_PROTOCOL: httpProtocolForHost(host, allowInsecureHttp),
    });
    if (authToken) env.REMNIC_HEALTH_TOKEN = authToken;

    const launchOptions = { timeout: 4000, env };
    const result = launchProcessSync(process.execPath, ["-e", script], launchOptions);
    if (result.status === HEALTH_EXIT_OK) return true;
    if (result.status !== HEALTH_EXIT_UNAUTHORIZED) return false;

    console.error("[remnic/connectors] health probe got 401 — retrying after token cache TTL...");
    launchProcessSync(process.execPath, ["-e", "setTimeout(() => {}, 6000)"], { timeout: 7000, env: {} });
    const retry = launchProcessSync(process.execPath, ["-e", script], launchOptions);
    return retry.status === HEALTH_EXIT_OK;
  } catch {
    return false;
  }
}
