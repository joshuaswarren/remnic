import assert from "node:assert/strict";
import test from "node:test";
import os from "node:os";
import path from "node:path";
import { mkdtemp, readFile, rm } from "node:fs/promises";

import { parseConfig } from "./config.js";
import {
  builtInLiveConnectorDefinitions,
  runLiveConnectorsOnce,
} from "./live-connectors-runner.js";
import {
  GOOGLE_DRIVE_CONNECTOR_ID,
  NOTION_CONNECTOR_ID,
  createGoogleDriveConnector,
  type GoogleDriveClient,
} from "./connectors/live/index.js";
import type { LiveConnector } from "./connectors/live/framework.js";

const RESOLVED_SECRET = "resolved-drive-secret";
const SECRET_REF = { source: "keychain", id: "projects/drive-secret" };

function driveConfig() {
  return {
    openaiApiKey: "sk-test",
    connectors: {
      googleDrive: {
        enabled: true,
        clientId: "synthetic-client",
        clientSecret: SECRET_REF,
        refreshToken: "synthetic-token",
      },
      notion: { enabled: true, token: "secret_synthetic_notion_token" },
    },
  };
}

function notionStub(): LiveConnector {
  return {
    id: NOTION_CONNECTOR_ID,
    displayName: "Notion",
    validateConfig: () => ({}),
    async syncIncremental() {
      return { newDocs: [], nextCursor: { kind: "notion", value: "cursor-1", updatedAt: "2026-11-11T00:00:00.000Z" } };
    },
  };
}

test("a Drive SecretRef resolves through parseConfig and the runner, and stays out of the state file", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-drive-secretref-"));
  try {
    const parsed = parseConfig(driveConfig());
    const definitions = builtInLiveConnectorDefinitions(parsed.connectors);
    let seenSecret = "";
    const client: GoogleDriveClient = {
      async getStartPageToken() {
        return { startPageToken: "seed-token" };
      },
      async listChanges() {
        return { changes: [], newStartPageToken: "next-token" };
      },
      async exportFile() {
        return "";
      },
      async getFileMedia() {
        return "";
      },
    };
    for (const definition of definitions) {
      if (definition.id === GOOGLE_DRIVE_CONNECTOR_ID) {
        definition.createConnector = () =>
          createGoogleDriveConnector({
            clientFactory: async (config) => {
              seenSecret = config.clientSecret;
              return client;
            },
          });
      }
      if (definition.id === NOTION_CONNECTOR_ID) {
        definition.createConnector = notionStub;
      }
    }
    const summary = await runLiveConnectorsOnce({
      memoryDir,
      connectors: parsed.connectors,
      definitions,
      force: true,
      resolveSecretRef: async () => RESOLVED_SECRET,
      ingestDocuments: async () => {},
    });
    assert.equal(seenSecret, RESOLVED_SECRET);
    const drive = summary.results.find((item) => item.id === GOOGLE_DRIVE_CONNECTOR_ID);
    assert.equal(drive?.ran, true);
    const statePath = path.join(memoryDir, "state", "connectors", `${GOOGLE_DRIVE_CONNECTOR_ID}.json`);
    const stateText = await readFile(statePath, "utf-8");
    assert.equal(stateText.includes(RESOLVED_SECRET), false);
    assert.equal(stateText.includes(SECRET_REF.id), false);
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("a Drive SecretRef with no resolver fails that connector and the others still run", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-drive-secretref-"));
  try {
    const parsed = parseConfig(driveConfig());
    const definitions = builtInLiveConnectorDefinitions(parsed.connectors);
    for (const definition of definitions) {
      if (definition.id === NOTION_CONNECTOR_ID) definition.createConnector = notionStub;
    }
    const summary = await runLiveConnectorsOnce({
      memoryDir,
      connectors: parsed.connectors,
      definitions,
      force: true,
      ingestDocuments: async () => {},
    });
    const drive = summary.results.find((item) => item.id === GOOGLE_DRIVE_CONNECTOR_ID);
    const notion = summary.results.find((item) => item.id === NOTION_CONNECTOR_ID);
    assert.match(drive?.error ?? "", /clientSecret is a secret reference but no resolver is configured/);
    assert.equal((drive?.error ?? "").includes(SECRET_REF.id), false);
    assert.equal(notion?.ran, true);
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});
