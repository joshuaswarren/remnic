
export {
  AES_KEY_LENGTH,
  AUTH_TAG_LENGTH,
  ENVELOPE_HEADER_SIZE,
  ENVELOPE_LAYOUT,
  ENVELOPE_SALT_LENGTH,
  ENVELOPE_VERSION,
  IV_LENGTH,
  generateSalt,
  open,
  parseEnvelope,
  seal,
  type DecryptOptions,
  type EncryptOptions,
  type ParsedEnvelope,
} from "./cipher.js";

export {
  DEFAULT_ARGON2ID_PARAMS,
  DEFAULT_SCRYPT_PARAMS,
  KDF_KEY_LENGTH,
  KDF_SALT_LENGTH,
  constantTimeEqual,
  deriveKey,
  deriveKeyScrypt,
  validateScryptParams,
  type Argon2idParams,
  type KdfAlgorithm,
  type ScryptParams,
} from "./kdf.js";

export {
  METADATA_FORMAT,
  METADATA_FORMAT_VERSION,
  buildMetadata,
  decodeMetadataSalt,
  parseMetadata,
  serializeMetadata,
  validateMetadata,
  type BuildMetadataOptions,
  type SecureStoreMetadata,
  type SecureStoreMetadataKdf,
  type SecureStoreMetadataKdfArgon2id,
  type SecureStoreMetadataKdfScrypt,
} from "./metadata.js";

export {
  HEADER_FILENAME,
  HEADER_FORMAT,
  HEADER_FORMAT_VERSION,
  SECURE_STORE_DIR_NAME,
  buildHeader,
  buildHeaderFromPassphrase,
  deriveKeyFromHeader,
  headerPath,
  parseHeader,
  readHeader,
  secureStoreDir,
  serializeHeader,
  validateHeader,
  verifyKey,
  writeHeader,
  type SecureStoreHeader,
} from "./header.js";

export * as keyring from "./keyring.js";

export {
  MIN_PASSPHRASE_LENGTH,
  runSecureStoreInit,
  runSecureStoreLock,
  runSecureStoreDisable,
  runSecureStoreMigrate,
  runSecureStoreStatus,
  runSecureStoreUnlock,
  type PassphraseReader,
  type SecureStoreInitOptions,
  type SecureStoreInitReport,
  type SecureStoreLockOptions,
  type SecureStoreLockReport,
  type SecureStoreDisableOptions,
  type SecureStoreDisableReport,
  type SecureStoreMigrateOptions,
  type SecureStoreMigrateReport,
  type SecureStoreStatusOptions,
  type SecureStoreStatusReport,
  type SecureStoreUnlockOptions,
  type SecureStoreUnlockReport,
} from "./cli-handlers.js";

export {
  renderDisableReport,
  renderInitReport,
  renderLockReport,
  renderMigrateReport,
  renderStatusReport,
  renderUnlockReport,
} from "./cli-renderer.js";

export { createPassphraseReader } from "./passphrase-reader.js";

export {
  FILE_FORMAT_FLAGS,
  FILE_FORMAT_VERSION,
  MAGIC_BYTES,
  MAGIC_HEADER_SIZE,
  SECURE_STORE_ENVELOPE_OVERHEAD_BYTES,
  SecureStoreDecryptError,
  SecureStoreLockedError,
  decryptMemoryDirToPlaintext,
  decryptFileBody,
  encryptFileBody,
  filePathAad,
  isEncryptedFile,
  migrateMemoryDirToEncrypted,
  readMaybeEncryptedFile,
  writeMaybeEncryptedFile,
  type MigrateResult,
  type DecryptResult,
  type WriteMaybeEncryptedFileOptions,
} from "./secure-fs.js";
