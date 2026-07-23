/**
 * Live capture cycle: one snapshot fetched through the native helper and run
 * through the processing pipeline. Shared by `test-snapshot` (which prints the
 * decision without storing) and available to a future capture scheduler.
 *
 * The routing (AX vs OCR) happens here because the native OCR call is async
 * while the processor's OCR seam is sync: a terminal-class or AX-empty window
 * has its OCR text fetched eagerly, then handed to the processor as
 * pre-extracted text. When OCR fails, the candidate is left text-less so the
 * processor skips it (ocr-unavailable) rather than storing empty AX text.
 */

import { extractAxText } from "./axtree.js";
import { isTerminalApp } from "./capture.js";
import type { CaptureCandidate, CaptureDecision, CaptureProcessor } from "./capture.js";
import type { DaemonConfig } from "./config.js";
import type { AxSnapshot, NativeHelper } from "./helper.js";

export async function captureViaHelper(
  helper: NativeHelper,
  processor: CaptureProcessor,
  config: DaemonConfig,
  capturedAtUtc: string,
): Promise<CaptureDecision> {
  const snap = await helper.axSnapshot({ frontmost: true, maxNodes: config.maxNodes });
  return captureFromSnapshot(snap, helper, processor, config, capturedAtUtc);
}

/**
 * Run an already-fetched AX snapshot through the pipeline. The live scheduler
 * uses this so a single ax-snapshot poll drives both change detection and the
 * capture, avoiding a redundant fetch.
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
  if (isTerminalApp(snap.app, config.terminalApps) || axText.trim() === "") {
    try {
      const ocrText = await helper.ocrWindow({ frontmost: true });
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
