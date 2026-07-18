import { randomBytes } from "node:crypto";
import { type Server, createServer } from "node:http";

import { EngramAccessHttpServer, EngramAccessService, Orchestrator, parseConfig } from "@remnic/core";

import {
  RELAY_AGENT_PRINCIPAL,
  RELAY_NAMESPACE,
  RELAY_OPERATOR_PRINCIPAL,
  RELAY_QUERY,
  RELAY_RECALL_DISCLOSURE,
  RELAY_RECALL_MODE,
  RELAY_RECALL_TAGS,
  RELAY_RECALL_TAG_MATCH,
  RELAY_RECALL_TOP_K,
  type RelayProbeSessionKey,
  type RelayResolverOutput,
} from "./contracts.js";

interface ResolverBridge {
  origin: string;
  setCorrectionResponse(response: string): void;
  getRequestCount(): number;
  stop(): Promise<void>;
}

async function listen(server: Server): Promise<{ host: string; port: number }> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Relay loopback server did not expose a TCP port");
  return { host: address.address, port: address.port };
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
    server.closeAllConnections?.();
  });
}

async function startResolverBridge(): Promise<ResolverBridge> {
  let correctionResponse: string | undefined;
  let requestCount = 0;
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    response.setHeader("content-type", "application/json");
    if (request.method === "GET" && (url.pathname === "/" || url.pathname === "/health")) {
      response.end(JSON.stringify({ status: "ok" }));
      return;
    }
    if (request.method === "GET" && url.pathname === "/v1/models") {
      response.end(JSON.stringify({ data: [{ id: "relay-resolver-output", owned_by: "llamacpp" }] }));
      return;
    }
    if (request.method === "POST" && url.pathname === "/v1/chat/completions") {
      requestCount += 1;
      if (!correctionResponse) {
        response.statusCode = 503;
        response.end(JSON.stringify({ error: { message: "Relay Resolver output is not approved for planning" } }));
        return;
      }
      response.end(
        JSON.stringify({
          choices: [{ message: { content: correctionResponse } }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        })
      );
      return;
    }
    response.statusCode = 404;
    response.end(JSON.stringify({ error: { message: "not found" } }));
  });
  const address = await listen(server);
  return {
    origin: `http://127.0.0.1:${address.port}`,
    setCorrectionResponse(value) {
      correctionResponse = value;
    },
    getRequestCount: () => requestCount,
    stop: () => closeServer(server),
  };
}

function createRelayConfig(memoryDir: string, resolverBridgeOrigin: string) {
  return parseConfig({
    memoryDir,
    workspaceDir: `${memoryDir}/workspace`,
    openaiApiKey: false,
    qmdEnabled: false,
    queryAwareIndexingEnabled: false,
    embeddingFallbackEnabled: false,
    transcriptEnabled: false,
    hourlySummariesEnabled: false,
    knowledgeIndexEnabled: false,
    compoundingInjectEnabled: false,
    memoryBoxesEnabled: false,
    temporalMemoryTreeEnabled: false,
    injectQuestions: false,
    recallDirectAnswerEnabled: false,
    localLlmEnabled: true,
    localLlmUrl: resolverBridgeOrigin,
    localLlmModel: "relay-resolver-output",
    localLlmTimeoutMs: 5_000,
    localLlmRetry5xxCount: 0,
    localLlmFallback: false,
    namespacesEnabled: true,
    defaultNamespace: RELAY_NAMESPACE,
    sharedNamespace: RELAY_NAMESPACE,
    defaultRecallNamespaces: ["self"],
    principalFromSessionKeyMode: "none",
    namespacePolicies: [
      {
        name: RELAY_NAMESPACE,
        readPrincipals: [RELAY_OPERATOR_PRINCIPAL, RELAY_AGENT_PRINCIPAL],
        writePrincipals: [RELAY_OPERATOR_PRINCIPAL],
      },
    ],
    correction: {
      enabled: true,
      applyRequiresConfirm: true,
      maxAffected: 2,
      planTtlHours: 1,
    },
    recallOuterTimeoutMs: 10_000,
  });
}

export interface RelayCorrectionResult {
  plan: Awaited<ReturnType<EngramAccessService["correctionPlan"]>>;
  outcome: Awaited<ReturnType<EngramAccessService["correctionApply"]>>;
  replacementMemoryId: string;
  staleMemoryStatus: string | undefined;
  recall: Awaited<ReturnType<EngramAccessService["recall"]>>;
  resolverBridgeRequests: number;
}

export interface RelayMcpRecallProof {
  query: typeof RELAY_QUERY;
  namespace: typeof RELAY_NAMESPACE;
  sessionKey: RelayProbeSessionKey;
  memoryIds: [string];
  count: 1;
  plannerMode: typeof RELAY_RECALL_MODE;
  disclosure: typeof RELAY_RECALL_DISCLOSURE;
}

export interface RelayRemnicHarness {
  orchestrator: Orchestrator;
  service: EngramAccessService;
  accessServer: EngramAccessHttpServer;
  mcpUrl: string;
  mcpToken: string;
  seedStaleDecision(): Promise<string>;
  proveMcpRecall(expectedMemoryId: string, sessionKey: RelayProbeSessionKey): Promise<RelayMcpRecallProof>;
  applyResolverCorrection(
    resolver: RelayResolverOutput,
    staleMemoryId: string,
    operatorPrincipal: string
  ): Promise<RelayCorrectionResult>;
  stop(): Promise<void>;
}

export async function startRelayRemnicHarness(memoryDir: string): Promise<RelayRemnicHarness> {
  const resolverBridge = await startResolverBridge();
  const orchestrator = new Orchestrator(createRelayConfig(memoryDir, resolverBridge.origin));
  await orchestrator.initialize();
  const service = new EngramAccessService(orchestrator);
  const mcpToken = randomBytes(32).toString("base64url");
  const accessServer = new EngramAccessHttpServer({
    service,
    host: "127.0.0.1",
    port: 0,
    principal: RELAY_AGENT_PRINCIPAL,
    authTokenEntriesGetter: () => [
      {
        token: mcpToken,
        connector: "relay-codex",
        capabilities: { version: 1, ops: ["recall"], namespaces: [RELAY_NAMESPACE] },
      },
    ],
    tokenPathPolicy: (connector, pathname) => connector === "relay-codex" && pathname === "/mcp",
    adminConsoleEnabled: false,
    citationsEnabled: true,
    citationsAutoDetect: true,
    emitLegacyTools: false,
    enableAdapters: false,
  });
  const status = await accessServer.start();
  const mcpUrl = `http://127.0.0.1:${status.port}/mcp`;

  return {
    orchestrator,
    service,
    accessServer,
    mcpToken,
    mcpUrl,
    async seedStaleDecision() {
      const result = await service.memoryStore({
        schemaVersion: 1,
        sessionKey: "relay:seed-stale-decision",
        authenticatedPrincipal: RELAY_OPERATOR_PRINCIPAL,
        namespace: RELAY_NAMESPACE,
        content:
          "Decision: Checkout token retry policy must mint a new checkout token for every request and every retry.",
        category: "decision",
        confidence: 0.96,
        tags: ["remnic-relay", "checkout", "token-policy", "stale-decision"],
        sourceReason: "relay-build-week:synthetic-stale-project-decision",
      });
      if (result.status !== "stored" || !result.memoryId) {
        throw new Error(`Relay failed to seed one unique stale decision (status ${result.status})`);
      }
      return result.memoryId;
    },
    async proveMcpRecall(expectedMemoryId, sessionKey) {
      const proof = await callRelayMcpRecall(mcpUrl, mcpToken, sessionKey);
      if (proof.memoryIds[0] !== expectedMemoryId) {
        throw new Error(
          `Relay MCP proof returned ${proof.memoryIds[0]} instead of expected active memory ${expectedMemoryId}`
        );
      }
      return proof;
    },
    async applyResolverCorrection(resolver, staleMemoryId, operatorPrincipal) {
      if (operatorPrincipal !== RELAY_OPERATOR_PRINCIPAL) {
        throw new Error("Relay correction operator does not match the isolated namespace principal");
      }
      resolverBridge.setCorrectionResponse(
        JSON.stringify({
          classification: "outdated",
          confidence: resolver.confidence,
          actions: [
            {
              kind: "supersede",
              loserId: staleMemoryId,
              replacement: {
                content: `Decision: Checkout token retry policy — ${resolver.replacement_decision}`,
                category: "decision",
                confidence: resolver.confidence,
                tags: ["remnic-relay", "checkout", "token-policy", "approved-correction"],
              },
            },
          ],
          relevance: [{ memoryId: staleMemoryId, why: "Resolver identified this decision as outdated" }],
        })
      );
      const plan = await service.correctionPlan({
        text: resolver.replacement_decision,
        targetIds: [staleMemoryId],
        sessionKey: "relay:correction-plan",
        principal: operatorPrincipal,
        namespace: RELAY_NAMESPACE,
      });
      if (
        plan.actions.length !== 1 ||
        plan.actions[0]?.kind !== "supersede" ||
        plan.actions[0].loserId !== staleMemoryId
      ) {
        throw new Error("Relay Correction Contract did not produce the expected bounded supersession plan");
      }
      const outcome = await service.correctionApply(plan.planId, {
        confirm: true,
        namespace: RELAY_NAMESPACE,
        sessionKey: "relay:correction-apply",
        principal: operatorPrincipal,
      });
      const replacement = outcome.results.find(
        (result) => result.status === "applied" && result.action.kind === "supersede" && result.memoryId
      );
      if (!replacement?.memoryId) throw new Error("Relay correction did not persist an active replacement memory");
      const storage = await orchestrator.getStorage(RELAY_NAMESPACE);
      const staleMemory = await storage.getMemoryById(staleMemoryId);
      const recall = await service.recall({
        query: RELAY_QUERY,
        namespace: RELAY_NAMESPACE,
        sessionKey: "relay:post-correction-proof",
        authenticatedPrincipal: RELAY_AGENT_PRINCIPAL,
        mode: RELAY_RECALL_MODE,
        disclosure: RELAY_RECALL_DISCLOSURE,
        topK: RELAY_RECALL_TOP_K,
        tags: [...RELAY_RECALL_TAGS],
        tagMatch: RELAY_RECALL_TAG_MATCH,
      });
      if (!recall.memoryIds.includes(replacement.memoryId) || recall.memoryIds.includes(staleMemoryId)) {
        throw new Error("Relay correction propagation proof did not return only the active replacement decision");
      }
      return {
        plan,
        outcome,
        replacementMemoryId: replacement.memoryId,
        staleMemoryStatus: staleMemory?.frontmatter.status,
        recall,
        resolverBridgeRequests: resolverBridge.getRequestCount(),
      };
    },
    async stop() {
      await accessServer.stop().catch(() => undefined);
      await orchestrator.destroy().catch(() => undefined);
      await resolverBridge.stop().catch(() => undefined);
    },
  };
}

async function initializeRelayMcp(mcpUrl: string, mcpToken: string) {
  const headers = { authorization: `Bearer ${mcpToken}`, "content-type": "application/json" };
  const initialized = await fetch(mcpUrl, {
    method: "POST",
    headers,
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "remnic-relay-preflight", version: "1.0.0" },
      },
    }),
  });
  if (!initialized.ok) throw new Error(`Relay MCP initialize failed with HTTP ${initialized.status}`);
  const sessionId = initialized.headers.get("mcp-session-id");
  if (!sessionId) throw new Error("Relay MCP initialize omitted the session id");
  return {
    headers: { ...headers, "mcp-session-id": sessionId, "mcp-protocol-version": "2025-06-18" },
  };
}

export async function callRelayMcpRecall(
  mcpUrl: string,
  mcpToken: string,
  sessionKey: RelayProbeSessionKey
): Promise<RelayMcpRecallProof> {
  const session = await initializeRelayMcp(mcpUrl, mcpToken);
  const called = await fetch(mcpUrl, {
    method: "POST",
    headers: session.headers,
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: {
        name: "remnic.recall",
        arguments: {
          query: RELAY_QUERY,
          namespace: RELAY_NAMESPACE,
          sessionKey,
          mode: RELAY_RECALL_MODE,
          topK: RELAY_RECALL_TOP_K,
          disclosure: RELAY_RECALL_DISCLOSURE,
          tags: RELAY_RECALL_TAGS,
          tagMatch: RELAY_RECALL_TAG_MATCH,
        },
      },
    }),
  });
  if (!called.ok) throw new Error(`Relay MCP tools/call failed with HTTP ${called.status}`);
  const payload = (await called.json()) as {
    error?: unknown;
    result?: { isError?: unknown; structuredContent?: unknown };
  };
  if (payload.error || payload.result?.isError === true) {
    throw new Error("Relay MCP recall proof returned a JSON-RPC or tool error");
  }
  const structured = payload.result?.structuredContent;
  if (!structured || typeof structured !== "object" || Array.isArray(structured)) {
    throw new Error("Relay MCP recall proof omitted structured content");
  }
  const result = structured as Record<string, unknown>;
  const memoryIds = result.memoryIds;
  const results = result.results;
  if (
    result.query !== RELAY_QUERY ||
    result.namespace !== RELAY_NAMESPACE ||
    result.sessionKey !== sessionKey ||
    result.count !== 1 ||
    result.plannerMode !== RELAY_RECALL_MODE ||
    result.disclosure !== RELAY_RECALL_DISCLOSURE ||
    !Array.isArray(memoryIds) ||
    memoryIds.length !== 1 ||
    typeof memoryIds[0] !== "string" ||
    !Array.isArray(results) ||
    results.length !== 1 ||
    !results[0] ||
    typeof results[0] !== "object" ||
    Array.isArray(results[0]) ||
    (results[0] as Record<string, unknown>).id !== memoryIds[0] ||
    (results[0] as Record<string, unknown>).status !== "active" ||
    (results[0] as Record<string, unknown>).category !== "decision"
  ) {
    throw new Error("Relay MCP recall proof did not return exactly one active decision");
  }
  return {
    query: RELAY_QUERY,
    namespace: RELAY_NAMESPACE,
    sessionKey,
    memoryIds: [memoryIds[0]],
    count: 1,
    plannerMode: RELAY_RECALL_MODE,
    disclosure: RELAY_RECALL_DISCLOSURE,
  };
}

export async function listRelayMcpTools(mcpUrl: string, mcpToken: string): Promise<string[]> {
  const session = await initializeRelayMcp(mcpUrl, mcpToken);
  const listed = await fetch(mcpUrl, {
    method: "POST",
    headers: session.headers,
    body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
  });
  if (!listed.ok) throw new Error(`Relay MCP tools/list failed with HTTP ${listed.status}`);
  const payload = (await listed.json()) as { result?: { tools?: Array<{ name?: unknown }> } };
  return (payload.result?.tools ?? [])
    .map((tool) => tool.name)
    .filter((name): name is string => typeof name === "string")
    .sort();
}
