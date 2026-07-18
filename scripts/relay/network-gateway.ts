import { chmod, lstat, rm } from "node:fs/promises";
import net, { type Server, type Socket } from "node:net";
import path from "node:path";

const GATEWAY_HEADER_LIMIT = 1_024;
const OPENAI_EGRESS_DOMAINS = ["chatgpt.com", "openai.com"] as const;

export const RELAY_NETWORK_PROXY_PORT = 43_191 as const;
export const RELAY_ISOLATED_MCP_URL = `http://127.0.0.1:${RELAY_NETWORK_PROXY_PORT}/mcp` as const;
export const RELAY_UNSHARE_NAMESPACE_ARGS = [
  "--user",
  "--map-root-user",
  "--mount",
  "--net",
  "--pid",
  "--fork",
  "--kill-child=SIGKILL",
] as const;

interface RelayNetworkTarget {
  host: string;
  port: number;
}

export interface RelayNetworkGateway {
  socketPath: string;
  mcpTargetPort: number;
  stop(): Promise<void>;
}

function normalizeHost(host: string): string {
  return host.trim().toLowerCase().replace(/\.$/, "");
}

export function isRelayNetworkTargetAllowed(
  host: string,
  port: number,
  mcpTargetPort: number,
): boolean {
  const normalized = normalizeHost(host);
  if (normalized === "127.0.0.1") return port === mcpTargetPort;
  if (port !== 443 || net.isIP(normalized) !== 0) return false;
  return OPENAI_EGRESS_DOMAINS.some(
    (domain) => normalized === domain || normalized.endsWith(`.${domain}`),
  );
}

function parseMcpTarget(mcpUrl: string): RelayNetworkTarget {
  const url = new URL(mcpUrl);
  const port = Number(url.port);
  if (
    url.protocol !== "http:" ||
    url.hostname !== "127.0.0.1" ||
    url.pathname !== "/mcp" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65_535
  ) {
    throw new Error("Relay network gateway requires an exact loopback MCP URL");
  }
  return { host: url.hostname, port };
}

function parseGatewayHeader(value: string): RelayNetworkTarget {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("Relay network gateway received an invalid target header");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Relay network gateway target must be an object");
  }
  const candidate = parsed as { host?: unknown; port?: unknown };
  if (
    Object.keys(candidate).sort().join(",") !== "host,port" ||
    typeof candidate.host !== "string" ||
    candidate.host.length < 1 ||
    candidate.host.length > 253 ||
    typeof candidate.port !== "number" ||
    !Number.isInteger(candidate.port) ||
    candidate.port < 1 ||
    candidate.port > 65_535
  ) {
    throw new Error("Relay network gateway target is malformed");
  }
  return { host: normalizeHost(candidate.host), port: candidate.port };
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

export async function startRelayNetworkGateway(options: {
  outputDir: string;
  mcpUrl: string;
}): Promise<RelayNetworkGateway> {
  const outputDir = path.resolve(options.outputDir);
  const outputInfo = await lstat(outputDir);
  if (outputInfo.isSymbolicLink() || !outputInfo.isDirectory()) {
    throw new Error("Relay network gateway output root must be a real directory");
  }
  const mcpTarget = parseMcpTarget(options.mcpUrl);
  const socketPath = path.join(outputDir, "network-gateway.sock");
  await lstat(socketPath).then(
    () => {
      throw new Error("Relay network gateway socket already exists");
    },
    (error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    },
  );

  const connections = new Set<Socket>();
  const server = net.createServer((connection) => {
    connections.add(connection);
    connection.once("close", () => connections.delete(connection));
    let header = Buffer.alloc(0);
    const deny = () => {
      if (!connection.destroyed) connection.end(Buffer.from([0]));
    };
    const onHeader = (chunk: Buffer) => {
      header = Buffer.concat([header, chunk]);
      if (header.byteLength > GATEWAY_HEADER_LIMIT) {
        connection.off("data", onHeader);
        deny();
        return;
      }
      const newline = header.indexOf(0x0a);
      if (newline < 0) return;
      connection.off("data", onHeader);
      if (newline !== header.byteLength - 1) {
        deny();
        return;
      }
      let target: RelayNetworkTarget;
      try {
        target = parseGatewayHeader(header.subarray(0, newline).toString("utf8"));
      } catch {
        deny();
        return;
      }
      if (!isRelayNetworkTargetAllowed(target.host, target.port, mcpTarget.port)) {
        deny();
        return;
      }
      const upstream = net.createConnection({ host: target.host, port: target.port });
      connections.add(upstream);
      upstream.once("close", () => connections.delete(upstream));
      let upstreamConnected = false;
      upstream.once("connect", () => {
        upstreamConnected = true;
        connection.write(Buffer.from([1]));
        connection.pipe(upstream);
        upstream.pipe(connection);
      });
      upstream.once("error", () => {
        if (!upstreamConnected) deny();
        else connection.destroy();
        upstream.destroy();
      });
      connection.once("error", () => upstream.destroy());
      connection.once("close", () => upstream.destroy());
    };
    connection.on("data", onHeader);
    connection.once("error", () => connection.destroy());
  });

  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, () => {
        server.off("error", reject);
        resolve();
      });
    });
    await chmod(socketPath, 0o600);
  } catch (error) {
    for (const connection of connections) connection.destroy();
    await closeServer(server).catch(() => undefined);
    await rm(socketPath, { force: true }).catch(() => undefined);
    throw error;
  }

  let stopped = false;
  return {
    socketPath,
    mcpTargetPort: mcpTarget.port,
    async stop() {
      if (stopped) return;
      stopped = true;
      for (const connection of connections) connection.destroy();
      await closeServer(server).catch(() => undefined);
      await rm(socketPath, { force: true });
    },
  };
}
