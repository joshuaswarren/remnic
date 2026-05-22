import { constants } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import { mkdir, open, readdir, realpath, stat } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { URL } from "node:url";

export function hostToUrlAuthority(host: string): string {
  if (host.includes(":") && !host.startsWith("[") && !host.endsWith("]")) {
    return `[${host}]`;
  }
  return host;
}

export interface WebDavAuth {
  username: string;
  password: string;
}

export interface WebDavServerOptions {
  enabled?: boolean;
  host?: string;
  port: number;
  allowlistDirs: string[];
  auth?: WebDavAuth;
}

export interface WebDavServerStatus {
  running: boolean;
  host: string;
  port: number;
  rootCount: number;
}

interface AllowedRoot {
  absolute: string;
  name: string;
}

type WebDavReadOpenResult =
  | { ok: true; handle: FileHandle; size: number }
  | { ok: false; code: number; message: string };

function validateWebDavAuth(auth: WebDavAuth): WebDavAuth {
  if (typeof auth.username !== "string" || auth.username.trim().length === 0) {
    throw new Error("webdav auth.username must be a non-empty string");
  }
  if (typeof auth.password !== "string" || auth.password.trim().length === 0) {
    throw new Error("webdav auth.password must be a non-empty string");
  }
  return auth;
}

export async function openWebDavFileForRead(absolutePath: string): Promise<WebDavReadOpenResult> {
  let handle: FileHandle | null = null;
  try {
    handle = await open(absolutePath, constants.O_RDONLY | constants.O_NOFOLLOW);
    const info = await handle.stat();
    if (!info.isFile()) {
      await handle.close().catch(() => {});
      return { ok: false, code: 403, message: "path is not a file" };
    }
    return { ok: true, handle, size: info.size };
  } catch (err) {
    await handle?.close().catch(() => {});
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ELOOP") {
      return { ok: false, code: 403, message: "path escaped allowlist via symlink" };
    }
    if (code === "ENOENT" || code === "ENOTDIR") {
      return { ok: false, code: 404, message: "not found" };
    }
    return { ok: false, code: 404, message: "not found" };
  }
}

export class WebDavServer {
  private readonly options: Required<Omit<WebDavServerOptions, "auth">> & Pick<WebDavServerOptions, "auth">;
  private readonly allowedRoots: AllowedRoot[];
  private server: Server | null = null;
  private startPromise: Promise<WebDavServerStatus> | null = null;
  private listening = false;
  private boundPort: number;

  private constructor(
    options: Required<Omit<WebDavServerOptions, "auth">> & Pick<WebDavServerOptions, "auth">,
    allowedRoots: AllowedRoot[],
  ) {
    this.options = options;
    this.allowedRoots = allowedRoots;
    this.boundPort = options.port;
  }

  static async create(input: WebDavServerOptions): Promise<WebDavServer> {
    const options: Required<Omit<WebDavServerOptions, "auth">> & Pick<WebDavServerOptions, "auth"> = {
      enabled: input.enabled ?? false,
      host: input.host ?? "127.0.0.1",
      port: input.port,
      allowlistDirs: input.allowlistDirs,
      auth: input.auth ? validateWebDavAuth(input.auth) : undefined,
    };

    if (!Array.isArray(options.allowlistDirs) || options.allowlistDirs.length === 0) {
      throw new Error("webdav allowlistDirs must include at least one directory");
    }
    if (!Number.isInteger(options.port) || options.port < 0 || options.port > 65535) {
      throw new Error(`invalid webdav port: ${options.port}`);
    }

    const allowedRoots: AllowedRoot[] = [];
    const aliasSet = new Set<string>();
    for (const dir of options.allowlistDirs) {
      const resolved = path.resolve(dir);
      await mkdir(resolved, { recursive: true });
      const canonical = await realpath(resolved);
      const alias = path.basename(canonical) || "root";
      if (aliasSet.has(alias)) {
        throw new Error(`duplicate webdav allowlist alias: ${alias}`);
      }
      aliasSet.add(alias);
      allowedRoots.push({ absolute: canonical, name: alias });
    }

    return new WebDavServer(options, allowedRoots);
  }

  async start(): Promise<WebDavServerStatus> {
    if (!this.options.enabled) {
      throw new Error("webdav server is disabled; set enabled=true to start");
    }
    if (this.server && this.listening) {
      return this.status();
    }
    if (this.startPromise) return this.startPromise;

    const server = createServer((req, res) => {
      this.handle(req, res).catch((err) => {
        if (res.headersSent) {
          res.destroy(err as Error);
          return;
        }
        res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("webdav error");
      });
    });
    this.server = server;
    this.listening = false;

    this.startPromise = (async () => {
      try {
        await new Promise<void>((resolve, reject) => {
          const onError = (err: Error) => {
            server.removeListener("listening", onListening);
            server.removeListener("close", onClose);
            reject(err);
          };
          const onListening = () => {
            server.removeListener("error", onError);
            server.removeListener("close", onClose);
            resolve();
          };
          const onClose = () => {
            server.removeListener("error", onError);
            server.removeListener("listening", onListening);
            reject(new Error("webdav server closed before listening"));
          };
          server.once("error", onError);
          server.once("listening", onListening);
          server.once("close", onClose);
          server.listen(this.options.port, this.options.host);
        });
      } catch (err) {
        if (this.server === server) {
          this.server = null;
        }
        this.listening = false;
        server.close();
        throw err;
      }

      const address = server.address();
      if (address && typeof address !== "string") {
        this.boundPort = address.port;
      }
      this.listening = true;

      return this.status();
    })();

    try {
      return await this.startPromise;
    } finally {
      this.startPromise = null;
    }
  }

  async stop(): Promise<void> {
    if (!this.server) return;
    const server = this.server;
    const pendingStart = this.startPromise;
    await new Promise<void>((resolve, reject) => {
      server.close((err) => {
        if (err && (err as NodeJS.ErrnoException).code !== "ERR_SERVER_NOT_RUNNING") {
          reject(err);
          return;
        }
        resolve();
      });
    });
    await pendingStart?.catch(() => undefined);
    if (this.server === server) {
      this.server = null;
    }
    this.listening = false;
    this.boundPort = this.options.port;
  }

  status(): WebDavServerStatus {
    return {
      running: this.server !== null && this.listening,
      host: this.options.host,
      port: this.boundPort,
      rootCount: this.allowedRoots.length,
    };
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!this.isAuthorized(req)) {
      res.writeHead(401, {
        "WWW-Authenticate": 'Basic realm="Engram WebDAV"',
        "Content-Type": "text/plain; charset=utf-8",
      });
      res.end("authentication required");
      return;
    }

    const method = (req.method ?? "GET").toUpperCase();
    if (method === "OPTIONS") {
      res.writeHead(204, {
        Allow: "OPTIONS, PROPFIND, GET, HEAD",
        DAV: "1",
      });
      res.end();
      return;
    }

    const parsed = new URL(req.url ?? "/", `http://${hostToUrlAuthority(this.options.host)}`);
    const resolved = await this.resolvePath(parsed.pathname);
    if (!resolved.ok) {
      res.writeHead(resolved.code, { "Content-Type": "text/plain; charset=utf-8" });
      res.end(resolved.message);
      return;
    }

    if (method === "PROPFIND") {
      await this.handlePropfind(resolved.absolutePath, resolved.rootAbsolute, resolved.displayPath, res);
      return;
    }

    if (method === "GET" || method === "HEAD") {
      await this.handleRead(method, resolved.absolutePath, resolved.rootAbsolute, res);
      return;
    }

    res.writeHead(405, {
      Allow: "OPTIONS, PROPFIND, GET, HEAD",
      "Content-Type": "text/plain; charset=utf-8",
    });
    res.end("method not allowed");
  }

  private isAuthorized(req: IncomingMessage): boolean {
    if (!this.options.auth) return true;
    const raw = req.headers.authorization;
    if (!raw) return false;
    const separator = raw.indexOf(" ");
    if (separator <= 0) return false;
    const scheme = raw.slice(0, separator).toLowerCase();
    if (scheme !== "basic") return false;
    const encodedPart = raw.slice(separator + 1).trim();
    if (!encodedPart) return false;

    try {
      const decoded = Buffer.from(encodedPart, "base64").toString("utf-8");
      const credentialSeparator = decoded.indexOf(":");
      if (credentialSeparator < 0) return false;
      const username = decoded.slice(0, credentialSeparator);
      const password = decoded.slice(credentialSeparator + 1);
      const usernameOk = this.timingSafeStringEqual(username, this.options.auth.username);
      const passwordOk = this.timingSafeStringEqual(password, this.options.auth.password);
      return Boolean((usernameOk ? 1 : 0) & (passwordOk ? 1 : 0));
    } catch {
      return false;
    }
  }

  private timingSafeStringEqual(a: string, b: string): boolean {
    const left = this.encodeAuthField(a);
    const right = this.encodeAuthField(b);
    if (!left || !right) return false;
    return timingSafeEqual(left, right);
  }

  private encodeAuthField(value: string): Buffer | null {
    const maxBytes = 512;
    const encoded = Buffer.from(value, "utf-8");
    if (encoded.length > maxBytes) return null;
    const out = Buffer.alloc(2 + maxBytes);
    out.writeUInt16BE(encoded.length, 0);
    encoded.copy(out, 2);
    return out;
  }

  private async resolvePath(requestPathname: string): Promise<
    | { ok: true; absolutePath: string; displayPath: string; rootAbsolute: string }
    | { ok: false; code: number; message: string }
  > {
    let decodedPath: string;
    try {
      decodedPath = decodeURIComponent(requestPathname || "/");
    } catch {
      return { ok: false, code: 400, message: "invalid path encoding" };
    }
    if (decodedPath.includes("\0")) {
      return { ok: false, code: 400, message: "invalid path" };
    }

    const normalized = path.posix.normalize(decodedPath);
    const segments = normalized.split("/").filter((segment) => segment.length > 0);

    if (segments.length === 0) {
      return { ok: false, code: 403, message: "root listing is not allowed" };
    }

    const rootName = segments[0];
    const root = this.allowedRoots.find((entry) => entry.name === rootName);
    if (!root) {
      return { ok: false, code: 403, message: "path is outside allowlist" };
    }

    const relative = segments.slice(1);
    if (relative.some((segment) => segment === ".." || segment.includes("\\"))) {
      return { ok: false, code: 403, message: "path traversal is not allowed" };
    }

    const candidate = path.resolve(root.absolute, ...relative);
    if (!this.isPathInside(root.absolute, candidate)) {
      return { ok: false, code: 403, message: "path escaped allowlist" };
    }

    try {
      const canonicalCandidate = await realpath(candidate);
      if (!this.isPathInside(root.absolute, canonicalCandidate)) {
        return { ok: false, code: 403, message: "path escaped allowlist via symlink" };
      }
      return { ok: true, absolutePath: canonicalCandidate, displayPath: `/${segments.join("/")}`, rootAbsolute: root.absolute };
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        return { ok: true, absolutePath: candidate, displayPath: `/${segments.join("/")}`, rootAbsolute: root.absolute };
      }
      if (code === "ENOTDIR" || code === "ELOOP") {
        return { ok: false, code: 400, message: "invalid path" };
      }
      throw err;
    }
  }

  private async handleRead(
    method: "GET" | "HEAD",
    absolutePath: string,
    rootAbsolute: string,
    res: ServerResponse,
  ): Promise<void> {
    const revalidated = await this.revalidatePathInsideRoot(absolutePath, rootAbsolute);
    if (!revalidated.ok) {
      res.writeHead(revalidated.code, { "Content-Type": "text/plain; charset=utf-8" });
      res.end(revalidated.message);
      return;
    }
    const opened = await openWebDavFileForRead(revalidated.absolutePath);
    if (!opened.ok) {
      res.writeHead(opened.code, { "Content-Type": "text/plain; charset=utf-8" });
      res.end(opened.message);
      return;
    }

    const { handle, size } = opened;

    try {
      res.writeHead(200, {
        "Content-Length": String(size),
        "Content-Type": "application/octet-stream",
      });

      if (method === "HEAD") {
        res.end();
        return;
      }

      await pipeline(handle.createReadStream({ autoClose: false }), res);
    } finally {
      await handle.close().catch(() => {});
    }
  }

  private async handlePropfind(
    absolutePath: string,
    rootAbsolute: string,
    displayPath: string,
    res: ServerResponse,
  ): Promise<void> {
    const revalidated = await this.revalidatePathInsideRoot(absolutePath, rootAbsolute);
    if (!revalidated.ok) {
      res.writeHead(revalidated.code, { "Content-Type": "text/plain; charset=utf-8" });
      res.end(revalidated.message);
      return;
    }
    absolutePath = revalidated.absolutePath;
    let info;
    try {
      info = await stat(absolutePath);
    } catch {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("not found");
      return;
    }

    const entries: string[] = [];
    if (info.isDirectory()) {
      const children = await readdir(absolutePath, { withFileTypes: true });
      for (const child of children) {
        const childHref = toEncodedHref(`${displayPath.replace(/\/$/, "")}/${child.name}`);
        entries.push(`
  <d:response>
    <d:href>${xmlEscape(childHref)}</d:href>
    <d:propstat><d:prop><d:resourcetype>${child.isDirectory() ? "<d:collection/>" : ""}</d:resourcetype></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat>
  </d:response>`);
      }
    }

    const xml = `<?xml version="1.0" encoding="utf-8"?>
<d:multistatus xmlns:d="DAV:">
  <d:response>
    <d:href>${xmlEscape(toEncodedHref(displayPath))}</d:href>
    <d:propstat><d:prop><d:resourcetype>${info.isDirectory() ? "<d:collection/>" : ""}</d:resourcetype></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat>
  </d:response>${entries.join("")}
</d:multistatus>`;

    res.writeHead(207, { "Content-Type": "application/xml; charset=utf-8" });
    res.end(xml);
  }

  private isPathInside(root: string, target: string): boolean {
    if (target === root) return true;
    if (root === path.parse(root).root) {
      return target.startsWith(root);
    }
    return target.startsWith(`${root}${path.sep}`);
  }

  private async revalidatePathInsideRoot(
    absolutePath: string,
    rootAbsolute: string,
  ): Promise<
    | { ok: true; absolutePath: string }
    | { ok: false; code: number; message: string }
  > {
    try {
      const canonical = await realpath(absolutePath);
      if (!this.isPathInside(rootAbsolute, canonical)) {
        return { ok: false, code: 403, message: "path escaped allowlist via symlink" };
      }
      return { ok: true, absolutePath: canonical };
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "ENOTDIR") {
        return { ok: false, code: 404, message: "not found" };
      }
      if (code === "ELOOP") {
        return { ok: false, code: 403, message: "path escaped allowlist via symlink" };
      }
      throw err;
    }
  }
}

function xmlEscape(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function toEncodedHref(pathname: string): string {
  return pathname
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
}
