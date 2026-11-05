/**
 * LCM archival acceptance for the observe surface.
 *
 * The archive append is durable before this returns: the queue holds only a
 * session reference and summary DAGs are built in the background, so the
 * caller is never blocked on inference.
 *
 * An archive failure rejects the observe (fail closed). An acknowledged
 * observe must never lose its lossless copy: the client would not retry a
 * request it was told succeeded.
 */
import { log } from "./logger.js";
import type { LcmEngine } from "./lcm/engine.js";
import type { LcmObserveMessage } from "./lcm/queue.js";

/** Archive the observed turns; returns false when LCM is off. */
export async function archiveObservedTurns(
  lcmEngine: LcmEngine | null,
  lcmSessionKey: string,
  messages: LcmObserveMessage[],
): Promise<boolean> {
  if (!lcmEngine || !lcmEngine.enabled) return false;
  try {
    await lcmEngine.enqueueObserveMessages(lcmSessionKey, messages);
    return true;
  } catch (err) {
    log.error(`access-observe LCM archival failed: ${err}`);
    throw err;
  }
}
