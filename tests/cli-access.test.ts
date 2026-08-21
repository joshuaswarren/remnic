import test from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { resolveAccessPrincipalOverride, runAccessMcpServeCliCommand } from "../src/cli.js";
import type { EngramAccessService } from "../src/access-service.js";

test("resolveAccessPrincipalOverride prefers explicit CLI principals and falls back to config", () => {
  assert.equal(resolveAccessPrincipalOverride(" cli-principal ", "config-principal"), "cli-principal");
  assert.equal(resolveAccessPrincipalOverride(undefined, " config-principal "), "config-principal");
  assert.equal(resolveAccessPrincipalOverride("   ", "config-principal"), "config-principal");
  assert.equal(resolveAccessPrincipalOverride(undefined, undefined), undefined);
});

test("runAccessMcpServeCliCommand forwards the resolved principal to the MCP server", async () => {
  let receivedPrincipal: string | undefined;
  let usedInput: NodeJS.ReadableStream | undefined;
  let usedOutput: NodeJS.WritableStream | undefined;
  const stdin = new PassThrough();
  const stdout = new PassThrough();

  const result = await runAccessMcpServeCliCommand({} as EngramAccessService, {
    principal: "project-x",
    stdin,
    stdout,
    createServer: (_service, options) => {
      receivedPrincipal = options.principal;
      return {
        async runStdio(input, output) {
          usedInput = input;
          usedOutput = output;
        },
      };
    },
  });

  assert.deepEqual(result, { ok: true });
  assert.equal(receivedPrincipal, "project-x");
  assert.equal(usedInput, stdin);
  assert.equal(usedOutput, stdout);
});
