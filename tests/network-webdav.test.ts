import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { chmod, mkdir, mkdtemp, rm, stat, symlink, writeFile } from "node:fs/promises";
import { request } from "node:http";
import { WebDavServer, hostToUrlAuthority, openWebDavFileForRead } from "../src/network/webdav.ts";

type HttpResult = {
  status: number;
  body: string;
  headers: Record<string, string | string[] | undefined>;
};

async function httpRequest(
  method: string,
  port: number,
  pathname: string,
  headers?: Record<string, string>,
): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: "127.0.0.1",
        port,
        path: pathname,
        method,
        headers,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          resolve({
            status: res.statusCode ?? 0,
            body: Buffer.concat(chunks).toString("utf-8"),
            headers: res.headers,
          });
        });
      },
    );
    req.on("error", reject);
    req.end();
  });
}

test("webdav server is disabled by default", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "engram-webdav-disabled-"));
  const server = await WebDavServer.create({
    port: 0,
    allowlistDirs: [root],
  });

  await assert.rejects(() => server.start(), /disabled/);
});

test("webdav serves files only inside allowlisted root alias", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "engram-webdav-allow-"));
  await writeFile(path.join(root, "hello.txt"), "hello-world", "utf-8");

  const server = await WebDavServer.create({
    enabled: true,
    port: 0,
    allowlistDirs: [root],
  });
  const started = await server.start();
  const alias = path.basename(root);

  try {
    const ok = await httpRequest("GET", started.port, `/${alias}/hello.txt`);
    assert.equal(ok.status, 200);
    assert.equal(ok.body, "hello-world");

    const blocked = await httpRequest("GET", started.port, "/hello.txt");
    assert.equal(blocked.status, 403);
  } finally {
    await server.stop();
  }
});

test("webdav blocks traversal and supports PROPFIND", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "engram-webdav-propfind-"));
  await writeFile(path.join(root, "a.txt"), "a", "utf-8");

  const server = await WebDavServer.create({
    enabled: true,
    port: 0,
    allowlistDirs: [root],
  });
  const started = await server.start();
  const alias = path.basename(root);

  try {
    const propfind = await httpRequest("PROPFIND", started.port, `/${alias}`);
    assert.equal(propfind.status, 207);
    assert.match(propfind.body, /multistatus/);
    assert.match(propfind.body, /a\.txt/);
    assert.match(propfind.body, /<d:status>HTTP\/1.1 200 OK<\/d:status>/);

    const traversal = await httpRequest("GET", started.port, `/${alias}/../etc/passwd`);
    assert.equal(traversal.status, 403);
  } finally {
    await server.stop();
  }
});

test("webdav PROPFIND hrefs are URI-encoded", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "engram-webdav-propfind-encode-"));
  await writeFile(path.join(root, "my file#1?.txt"), "a", "utf-8");

  const server = await WebDavServer.create({
    enabled: true,
    port: 0,
    allowlistDirs: [root],
  });
  const started = await server.start();
  const alias = path.basename(root);

  try {
    const propfind = await httpRequest("PROPFIND", started.port, `/${alias}`);
    assert.equal(propfind.status, 207);
    assert.match(propfind.body, /\/my%20file%231%3F\.txt/);
  } finally {
    await server.stop();
  }
});

test("webdav enforces optional basic auth", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "engram-webdav-auth-"));
  await writeFile(path.join(root, "secret.txt"), "top-secret", "utf-8");

  const server = await WebDavServer.create({
    enabled: true,
    port: 0,
    allowlistDirs: [root],
    auth: {
      username: "engram",
      password: "pass123",
    },
  });
  const started = await server.start();
  const alias = path.basename(root);

  try {
    const denied = await httpRequest("GET", started.port, `/${alias}/secret.txt`);
    assert.equal(denied.status, 401);

    const emptyCredentials = await httpRequest("GET", started.port, `/${alias}/secret.txt`, {
      Authorization: `Basic ${Buffer.from(":").toString("base64")}`,
    });
    assert.equal(emptyCredentials.status, 401);

    const authHeader = `Basic ${Buffer.from("engram:pass123").toString("base64")}`;
    const allowed = await httpRequest("GET", started.port, `/${alias}/secret.txt`, {
      Authorization: authHeader,
    });

    assert.equal(allowed.status, 200);
    assert.equal(allowed.body, "top-secret");

    const lowerScheme = await httpRequest("GET", started.port, `/${alias}/secret.txt`, {
      Authorization: authHeader.replace("Basic ", "basic "),
    });
    assert.equal(lowerScheme.status, 200);
    assert.equal(lowerScheme.body, "top-secret");
  } finally {
    await server.stop();
  }
});

test("webdav rejects empty basic auth credentials at create time", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "engram-webdav-empty-auth-"));

  await assert.rejects(
    () =>
      WebDavServer.create({
        enabled: true,
        port: 0,
        allowlistDirs: [root],
        auth: { username: "", password: "pass123" },
      }),
    /webdav auth\.username must be a non-empty string/,
  );
  await assert.rejects(
    () =>
      WebDavServer.create({
        enabled: true,
        port: 0,
        allowlistDirs: [root],
        auth: { username: "engram", password: "" },
      }),
    /webdav auth\.password must be a non-empty string/,
  );
  await assert.rejects(
    () =>
      WebDavServer.create({
        enabled: true,
        port: 0,
        allowlistDirs: [root],
        auth: { username: "   ", password: "\t" },
      }),
    /webdav auth\.username must be a non-empty string/,
  );
});

test("webdav does not leak internal errors in 500 response bodies", async () => {
  if (typeof process.getuid === "function" && process.getuid() === 0) {
    return;
  }

  const root = await mkdtemp(path.join(os.tmpdir(), "engram-webdav-500-redact-"));
  const blocked = path.join(root, "blocked");
  await mkdir(blocked, { recursive: true });
  await chmod(blocked, 0o000);

  const server = await WebDavServer.create({
    enabled: true,
    port: 0,
    allowlistDirs: [root],
  });
  const started = await server.start();
  const alias = path.basename(root);

  try {
    const res = await httpRequest("PROPFIND", started.port, `/${alias}/blocked`);
    assert.equal(res.status, 500);
    assert.equal(res.body, "webdav error");
  } finally {
    await chmod(blocked, 0o700).catch(() => {});
    await server.stop();
  }
});

test("webdav blocks symlink escapes outside allowlisted root", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "engram-webdav-symlink-"));
  const outsideDir = await mkdtemp(path.join(os.tmpdir(), "engram-webdav-outside-"));
  const outsideFile = path.join(outsideDir, "outside.txt");
  await writeFile(outsideFile, "outside-secret", "utf-8");
  await symlink(outsideFile, path.join(root, "leak.txt"));

  const server = await WebDavServer.create({
    enabled: true,
    port: 0,
    allowlistDirs: [root],
  });
  const started = await server.start();
  const alias = path.basename(root);

  try {
    const leakAttempt = await httpRequest("GET", started.port, `/${alias}/leak.txt`);
    assert.equal(leakAttempt.status, 403);
    assert.match(leakAttempt.body, /allowlist/i);
  } finally {
    await server.stop();
  }
});

test("webdav read open rejects a symlink swapped after path validation", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "engram-webdav-race-"));
  const outsideDir = await mkdtemp(path.join(os.tmpdir(), "engram-webdav-race-outside-"));
  const target = path.join(root, "target.txt");
  const outsideFile = path.join(outsideDir, "outside.txt");
  await writeFile(target, "inside", "utf-8");
  await writeFile(outsideFile, "outside-secret", "utf-8");

  try {
    await rm(target);
    await symlink(outsideFile, target);
  } catch {
    return; // symlinks unavailable
  }

  const opened = await openWebDavFileForRead(target);
  assert.equal(opened.ok, false);
  if (!opened.ok) {
    assert.equal(opened.code, 403);
    assert.match(opened.message, /symlink/i);
  }
});

test("webdav blocks parent-directory symlink escapes", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "engram-webdav-parent-symlink-"));
  const outsideDir = await mkdtemp(path.join(os.tmpdir(), "engram-webdav-parent-outside-"));
  await writeFile(path.join(outsideDir, "outside.txt"), "outside-secret", "utf-8");

  try {
    await symlink(outsideDir, path.join(root, "linked-dir"), "dir");
  } catch {
    return; // symlinks unavailable
  }

  const server = await WebDavServer.create({
    enabled: true,
    port: 0,
    allowlistDirs: [root],
  });
  const started = await server.start();
  const alias = path.basename(root);

  try {
    const get = await httpRequest("GET", started.port, `/${alias}/linked-dir/outside.txt`);
    assert.equal(get.status, 403);
    assert.match(get.body, /symlink|allowlist/i);

    const propfind = await httpRequest("PROPFIND", started.port, `/${alias}/linked-dir`);
    assert.equal(propfind.status, 403);
    assert.match(propfind.body, /symlink|allowlist/i);
  } finally {
    await server.stop();
    await rm(outsideDir, { recursive: true, force: true });
  }
});

test("webdav start resets state after listen failure and supports retry", async () => {
  const rootA = await mkdtemp(path.join(os.tmpdir(), "engram-webdav-retry-a-"));
  const rootB = await mkdtemp(path.join(os.tmpdir(), "engram-webdav-retry-b-"));

  const first = await WebDavServer.create({
    enabled: true,
    port: 0,
    allowlistDirs: [rootA],
  });
  const firstStarted = await first.start();

  const second = await WebDavServer.create({
    enabled: true,
    port: firstStarted.port,
    allowlistDirs: [rootB],
  });

  await assert.rejects(() => second.start());
  assert.equal(second.status().running, false);

  await first.stop();

  const secondStarted = await second.start();
  assert.equal(secondStarted.running, true);
  await second.stop();
});

test("webdav stop during startup settles lifecycle and allows restart", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "engram-webdav-stop-startup-"));
  const server = await WebDavServer.create({
    enabled: true,
    port: 0,
    allowlistDirs: [root],
  });

  const started = server.start();
  await server.stop();
  await started.catch((error) => {
    assert.match(String(error), /closed before listening|Server is not running|ERR_SERVER_NOT_RUNNING/);
  });

  const restarted = await server.start();
  assert.equal(restarted.running, true);
  await server.stop();
});

test("webdav concurrent start waits for listening state and bound port", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "engram-webdav-concurrent-start-"));
  const server = await WebDavServer.create({
    enabled: true,
    port: 0,
    allowlistDirs: [root],
  });

  try {
    const [first, second] = await Promise.all([server.start(), server.start()]);
    assert.equal(first.running, true);
    assert.equal(second.running, true);
    assert.ok(first.port > 0);
    assert.equal(second.port, first.port);
    assert.deepEqual(server.status(), first);
  } finally {
    await server.stop();
  }
});

test("webdav restart with port 0 rebinds to a fresh ephemeral port", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "engram-webdav-ephemeral-"));
  const server = await WebDavServer.create({
    enabled: true,
    port: 0,
    allowlistDirs: [root],
  });

  const first = await server.start();
  assert.ok(first.port > 0);
  await server.stop();
  assert.equal(server.status().port, 0);

  const second = await server.start();
  assert.ok(second.port > 0);
  await server.stop();
});

test("hostToUrlAuthority brackets IPv6 host literals", () => {
  assert.equal(hostToUrlAuthority("127.0.0.1"), "127.0.0.1");
  assert.equal(hostToUrlAuthority("::1"), "[::1]");
  assert.equal(hostToUrlAuthority("[::1]"), "[::1]");
});

test("webdav returns 400 for malformed URL encoding", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "engram-webdav-bad-escape-"));
  const server = await WebDavServer.create({
    enabled: true,
    port: 0,
    allowlistDirs: [root],
  });
  const started = await server.start();
  try {
    const malformed = await httpRequest("GET", started.port, "/%E0%A4%A");
    assert.equal(malformed.status, 400);
    assert.match(malformed.body, /invalid path encoding/i);
  } finally {
    await server.stop();
  }
});

test("webdav returns 400 for ENOTDIR path traversal shape", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "engram-webdav-notdir-"));
  await writeFile(path.join(root, "leaf.txt"), "leaf", "utf-8");

  const server = await WebDavServer.create({
    enabled: true,
    port: 0,
    allowlistDirs: [root],
  });
  const started = await server.start();
  const alias = path.basename(root);

  try {
    const res = await httpRequest("GET", started.port, `/${alias}/leaf.txt/child`);
    assert.equal(res.status, 400);
    assert.match(res.body, /invalid path/i);
  } finally {
    await server.stop();
  }
});

test("webdav create rejects duplicate root aliases", async () => {
  const baseA = await mkdtemp(path.join(os.tmpdir(), "engram-webdav-alias-a-"));
  const baseB = await mkdtemp(path.join(os.tmpdir(), "engram-webdav-alias-b-"));
  const dirA = path.join(baseA, "shared");
  const dirB = path.join(baseB, "shared");
  await mkdir(dirA, { recursive: true });
  await mkdir(dirB, { recursive: true });

  await assert.rejects(
    () =>
      WebDavServer.create({
        enabled: true,
        port: 0,
        allowlistDirs: [dirA, dirB],
      }),
    /duplicate webdav allowlist alias: shared/,
  );
});

test("webdav supports filesystem-root allowlists", async () => {
  const hostsPath = "/etc/hosts";
  try {
    await stat(hostsPath);
  } catch {
    return;
  }

  const server = await WebDavServer.create({
    enabled: true,
    port: 0,
    allowlistDirs: ["/"],
  });
  const started = await server.start();
  try {
    const res = await httpRequest("GET", started.port, "/root/etc/hosts");
    assert.equal(res.status, 200);
  } finally {
    await server.stop();
  }
});
