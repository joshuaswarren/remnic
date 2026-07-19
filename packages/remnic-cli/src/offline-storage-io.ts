import fs from "node:fs";
import { createDecipheriv, createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  OFFLINE_SYNC_FILE_CONTENT_TRANSFER_CHUNK_BYTES,
  StorageManager,
} from "@remnic/core";
import type {
  applyOfflineSyncFileContentChunk,
  applyOfflineSyncSnapshot,
  buildOfflineSyncChangeset,
} from "@remnic/core";
import type {
  OfflineSyncFileDigest,
  OfflineSyncFileTarget,
} from "@remnic/core";
import {
  AUTH_TAG_LENGTH,
  ENVELOPE_HEADER_SIZE,
  ENVELOPE_LAYOUT,
  ENVELOPE_SALT_LENGTH,
  ENVELOPE_VERSION,
  FILE_FORMAT_FLAGS,
  FILE_FORMAT_VERSION,
  IV_LENGTH,
  MAGIC_BYTES,
  MAGIC_HEADER_SIZE,
  SecureStoreLockedError,
  filePathAad,
  isEncryptedFile,
  keyring,
  readHeader,
  secureStoreDir,
} from "@remnic/core/secure-store";

export type OfflineFileChunkReader = (
  target: OfflineSyncFileTarget & { chunkSize: number },
) => AsyncIterable<Buffer>;

export type ConfiguredOfflineStorage = {
  storage: StorageManager;
  secureStoreKey: Buffer | null;
};

export interface OfflineStorageIo {
  readFile: Parameters<typeof buildOfflineSyncChangeset>[0]["readFile"];
  readFileDigest: (target: OfflineSyncFileTarget) => Promise<OfflineSyncFileDigest>;
  readFileChunks: OfflineFileChunkReader;
  writeFile: Parameters<typeof applyOfflineSyncSnapshot>[0]["writeFile"];
  writeStagingFile: Parameters<typeof applyOfflineSyncFileContentChunk>[0]["writeStagingFile"];
  writeFileChunks: Parameters<typeof applyOfflineSyncFileContentChunk>[0]["writeFileChunks"];
  deleteFile: Parameters<typeof applyOfflineSyncSnapshot>[0]["deleteFile"];
}

export async function createConfiguredOfflineStorage(memoryDir: string): Promise<ConfiguredOfflineStorage> {
  const storage = new StorageManager(memoryDir);
  const header = await readHeader(memoryDir);
  let secureStoreKey: Buffer | null = null;
  if (header) {
    storage.setSecureStoreRequired(true);
    const key = keyring.getKey(secureStoreDir(memoryDir));
    if (key) {
      storage.setSecureStoreKey(key);
      secureStoreKey = key;
    }
  }
  return { storage, secureStoreKey };
}

export async function createOfflineStorageIo(
  memoryDir: string,
  configuredStorage?: ConfiguredOfflineStorage,
): Promise<OfflineStorageIo> {
  const { storage, secureStoreKey } =
    configuredStorage ?? (await createConfiguredOfflineStorage(memoryDir));
  return {
    readFile: async ({ filePath }) => storage.readOfflineSyncFile(filePath),
    readFileDigest: async ({ filePath }) => {
      const hash = createHash("sha256");
      let bytes = 0;
      for await (const rawChunk of readOfflineSyncFileChunks({
        filePath,
        memoryDir,
        secureStoreKey,
        chunkSize: OFFLINE_SYNC_FILE_CONTENT_TRANSFER_CHUNK_BYTES,
      })) {
        const chunk = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk);
        hash.update(chunk);
        bytes += chunk.length;
      }
      return {
        sha256: hash.digest("hex"),
        bytes,
      };
    },
    readFileChunks: ({ filePath, chunkSize }) => readOfflineSyncFileChunks({
      filePath,
      memoryDir,
      secureStoreKey,
      chunkSize,
    }),
    writeFile: async ({ filePath, content }) => storage.writeOfflineSyncFile(filePath, content),
    writeStagingFile: async ({ filePath, content }) => storage.writeOfflineSyncStagingFile(filePath, content),
    writeFileChunks: async ({ filePath, chunks }) => storage.writeOfflineSyncFileChunks(filePath, chunks),
    deleteFile: async ({ filePath }) => storage.deleteOfflineSyncFile(filePath),
  };
}

async function* readOfflineSyncFileChunks(options: {
  filePath: string;
  memoryDir: string;
  secureStoreKey: Buffer | null;
  chunkSize: number;
}): AsyncIterable<Buffer> {
  const header = await readFilePrefix(options.filePath, MAGIC_HEADER_SIZE);
  if (!isEncryptedFile(header)) {
    yield* readPlainOfflineFileChunks(options.filePath, options.chunkSize);
    return;
  }
  if (!options.secureStoreKey) {
    throw new SecureStoreLockedError(
      `secure-store is locked — cannot read encrypted file at ${options.filePath}. Run \`remnic secure-store unlock\` to decrypt.`,
    );
  }
  yield* readEncryptedOfflineFileChunks({
    filePath: options.filePath,
    memoryDir: options.memoryDir,
    key: options.secureStoreKey,
    chunkSize: options.chunkSize,
  });
}

async function readFilePrefix(filePath: string, length: number): Promise<Buffer> {
  const handle = await fs.promises.open(filePath, "r");
  try {
    const out = Buffer.alloc(length);
    const { bytesRead } = await handle.read(out, 0, length, 0);
    return out.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

async function* readPlainOfflineFileChunks(filePath: string, chunkSize: number): AsyncIterable<Buffer> {
  const stream = fs.createReadStream(filePath, { highWaterMark: chunkSize });
  for await (const chunk of stream) {
    yield Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
  }
}

async function* readEncryptedOfflineFileChunks(options: {
  filePath: string;
  memoryDir: string;
  key: Buffer;
  chunkSize: number;
}): AsyncIterable<Buffer> {
  const header = await readFilePrefix(options.filePath, MAGIC_HEADER_SIZE + ENVELOPE_HEADER_SIZE);
  if (header.length < MAGIC_HEADER_SIZE + ENVELOPE_HEADER_SIZE || !isEncryptedFile(header)) {
    throw new Error(`secure-store encrypted file is truncated: ${options.filePath}`);
  }
  const version = header.readUInt8(MAGIC_BYTES.length);
  const flags = header.readUInt8(MAGIC_BYTES.length + 1);
  if (version !== FILE_FORMAT_VERSION) {
    throw new Error(`secure-store file has unsupported version ${version}: ${options.filePath}`);
  }
  if (flags !== FILE_FORMAT_FLAGS) {
    throw new Error(`secure-store file has unsupported flags 0x${flags.toString(16)}: ${options.filePath}`);
  }

  const envelopeHeader = header.subarray(MAGIC_HEADER_SIZE);
  const envelopeVersion = envelopeHeader.readUInt8(ENVELOPE_LAYOUT.version);
  if (envelopeVersion !== ENVELOPE_VERSION) {
    throw new Error(`secure-store envelope has unsupported version ${envelopeVersion}: ${options.filePath}`);
  }
  const salt = envelopeHeader.subarray(
    ENVELOPE_LAYOUT.salt,
    ENVELOPE_LAYOUT.salt + ENVELOPE_SALT_LENGTH,
  );
  const iv = envelopeHeader.subarray(ENVELOPE_LAYOUT.iv, ENVELOPE_LAYOUT.iv + IV_LENGTH);
  const authTag = envelopeHeader.subarray(
    ENVELOPE_LAYOUT.authTag,
    ENVELOPE_LAYOUT.authTag + AUTH_TAG_LENGTH,
  );
  const aadCandidates = offlineFileAadCandidates(options.filePath, options.memoryDir);
  let lastError: unknown;
  for (const aad of aadCandidates) {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "remnic-offline-decrypt-"));
    const tempPath = path.join(tempDir, "content");
    try {
      const decipher = createDecipheriv("aes-256-gcm", options.key, iv, {
        authTagLength: AUTH_TAG_LENGTH,
      });
      decipher.setAuthTag(authTag);
      decipher.setAAD(Buffer.concat([secureStoreEnvelopeHeaderAad(salt), aad]));
      const output = fs.createWriteStream(tempPath, { mode: 0o600 });
      try {
        const stream = fs.createReadStream(options.filePath, {
          start: MAGIC_HEADER_SIZE + ENVELOPE_HEADER_SIZE,
          highWaterMark: options.chunkSize,
        });
        for await (const encryptedChunk of stream) {
          const plain = decipher.update(
            Buffer.isBuffer(encryptedChunk) ? encryptedChunk : Buffer.from(encryptedChunk),
          );
          if (plain.length > 0 && !output.write(plain)) {
            await new Promise<void>((resolve, reject) => {
              output.once("drain", resolve);
              output.once("error", reject);
            });
          }
        }
        const finalPlain = decipher.final();
        if (finalPlain.length > 0 && !output.write(finalPlain)) {
          await new Promise<void>((resolve, reject) => {
            output.once("drain", resolve);
            output.once("error", reject);
          });
        }
      } finally {
        await closeWriteStream(output);
      }
      yield* readPlainOfflineFileChunks(tempPath, options.chunkSize);
      return;
    } catch (error) {
      lastError = error;
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error(`secure-store could not decrypt file: ${options.filePath}`);
}

function offlineFileAadCandidates(filePath: string, memoryDir: string): Buffer[] {
  const candidates = [filePathAad(filePath, memoryDir)];
  const relative = path.relative(memoryDir, filePath);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) return candidates;
  const parts = relative.split(path.sep);
  if (parts[0] === "namespaces" && parts.length >= 3 && parts[1]) {
    candidates.push(filePathAad(filePath, path.join(memoryDir, "namespaces", parts[1])));
  }
  const memoryParts = path.resolve(memoryDir).split(path.sep);
  if (memoryParts.length >= 3 && memoryParts.at(-2) === "namespaces" && memoryParts.at(-1)) {
    const topLevelRoot = memoryParts.slice(0, -2).join(path.sep) || path.sep;
    const topRelative = path.relative(topLevelRoot, filePath);
    if (
      topRelative
      && !topRelative.startsWith("..")
      && !path.isAbsolute(topRelative)
      && topRelative.split(path.sep)[0] === "namespaces"
      && topRelative.split(path.sep)[1] === memoryParts.at(-1)
    ) {
      candidates.push(filePathAad(filePath, topLevelRoot));
    }
  }
  return candidates;
}

async function closeWriteStream(stream: fs.WriteStream): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    stream.once("error", reject);
    stream.end(() => resolve());
  });
}

function secureStoreEnvelopeHeaderAad(salt: Uint8Array): Buffer {
  const out = Buffer.alloc(1 + ENVELOPE_SALT_LENGTH);
  out.writeUInt8(ENVELOPE_VERSION, 0);
  Buffer.from(salt).copy(out, 1);
  return out;
}
