
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
