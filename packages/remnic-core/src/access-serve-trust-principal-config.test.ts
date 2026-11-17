/**
 * `agentAccessHttp.trustPrincipalHeader` config path (issue #3462).
 *
 * The per-request principal header (`x-engram-principal`) was only reachable
 * through the `--trust-principal-header` CLI flag; a fleet daemon started
 * without the flag silently ignored pane-sent principals. This drives the
 * registered `engram access http-serve` action (registerCli + recording
 * program mock, as in cli-wearables-fuse.test.ts) against real namespace
 * storage and asserts the precedence contract:
 *
 * - explicit `--trust-principal-header` flag wins,
 * - absent flag falls back to `agentAccessHttp.trustPrincipalHeader` config,
 * - both unset: header ignored (unchanged behavior),
 * - parseConfig coerces bool-like strings and defaults to false.
 */

import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  registerCli,
  type CliApi,
  type CliCommand,
  type CliProgram,
} from "./cli.js";
import { parseConfig } from "./config.js";
import { NamespaceStorageRouter } from "./namespaces/storage.js";
import type { Orchestrator } from "./orchestrator.js";

/** Recording commander stand-in (same shape as cli-wearables-fuse.test.ts). */
class RecCmd implements CliCommand {
  readonly children = new Map<string, RecCmd>();
  readonly options: string[] = [];
  readonly args: string[] = [];
  actionFn?: (...args: unknown[]) => Promise<void> | void;
  constructor(readonly rawName: string) {}
  description(): CliCommand {
    return this;
  }
  option(flags: string): CliCommand {
    this.options.push(flags);
    return this;
  }
  requiredOption(flags: string): CliCommand {
    this.options.push(flags);
    return this;
  }
  argument(name: string): CliCommand {
    this.args.push(name);
    return this;
  }
  action(fn: (...args: unknown[]) => Promise<void> | void): CliCommand {
    this.actionFn = fn;
    return this;
  }
  command(name: string): CliCommand {
    const key = name.split(/\s+/)[0]!;
    const child = new RecCmd(name);
    this.children.set(key, child);
    return child;
  }
}

class RecProgram implements CliProgram {
  readonly root = new RecCmd("__program__");
  command(name: string): CliCommand {
    return this.root.command(name);
  }
}

const SERVE_TOKEN = "synthetic-serve-token";

/** CLI options shape commander hands the `engram access http-serve` action (flag values stay strings). */
interface ServeCliOptions {
  host?: string;
  port?: string;
  token?: string;
  trustPrincipalHeader?: boolean;
}

interface ServeFixture {
  serve: (options: ServeCliOptions) => Promise<{ host: string; port: number }>;
  stop: () => Promise<void>;
  cleanup: () => Promise<void>;
}

interface EntityListBody {
  entities?: Array<{ name?: string }>;
}

/** Config input for the fixture's access server; parseConfig accepts bool-like strings for the flag. */
interface FixtureAccessHttp {
  principal: string;
  trustPrincipalHeader?: boolean | string;
}

/**
 * Entity reads need only config + real storage routing from the orchestrator
 * (same Pick pattern as access-entity-principal.test.ts). The configured
 * access principal is "reader", who may read `restricted` but NOT `default`;
 * the header-supplied principal "owner" may read both — so a 200 on
 * `namespace=default` proves the header principal was trusted.
 */
async function createServeFixture(options: { trustPrincipalHeader?: boolean | string } = {}): Promise<ServeFixture> {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-serve-trust-"));
  const agentAccessHttp: FixtureAccessHttp = {
    principal: "reader",
  };
  if (options.trustPrincipalHeader !== undefined) {
    agentAccessHttp.trustPrincipalHeader = options.trustPrincipalHeader;
  }
  const config = parseConfig({
    memoryDir,
    namespacesEnabled: true,
    defaultNamespace: "default",
    namespacePolicies: [
      { name: "default", readPrincipals: ["owner"], writePrincipals: ["owner"] },
      { name: "restricted", readPrincipals: ["owner", "reader"], writePrincipals: ["owner"] },
    ],
    agentAccessHttp,
  });
  const router = new NamespaceStorageRouter(config);
  for (const namespace of ["default", "restricted"]) {
    const storage = await router.storageFor(namespace);
    const entitiesDir = path.join(storage.dir, "entities");
    await mkdir(entitiesDir, { recursive: true });
    await writeFile(path.join(entitiesDir, "project-widget.md"), [
      `# Widget-${namespace}`,
      "",
      "**Type:** project",
      "",
      "## Summary",
      "",
      `Synthetic entity in ${namespace}.`,
      "",
    ].join("\n"));
  }

  const dependencies: Pick<Orchestrator, "config" | "getStorage" | "initialize"> = {
    config,
    getStorage: (namespace?: string) => router.storageFor(namespace ?? config.defaultNamespace),
    initialize: async () => {},
  };

  const program = new RecProgram();
  const api: CliApi = {
    registerCli: (handler) => handler({ program }),
  };
  // SAFETY: registerCli and the http-serve action touch only config, getStorage, and
  // initialize on the orchestrator; each member is provided with its real shape.
  registerCli(api, dependencies as Parameters<typeof registerCli>[1]);
  const engram = program.root.children.get("engram");
  const access = engram?.children.get("access");
  const serveCmd = access?.children.get("http-serve");
  const stopCmd = access?.children.get("http-stop");
  assert.ok(serveCmd?.actionFn, "engram access http-serve registered an action");
  assert.ok(stopCmd?.actionFn, "engram access http-stop registered an action");

  const stop = async () => {
    await stopCmd!.actionFn!({});
  };

  const serve = async (options: ServeCliOptions) => {
    const logs: string[] = [];
    const originalLog = console.log;
    console.log = (...args: unknown[]) => {
      logs.push(args.map(String).join(" "));
    };
    try {
      await serveCmd!.actionFn!(options);
    } finally {
      console.log = originalLog;
    }
    const statusLine = logs.map((line) => line.trim()).find((line) => line.startsWith("{"));
    assert.ok(statusLine, "http-serve printed its status JSON");
    // SAFETY: http-serve prints the server.start() status JSON ({ running, host, port, ... });
    // only running/host/port are read and each is asserted below.
    const status = JSON.parse(statusLine) as { running?: boolean; host?: string; port?: number };
    assert.equal(status.running, true);
    assert.ok(Number.isInteger(status.port), "http-serve status carries an integer port");
    return { host: status.host ?? "127.0.0.1", port: status.port! };
  };

  return { serve, stop, cleanup: () => rm(memoryDir, { recursive: true, force: true }) };
}

async function readDefaultNamespaceAsOwner(
  fixture: ServeFixture,
  serveOptions: ServeCliOptions,
): Promise<Response> {
  const { host, port } = await fixture.serve(serveOptions);
  try {
    return await fetch(`http://${host}:${port}/engram/v1/entities?namespace=default`, {
      headers: {
        authorization: "Bearer " + SERVE_TOKEN,
        "x-engram-principal": "owner",
      },
    });
  } finally {
    await fixture.stop();
  }
}

test("parseConfig defaults agentAccessHttp.trustPrincipalHeader to false and coerces bool-like strings", () => {
  assert.equal(parseConfig({}).agentAccessHttp.trustPrincipalHeader, false);
  assert.equal(parseConfig({ agentAccessHttp: {} }).agentAccessHttp.trustPrincipalHeader, false);
  assert.equal(parseConfig({ agentAccessHttp: { trustPrincipalHeader: true } }).agentAccessHttp.trustPrincipalHeader, true);
  assert.equal(parseConfig({ agentAccessHttp: { trustPrincipalHeader: false } }).agentAccessHttp.trustPrincipalHeader, false);
  assert.equal(parseConfig({ agentAccessHttp: { trustPrincipalHeader: "true" } }).agentAccessHttp.trustPrincipalHeader, true);
  assert.equal(parseConfig({ agentAccessHttp: { trustPrincipalHeader: "1" } }).agentAccessHttp.trustPrincipalHeader, true);
  assert.equal(parseConfig({ agentAccessHttp: { trustPrincipalHeader: "false" } }).agentAccessHttp.trustPrincipalHeader, false);
  assert.equal(parseConfig({ agentAccessHttp: { trustPrincipalHeader: "0" } }).agentAccessHttp.trustPrincipalHeader, false);
});

test("absent flag falls back to agentAccessHttp.trustPrincipalHeader config (issue #3462)", async () => {
  const fixture = await createServeFixture({ trustPrincipalHeader: true });
  try {
    // NO --trust-principal-header flag: config alone must trust the header.
    // reader cannot read `default`; the header principal "owner" can.
    const response = await readDefaultNamespaceAsOwner(fixture, {
      host: "127.0.0.1",
      port: "0",
      token: "synthetic-serve-token",
    });
    assert.equal(response.status, 200);
    // SAFETY: a 200 from /engram/v1/entities carries the entity-list envelope; only entity names are read.
    const body = (await response.json()) as EntityListBody;
    assert.equal(body.entities?.[0]?.name, "Widget-default");
  } finally {
    await fixture.cleanup();
  }
});

test("explicit --trust-principal-header flag wins over config", async () => {
  const fixture = await createServeFixture();
  try {
    const response = await readDefaultNamespaceAsOwner(fixture, {
      host: "127.0.0.1",
      port: "0",
      token: "synthetic-serve-token",
      trustPrincipalHeader: true,
    });
    assert.equal(response.status, 200);
    // SAFETY: a 200 from /engram/v1/entities carries the entity-list envelope; only entity names are read.
    const body = (await response.json()) as EntityListBody;
    assert.equal(body.entities?.[0]?.name, "Widget-default");
  } finally {
    await fixture.cleanup();
  }
});

test("both unset: x-engram-principal header stays ignored", async () => {
  const fixture = await createServeFixture();
  try {
    const response = await readDefaultNamespaceAsOwner(fixture, {
      host: "127.0.0.1",
      port: "0",
      token: "synthetic-serve-token",
    });
    assert.equal(response.status, 400);
    // SAFETY: an ACL refusal from the access server answers { error }; only the message is read.
    const body = (await response.json()) as { error?: string };
    assert.match(body.error ?? "", /not readable/);
  } finally {
    await fixture.cleanup();
  }
});
