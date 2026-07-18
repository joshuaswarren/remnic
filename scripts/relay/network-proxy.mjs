#!/usr/bin/env node

import { lstat, writeFile } from "node:fs/promises";
import net from "node:net";

const REQUEST_HEADER_LIMIT = 64 * 1024;

function requiredInteger(value, name) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65_535) {
    throw new Error(`${name} must be an integer TCP port`);
  }
  return parsed;
}

function parseArgs(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (!name?.startsWith("--") || !value || value.startsWith("--")) {
      throw new Error("Relay network proxy arguments must be flag/value pairs");
    }
    if (values.has(name)) throw new Error(`Duplicate Relay network proxy argument ${name}`);
    values.set(name, value);
  }
  if (values.size !== 3) throw new Error("Relay network proxy received an unexpected argument set");
  const gateway = values.get("--gateway");
  if (gateway !== "/output/network-gateway.sock") {
    throw new Error("Relay network proxy gateway path is fixed inside the chroot");
  }
  return {
    gateway,
    listenPort: requiredInteger(values.get("--listen-port"), "--listen-port"),
    mcpTargetPort: requiredInteger(values.get("--mcp-target-port"), "--mcp-target-port"),
  };
}

function parseAuthority(authority, defaultPort) {
  const url = new URL(`http://${authority}`);
  if (url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new Error("Relay network proxy authority is malformed");
  }
  return { host: url.hostname, port: url.port ? requiredInteger(url.port, "target port") : defaultPort };
}

function targetForRequest(header, mcpTargetPort) {
  const firstLine = header.split("\r\n", 1)[0] ?? "";
  const connect = firstLine.match(/^CONNECT\s+(\S+)\s+HTTP\/1\.[01]$/i);
  if (connect) return { kind: "connect", ...parseAuthority(connect[1], 443) };
  const absolute = firstLine.match(/^[A-Z]+\s+(https?:\/\/\S+)\s+HTTP\/1\.[01]$/i);
  if (absolute) {
    const url = new URL(absolute[1]);
    return {
      kind: "forward",
      host: url.hostname,
      port: url.port ? requiredInteger(url.port, "target port") : url.protocol === "https:" ? 443 : 80,
    };
  }
  if (!/^[A-Z]+\s+\/\S*\s+HTTP\/1\.[01]$/i.test(firstLine)) {
    throw new Error("Relay network proxy received an unsupported request line");
  }
  return { kind: "forward", host: "127.0.0.1", port: mcpTargetPort };
}

function rejectClient(client) {
  if (!client.destroyed) {
    client.end("HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
  }
}

const options = parseArgs(process.argv.slice(2));
const gatewayInfo = await lstat(options.gateway);
if (!gatewayInfo.isSocket()) throw new Error("Relay network gateway is not a Unix socket");

const connections = new Set();
const server = net.createServer((client) => {
  connections.add(client);
  client.once("close", () => connections.delete(client));
  let buffered = Buffer.alloc(0);
  const onRequest = (chunk) => {
    buffered = Buffer.concat([buffered, chunk]);
    if (buffered.byteLength > REQUEST_HEADER_LIMIT) {
      client.off("data", onRequest);
      rejectClient(client);
      return;
    }
    const headerEnd = buffered.indexOf("\r\n\r\n");
    if (headerEnd < 0) return;
    client.pause();
    client.off("data", onRequest);
    let target;
    try {
      target = targetForRequest(buffered.subarray(0, headerEnd + 4).toString("latin1"), options.mcpTargetPort);
    } catch {
      rejectClient(client);
      return;
    }
    const gateway = net.createConnection(options.gateway);
    connections.add(gateway);
    gateway.once("close", () => connections.delete(gateway));
    gateway.once("connect", () => {
      gateway.write(`${JSON.stringify({ host: target.host, port: target.port })}\n`);
    });
    gateway.once("data", (acknowledgement) => {
      if (acknowledgement[0] !== 1) {
        rejectClient(client);
        gateway.destroy();
        return;
      }
      const gatewayRemainder = acknowledgement.subarray(1);
      if (target.kind === "connect") {
        client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        const requestRemainder = buffered.subarray(headerEnd + 4);
        if (requestRemainder.byteLength > 0) gateway.write(requestRemainder);
      } else {
        gateway.write(buffered);
      }
      if (gatewayRemainder.byteLength > 0) client.write(gatewayRemainder);
      client.pipe(gateway);
      gateway.pipe(client);
      client.resume();
    });
    gateway.once("error", () => rejectClient(client));
    client.once("error", () => gateway.destroy());
    client.once("close", () => gateway.destroy());
  };
  client.on("data", onRequest);
  client.once("error", () => client.destroy());
});

await new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(options.listenPort, "127.0.0.1", () => {
    server.off("error", reject);
    resolve();
  });
});
await writeFile("/output/network-proxy.ready", "ready\n", { mode: 0o600, flag: "wx" });

const shutdown = () => {
  for (const connection of connections) connection.destroy();
  server.close(() => process.exit(0));
};
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
