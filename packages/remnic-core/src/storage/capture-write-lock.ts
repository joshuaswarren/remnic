/**
 * Public seam for the tombstone-blocked capture write lock.
 * Converge tests hold the same lock the apply path acquires.
 */
export {
  buildCapturePathLockIdentity,
  TombstoneBlockedCaptureWriteLock,
} from "./tombstone-blocked-capture-mutation.js";
