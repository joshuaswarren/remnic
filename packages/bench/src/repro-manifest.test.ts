import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, realpath, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  BENCHMARK_REPRO_MANIFEST_FILENAME,
  buildBenchmarkReproManifest,
  computeBenchmarkReproManifestArtifactHash,
  parseBenchmarkReproManifest,
  writeBenchmarkReproManifest,
} from "./repro-manifest.ts";
import type { BenchmarkResult } from "./types.js";

function buildResult(): BenchmarkResult {
  return {
    meta: {
      id: "run-1",
      benchmark: "longmemeval",
      benchmarkTier: "published",
      version: "1.0.0",
      remnicVersion: "9.3.167",
      gitSha: "abc1234",
      timestamp: "2026-04-24T20:00:00.000Z",
      mode: "full",
      runCount: 5,
      seeds: [42, 43, 44, 45, 46],
    },
    config: {
      runtimeProfile: "real",
      systemProvider: {
        provider: "openai",
        model: "gemma4:31b",
        baseUrl: "https://ollama.com/v1",
      },
      judgeProvider: null,
      adapterMode: "direct",
      remnicConfig: {
        qmdCollection: "bench-hot",
        qmdColdCollection: "bench-cold",
        conversationIndexQmdCollection: "bench-conversations",
      },
    },
    cost: {
      totalTokens: 0,
      inputTokens: 0,
      outputTokens: 0,
      estimatedCostUsd: 0,
      totalLatencyMs: 0,
      meanQueryLatencyMs: 0,
    },
    results: {
      tasks: [],
      aggregates: {},
    },
    environment: {
      os: "darwin",
      nodeVersion: process.version,
      hardware: process.arch,
    },
  };
}

async function createTempRoot(prefix: string): Promise<string> {
  return mkdtemp(path.join(await realpath(os.tmpdir()), prefix));
}

test("buildBenchmarkReproManifest hashes datasets/results and redacts secret argv values", async () => {
  const root = await createTempRoot("remnic-repro-manifest-");
  const resultsDir = path.join(root, "results");
  const datasetDir = path.join(root, "dataset");
  await mkdir(resultsDir, { recursive: true });
  await mkdir(path.join(datasetDir, "nested"), { recursive: true });
  await writeFile(path.join(datasetDir, "answers.json"), JSON.stringify({ answer: 42 }), "utf8");
  await writeFile(path.join(datasetDir, "nested", "notes.txt"), "dataset note\n", "utf8");
  await symlink("answers.json", path.join(datasetDir, "answers-link.json"));

  const resultPath = path.join(resultsDir, "longmemeval.json");
  await writeFile(resultPath, `${JSON.stringify(buildResult(), null, 2)}\n`, "utf8");

  const manifest = await buildBenchmarkReproManifest(resultsDir, {
    resultPaths: [resultPath],
    selectedBenchmarks: ["longmemeval"],
    runtimeProfiles: ["real"],
    mode: "full",
    seed: 42,
    datasetDirs: { longmemeval: datasetDir },
    command: {
      cwd: root,
      argv: [
        "bench",
        "run",
        "fixtures/token-benchmark.json",
        "--system-api-key",
        "secret-value",
        "--judge-api-key=other-secret",
        "--api-key",
        "--limit",
        "10",
        "--max-tokens",
        "2048",
        "--output-token-limit=128",
        "--api-key",
        "--config",
        "profile=real",
        "--api-key",
        "--token",
        "adjacent-token-secret",
        "--api-key",
        "-sk-live-dash-secret",
        "--mode",
        "quick",
        "--api-key",
        "-sk_live_123",
        "--limit",
        "21",
        "--api-key",
        "--sk-live-secret",
        "--mode",
        "boundary-mode",
        "--api-key",
        "--tokenlike-secret",
        "--limit",
        "24",
        "--apiKey",
        "camel-api-key-secret",
        "--accessToken",
        "camel-access-token-secret",
        "--openai-api-key",
        "provider-prefixed-openai-api-secret",
        "--anthropic-api-key",
        "provider-prefixed-anthropic-api-secret",
        "--bearer-token",
        "provider-prefixed-bearer-token-secret",
        "--password",
        "provider-password-alias-secret",
        "--secret",
        "provider-secret-alias-secret",
        "--authorization",
        "Bearer",
        "split-authorization-token",
        "--authorization=Bearer",
        "assigned-authorization-secret",
        "--mode",
        "auth-mode",
        "--auth-token",
        "Bearer",
        "split-auth-token-secret",
        "--auth-token=Bearer",
        "assigned-auth-token-secret",
        "--mode",
        "auth-token-mode",
        "--auth-token",
        "auth-secret",
        "--token",
        "-dash-secret",
        "--auth-token",
        "Bearer",
        "-dash-auth-token-secret",
        "--mode",
        "dash-auth-mode",
        "--auth-token",
        "--opaque-token",
        "--token",
        "--provider-config",
        "--mode",
        "dash-mode",
        "-t",
        "short-token-secret",
        "-k=short-key-secret",
        "-p",
        "-short-dash-secret",
        "-pattached-secret",
        "-tAttachedToken",
        "-kAttachedKey",
        "--api-keysk-live-attached-long-secret",
        "--tokenabc-attached-long-secret",
        "--auth-tokenBearerAttachedLongSecret",
        "--auth-tokenBearer",
        "attached-long-auth-continuation-secret",
        "--api-key=attached-equals-api-secret",
        "--token=attached-equals-token-secret",
        "--secret-key",
        "split-secret-key-value",
        "--client-secret-key=client-secret-key-value",
        "secretKey=direct-secret-key-value",
        "provider.clientSecretKey=nested-client-secret-key-value",
        "AWS_SECRET_ACCESS_KEY=aws-secret-access-key-value",
        "--config",
        "apiKey=sk-test",
        "--config",
        "accessKey",
        "split-access-key-secret",
        "--config=apiKey",
        "split-assigned-secret",
        "--config=callbackUrl=https://example.test/cb?api_key=url-query-secret&mode=test",
        "--endpoint=https://user:p@ss-argv-url-userinfo-secret@example.test/v1?model=keep",
        "--provider-config=apiKey",
        "split-provider-assigned-secret",
        "--provider-config=token",
        "split-provider-token-secret",
        "--provider-config",
        "awsSecretAccessKey=provider-access-key-secret",
        "--provider-config",
        "baseUrl=https://host.test/path?access_token=url-access-secret;mode=keep",
        "--provider-config",
        "https://example.test/v1?api_key=separate-url-secret&model=x",
        "--config",
        "https://example.test/cb?password=url-password-secret&mode=keep",
        "--config=api_key=sk-inline",
        "--config=systemApiKey=system-camel-secret",
        "--provider-config",
        '{"apiKey":"sk-live-secret","systemApiKey":"json-camel-secret","baseUrl":"https://proxy.test/v1?api_key=json-url-secret&model=x","provider":"openai"}',
        "--provider-config",
        '{"headers":{"Cookie":"sid=json-cookie-secret","Authorization":"Bearer json-auth-secret"},"provider":"openai"}',
        "--provider-config",
        '{"privateKey":"json-private-key-secret","provider":"aws"}',
        "--provider-config",
        "{apiKey:loose-object-api-secret,provider:openai}",
        "--config={authorization:loose-object-authorization-secret,model:gpt-test}",
        "provider={credentials:{password:'loose-nested-password-secret'},name:openai}",
        "provider=https://user:p@ss-provider-url-userinfo-secret@example.test/v1?api_key=provider-url-query-secret&model=keep",
        '--config={"judge":{"token":"judge-secret"},"model":"gpt-test"}',
        'provider={"credentials":{"password":"nested-secret","accessToken":"access-camel-secret"},"name":"openai"}',
        "--config",
        "token",
        "split-secret",
        "--config",
        "authorization=Bearer",
        "config-assigned-authorization-secret",
        "--provider-config",
        "authorization=Bearer",
        "provider-assigned-authorization-secret",
        "--config=authorization=Bearer",
        "assigned-wrapper-authorization-secret",
        "--config=auth_token",
        "Bearer",
        "assigned-config-auth-token-secret",
        "--config",
        "auth_token",
        "Bearer",
        "split-config-auth-token-secret",
        "--config",
        "auth_token:",
        "Bearer",
        "colon-config-auth-token-secret",
        "--config",
        "Authorization:",
        "ApiKey",
        "config-authorization-apikey-secret",
        "--limit",
        "25",
        "--config",
        "authorization:",
        "Bearer",
        "config-lower-authorization-bearer-secret",
        "--provider-config",
        "authorization:",
        "Bearer",
        "provider-lower-authorization-bearer-secret",
        "--config",
        "token",
        "--token-value",
        "--config",
        "openai.apiKey",
        "namespaced-secret",
        "--config",
        "openai.apiKey:colon-secret",
        "--config=openai.apiKey:colon-inline-secret",
        "--config",
        "refreshToken",
        "refresh-camel-secret",
        "--config",
        "--api-key",
        "dashed-config-secret",
        "--header",
        "Authorization",
        "Bearer header-secret",
        "--header",
        "Authorization",
        "Bearer",
        "split-auth-token",
        "--header",
        "Authorization",
        "-dash-header-name-secret",
        "--limit",
        "16",
        "--header",
        "Authorization",
        "--bearer-secret",
        "--limit",
        "17",
        "--header",
        "Authorization:",
        "Bearer",
        "split-header-secret",
        "--header",
        "Authorization:",
        "-dash-header-secret",
        "--limit",
        "14",
        "--config",
        "apiKey:",
        "split-colon-secret",
        "--config",
        "apiKey",
        "-split-dash-config-secret",
        "--limit",
        "15",
        "authorization:",
        "-dash-bearer-secret",
        "--limit",
        "13",
        "--header",
        "Cookie: session=cookie-secret",
        "--header",
        "Cookie: session=cookie-multipart-secret",
        "path=/",
        "domain=example.test",
        "--limit",
        "11",
        "--header",
        "Authorization=Bearer auth-equals-secret",
        "--header",
        "Authorization=Bearer",
        "split-equals-secret",
        "--header=Authorization: Bearer assigned-colon-header-secret",
        "--header=Authorization:",
        "Bearer",
        "split-assigned-colon-header-secret",
        "--limit",
        "18",
        "--header=Authorization=Bearer",
        "split-assigned-equals-secret",
        "--header=Authorization=",
        "Bearer",
        "split-assigned-empty-equals-secret",
        "--limit",
        "19",
        "--header=Authorization",
        "Bearer",
        "split-assigned-auth-secret",
        "--header=Authorization",
        "Bearer assigned-auth-secret",
        "--header=Cookie=session=assigned-cookie-secret",
        "--header=Cookie: session=assigned-cookie-multipart-secret",
        "path=/",
        "secure=true",
        "--mode",
        "smoke",
        "--header",
        "Cookie=session",
        "cookie-continuation-secret",
        "--limit",
        "12",
        "provider.header=Authorization: Bearer generic-header-secret",
        "authorization=Bearer",
        "bare-assigned-authorization-secret",
        "token=Bearer",
        "bare-assigned-token-secret",
        "authorization",
        "Bearer",
        "bare-authorization-secret",
        "--limit",
        "22",
        "token:",
        "Bearer",
        "bare-token-colon-secret",
        "access_token:",
        "Bearer",
        "bare-access-token-colon-secret",
        "Authorization:",
        "Bearer",
        "bare-authorization-colon-secret",
        "--limit",
        "23",
        "--password:option-password-secret",
        "--token:option-token-secret",
        "--password:",
        "option-password-continuation-secret",
        "token",
        "Bearer",
        "bare-token-secret",
        "password",
        "bare-password-secret",
        "provider.token=provider-secret",
        "provider.name=openai",
        "next-positional",
      ],
      env: { OLLAMA_API_KEY: "secret-value", QMD_CONFIG_DIR: "/tmp/qmd" },
      envKeys: ["OLLAMA_API_KEY", "QMD_CONFIG_DIR"],
    },
    qmd: { configDir: "/tmp/qmd" },
  });
  const parsedManifest = parseBenchmarkReproManifest(
    JSON.parse(JSON.stringify(manifest)),
  );
  assert.deepEqual(parsedManifest, manifest);

  assert.equal(manifest.run.mode, "full");
  assert.match(manifest.run.id, /^20[0-9]{2}-/);
  assert.deepEqual(manifest.run.runtimeProfiles, ["real"]);
  assert.deepEqual(manifest.run.selectedWorkItems, [{ benchmark: "longmemeval", runtimeProfile: "real" }]);
  assert.equal(manifest.run.seed, 42);
  assert.deepEqual(manifest.command.argv, [
    "bench",
    "run",
    "fixtures/token-benchmark.json",
    "--system-api-key",
    "[redacted]",
    "--judge-api-key=[redacted]",
    "--api-key",
    "--limit",
    "10",
    "--max-tokens",
    "2048",
    "--output-token-limit=128",
    "--api-key",
    "--config",
    "profile=real",
    "--api-key",
    "--token",
    "[redacted]",
    "--api-key",
    "[redacted]",
    "--mode",
    "quick",
    "--api-key",
    "[redacted]",
    "--limit",
    "21",
    "--api-key",
    "[redacted]",
    "--mode",
    "boundary-mode",
    "--api-key",
    "[redacted]",
    "--limit",
    "24",
    "--apiKey",
    "[redacted]",
    "--accessToken",
    "[redacted]",
    "--openai-api-key",
    "[redacted]",
    "--anthropic-api-key",
    "[redacted]",
    "--bearer-token",
    "[redacted]",
    "--password",
    "[redacted]",
    "--secret",
    "[redacted]",
    "--authorization",
    "[redacted]",
    "[redacted]",
    "--authorization=[redacted]",
    "[redacted]",
    "--mode",
    "auth-mode",
    "--auth-token",
    "[redacted]",
    "[redacted]",
    "--auth-token=[redacted]",
    "[redacted]",
    "--mode",
    "auth-token-mode",
    "--auth-token",
    "[redacted]",
    "--token",
    "[redacted]",
    "--auth-token",
    "[redacted]",
    "[redacted]",
    "--mode",
    "dash-auth-mode",
    "--auth-token",
    "[redacted]",
    "--token",
    "--provider-config",
    "--mode",
    "dash-mode",
    "-t",
    "[redacted]",
    "-k=[redacted]",
    "-p",
    "[redacted]",
    "-p[redacted]",
    "-t[redacted]",
    "-k[redacted]",
    "--api-key[redacted]",
    "--token[redacted]",
    "--auth-token[redacted]",
    "--auth-token[redacted]",
    "[redacted]",
    "--api-key=[redacted]",
    "--token=[redacted]",
    "--secret-key",
    "[redacted]",
    "--client-secret-key=[redacted]",
    "secretKey=[redacted]",
    "provider.clientSecretKey=[redacted]",
    "AWS_SECRET_ACCESS_KEY=[redacted]",
    "--config",
    "apiKey=[redacted]",
    "--config",
    "accessKey",
    "[redacted]",
    "--config=apiKey",
    "[redacted]",
    "--config=callbackUrl=https://example.test/cb?api_key=[redacted]&mode=test",
    "--endpoint=https://[redacted]@example.test/v1?model=keep",
    "--provider-config=apiKey",
    "[redacted]",
    "--provider-config=token",
    "[redacted]",
    "--provider-config",
    "awsSecretAccessKey=[redacted]",
    "--provider-config",
    "baseUrl=https://host.test/path?access_token=[redacted];mode=keep",
    "--provider-config",
    "https://example.test/v1?api_key=[redacted]&model=x",
    "--config",
    "https://example.test/cb?password=[redacted]&mode=keep",
    "--config=api_key=[redacted]",
    "--config=systemApiKey=[redacted]",
    "--provider-config",
    '{"apiKey":"[redacted]","systemApiKey":"[redacted]","baseUrl":"https://proxy.test/v1?api_key=[redacted]&model=x","provider":"openai"}',
    "--provider-config",
    '{"headers":{"Cookie":"[redacted]","Authorization":"[redacted]"},"provider":"openai"}',
    "--provider-config",
    '{"privateKey":"[redacted]","provider":"aws"}',
    "--provider-config",
    "{apiKey:[redacted],provider:openai}",
    "--config={authorization:[redacted],model:gpt-test}",
    "provider={credentials:{password:[redacted]},name:openai}",
    "provider=https://[redacted]@example.test/v1?api_key=[redacted]&model=keep",
    '--config={"judge":{"token":"[redacted]"},"model":"gpt-test"}',
    'provider={"credentials":{"password":"[redacted]","accessToken":"[redacted]"},"name":"openai"}',
    "--config",
    "token",
    "[redacted]",
    "--config",
    "authorization=[redacted]",
    "[redacted]",
    "--provider-config",
    "authorization=[redacted]",
    "[redacted]",
    "--config=authorization=[redacted]",
    "[redacted]",
    "--config=auth_token",
    "[redacted]",
    "[redacted]",
    "--config",
    "auth_token",
    "[redacted]",
    "[redacted]",
    "--config",
    "auth_token:[redacted]",
    "[redacted]",
    "[redacted]",
    "--config",
    "Authorization:[redacted]",
    "[redacted]",
    "[redacted]",
    "--limit",
    "25",
    "--config",
    "authorization:[redacted]",
    "[redacted]",
    "[redacted]",
    "--provider-config",
    "authorization:[redacted]",
    "[redacted]",
    "[redacted]",
    "--config",
    "token",
    "[redacted]",
    "--config",
    "openai.apiKey",
    "[redacted]",
    "--config",
    "openai.apiKey:[redacted]",
    "--config=openai.apiKey:[redacted]",
    "--config",
    "refreshToken",
    "[redacted]",
    "--config",
    "--api-key",
    "[redacted]",
    "--header",
    "Authorization",
    "[redacted]",
    "--header",
    "Authorization",
    "[redacted]",
    "[redacted]",
    "--header",
    "Authorization",
    "[redacted]",
    "--limit",
    "16",
    "--header",
    "Authorization",
    "[redacted]",
    "--limit",
    "17",
    "--header",
    "Authorization:[redacted]",
    "[redacted]",
    "[redacted]",
    "--header",
    "Authorization:[redacted]",
    "[redacted]",
    "--limit",
    "14",
    "--config",
    "apiKey:[redacted]",
    "--config",
    "apiKey",
    "[redacted]",
    "--limit",
    "15",
    "authorization:[redacted]",
    "--limit",
    "13",
    "--header",
    "Cookie:[redacted]",
    "--header",
    "Cookie:[redacted]",
    "[redacted]",
    "[redacted]",
    "--limit",
    "11",
    "--header",
    "Authorization=[redacted]",
    "--header",
    "Authorization=[redacted]",
    "[redacted]",
    "--header=Authorization:[redacted]",
    "--header=Authorization:[redacted]",
    "[redacted]",
    "[redacted]",
    "--limit",
    "18",
    "--header=Authorization=[redacted]",
    "[redacted]",
    "--header=Authorization=[redacted]",
    "[redacted]",
    "[redacted]",
    "--limit",
    "19",
    "--header=Authorization",
    "[redacted]",
    "[redacted]",
    "--header=Authorization",
    "[redacted]",
    "--header=Cookie=[redacted]",
    "--header=Cookie:[redacted]",
    "[redacted]",
    "[redacted]",
    "--mode",
    "smoke",
    "--header",
    "Cookie=[redacted]",
    "[redacted]",
    "--limit",
    "12",
    "provider.header=Authorization: [redacted]",
    "authorization=[redacted]",
    "[redacted]",
    "token=[redacted]",
    "[redacted]",
    "authorization",
    "[redacted]",
    "[redacted]",
    "--limit",
    "22",
    "token:[redacted]",
    "access_token:[redacted]",
    "Authorization:[redacted]",
    "--limit",
    "23",
    "--password:[redacted]",
    "--token:[redacted]",
    "--password:[redacted]",
    "token",
    "[redacted]",
    "[redacted]",
    "password",
    "[redacted]",
    "provider.token=[redacted]",
    "provider.name=openai",
    "next-positional",
  ]);
  assert.deepEqual(manifest.command.envKeys, ["OLLAMA_API_KEY", "QMD_CONFIG_DIR"]);
  assert.equal(manifest.datasets[0]?.status, "hashed");
  assert.equal(manifest.datasets[0]?.fileCount, 3);
  assert.ok(manifest.datasets[0]?.sha256);
  assert.equal(manifest.results[0]?.benchmark, "longmemeval");
  assert.equal(manifest.results[0]?.seeds.length, 5);
  assert.deepEqual(manifest.qmd?.collections, ["bench-cold", "bench-conversations", "bench-hot"]);
  assert.ok(/^[0-9a-f]{64}$/.test(manifest.artifactHash));
  assert.doesNotMatch(
    JSON.stringify(manifest),
    /secret-value|other-secret|auth-secret|dash-secret|adjacent-token-secret|sk-live-dash-secret|sk_live_123|tokenlike-secret|camel-api-key-secret|camel-access-token-secret|provider-prefixed-openai-api-secret|provider-prefixed-anthropic-api-secret|provider-prefixed-bearer-token-secret|provider-password-alias-secret|provider-secret-alias-secret|split-authorization-token|assigned-authorization-secret|split-auth-token-secret|assigned-auth-token-secret|short-token-secret|short-key-secret|short-dash-secret|attached-secret|AttachedToken|AttachedKey|sk-live-attached-long-secret|abc-attached-long-secret|BearerAttachedLongSecret|attached-long-auth-continuation-secret|attached-equals-api-secret|attached-equals-token-secret|split-secret-key-value|client-secret-key-value|direct-secret-key-value|nested-client-secret-key-value|aws-secret-access-key-value|sk-test|split-access-key-secret|split-assigned-secret|url-query-secret|argv-url-userinfo-secret|split-provider-assigned-secret|split-provider-token-secret|provider-access-key-secret|url-access-secret|separate-url-secret|url-password-secret|sk-inline|system-camel-secret|sk-live-secret|json-camel-secret|json-url-secret|json-cookie-secret|json-auth-secret|json-private-key-secret|json-private-key-secret|loose-object-api-secret|loose-object-authorization-secret|loose-nested-password-secret|provider-url-userinfo-secret|provider-url-query-secret|judge-secret|nested-secret|access-camel-secret|split-secret|config-assigned-authorization-secret|provider-assigned-authorization-secret|assigned-wrapper-authorization-secret|assigned-config-auth-token-secret|split-config-auth-token-secret|colon-config-auth-token-secret|config-authorization-apikey-secret|config-lower-authorization-bearer-secret|provider-lower-authorization-bearer-secret|namespaced-secret|colon-secret|colon-inline-secret|refresh-camel-secret|dashed-config-secret|header-secret|dash-header-secret|dash-header-name-secret|bearer-secret|Bearer|split-auth-token|dash-auth-token-secret|split-header-secret|dash-bearer-secret|split-colon-secret|split-dash-config-secret|token-value|option-password-secret|option-token-secret|option-password-continuation-secret|cookie-secret|cookie-multipart-secret|auth-equals-secret|split-equals-secret|assigned-colon-header-secret|split-assigned-colon-header-secret|split-assigned-equals-secret|split-assigned-empty-equals-secret|split-assigned-auth-secret|assigned-auth-secret|assigned-cookie-secret|assigned-cookie-multipart-secret|cookie-continuation-secret|generic-header-secret|bare-assigned-authorization-secret|bare-assigned-token-secret|bare-authorization-secret|bare-token-colon-secret|bare-access-token-colon-secret|bare-authorization-colon-secret|bare-token-secret|bare-password-secret|provider-secret/
  );
});

test("result manifest exposes sanitized judge identity and binds rubric changes into artifactHash", async () => {
  const root = await createTempRoot("remnic-repro-judge-identity-");
  const resultsDir = path.join(root, "results");
  await mkdir(resultsDir, { recursive: true });
  const resultPath = path.join(resultsDir, "judge.json");
  const result = buildResult();
  result.config.judgeProvider = {
    provider: "openai",
    model: "gpt-5.6",
    rubricVersion: "rubric-v1",
    apiKey: "must-not-persist",
  };
  await writeFile(resultPath, `${JSON.stringify(result)}\n`, "utf8");
  const first = await buildBenchmarkReproManifest(resultsDir, {
    resultPaths: [resultPath],
    runId: "judge-identity",
    command: { cwd: root, argv: ["bench", "run"] },
  });
  assert.deepEqual(first.results[0]?.judge, {
    provider: "openai",
    model: "gpt-5.6",
    rubricVersion: "rubric-v1",
  });
  assert.doesNotMatch(JSON.stringify(first.results[0]?.judge), /must-not-persist/);

  result.config.judgeProvider.rubricVersion = "rubric-v2";
  await writeFile(resultPath, `${JSON.stringify(result)}\n`, "utf8");
  const second = await buildBenchmarkReproManifest(resultsDir, {
    resultPaths: [resultPath],
    runId: "judge-identity",
    command: { cwd: root, argv: ["bench", "run"] },
  });
  assert.equal(second.results[0]?.judge?.rubricVersion, "rubric-v2");
  assert.notEqual(first.artifactHash, second.artifactHash);
});

test("writeBenchmarkReproManifest writes MANIFEST.json beside results", async () => {
  const root = await createTempRoot("remnic-repro-manifest-write-");
  const resultsDir = path.join(root, "results");
  await mkdir(resultsDir, { recursive: true });
  const resultPath = path.join(resultsDir, "longmemeval.json");
  await writeFile(resultPath, `${JSON.stringify(buildResult(), null, 2)}\n`, "utf8");

  const manifestPath = await writeBenchmarkReproManifest(resultsDir, {
    resultPaths: [resultPath],
    selectedBenchmarks: ["longmemeval"],
  });
  assert.equal(manifestPath, path.join(resultsDir, BENCHMARK_REPRO_MANIFEST_FILENAME));

  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
    results: Array<{ benchmark: string }>;
  };
  assert.equal(manifest.results[0]?.benchmark, "longmemeval");
});

test("manifest binds sanitized Codex local-budget-unit totals and public env-key provenance", async () => {
  const root = await createTempRoot("remnic-repro-codex-credit-");
  const resultsDir = path.join(root, "results");
  const ledgerPath = path.join(root, "private-credit-ledger.json");
  await mkdir(resultsDir, { recursive: true });
  const resultPath = path.join(resultsDir, "longmemeval.json");
  await writeFile(resultPath, `${JSON.stringify(buildResult(), null, 2)}\n`, "utf8");
  await writeFile(
    ledgerPath,
    `${JSON.stringify({
      schemaVersion: 1,
      budgetCredits: 2_473,
      reserveCredits: 473,
      spentCredits: 3.55,
      entries: [
        {
          at: "2026-07-15T00:00:00.000Z",
          model: "gpt-5.6-luna",
          runId: "frontier-smoke",
          credits: 3.55,
          inputTokens: 100_000,
          cachedInputTokens: 20_000,
          outputTokens: 10_000,
          reasoningOutputTokens: 8_000,
        },
      ],
    })}\n`,
    { mode: 0o600 },
  );

  const manifest = await buildBenchmarkReproManifest(resultsDir, {
    resultPaths: [resultPath],
    runId: "frontier-smoke",
    command: {
      cwd: root,
      argv: ["bench", "run", "longmemeval"],
      env: {
        REMNIC_BENCH_CODEX_CREDIT_BUDGET: "2473",
        REMNIC_BENCH_CODEX_CREDIT_RESERVE: "473",
        REMNIC_BENCH_CODEX_CREDIT_LEDGER: ledgerPath,
        REMNIC_BENCH_RUN_ID: "frontier-smoke",
      },
      envKeys: [],
    },
  });

  assert.equal(manifest.codexCredit?.schemaVersion, 2);
  assert.equal(manifest.codexCredit?.plannedSpendCeilingUnits, 2_000);
  assert.equal(manifest.codexCredit?.run?.id, "frontier-smoke");
  assert.equal(manifest.codexCredit?.run?.budgetUnits, 3.55);
  assert.equal(manifest.codexCredit?.run?.accountBalanceResolutionCount, 0);
  assert.equal(manifest.codexCredit?.run?.conservativeResolutionChargeUnits, 0);
  assert.deepEqual(manifest.command.envKeys, [
    "REMNIC_BENCH_CODEX_CREDIT_BUDGET",
    "REMNIC_BENCH_CODEX_CREDIT_LEDGER",
    "REMNIC_BENCH_CODEX_CREDIT_RESERVE",
    "REMNIC_BENCH_RUN_ID",
  ]);
  assert.doesNotMatch(JSON.stringify(manifest), /private-credit-ledger\.json/);
  assert.equal(Object.hasOwn(manifest.codexCredit ?? {}, "budgetCredits"), false);
  assert.equal(Object.hasOwn(manifest.codexCredit ?? {}, "totalRemainingCredits"), false);
  assert.doesNotMatch(
    JSON.stringify(manifest.codexCredit),
    /beforeAccountBalance|afterAccountBalance|observedAccountDebit|blockedReason/,
  );

  const firstArtifactHash = manifest.artifactHash;
  const ledger = JSON.parse(await readFile(ledgerPath, "utf8")) as {
    spentCredits: number;
    entries: Array<Record<string, unknown>>;
  };
  ledger.spentCredits = 7.1;
  ledger.entries.push({ ...ledger.entries[0], at: "2026-07-15T00:01:00.000Z", credits: 3.55 });
  await writeFile(ledgerPath, `${JSON.stringify(ledger)}\n`, { mode: 0o600 });
  const changed = await buildBenchmarkReproManifest(resultsDir, {
    resultPaths: [resultPath],
    runId: "frontier-smoke",
    command: {
      cwd: root,
      argv: ["bench", "run", "longmemeval"],
      env: {
        REMNIC_BENCH_CODEX_CREDIT_BUDGET: "2473",
        REMNIC_BENCH_CODEX_CREDIT_RESERVE: "473",
        REMNIC_BENCH_CODEX_CREDIT_LEDGER: ledgerPath,
        REMNIC_BENCH_RUN_ID: "frontier-smoke",
      },
    },
  });
  assert.notEqual(changed.artifactHash, firstArtifactHash);
});

test("manifest records Codex credit env-key provenance from process.env", async () => {
  const root = await createTempRoot("remnic-repro-codex-process-env-");
  const resultsDir = path.join(root, "results");
  const ledgerPath = path.join(root, "private-credit-ledger.json");
  await mkdir(resultsDir, { recursive: true });
  const resultPath = path.join(resultsDir, "longmemeval.json");
  await writeFile(resultPath, `${JSON.stringify(buildResult(), null, 2)}\n`, "utf8");
  await writeFile(
    ledgerPath,
    `${JSON.stringify({
      schemaVersion: 1,
      budgetCredits: 2_473,
      reserveCredits: 473,
      spentCredits: 0.04,
      entries: [
        {
          at: "2026-07-15T00:00:00.000Z",
          model: "gpt-5.6-luna",
          runId: "process-env-run",
          credits: 0.04,
          inputTokens: 1_000,
          cachedInputTokens: 0,
          outputTokens: 100,
          reasoningOutputTokens: 50,
        },
      ],
    })}\n`,
    { mode: 0o600 },
  );

  const env = {
    REMNIC_BENCH_CODEX_CREDIT_BUDGET: "2473",
    REMNIC_BENCH_CODEX_CREDIT_RESERVE: "473",
    REMNIC_BENCH_CODEX_CREDIT_LEDGER: ledgerPath,
    REMNIC_BENCH_RUN_ID: "conflicting-env-run",
  };
  const previous = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
  Object.assign(process.env, env);
  try {
    const manifest = await buildBenchmarkReproManifest(resultsDir, {
      resultPaths: [resultPath],
      runId: "process-env-run",
      command: { cwd: root, argv: ["bench", "run", "longmemeval"], envKeys: [] },
    });

    assert.deepEqual(manifest.command.envKeys, [
      "REMNIC_BENCH_CODEX_CREDIT_BUDGET",
      "REMNIC_BENCH_CODEX_CREDIT_LEDGER",
      "REMNIC_BENCH_CODEX_CREDIT_RESERVE",
      "REMNIC_BENCH_RUN_ID",
    ]);
    assert.equal(manifest.codexCredit?.run?.id, "process-env-run");
    assert.doesNotMatch(JSON.stringify(manifest), /private-credit-ledger\.json/);
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("budget-configured zero-call runs still produce a manifest before a ledger exists", async () => {
  const root = await createTempRoot("remnic-repro-codex-zero-call-");
  const resultsDir = path.join(root, "results");
  await mkdir(resultsDir, { recursive: true });
  const resultPath = path.join(resultsDir, "longmemeval.json");
  await writeFile(resultPath, `${JSON.stringify(buildResult(), null, 2)}\n`, "utf8");

  const manifest = await buildBenchmarkReproManifest(resultsDir, {
    resultPaths: [resultPath],
    runId: "zero-call-run",
    command: {
      cwd: root,
      argv: ["bench", "run", "longmemeval", "--limit", "0"],
      env: {
        REMNIC_BENCH_CODEX_CREDIT_BUDGET: "2473",
        REMNIC_BENCH_CODEX_CREDIT_RESERVE: "473",
        REMNIC_BENCH_CODEX_CREDIT_LEDGER: path.join(root, "missing-ledger.json"),
      },
    },
  });

  assert.equal(manifest.run.id, "zero-call-run");
  assert.equal(manifest.codexCredit, undefined);
  assert.equal(manifest.command.envKeys.includes("REMNIC_BENCH_CODEX_CREDIT_LEDGER"), true);
});

test("buildBenchmarkReproManifest redacts terminal URL query secrets inside JSON argv", async () => {
  const root = await createTempRoot("remnic-repro-manifest-json-url-redaction-");
  const resultsDir = path.join(root, "results");
  await mkdir(resultsDir, { recursive: true });
  const resultPath = path.join(resultsDir, "longmemeval.json");
  await writeFile(resultPath, `${JSON.stringify(buildResult(), null, 2)}\n`, "utf8");

  const manifest = await buildBenchmarkReproManifest(resultsDir, {
    resultPaths: [resultPath],
    selectedBenchmarks: ["longmemeval"],
    command: {
      cwd: root,
      argv: [
        "--provider-config",
        '{"baseUrl":"https://proxy.test/v1?api_key=json-terminal-url-secret","provider":"openai"}',
      ],
    },
  });

  assert.deepEqual(manifest.command.argv, [
    "--provider-config",
    '{"baseUrl":"https://proxy.test/v1?api_key=[redacted]","provider":"openai"}',
  ]);
  assert.doesNotMatch(JSON.stringify(manifest), /json-terminal-url-secret/);
});

test("buildBenchmarkReproManifest redacts separated URL-valued bench flags", async () => {
  const root = await createTempRoot("remnic-repro-manifest-separated-url-redaction-");
  const resultsDir = path.join(root, "results");
  await mkdir(resultsDir, { recursive: true });
  const resultPath = path.join(resultsDir, "longmemeval.json");
  await writeFile(resultPath, `${JSON.stringify(buildResult(), null, 2)}\n`, "utf8");

  const manifest = await buildBenchmarkReproManifest(resultsDir, {
    resultPaths: [resultPath],
    selectedBenchmarks: ["longmemeval"],
    command: {
      cwd: root,
      argv: [
        "--system-base-url",
        "https://system.test/v1?api_key=system-url-secret&model=keep",
        "--judge-base-url",
        "https://judge.test/v1?access_token=judge-url-secret&model=keep",
        "--internal-base-url",
        "https://internal.test/v1?password=internal-url-secret&model=keep",
        "--base-url",
        "https://published.test/v1?token=published-url-secret&model=keep",
        "--ama-bench-cross-judge-base-url",
        "https://ama.test/v1?client_secret=ama-url-secret&model=keep",
      ],
    },
  });

  assert.deepEqual(manifest.command.argv, [
    "--system-base-url",
    "https://system.test/v1?api_key=[redacted]&model=keep",
    "--judge-base-url",
    "https://judge.test/v1?access_token=[redacted]&model=keep",
    "--internal-base-url",
    "https://internal.test/v1?password=[redacted]&model=keep",
    "--base-url",
    "https://published.test/v1?token=[redacted]&model=keep",
    "--ama-bench-cross-judge-base-url",
    "https://ama.test/v1?client_secret=[redacted]&model=keep",
  ]);
  assert.doesNotMatch(
    JSON.stringify(manifest),
    /system-url-secret|judge-url-secret|internal-url-secret|published-url-secret|ama-url-secret/
  );
});

test("buildBenchmarkReproManifest preserves bench flags after multi-token secrets", async () => {
  const root = await createTempRoot("remnic-repro-manifest-secret-boundaries-");
  const resultsDir = path.join(root, "results");
  await mkdir(resultsDir, { recursive: true });
  const resultPath = path.join(resultsDir, "longmemeval.json");
  await writeFile(resultPath, `${JSON.stringify(buildResult(), null, 2)}\n`, "utf8");

  const manifest = await buildBenchmarkReproManifest(resultsDir, {
    resultPaths: [resultPath],
    selectedBenchmarks: ["longmemeval"],
    command: {
      cwd: root,
      argv: [
        "--header",
        "Authorization",
        "Bearer",
        "header-boundary-secret",
        "--system-model",
        "gpt-5.4",
        "--auth-token",
        "Bearer",
        "auth-token-boundary-secret",
        "--judge-model",
        "claude-opus-4.5",
        "--authorization",
        "Bearer",
        "authorization-boundary-secret",
        "--json",
        "--token",
        "Bearer",
        "token-boundary-secret",
        "--results-dir",
        "results",
        "--header",
        "Cookie=session=cookie-boundary-secret",
        "--out",
        "published-artifacts",
        "--provider",
        "openai",
      ],
    },
  });

  assert.deepEqual(manifest.command.argv, [
    "--header",
    "Authorization",
    "[redacted]",
    "[redacted]",
    "--system-model",
    "gpt-5.4",
    "--auth-token",
    "[redacted]",
    "[redacted]",
    "--judge-model",
    "claude-opus-4.5",
    "--authorization",
    "[redacted]",
    "[redacted]",
    "--json",
    "--token",
    "[redacted]",
    "[redacted]",
    "--results-dir",
    "results",
    "--header",
    "Cookie=[redacted]",
    "--out",
    "published-artifacts",
    "--provider",
    "openai",
  ]);
  assert.doesNotMatch(
    JSON.stringify(manifest),
    /header-boundary-secret|auth-token-boundary-secret|authorization-boundary-secret|token-boundary-secret|cookie-boundary-secret/
  );
});

test("buildBenchmarkReproManifest preserves suffixes after colon-delimited secret values", async () => {
  const root = await createTempRoot("remnic-repro-manifest-colon-suffixes-");
  const resultsDir = path.join(root, "results");
  await mkdir(resultsDir, { recursive: true });
  const resultPath = path.join(resultsDir, "longmemeval.json");
  await writeFile(resultPath, `${JSON.stringify(buildResult(), null, 2)}\n`, "utf8");

  const manifest = await buildBenchmarkReproManifest(resultsDir, {
    resultPaths: [resultPath],
    selectedBenchmarks: ["longmemeval"],
    command: {
      cwd: root,
      argv: [
        "--config=apiKey:sk-live-colon-secret,provider:openai",
        "--provider-config",
        "openai.apiKey:provider-colon-secret,model:gpt-test",
      ],
    },
  });

  assert.deepEqual(manifest.command.argv, [
    "--config=apiKey:[redacted],provider:openai",
    "--provider-config",
    "openai.apiKey:[redacted],model:gpt-test",
  ]);
  assert.doesNotMatch(JSON.stringify(manifest), /sk-live-colon-secret|provider-colon-secret/);
});

test("buildBenchmarkReproManifest redacts every pair in Cookie argv headers", async () => {
  const root = await createTempRoot("remnic-repro-manifest-cookie-pairs-");
  const resultsDir = path.join(root, "results");
  await mkdir(resultsDir, { recursive: true });
  const resultPath = path.join(resultsDir, "longmemeval.json");
  await writeFile(resultPath, `${JSON.stringify(buildResult(), null, 2)}\n`, "utf8");

  const manifest = await buildBenchmarkReproManifest(resultsDir, {
    resultPaths: [resultPath],
    selectedBenchmarks: ["longmemeval"],
    command: {
      cwd: root,
      argv: [
        "--header",
        "Cookie=sid=cookie-sid-secret; csrf=cookie-csrf-secret",
        "--header=Cookie: sid=assigned-cookie-sid-secret; csrf=assigned-cookie-csrf-secret",
      ],
    },
  });

  assert.deepEqual(manifest.command.argv, ["--header", "Cookie=[redacted]", "--header=Cookie:[redacted]"]);
  assert.doesNotMatch(
    JSON.stringify(manifest),
    /cookie-sid-secret|cookie-csrf-secret|assigned-cookie-sid-secret|assigned-cookie-csrf-secret/
  );
});

test("buildBenchmarkReproManifest redacts secret-bearing config file hashes", async () => {
  const root = await createTempRoot("remnic-repro-manifest-config-redaction-");
  const resultsDir = path.join(root, "results");
  await mkdir(resultsDir, { recursive: true });
  const resultPath = path.join(resultsDir, "longmemeval.json");
  await writeFile(resultPath, `${JSON.stringify(buildResult(), null, 2)}\n`, "utf8");
  const secretConfigPath = path.join(root, "secret-config.json");
  const malformedSecretConfigPath = path.join(root, "malformed-secret-config.json");
  const jsonStringSecretConfigPath = path.join(root, "json-string-secret-config.json");
  const tomlSecretConfigPath = path.join(root, "secret-config.toml");
  const urlSecretConfigPath = path.join(root, "url-secret-config.toml");
  const safeConfigPath = path.join(root, "safe-config.json");
  const secretConfig = `${JSON.stringify({ model: "gpt-test", systemApiKey: "config-secret" })}\n`;
  const malformedSecretConfig = '{"systemApiKey":"malformed-config-secret",}\n';
  const jsonStringSecretConfig = `${JSON.stringify({
    model: "gpt-test",
    note: "api_key=json-string-config-secret",
  })}\n`;
  const tomlSecretConfig = '"api_key" = "toml-config-secret"\nmodel = "gpt-test"\n';
  const urlSecretConfig = 'baseUrl = "https://proxy.test/v1?api_key=url-config-secret"\nmodel = "gpt-test"\n';
  const safeConfig = `${JSON.stringify({ model: "gpt-test", temperature: 0 })}\n`;
  await writeFile(secretConfigPath, secretConfig, "utf8");
  await writeFile(malformedSecretConfigPath, malformedSecretConfig, "utf8");
  await writeFile(jsonStringSecretConfigPath, jsonStringSecretConfig, "utf8");
  await writeFile(tomlSecretConfigPath, tomlSecretConfig, "utf8");
  await writeFile(urlSecretConfigPath, urlSecretConfig, "utf8");
  await writeFile(safeConfigPath, safeConfig, "utf8");

  const manifest = await buildBenchmarkReproManifest(resultsDir, {
    resultPaths: [resultPath],
    selectedBenchmarks: ["longmemeval"],
    configFiles: [
      { label: "secret", path: secretConfigPath },
      { label: "malformed-secret", path: malformedSecretConfigPath },
      { label: "json-string-secret", path: jsonStringSecretConfigPath },
      { label: "toml-secret", path: tomlSecretConfigPath },
      { label: "url-secret", path: urlSecretConfigPath },
      { label: "safe", path: safeConfigPath },
    ],
  });

  const secretEntry = manifest.configFiles.find((entry) => entry.label === "secret");
  const malformedSecretEntry = manifest.configFiles.find((entry) => entry.label === "malformed-secret");
  const jsonStringSecretEntry = manifest.configFiles.find((entry) => entry.label === "json-string-secret");
  const tomlSecretEntry = manifest.configFiles.find((entry) => entry.label === "toml-secret");
  const urlSecretEntry = manifest.configFiles.find((entry) => entry.label === "url-secret");
  const safeEntry = manifest.configFiles.find((entry) => entry.label === "safe");
  const rawSecretHash = createHash("sha256").update(secretConfig).digest("hex");
  const rawJsonStringSecretHash = createHash("sha256").update(jsonStringSecretConfig).digest("hex");
  const rawUrlSecretHash = createHash("sha256").update(urlSecretConfig).digest("hex");
  const rawSafeHash = createHash("sha256").update(safeConfig).digest("hex");
  assert.equal(secretEntry?.redacted, true);
  assert.ok(secretEntry?.sha256);
  assert.notEqual(secretEntry?.sha256, rawSecretHash);
  assert.equal(malformedSecretEntry?.redacted, true);
  assert.equal(Object.hasOwn(malformedSecretEntry ?? {}, "sha256"), false);
  assert.equal(jsonStringSecretEntry?.redacted, true);
  assert.ok(jsonStringSecretEntry?.sha256);
  assert.notEqual(jsonStringSecretEntry?.sha256, rawJsonStringSecretHash);
  assert.equal(tomlSecretEntry?.redacted, true);
  assert.equal(Object.hasOwn(tomlSecretEntry ?? {}, "sha256"), false);
  assert.equal(urlSecretEntry?.redacted, true);
  assert.equal(Object.hasOwn(urlSecretEntry ?? {}, "sha256"), false);
  assert.equal(safeEntry?.redacted, undefined);
  assert.equal(safeEntry?.sha256, rawSafeHash);
  assert.doesNotMatch(
    JSON.stringify(manifest),
    new RegExp(
      `config-secret|malformed-config-secret|json-string-config-secret|toml-config-secret|url-config-secret|${rawSecretHash}|${rawJsonStringSecretHash}|${rawUrlSecretHash}`
    )
  );
});

test("buildBenchmarkReproManifest rejects explicit result paths outside resultsDir", async () => {
  const root = await createTempRoot("remnic-repro-manifest-result-containment-");
  const resultsDir = path.join(root, "results");
  const outsideDir = path.join(root, "outside");
  await mkdir(resultsDir, { recursive: true });
  await mkdir(outsideDir, { recursive: true });
  const outsideResultPath = path.join(outsideDir, "longmemeval.json");
  await writeFile(outsideResultPath, `${JSON.stringify(buildResult(), null, 2)}\n`, "utf8");

  await assert.rejects(
    () =>
      buildBenchmarkReproManifest(resultsDir, {
        resultPaths: [outsideResultPath],
      }),
    /result path must be inside/
  );
});

test("buildBenchmarkReproManifest rejects outside result paths when resultsDir is relative", async () => {
  const root = await createTempRoot("remnic-repro-manifest-relative-result-containment-");
  const resultsDir = path.join(root, "results");
  const outsideDir = path.join(root, "outside");
  await mkdir(resultsDir, { recursive: true });
  await mkdir(outsideDir, { recursive: true });
  const outsideResultPath = path.join(outsideDir, "longmemeval.json");
  await writeFile(outsideResultPath, `${JSON.stringify(buildResult(), null, 2)}\n`, "utf8");

  const previousCwd = process.cwd();
  try {
    process.chdir(root);
    await assert.rejects(
      () =>
        buildBenchmarkReproManifest("results", {
          resultPaths: [outsideResultPath],
        }),
      /result path must be inside/
    );
  } finally {
    process.chdir(previousCwd);
  }
});

test("buildBenchmarkReproManifest rejects explicit result paths that are symlinks", async () => {
  const root = await createTempRoot("remnic-repro-manifest-result-link-containment-");
  const resultsDir = path.join(root, "results");
  const outsideDir = path.join(root, "outside");
  await mkdir(resultsDir, { recursive: true });
  await mkdir(outsideDir, { recursive: true });
  const outsideResultPath = path.join(outsideDir, "longmemeval.json");
  const linkedResultPath = path.join(resultsDir, "linked.json");
  await writeFile(outsideResultPath, `${JSON.stringify(buildResult(), null, 2)}\n`, "utf8");
  await symlink(outsideResultPath, linkedResultPath);

  await assert.rejects(
    () =>
      buildBenchmarkReproManifest(resultsDir, {
        resultPaths: [linkedResultPath],
      }),
    /result path must be a regular file without symlink components/
  );
});

test("buildBenchmarkReproManifest accepts contained result filenames starting with dots", async () => {
  const root = await createTempRoot("remnic-repro-manifest-result-dotfile-");
  const resultsDir = path.join(root, "results");
  await mkdir(resultsDir, { recursive: true });
  const resultPath = path.join(resultsDir, "..valid.json");
  await writeFile(resultPath, `${JSON.stringify(buildResult(), null, 2)}\n`, "utf8");

  const manifest = await buildBenchmarkReproManifest(resultsDir, {
    resultPaths: [resultPath],
  });

  assert.equal(manifest.results[0]?.path, "..valid.json");
});

test("artifact hash ignores volatile host metadata but binds run id", async () => {
  const firstRoot = await createTempRoot("remnic-repro-manifest-stable-a-");
  const secondRoot = await createTempRoot("remnic-repro-manifest-stable-b-");
  const firstResultsDir = path.join(firstRoot, "results");
  const secondResultsDir = path.join(secondRoot, "results");
  await mkdir(firstResultsDir, { recursive: true });
  await mkdir(secondResultsDir, { recursive: true });

  const resultJson = `${JSON.stringify(buildResult(), null, 2)}\n`;
  const firstResultPath = path.join(firstResultsDir, "longmemeval.json");
  const secondResultPath = path.join(secondResultsDir, "longmemeval.json");
  await writeFile(firstResultPath, resultJson, "utf8");
  await writeFile(secondResultPath, resultJson, "utf8");

  const firstManifest = await buildBenchmarkReproManifest(firstResultsDir, {
    resultPaths: [firstResultPath],
    runId: "stable-run",
    selectedBenchmarks: ["longmemeval"],
    command: { cwd: firstRoot, argv: ["bench", "run", "longmemeval"] },
  });
  const secondManifest = await buildBenchmarkReproManifest(secondResultsDir, {
    resultPaths: [secondResultPath],
    runId: "stable-run",
    selectedBenchmarks: ["longmemeval"],
    command: { cwd: secondRoot, argv: ["bench", "run", "longmemeval"] },
  });
  const tamperedRunManifest = await buildBenchmarkReproManifest(firstResultsDir, {
    resultPaths: [firstResultPath],
    runId: "borrowed-run",
    selectedBenchmarks: ["longmemeval"],
    command: { cwd: firstRoot, argv: ["bench", "run", "longmemeval"] },
  });

  assert.notEqual(firstManifest.command.cwd, secondManifest.command.cwd);
  assert.equal(firstManifest.run.id, secondManifest.run.id);
  assert.equal(firstManifest.artifactHash, secondManifest.artifactHash);
  assert.notEqual(firstManifest.run.id, tamperedRunManifest.run.id);
  assert.notEqual(firstManifest.artifactHash, tamperedRunManifest.artifactHash);
});

test("buildBenchmarkReproManifest rejects symlinked dataset roots", async () => {
  const root = await createTempRoot("remnic-repro-manifest-root-link-");
  const resultsDir = path.join(root, "results");
  const datasetDir = path.join(root, "dataset");
  const linkedDatasetDir = path.join(root, "linked-dataset");
  await mkdir(resultsDir, { recursive: true });
  await mkdir(datasetDir, { recursive: true });
  await writeFile(path.join(datasetDir, "answers.json"), JSON.stringify({ answer: 42 }), "utf8");
  await symlink(datasetDir, linkedDatasetDir);
  const resultPath = path.join(resultsDir, "longmemeval.json");
  await writeFile(resultPath, `${JSON.stringify(buildResult(), null, 2)}\n`, "utf8");

  const manifest = await buildBenchmarkReproManifest(resultsDir, {
    resultPaths: [resultPath],
    selectedBenchmarks: ["longmemeval"],
    datasetDirs: { longmemeval: `${linkedDatasetDir}${path.sep}` },
  });

  assert.equal(manifest.datasets[0]?.status, "missing");
  assert.equal(manifest.datasets[0]?.fileCount, 0);
  assert.equal(manifest.datasets[0]?.sha256, undefined);
});

test("buildBenchmarkReproManifest rejects symlinked dataset ancestors", async () => {
  const root = await createTempRoot("remnic-repro-manifest-parent-link-");
  const resultsDir = path.join(root, "results");
  const parentDir = path.join(root, "parent");
  const datasetDir = path.join(parentDir, "dataset");
  const linkedParentDir = path.join(root, "linked-parent");
  await mkdir(resultsDir, { recursive: true });
  await mkdir(datasetDir, { recursive: true });
  await writeFile(path.join(datasetDir, "answers.json"), JSON.stringify({ answer: 42 }), "utf8");
  await symlink(parentDir, linkedParentDir);
  const resultPath = path.join(resultsDir, "longmemeval.json");
  await writeFile(resultPath, `${JSON.stringify(buildResult(), null, 2)}\n`, "utf8");

  const manifest = await buildBenchmarkReproManifest(resultsDir, {
    resultPaths: [resultPath],
    selectedBenchmarks: ["longmemeval"],
    datasetDirs: { longmemeval: path.join(linkedParentDir, "dataset") },
  });

  assert.equal(manifest.datasets[0]?.status, "missing");
  assert.equal(manifest.datasets[0]?.fileCount, 0);
  assert.equal(manifest.datasets[0]?.sha256, undefined);
});

test("buildBenchmarkReproManifest rejects dataset symlinks outside the dataset root", async () => {
  const root = await createTempRoot("remnic-repro-manifest-dataset-external-link-");
  const resultsDir = path.join(root, "results");
  const datasetDir = path.join(root, "dataset");
  const outsideDir = path.join(root, "outside");
  await mkdir(resultsDir, { recursive: true });
  await mkdir(datasetDir, { recursive: true });
  await mkdir(outsideDir, { recursive: true });
  await writeFile(path.join(outsideDir, "secret-notes.txt"), "outside dataset\n", "utf8");
  await symlink(path.join(outsideDir, "secret-notes.txt"), path.join(datasetDir, "outside-link.txt"));
  const resultPath = path.join(resultsDir, "longmemeval.json");
  await writeFile(resultPath, `${JSON.stringify(buildResult(), null, 2)}\n`, "utf8");

  await assert.rejects(
    () =>
      buildBenchmarkReproManifest(resultsDir, {
        resultPaths: [resultPath],
        selectedBenchmarks: ["longmemeval"],
        datasetDirs: { longmemeval: datasetDir },
      }),
    /dataset symlink target must be inside/
  );
});

test("buildBenchmarkReproManifest preserves explicitly empty result paths", async () => {
  const root = await createTempRoot("remnic-repro-manifest-empty-results-");
  const resultsDir = path.join(root, "results");
  await mkdir(resultsDir, { recursive: true });
  await writeFile(path.join(resultsDir, "longmemeval.json"), `${JSON.stringify(buildResult(), null, 2)}\n`, "utf8");

  const manifest = await buildBenchmarkReproManifest(resultsDir, {
    resultPaths: [],
  });

  assert.deepEqual(manifest.results, []);
  assert.deepEqual(manifest.run.selectedBenchmarks, []);
});

test("buildBenchmarkReproManifest preserves uneven benchmark/profile work pairings", async () => {
  const root = await createTempRoot("remnic-repro-manifest-work-items-");
  const resultsDir = path.join(root, "results");
  await mkdir(resultsDir, { recursive: true });
  const resultPath = path.join(resultsDir, "longmemeval.json");
  await writeFile(resultPath, `${JSON.stringify(buildResult(), null, 2)}\n`, "utf8");

  const manifest = await buildBenchmarkReproManifest(resultsDir, {
    resultPaths: [resultPath],
    selectedBenchmarks: ["longmemeval", "locomo"],
    runtimeProfiles: ["real", "baseline"],
    selectedWorkItems: [
      { benchmark: "longmemeval", runtimeProfile: "real" },
      { benchmark: "locomo", runtimeProfile: "baseline" },
    ],
  });

  assert.deepEqual(manifest.run.selectedBenchmarks, ["longmemeval", "locomo"]);
  assert.deepEqual(manifest.run.runtimeProfiles, ["real", "baseline"]);
  assert.deepEqual(manifest.run.selectedWorkItems, [
    { benchmark: "longmemeval", runtimeProfile: "real" },
    { benchmark: "locomo", runtimeProfile: "baseline" },
  ]);
});

test("supplemental inventory is contained, deduplicated, sorted, hashed, and covered by artifactHash", async () => {
  const root = await createTempRoot("remnic-repro-supplemental-");
  const resultsDir = path.join(root, "results");
  const checkpointsDir = path.join(resultsDir, "checkpoints");
  await mkdir(checkpointsDir, { recursive: true });
  const resultPath = path.join(resultsDir, "result.json");
  const episodesPath = path.join(resultsDir, "episodes.jsonl");
  const statisticsPath = path.join(resultsDir, "statistics.json");
  const checkpointPath = path.join(checkpointsDir, "row.json");
  await writeFile(resultPath, `${JSON.stringify(buildResult())}\n`, "utf8");
  await writeFile(episodesPath, "{\"row\":1}\n", "utf8");
  await writeFile(statisticsPath, "{\"draws\":10000}\n", "utf8");
  await writeFile(checkpointPath, "{\"terminal\":true}\n", "utf8");

  const options = {
    resultPaths: [resultPath],
    selectedBenchmarks: ["longmemeval"],
    command: { cwd: root, argv: [] },
    supplementalArtifactPaths: [
      statisticsPath,
      checkpointPath,
      episodesPath,
      statisticsPath,
    ],
  };
  const first = await buildBenchmarkReproManifest(resultsDir, options);
  assert.deepEqual(
    first.supplementalArtifacts?.map((entry) => entry.path),
    ["checkpoints/row.json", "episodes.jsonl", "statistics.json"]
  );
  assert.deepEqual(
    first.supplementalArtifacts?.map((entry) => entry.sizeBytes),
    [18, 10, 16]
  );
  assert.deepEqual(
    first.supplementalArtifacts?.map((entry) => entry.sha256),
    [checkpointPath, episodesPath, statisticsPath].map((filePath) =>
      createHash("sha256").update(
        filePath === checkpointPath
          ? "{\"terminal\":true}\n"
          : filePath === episodesPath
            ? "{\"row\":1}\n"
            : "{\"draws\":10000}\n"
      ).digest("hex")
    )
  );

  await writeFile(statisticsPath, "{\"draws\":9999}\n", "utf8");
  const changed = await buildBenchmarkReproManifest(resultsDir, options);
  assert.notEqual(changed.artifactHash, first.artifactHash);
  assert.equal(
    changed.artifactHash,
    computeBenchmarkReproManifestArtifactHash(
      (({ artifactHash: _artifactHash, ...withoutHash }) => withoutHash)(changed)
    )
  );
});

test("new manifests always emit an explicit supplemental artifact array", async () => {
  const root = await createTempRoot("remnic-repro-supplemental-empty-");
  const resultsDir = path.join(root, "results");
  await mkdir(resultsDir, { recursive: true });
  const resultPath = path.join(resultsDir, "result.json");
  await writeFile(resultPath, `${JSON.stringify(buildResult())}\n`, "utf8");
  const manifest = await buildBenchmarkReproManifest(resultsDir, {
    resultPaths: [resultPath],
    selectedBenchmarks: ["longmemeval"],
    command: { cwd: root, argv: [] },
    supplementalArtifactPaths: [],
  });
  assert.deepEqual(manifest.supplementalArtifacts, []);
});

test("supplemental artifacts reject outside paths, directories, symlinks, collisions, and self-reference", async () => {
  const root = await createTempRoot("remnic-repro-supplemental-reject-");
  const resultsDir = path.join(root, "results");
  await mkdir(path.join(resultsDir, "real-dir"), { recursive: true });
  const resultPath = path.join(resultsDir, "result.json");
  const regularPath = path.join(resultsDir, "real-dir", "artifact.json");
  const outsidePath = path.join(root, "outside.json");
  await writeFile(resultPath, `${JSON.stringify(buildResult())}\n`, "utf8");
  await writeFile(regularPath, "{}\n", "utf8");
  await writeFile(outsidePath, "{}\n", "utf8");
  await symlink(regularPath, path.join(resultsDir, "leaf-link.json"));
  await symlink(path.join(resultsDir, "real-dir"), path.join(resultsDir, "ancestor-link"));
  await writeFile(path.join(resultsDir, BENCHMARK_REPRO_MANIFEST_FILENAME), "{}\n", "utf8");
  const base = {
    resultPaths: [resultPath],
    selectedBenchmarks: ["longmemeval"],
    command: { cwd: root, argv: [] },
  };
  await assert.rejects(
    () => buildBenchmarkReproManifest(resultsDir, { ...base, supplementalArtifactPaths: [outsidePath] }),
    /outside/
  );
  await assert.rejects(
    () => buildBenchmarkReproManifest(resultsDir, { ...base, supplementalArtifactPaths: [path.join(resultsDir, "real-dir")] }),
    /regular file/
  );
  await assert.rejects(
    () => buildBenchmarkReproManifest(resultsDir, { ...base, supplementalArtifactPaths: [path.join(resultsDir, "leaf-link.json")] }),
    /symlink/
  );
  await assert.rejects(
    () => buildBenchmarkReproManifest(resultsDir, { ...base, supplementalArtifactPaths: [path.join(resultsDir, "ancestor-link", "artifact.json")] }),
    /symlink/
  );
  await assert.rejects(
    () => buildBenchmarkReproManifest(resultsDir, { ...base, supplementalArtifactPaths: [resultPath] }),
    /already listed under results/
  );
  await assert.rejects(
    () => buildBenchmarkReproManifest(resultsDir, {
      ...base,
      supplementalArtifactPaths: [path.join(resultsDir, BENCHMARK_REPRO_MANIFEST_FILENAME)],
    }),
    /cannot be MANIFEST.json/
  );
});

test("v1 artifact hashes remain compatible when supplementalArtifacts is absent", async () => {
  const root = await createTempRoot("remnic-repro-v1-compatible-");
  const resultsDir = path.join(root, "results");
  await mkdir(resultsDir, { recursive: true });
  const resultPath = path.join(resultsDir, "result.json");
  await writeFile(resultPath, `${JSON.stringify(buildResult())}\n`, "utf8");
  const current = await buildBenchmarkReproManifest(resultsDir, {
    resultPaths: [resultPath],
    selectedBenchmarks: ["longmemeval"],
    command: { cwd: root, argv: [] },
  });
  const { artifactHash: _artifactHash, supplementalArtifacts: _supplemental, ...withoutVolatile } = current;
  const v1 = { ...withoutVolatile, schemaVersion: 1 };
  const oldIdentity = {
    schemaVersion: v1.schemaVersion,
    run: v1.run,
    git: { commit: v1.git.commit, shortCommit: v1.git.shortCommit },
    command: { argv: v1.command.argv, envKeys: v1.command.envKeys },
    environment: {
      platform: v1.environment.platform,
      arch: v1.environment.arch,
      nodeVersion: v1.environment.nodeVersion,
      ...(v1.environment.packageManager ? { packageManager: v1.environment.packageManager } : {}),
    },
    ...(v1.qmd ? { qmd: v1.qmd } : {}),
    configFiles: v1.configFiles,
    datasets: v1.datasets,
    results: v1.results,
    ...(v1.codexCredit ? { codexCredit: v1.codexCredit } : {}),
  };
  const stable = (value: unknown): string => {
    if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
    if (value && typeof value === "object") {
      return `{${Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => `${JSON.stringify(key)}:${stable(entry)}`)
        .join(",")}}`;
    }
    return JSON.stringify(value) ?? "null";
  };
  const legacyHash = createHash("sha256").update(stable(oldIdentity)).digest("hex");
  assert.equal(
    computeBenchmarkReproManifestArtifactHash(v1),
    legacyHash
  );
});

test("schema-v2 manifest writer publishes atomically without leaving temp files", async () => {
  const root = await createTempRoot("remnic-repro-v2-atomic-");
  const resultsDir = path.join(root, "results");
  await mkdir(resultsDir, { recursive: true });
  const resultPath = path.join(resultsDir, "result.json");
  await writeFile(resultPath, `${JSON.stringify(buildResult())}\n`, "utf8");
  await writeFile(path.join(resultsDir, BENCHMARK_REPRO_MANIFEST_FILENAME), "{\"schemaVersion\":1}\n", "utf8");
  const manifestPath = await writeBenchmarkReproManifest(resultsDir, {
    resultPaths: [resultPath],
    selectedBenchmarks: ["longmemeval"],
    command: { cwd: root, argv: [] },
    supplementalArtifactPaths: [],
  });
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  assert.equal(manifest.schemaVersion, 2);
  assert.deepEqual(manifest.supplementalArtifacts, []);
  assert.deepEqual((await readdir(resultsDir)).filter((name) => name.endsWith(".tmp")), []);
});
