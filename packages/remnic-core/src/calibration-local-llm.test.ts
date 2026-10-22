import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { calibrationConsolidationInput, readCalibrationIndex, runCalibrationConsolidation } from "./calibration.js";
import { parseConfig } from "./config.js";
import { type LoggerBackend, initLogger, resetLogger } from "./logger.js";
import type { GatewayConfig } from "./types.js";

/**
 * Gateway-less calibration (standalone daemon): no gateway model chain, so
 * consolidation must call the configured local LLM and surface skips above
 * debug. These tests drive the real LocalLlmClient against a loopback stub.
 */

interface CapturedRequest {
  method: string;
  path: string;
  body: string;
  headers: http.IncomingHttpHeaders;
}

interface StubServer {
  url: string;
  requests: CapturedRequest[];
  close(): Promise<void>;
}

function startServer(handle: (req: CapturedRequest, res: http.ServerResponse) => void): Promise<StubServer> {
  const requests: CapturedRequest[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const captured: CapturedRequest = {
        method: req.method ?? "",
        path: req.url ?? "",
        body: Buffer.concat(chunks).toString("utf8"),
        headers: req.headers,
      };
      requests.push(captured);
      handle(captured, res);
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${port}/v1`,
        requests,
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
}

function json(res: http.ServerResponse, body: unknown): void {
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

function ruleJson(condition: string): string {
  return JSON.stringify({
    rules: [
      {
        ruleType: "scope_boundary",
        condition,
        modelTendency: "It expands the task",
        userExpectation: "Stay inside the request",
        calibration: "Ask before widening the task.",
        confidence: 0.8,
        evidenceIds: ["correction-1", "correction-2"],
      },
    ],
  });
}

function chatCompletionBody(content: string): unknown {
  return { choices: [{ message: { content } }] };
}

async function writeCorrections(memoryDir: string, count: number): Promise<void> {
  const dir = path.join(memoryDir, "corrections");
  await mkdir(dir, { recursive: true });
  for (let i = 1; i <= count; i += 1) {
    const body = [
      "---",
      `id: correction-${i}`,
      "confidence: 0.9",
      "---",
      "",
      `Correction ${i}: the model assumed a broader scope than the user stated for task ${i}.`,
      "",
    ].join("\n");
    await writeFile(path.join(dir, `correction-${i}.md`), body, "utf8");
  }
}

function captureLogs(debug = true): { lines: Array<{ level: string; msg: string }> } {
  const lines: Array<{ level: string; msg: string }> = [];
  const backend: LoggerBackend = {
    info(msg) {
      lines.push({ level: "info", msg: String(msg) });
    },
    warn(msg) {
      lines.push({ level: "warn", msg: String(msg) });
    },
    error(msg) {
      lines.push({ level: "error", msg: String(msg) });
    },
    debug(msg) {
      lines.push({ level: "debug", msg: String(msg) });
    },
  };
  initLogger(backend, debug);
  return { lines };
}

function gatewayConfig(baseUrl: string): GatewayConfig {
  return {
    agents: { defaults: { model: { primary: "stub/calibration-gateway" } } },
    models: {
      providers: {
        stub: {
          baseUrl,
          api: "openai-completions",
          apiKey: "gateway-test-key",
          models: [],
        },
      },
    },
  };
}

test.describe("gateway-less calibration", { concurrency: false }, () => {
  test("plugin mode supplies localLlm settings and leaves the gateway chain unset", () => {
    const config = parseConfig({
      memoryDir: "/tmp/remnic-cal-plugin",
      modelSource: "plugin",
      localLlmEnabled: true,
      localLlmModel: "daemon-calibration-model",
      gatewayAgentId: "ignored-in-plugin-mode",
      taskModelChain: { primary: "stub/ignored" },
    });
    const input = calibrationConsolidationInput(config);
    assert.equal(input.pluginConfig, config);
    assert.equal(input.pluginConfig.localLlmModel, "daemon-calibration-model");
    assert.equal(input.pluginConfig.localLlmEnabled, true);
    assert.equal(input.gatewayAgentId, undefined);
    assert.equal(input.modelChain, undefined);
    assert.equal(input.gatewayConfig, undefined);
  });

  test("gateway mode keeps the agent and task chain on the calibration input", () => {
    const config = parseConfig({
      memoryDir: "/tmp/remnic-cal-gateway-input",
      modelSource: "gateway",
      gatewayAgentId: "agent-a",
      taskModelChain: { primary: "stub/calibration-gateway" },
    });
    const input = calibrationConsolidationInput(config);
    assert.equal(input.gatewayAgentId, "agent-a");
    assert.deepEqual(input.modelChain, { primary: "stub/calibration-gateway" });
    assert.equal(input.pluginConfig, config);
  });

  test("uses the daemon localLlm* settings when no gateway model chain exists", async () => {
    const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-cal-local-"));
    const logs = captureLogs();
    const server = await startServer((req, res) => {
      if (req.method === "GET" && req.path === "/") {
        res.writeHead(200, { "content-type": "text/plain" });
        res.end("Ollama is running");
        return;
      }
      if (req.method === "POST" && req.path === "/v1/chat/completions") {
        json(res, chatCompletionBody(ruleJson("When the daemon has no gateway chain")));
        return;
      }
      res.writeHead(404);
      res.end();
    });
    try {
      await writeCorrections(memoryDir, 3);
      const pluginConfig = parseConfig({
        memoryDir,
        modelSource: "plugin",
        localLlmEnabled: true,
        localLlmUrl: server.url,
        localLlmModel: "daemon-calibration-model",
        localLlmHeaders: { "X-Remnic-Local": "calibration" },
        localLlmApiKey: "local-test-key",
        localLlmAuthHeader: true,
      });
      const rules = await runCalibrationConsolidation({
        memoryDir,
        workspaceDir: memoryDir,
        pluginConfig,
      });

      assert.equal(rules.length, 1);
      assert.equal(rules[0]?.condition, "When the daemon has no gateway chain");
      const stored = await readCalibrationIndex(memoryDir);
      assert.equal(stored.rules.length, 1);
      assert.equal(stored.totalCorrectionsAnalyzed, 3);

      const completion = server.requests.find((req) => req.method === "POST" && req.path === "/v1/chat/completions");
      assert.ok(completion, "local LLM chat completion was not called");
      const body = JSON.parse(completion.body) as { model?: string };
      assert.equal(body.model, "daemon-calibration-model");
      assert.equal(completion.headers["x-remnic-local"], "calibration");
      assert.equal(completion.headers.authorization, "Bearer local-test-key");
      assert.ok(
        logs.lines.some((line) => line.level === "info" && line.msg.includes("model=daemon-calibration-model"))
      );
      assert.equal(
        logs.lines.some((line) => line.msg.includes("no LLM available")),
        false
      );
    } finally {
      resetLogger();
      await server.close();
      await rm(memoryDir, { recursive: true, force: true });
    }
  });

  test("warns and skips when neither a gateway chain nor a local LLM is configured", async () => {
    const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-cal-skip-"));
    const logs = captureLogs(true);
    try {
      await writeCorrections(memoryDir, 3);
      const pluginConfig = parseConfig({
        memoryDir,
        modelSource: "plugin",
        localLlmEnabled: false,
      });
      const rules = await runCalibrationConsolidation({
        memoryDir,
        workspaceDir: memoryDir,
        pluginConfig,
      });
      assert.deepEqual(rules, []);
      const stored = await readCalibrationIndex(memoryDir);
      assert.equal(stored.rules.length, 0);
      assert.ok(logs.lines.some((line) => line.level === "warn" && line.msg.includes("no LLM available")));
      assert.equal(
        logs.lines.some((line) => line.level === "debug" && line.msg.includes("no LLM available")),
        false
      );
    } finally {
      resetLogger();
      await rm(memoryDir, { recursive: true, force: true });
    }
  });

  test("logs a short correction set at info", async () => {
    const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-cal-few-"));
    const logs = captureLogs(true);
    const server = await startServer((req, res) => {
      if (req.method === "GET" && req.path === "/") {
        res.writeHead(200, { "content-type": "text/plain" });
        res.end("Ollama is running");
        return;
      }
      res.writeHead(500);
      res.end();
    });
    try {
      await writeCorrections(memoryDir, 1);
      const pluginConfig = parseConfig({
        memoryDir,
        modelSource: "plugin",
        localLlmEnabled: true,
        localLlmUrl: server.url,
        localLlmModel: "daemon-calibration-model",
      });
      const rules = await runCalibrationConsolidation({
        memoryDir,
        workspaceDir: memoryDir,
        pluginConfig,
      });
      assert.deepEqual(rules, []);
      assert.equal(
        server.requests.some((req) => req.method === "POST"),
        false,
        "synthesis must not call the LLM before the correction minimum"
      );
      assert.ok(logs.lines.some((line) => line.level === "info" && line.msg.includes("need at least 3")));
      assert.equal(
        logs.lines.some((line) => line.level === "debug" && line.msg.includes("need at least 3")),
        false
      );
    } finally {
      resetLogger();
      await server.close();
      await rm(memoryDir, { recursive: true, force: true });
    }
  });

  test("keeps the gateway chain when one is configured", async () => {
    const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-cal-gateway-"));
    const logs = captureLogs();
    const local = await startServer((req, res) => {
      if (req.method === "GET" && req.path === "/") {
        res.writeHead(200, { "content-type": "text/plain" });
        res.end("Ollama is running");
        return;
      }
      if (req.method === "POST") {
        json(res, chatCompletionBody(ruleJson("When the local model was used by mistake")));
        return;
      }
      res.writeHead(404);
      res.end();
    });
    const gateway = await startServer((req, res) => {
      if (req.method === "POST" && req.path === "/v1/chat/completions") {
        json(res, chatCompletionBody(ruleJson("When the gateway chain is present")));
        return;
      }
      res.writeHead(404);
      res.end();
    });
    try {
      await writeCorrections(memoryDir, 3);
      const pluginConfig = parseConfig({
        memoryDir,
        modelSource: "plugin",
        localLlmEnabled: true,
        localLlmUrl: local.url,
        localLlmModel: "daemon-calibration-model",
      });
      const rules = await runCalibrationConsolidation({
        memoryDir,
        workspaceDir: memoryDir,
        gatewayConfig: gatewayConfig(gateway.url),
        pluginConfig,
      });
      assert.equal(rules.length, 1);
      assert.equal(rules[0]?.condition, "When the gateway chain is present");
      assert.equal(local.requests.length, 0);
      assert.equal(
        gateway.requests.filter((req) => req.method === "POST" && req.path === "/v1/chat/completions").length,
        1
      );
      assert.equal(
        logs.lines.some((line) => line.msg.includes("using configured local LLM")),
        false
      );
    } finally {
      resetLogger();
      await local.close();
      await gateway.close();
      await rm(memoryDir, { recursive: true, force: true });
    }
  });
});
