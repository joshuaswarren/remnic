import { isIP } from "node:net";

function normalizedIp(host: string): string {
  const value = host.trim().replace(/^\[/, "").replace(/\]\.?$/, "").replace(/\.$/, "");
  if (isIP(value) === 4) return value;
  if (isIP(value) !== 6) return "";
  return new URL(`http://[${value}]/`).hostname.slice(1, -1);
}

export function isLoopbackHost(host: string): boolean {
  const normalized = host.trim().replace(/^\[/, "").replace(/\]\.?$/, "").replace(/\.$/, "").toLowerCase();
  if (normalized === "localhost" || normalized.endsWith(".localhost")) return true;

  const ip = normalizedIp(normalized);
  if (ip === "::1") return true;
  if (isIP(ip) === 4) return ip.startsWith("127.");
  if (!ip.startsWith("::ffff:")) return false;

  const [high, low] = ip.slice("::ffff:".length).split(":");
  return Number.parseInt(high, 16) >>> 8 === 127 || (high === "0" && Number.parseInt(low, 16) >>> 8 === 127);
}

export function httpProtocolForHost(host: string, allowInsecureHttp = false): "http" | "https" {
  return isLoopbackHost(host) || allowInsecureHttp ? "http" : "https";
}
