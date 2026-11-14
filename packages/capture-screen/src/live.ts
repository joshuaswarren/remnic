/**
 * Live capture cycle: one window captured through the native helper and run
 * through the processing pipeline. Shared by `test-snapshot` (which prints the
 * decision without storing) and the capture scheduler.
 *
 * Order matters for privacy: the helper is first asked for the window's facts
 * only (app, title, id, address), the deny list is applied to those, and the
 * tree or the pixels of a window are read only when it passes. A denied
 * window's content is never read, not just never stored.
 *
 * The routing (AX vs OCR) happens here because the native OCR call is async
 * while the processor's OCR seam is sync: a terminal-class or AX-empty window
 * has its OCR text fetched eagerly, then handed to the processor as
 * pre-extracted text. When OCR fails, the candidate is left text-less so the
 * processor skips it (ocr-unavailable) rather than storing empty AX text.
 */

import { extractAxText } from "./axtree.js";
import { isTerminalApp } from "./capture.js";
import { hasUrlDenyRules, matchDenyRule } from "./denylist.js";
import type { CaptureCandidate, CaptureDecision, CaptureProcessor } from "./capture.js";
import type { DaemonConfig } from "./config.js";
import { helperPackageName, type AxSnapshot, type AxSnapshotOptions, type NativeHelper, type WindowContext } from "./helper.js";

function isDenied(config: DaemonConfig, who: { app: string; windowTitle: string; browserUrl?: string | null }): boolean {
  return (
    matchDenyRule(
      { app: who.app, windowTitle: who.windowTitle, browserUrl: who.browserUrl ?? null },
      { apps: config.denyApps, titles: config.denyTitles, urls: config.denyUrls },
    ) !== null
  );
}

/** AT-SPI cannot bind a checked URI to every subsequent content read. */
export function linuxUrlPolicyUnavailable(config: DaemonConfig): boolean {
  return helperPackageName() === "@remnic/capture-native-linux" && hasUrlDenyRules(config.denyUrls);
}

export async function captureViaHelper(
  helper: NativeHelper,
  processor: CaptureProcessor,
  config: DaemonConfig,
  capturedAtUtc: string,
): Promise<CaptureDecision> {
  if (linuxUrlPolicyUnavailable(config)) return { action: "skipped", reason: "url-policy-unavailable" };
  const context = await helper.windowContext({ frontmost: true, maxNodes: config.maxNodes });
  return captureWindow(context, helper, processor, config, capturedAtUtc);
}

/**
 * Capture the window the helper described. A denied window gets a text-less candidate that the processor
 * drops, and the helper is asked for nothing more. Any other window is read pinned to its id, so a focus
 * change after the window facts cannot redirect the read.
 */
export async function captureWindow(
  context: WindowContext,
  helper: NativeHelper,
  processor: CaptureProcessor,
  config: DaemonConfig,
  capturedAtUtc: string,
): Promise<CaptureDecision> {
  if (isDenied(config, context)) {
    const candidate: CaptureCandidate = { capturedAtUtc, app: context.app, windowTitle: context.windowTitle };
    if (context.browserUrl != null) candidate.browserUrl = context.browserUrl;
    return processor.process(candidate);
  }
  if (linuxUrlPolicyUnavailable(config)) return { action: "skipped", reason: "url-policy-unavailable" };
  const options: AxSnapshotOptions = context.windowId !== undefined ? { windowId: context.windowId } : { frontmost: true };
  options.expectTitle = context.windowTitle;
  options.maxNodes = config.maxNodes;
  const snap = context.snapshot ?? (await helper.axSnapshot(options));
  if (snap.windowTitle !== context.windowTitle) {
    // The window changed identity after the facts the deny list approved. The retitled snapshot
    // carries no URL, so a URL rule could not run on it; read nothing and store nothing.
    return { action: "skipped", reason: "identity-changed" };
  }
  return captureFromSnapshot(snap, helper, processor, config, capturedAtUtc);
}

/**
 * Run an already-fetched AX snapshot through the pipeline. `captureWindow` calls this after the deny list
 * passed the window facts and the snapshot proved the same title; `captureWindow` itself skips a window that
 * was retitled in between, because the retitled snapshot carries no URL to check. A direct caller's snapshot
 * is still checked here against its own identity.
 */
export async function captureFromSnapshot(
  snap: AxSnapshot,
  helper: NativeHelper,
  processor: CaptureProcessor,
  config: DaemonConfig,
  capturedAtUtc: string,
): Promise<CaptureDecision> {
  const axText = extractAxText(snap.tree, config.maxNodes).text;
  const candidate: CaptureCandidate = {
    capturedAtUtc,
    app: snap.app,
    windowTitle: snap.windowTitle,
    ...(snap.browserUrl != null ? { browserUrl: snap.browserUrl } : {}),
  };
  // Deny preflight on the snapshot's own identity: the window may have been
  // retitled between the window facts and the tree read, and a legacy helper
  // gives no window facts without the tree. Never OCR a deny-listed window;
  // process() applies deny too, but only AFTER text extraction.
  const denied = isDenied(config, snap);
  if (denied) {
    // Leave text-less; processor.process denies it below (no OCR ran).
  } else if (isTerminalApp(snap.app, config.terminalApps) || axText.trim() === "") {
    try {
      // The helper must establish ownership of the pixels, beyond these pre-read identity checks.
      // Linux refuses composited crops; its AT-SPI capture remains available.
      const ocrText = await helper.ocrWindow(
        { ...(snap.windowId !== undefined ? { windowId: snap.windowId } : { frontmost: true }), expectTitle: snap.windowTitle },
      );
      if (ocrText.trim() !== "") {
        candidate.text = ocrText;
        candidate.textSource = "ocr";
      }
      // Blank OCR: leave text-less so the processor reports ocr-unavailable
      // instead of persisting an empty snapshot.
    } catch {
      // OCR unavailable/failed: leave text-less so the processor reports
      // ocr-unavailable instead of persisting an empty snapshot.
    }
  } else {
    candidate.text = axText;
    candidate.textSource = "ax";
  }
  return processor.process(candidate);
}
