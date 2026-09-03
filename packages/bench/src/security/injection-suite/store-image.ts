import {
  composeMemoryEnvelope,
  screenCandidateFact,
  StorageManager,
} from "@remnic/core";
import { writeFileAtomically } from "@remnic/core/maintenance/atomic-file";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, rename, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type {
  BenchMemoryAdapter,
  BenchMemorySnapshot,
} from "../../adapters/types.js";
import type { RemnicAdapterOptions } from "../../adapters/remnic-adapter.js";
import { InjectionSuiteClaimLock } from "./claims.js";
import { InjectionSuiteHostFault } from "./llm-executor.js";
import { defaultSuiteIdentity } from "./store.js";
import {
  injectionSuiteArmUsesQuarantine,
  type InjectionSuiteArm,
  type InjectionSuiteCliInput,
  type InjectionSuiteRowIdentity,
  type InjectionSuiteVariant,
} from "./types.js";

interface InjectionSuiteSeedManifest {
  schemaVersion: 1;
  seedKey: string;
  screenEnabled: boolean;
  plantSession: string;
  memories: BenchMemorySnapshot[];
}

export interface PreparedInjectionSuiteStore {
  memoryDir: string;
  plantSession: string;
  seedMemories: BenchMemorySnapshot[];
  cleanup(): Promise<void>;
}

function seedIdentity(
  identity: InjectionSuiteRowIdentity,
  screenEnabled: boolean,
): InjectionSuiteRowIdentity {
  const arm: InjectionSuiteArm = screenEnabled ? "quarantine" : "none";
  return defaultSuiteIdentity({
    stage: identity.stage,
    modelProfileId: identity.modelProfileId,
    arm,
    family: identity.family,
    variantId: `${identity.variantId}-seed-image`,
    seed: identity.seed,
  });
}

function buildSeedKey(
  identity: InjectionSuiteRowIdentity,
  variant: InjectionSuiteVariant,
  input: InjectionSuiteCliInput,
  screenEnabled: boolean,
): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        suiteVersion: identity.suiteVersion,
        stage: identity.stage,
        modelProfileId: identity.modelProfileId,
        family: identity.family,
        variantId: identity.variantId,
        seed: identity.seed,
        screenEnabled,
        executor: input.executor ?? "local",
        baseUrl: input.baseUrl ?? "",
        model: input.model ?? "",
        scenarioSha256: createHash("sha256")
          .update(JSON.stringify(variant))
          .digest("hex"),
        modelDigest: input.modelDigest ?? "",
      }),
    )
    .digest("hex");
}

async function readManifest(
  directory: string,
): Promise<InjectionSuiteSeedManifest | undefined> {
  try {
    return JSON.parse(
      await readFile(path.join(directory, "h5-seed.json"), "utf8"),
    ) as InjectionSuiteSeedManifest;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function waitForSeed(
  directory: string,
  timeoutMs: number,
): Promise<InjectionSuiteSeedManifest> {
  const deadline = Date.now() + Math.max(20 * 60_000, timeoutMs * 2);
  while (Date.now() < deadline) {
    const manifest = await readManifest(directory);
    if (manifest) return manifest;
    const { promise, resolve } = Promise.withResolvers<void>();
    setTimeout(resolve, 1_000);
    await promise;
  }
  throw new InjectionSuiteHostFault(
    "timed out waiting for shared H5 extraction seed",
  );
}
function benchMemorySource(sessionId: string): string {
  return `bench-replay-${createHash("sha256").update(sessionId).digest("hex").slice(0, 16)}`;
}

function plantOrigin(
  variant: InjectionSuiteVariant,
): "user" | "assistant" | "tool_output" {
  const roles = new Set(variant.plantTurns.map((turn) => turn.originRole));
  if (roles.size !== 1)
    throw new Error("H5 sealed candidate requires one trusted plant origin");
  const role = [...roles][0];
  return role === "tool" ? "tool_output" : role!;
}

async function generateSeed(input: {
  directory: string;
  seedKey: string;
  screenEnabled: boolean;
  variant: InjectionSuiteVariant;
  createAdapter(options: RemnicAdapterOptions): Promise<BenchMemoryAdapter>;
  adapterOptions: RemnicAdapterOptions;
}): Promise<InjectionSuiteSeedManifest> {
  const parent = path.dirname(input.directory);
  await mkdir(parent, { recursive: true });
  const temporary = await mkdtemp(path.join(parent, ".h5-seed-"));
  const plantSession = `h5-seed-${input.seedKey}`;
  let adapter: BenchMemoryAdapter | undefined;
  try {
    adapter = await input.createAdapter({
      ...input.adapterOptions,
      memoryDir: temporary,
      replayExtractionMode: "skip",
    });
    await adapter.store(
      plantSession,
      input.variant.plantTurns.map((turn) => ({
        role: turn.role,
        originRole: turn.originRole,
        content: turn.content,
      })),
    );
    await adapter.drain?.();
    const screened = input.screenEnabled
      ? screenCandidateFact(input.variant.payload, "hardened")
      : { quarantine: false, findings: [] };
    const source = benchMemorySource(plantSession);
    const envelope = composeMemoryEnvelope(
      {
        category: "fact",
        content: input.variant.payload,
        confidence: 0.99,
        origin: plantOrigin(input.variant),
        tags: screened.quarantine
          ? screened.findings.map(
              (finding) => `injection-screen:${finding.rule}`,
            )
          : [],
      },
      { source },
    );
    await new StorageManager(temporary).writeSealedMemory(
      envelope,
      screened.quarantine ? { status: "pending_review" } : {},
    );
    if (!adapter.inspectSessionMemories) {
      throw new Error(
        "shared H5 extraction seed requires inspectSessionMemories",
      );
    }
    const memories = await adapter.inspectSessionMemories(plantSession);
    const manifest: InjectionSuiteSeedManifest = {
      schemaVersion: 1,
      seedKey: input.seedKey,
      screenEnabled: input.screenEnabled,
      plantSession,
      memories,
    };
    await adapter.destroy();
    adapter = undefined;
    await writeFileAtomically(
      path.join(temporary, "h5-seed.json"),
      `${JSON.stringify(manifest, null, 2)}\n`,
    );
    await rename(temporary, input.directory);
    return manifest;
  } finally {
    await adapter?.destroy().catch(() => undefined);
    await rm(temporary, { recursive: true, force: true }).catch(
      () => undefined,
    );
  }
}

export async function prepareInjectionSuiteStore(input: {
  identity: InjectionSuiteRowIdentity;
  variant: InjectionSuiteVariant;
  run: InjectionSuiteCliInput;
  createAdapter(options: RemnicAdapterOptions): Promise<BenchMemoryAdapter>;
  adapterOptionsForArm(arm: InjectionSuiteArm): RemnicAdapterOptions;
}): Promise<PreparedInjectionSuiteStore> {
  const screenEnabled = injectionSuiteArmUsesQuarantine(input.identity.arm);
  const seedKey = buildSeedKey(
    input.identity,
    input.variant,
    input.run,
    screenEnabled,
  );
  const storeRoot = path.join(input.run.outputDir, "store-images");
  const directory = path.join(storeRoot, seedKey);
  let manifest = await readManifest(directory);
  if (!manifest) {
    const claims = new InjectionSuiteClaimLock(path.join(storeRoot, "claims"));
    const claim = await claims.tryClaim(
      seedIdentity(input.identity, screenEnabled),
    );
    if (claim === "busy") {
      manifest = await waitForSeed(
        directory,
        input.run.requestTimeoutMs ?? 300_000,
      );
    } else {
      try {
        manifest = await readManifest(directory);
        if (!manifest) {
          manifest = await generateSeed({
            directory,
            seedKey,
            screenEnabled,
            variant: input.variant,
            createAdapter: input.createAdapter,
            adapterOptions: input.adapterOptionsForArm(
              screenEnabled ? "quarantine" : "none",
            ),
          });
        }
      } finally {
        await claims.release(claim);
      }
    }
  }
  if (
    manifest.seedKey !== seedKey ||
    manifest.screenEnabled !== screenEnabled
  ) {
    throw new Error("H5 extraction seed manifest drifted");
  }
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "h5-arm-store-"));
  await cp(directory, memoryDir, { recursive: true, force: false });
  return {
    memoryDir,
    plantSession: manifest.plantSession,
    seedMemories: manifest.memories,
    cleanup: () =>
      rm(memoryDir, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 100,
      }),
  };
}
