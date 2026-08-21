import crypto from "node:crypto";
import {
  type ObjectiveStateChangeKind,
  type ObjectiveStateOutcome,
  type ObjectiveStateSnapshot,
  recordObjectiveStateSnapshot,
} from "./objective-state.js";
import {
  parseMessageParts,
  type LcmMessagePartInput,
  type MessagePartSourceFormat,
} from "./message-parts/index.js";

interface ToolCallContext {
  toolName?: string;
  toolCallId?: string;
  args?: Record<string, unknown>;
}

interface DerivedObjectiveStateResult {
  snapshots: ObjectiveStateSnapshot[];
  filePaths: string[];
}

interface ObservedMessageWithParts {
  role?: string;
  content?: string;
  parts?: LcmMessagePartInput[] | null;
  rawContent?: unknown;
  sourceFormat?: MessagePartSourceFormat;
}

interface ObservedPartEntry {
  messageIndex: number;
  partIndex: number;
  part: LcmMessagePartInput;
}

const rawProviderParts = new WeakSet<LcmMessagePartInput>();

function markRawProviderParts(parts: LcmMessagePartInput[]): LcmMessagePartInput[] {
  for (const part of parts) {
    rawProviderParts.add(part);
  }
  return parts;
}

function isRawProviderPart(part: LcmMessagePartInput): boolean {
  return rawProviderParts.has(part);
}

function hashSha256(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function toolNameTokens(toolName: string | undefined): string[] {
  if (!toolName) return [];
  return toolName
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length > 0);
}

function normalizedToolName(toolName: string | undefined): string {
  return toolNameTokens(toolName).join("_");
}

function parseToolArguments(value: unknown): Record<string, unknown> | undefined {
  if (isRecord(value)) return value;
  if (typeof value !== "string") return undefined;
  try {
    const parsed = JSON.parse(value) as unknown;
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableStringify(entry)).join(",")}]`;
  }
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? String(value);
}

function extractTextContent(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (Array.isArray(value)) {
    return value
      .map((block) => {
        if (typeof block === "string") return block.trim();
        if (isRecord(block) && block.type === "text" && typeof block.text === "string") {
          return block.text.trim();
        }
        return "";
      })
      .filter((item) => item.length > 0)
      .join("\n");
  }
  if (isRecord(value)) {
    return JSON.stringify(value);
  }
  return "";
}

function parseToolResultPayload(content: unknown): unknown {
  const text = extractTextContent(content);
  if (text.length === 0) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

function resultHash(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  const canonical =
    typeof value === "string" ? value : stableStringify(value);
  if (!canonical || canonical.length === 0) return undefined;
  return `sha256:${hashSha256(canonical)}`;
}

function getToolCallContexts(messages: Array<Record<string, unknown>>): Map<string, ToolCallContext> {
  const contexts = new Map<string, ToolCallContext>();
  for (const message of messages) {
    if (message.role !== "assistant") continue;
    const toolCalls = message.tool_calls ?? message.toolCalls;
    if (!Array.isArray(toolCalls)) continue;
    for (const call of toolCalls) {
      if (!isRecord(call)) continue;
      const toolCallId = optionalString(call.id) ?? optionalString(call.toolCallId);
      if (!toolCallId) continue;
      const fn = isRecord(call.function) ? call.function : undefined;
      const toolName =
        optionalString(fn?.name) ??
        optionalString(call.name);
      const args =
        parseToolArguments(fn?.arguments) ??
        parseToolArguments(call.arguments) ??
        parseToolArguments(call.args) ??
        parseToolArguments(call.input);
      contexts.set(toolCallId, { toolCallId, toolName, args });
    }
  }
  return contexts;
}

function toolCallIdForMessage(message: Record<string, unknown>): string | undefined {
  return (
    optionalString(message.tool_call_id) ??
    optionalString(message.toolCallId) ??
    optionalString(message.tool_use_id) ??
    optionalString(message.toolUseId)
  );
}

function toolNameForMessage(message: Record<string, unknown>, context?: ToolCallContext): string | undefined {
  return (
    optionalString(message.name) ??
    optionalString(message.toolName) ??
    optionalString(message.tool) ??
    context?.toolName
  );
}

function pickString(args: Record<string, unknown> | undefined, keys: string[]): string | undefined {
  if (!args) return undefined;
  for (const key of keys) {
    const value = optionalString(args[key]);
    if (value) return value;
  }
  return undefined;
}

function pickFirstStringArrayValue(args: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = args?.[key];
  if (!Array.isArray(value)) return undefined;
  for (const item of value) {
    const candidate = optionalString(item);
    if (candidate) return candidate;
  }
  return undefined;
}

function fileScopeFromArgs(args: Record<string, unknown> | undefined): {
  scope?: string;
  sourcePath?: string;
  destinationPath?: string;
} {
  const destinationPath =
    pickString(args, ["destination", "dest", "targetPath", "target", "to"]) ??
    pickString(args, ["path", "filePath", "workspacePath", "projectPath"]) ??
    pickFirstStringArrayValue(args, "paths");
  const sourcePath =
    pickString(args, ["source", "src", "from", "oldPath"]);
  const scope = destinationPath ?? sourcePath;
  return { scope, sourcePath, destinationPath };
}

function fileContentHash(args: Record<string, unknown> | undefined): string | undefined {
  const content =
    pickString(args, ["content", "patch", "diff", "text", "value"]) ??
    args?.updates;
  return resultHash(content);
}

function inferOutcome(message: Record<string, unknown>, parsedPayload: unknown): ObjectiveStateOutcome {
  if (message.isError === true) return "failure";
  if (isRecord(parsedPayload)) {
    if (parsedPayload.partial === true || parsedPayload.status === "partial") return "partial";
    if (parsedPayload.success === false || parsedPayload.ok === false) return "failure";
    if (parsedPayload.success === true || parsedPayload.ok === true) return "success";
    if (typeof parsedPayload.exitCode === "number") {
      return parsedPayload.exitCode === 0 ? "success" : "failure";
    }
    if (optionalString(parsedPayload.error)) return "failure";
    if (parsedPayload.status === "error" || parsedPayload.status === "failed") return "failure";
    if (parsedPayload.status === "ok" || parsedPayload.status === "success") return "success";
    const outputText = [
      optionalString(parsedPayload.stdout),
      optionalString(parsedPayload.stderr),
    ].filter((entry): entry is string => entry !== undefined).join("\n");
    if (outputText) {
      const outputOutcome = inferOutcome({}, outputText);
      if (outputOutcome !== "unknown") return outputOutcome;
    }
  }
  if (typeof parsedPayload === "string") {
    const lowered = parsedPayload.toLowerCase();
    const loweredForFailure = lowered
      .replace(/\b(?:previously\s+)?failed tests?\s+now\s+pass(?:ed|es)?\b/g, "");
    const hasZeroCountMarker = /\b(?:0|no)\s+(?:errors?|failures?|exceptions?|timeouts?)\b/.test(lowered);
    const loweredForFailureCounts = loweredForFailure
      .replace(/\b(?:0|no)\s+errors?\b/g, "")
      .replace(/\b(?:0|no)\s+failures?\b/g, "")
      .replace(/\b(?:0|no)\s+exceptions?\b/g, "")
      .replace(/\b(?:0|no)\s+timeouts?\b/g, "");
    const hasNonZeroErrorCounts = /\b[1-9]\d*\s+errors?\b/.test(loweredForFailureCounts);
    const hasNegatedSuccessMarkers =
      /\b(?:not|did not|didn't|doesn't|isn't|aren't|wasn't|weren't|won't|can't|couldn't|shouldn't|wouldn't)\s+(?:ok|pass|passed|passes|succeeded|success)\b/.test(loweredForFailure);
    const hasSuccessMarkers =
      /\b(success|succeeded|pass|passes|passed|ok)\b/.test(lowered) ||
      hasZeroCountMarker;
    const hasFailureMarkers =
      hasNegatedSuccessMarkers ||
      /\b(exceptions?|failed|failures?|fatal|timeouts?|timed out)\b/.test(loweredForFailureCounts) ||
      hasNonZeroErrorCounts ||
      /\berrors?\b/.test(loweredForFailureCounts) ||
      /\b[a-z]+error\b/.test(loweredForFailureCounts) ||
      /\b[a-z]+exception\b/.test(loweredForFailureCounts);

    if (hasFailureMarkers) return "failure";
    if (hasSuccessMarkers) return "success";
  }
  return "unknown";
}

function isProcessTool(toolName: string | undefined, args: Record<string, unknown> | undefined): boolean {
  const tokens = toolNameTokens(toolName);
  const normalizedName = normalizedToolName(toolName);
  if (pickString(args, ["cmd", "command", "script"])) return true;
  return ["exec", "shell", "bash", "terminal", "run_command", "exec_command"].some((token) =>
    token.includes("_") ? normalizedName === token : tokens.includes(token),
  );
}

function isFileTool(toolName: string | undefined, args: Record<string, unknown> | undefined): boolean {
  const tokens = toolNameTokens(toolName);
  const fileScope = fileScopeFromArgs(args);
  if (fileScope.scope) return true;
  return ["file", "path", "patch", "directory", "mkdir", "rename", "move"].some((token) =>
    tokens.includes(token),
  );
}

function inferFileChangeKind(toolName: string | undefined, outcome: ObjectiveStateOutcome): ObjectiveStateChangeKind {
  if (outcome === "failure") return "failed";
  const tokens = toolNameTokens(toolName);
  if (["delete", "remove", "unlink"].some((token) => tokens.includes(token))) return "deleted";
  if (["create", "mkdir", "new"].some((token) => tokens.includes(token))) return "created";
  if (["write", "edit", "patch", "update", "append", "move", "rename"].some((token) => tokens.includes(token))) {
    return "updated";
  }
  return "observed";
}

function buildFileValueRefs(
  args: Record<string, unknown> | undefined,
  changeKind: ObjectiveStateChangeKind,
): Pick<ObjectiveStateSnapshot, "before" | "after"> {
  const { sourcePath, destinationPath, scope } = fileScopeFromArgs(args);
  const contentHash = fileContentHash(args);

  if (changeKind === "failed") {
    if (sourcePath && destinationPath && sourcePath !== destinationPath) {
      return {
        before: { ref: sourcePath },
        after: { ref: destinationPath },
      };
    }
    return {
      before: sourcePath ? { ref: sourcePath } : undefined,
      after: scope ? { ref: scope } : undefined,
    };
  }

  if (changeKind === "deleted") {
    return {
      before: scope ? { exists: true, ref: scope } : undefined,
      after: { exists: false },
    };
  }

  if (changeKind === "created") {
    return {
      after: {
        exists: true,
        ref: scope,
        valueHash: contentHash,
      },
    };
  }

  if (sourcePath && destinationPath && sourcePath !== destinationPath) {
    return {
      before: { exists: true, ref: sourcePath },
      after: {
        exists: true,
        ref: destinationPath,
      },
    };
  }

  return {
    after: {
      exists: true,
      ref: scope,
      valueHash: contentHash,
    },
  };
}

function summarizeSnapshot(
  kind: ObjectiveStateSnapshot["kind"],
  changeKind: ObjectiveStateChangeKind,
  toolName: string,
  scope: string,
): string {
  const action =
    changeKind === "executed"
      ? "Executed"
      : changeKind === "failed"
        ? "Failed"
        : changeKind === "created"
          ? "Created"
          : changeKind === "deleted"
            ? "Deleted"
            : changeKind === "updated"
              ? "Updated"
              : "Observed";
  if (kind === "process") return `${action} process via ${toolName}: ${scope}`;
  if (kind === "file") return `${action} file via ${toolName}: ${scope}`;
  return `${action} tool result from ${toolName}: ${scope}`;
}

function buildGenericToolAfterRef(outcome: ObjectiveStateOutcome, parsedPayload: unknown): ObjectiveStateSnapshot["after"] {
  const valueHash = resultHash(parsedPayload);
  return valueHash ? { valueHash } : { exists: outcome !== "failure" };
}

function snapshotIdFor(
  sessionKey: string,
  recordedAt: string,
  index: number,
  toolName: string,
  scope: string,
  stableKey?: string,
): string {
  const digest = crypto
    .createHash("sha256")
    .update(
      stableKey
        ? `${sessionKey}|${recordedAt}|${index}|${toolName}|${scope}|stable|${stableKey}`
        : `${sessionKey}|${recordedAt}|${index}|${toolName}|${scope}`,
    )
    .digest("hex")
    .slice(0, 12);
  return `obj-${digest}`;
}

function objectiveStatePartsForObservedMessage(
  message: ObservedMessageWithParts,
): LcmMessagePartInput[] {
  if (message.role === "user") {
    const explicitParts = Array.isArray(message.parts) && message.parts.length > 0
      ? sanitizeUserRoleToolResultParts(message.parts)
      : [];
    if (Array.isArray(message.parts) && message.parts.length > 0) {
      const rawParts = userRawToolResultParts(message);
      return mergeObservedEvidenceParts(explicitParts, rawParts);
    }
    return userRawToolResultParts(message);
  }
  if (message.role !== "assistant") {
    return [];
  }
  const explicitParts = Array.isArray(message.parts) && message.parts.length > 0
    ? message.parts
    : [];
  const rawParts = assistantRawObjectiveStateParts(message);
  return mergeObservedEvidenceParts(explicitParts, rawParts);
}

function userRawToolResultParts(message: ObservedMessageWithParts): LcmMessagePartInput[] {
  const rawContent = message.rawContent ?? message.content;
  if (!containsProviderToolResultBlock(rawContent)) {
    return [];
  }
  return markRawProviderParts(
    sanitizeUserRoleToolResultParts(parseMessageParts(rawContent, {
      sourceFormat: message.sourceFormat,
      allowRenderedFallback: false,
    })),
  );
}

function assistantRawObjectiveStateParts(message: ObservedMessageWithParts): LcmMessagePartInput[] {
  if (message.rawContent === undefined || message.rawContent === null) {
    return [];
  }
  return markRawProviderParts(parseMessageParts(message.rawContent, {
    sourceFormat: message.sourceFormat,
    allowRenderedFallback: false,
  }));
}

function mergeObservedEvidenceParts(
  explicitParts: LcmMessagePartInput[],
  rawParts: LcmMessagePartInput[],
): LcmMessagePartInput[] {
  if (explicitParts.length === 0) return rawParts;
  if (rawParts.length === 0) return explicitParts;

  const merged = [...explicitParts];
  const seen = new Set(
    explicitParts
      .filter(isObjectiveStateEvidencePart)
      .map(objectiveStateEvidencePartKey),
  );

  for (const part of rawParts) {
    if (!isObjectiveStateEvidencePart(part)) continue;
    const key = objectiveStateEvidencePartKey(part);
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(part);
  }

  return merged;
}

function isObjectiveStateEvidencePart(part: LcmMessagePartInput): boolean {
  return (
    part.kind === "tool_call" ||
    part.kind === "tool_result" ||
    part.kind === "file_write" ||
    part.kind === "patch"
  );
}

function objectiveStateEvidencePartKey(part: LcmMessagePartInput): string {
  const id = partToolCallId(part);
  if (id) return `${part.kind}:id:${id}`;
  const toolName = partToolName(part) ?? "";
  const filePath = partFilePath(part) ?? "";
  return `${part.kind}:shape:${toolName}:${filePath}:${stableStringify(partPayload(part))}`;
}

function flattenObservedParts(messages: readonly ObservedMessageWithParts[]): ObservedPartEntry[] {
  const entries: ObservedPartEntry[] = [];
  messages.forEach((message, messageIndex) => {
    const parts = objectiveStatePartsForObservedMessage(message);
    parts.forEach((part, partIndex) => {
      entries.push({ messageIndex, partIndex, part });
    });
  });
  return entries.sort((a, b) => {
    if (a.messageIndex !== b.messageIndex) return a.messageIndex - b.messageIndex;
    const aOrdinal = typeof a.part.ordinal === "number" ? a.part.ordinal : a.partIndex;
    const bOrdinal = typeof b.part.ordinal === "number" ? b.part.ordinal : b.partIndex;
    if (aOrdinal !== bOrdinal) return aOrdinal - bOrdinal;
    return a.partIndex - b.partIndex;
  });
}

function sanitizeUserRoleToolResultParts(parts: LcmMessagePartInput[]): LcmMessagePartInput[] {
  return parts
    .filter((part) => part.kind === "tool_result")
    .map((part) => {
      const payload = { ...partPayload(part) };
      delete payload.name;
      delete payload.tool;
      delete payload.toolName;
      delete payload.tool_name;
      return {
        ...part,
        toolName: null,
        tool_name: null,
        payload,
      };
    });
}

function containsProviderToolResultBlock(value: unknown): boolean {
  if (Array.isArray(value)) {
    return value.some(containsProviderToolResultBlock);
  }
  if (!isRecord(value)) return false;
  const type = optionalString(value.type ?? value.kind);
  if (
    type === "tool_result" ||
    type === "function_call_output"
  ) {
    return true;
  }
  return (
    containsProviderToolResultBlock(value.content) ||
    containsProviderToolResultBlock(value.output) ||
    containsProviderToolResultBlock(value.items)
  );
}

function partPayload(part: LcmMessagePartInput): Record<string, unknown> {
  return isRecord(part.payload) ? part.payload : {};
}

function partToolCallId(part: LcmMessagePartInput): string | undefined {
  const payload = partPayload(part);
  return (
    optionalString(payload.call_id) ??
    optionalString(payload.callId) ??
    optionalString(payload.id) ??
    optionalString(payload.tool_call_id) ??
    optionalString(payload.toolCallId) ??
    optionalString(payload.tool_use_id) ??
    optionalString(payload.toolUseId)
  );
}

function partToolName(part: LcmMessagePartInput): string | undefined {
  const payload = partPayload(part);
  return (
    optionalString(part.toolName) ??
    optionalString(part.tool_name) ??
    optionalString(payload.name) ??
    optionalString(payload.toolName) ??
    optionalString(payload.tool_name) ??
    (part.kind === "patch" ? "apply_patch" : undefined) ??
    (part.kind === "file_write" ? "file_write" : undefined)
  );
}

function partFilePath(part: LcmMessagePartInput): string | undefined {
  const payload = partPayload(part);
  return (
    optionalString(part.filePath) ??
    optionalString(part.file_path) ??
    optionalString(payload.path) ??
    optionalString(payload.filePath) ??
    optionalString(payload.file_path)
  );
}

function syntheticPartId(options: {
  sessionKey: string;
  messageIndex: number;
  partIndex: number;
  part: LcmMessagePartInput;
}): string {
  const digest = hashSha256(
    [
      options.sessionKey,
      String(options.messageIndex),
      String(options.part.ordinal ?? options.partIndex),
      options.part.kind,
      optionalString(options.part.toolName) ?? "",
      optionalString(options.part.tool_name) ?? "",
      optionalString(options.part.filePath) ?? "",
      optionalString(options.part.file_path) ?? "",
      stableStringify(options.part.payload),
    ].join("|"),
  ).slice(0, 12);
  return `part-${digest}`;
}

function toolArgumentsFromPart(part: LcmMessagePartInput): Record<string, unknown> {
  const payload = partPayload(part);
  const parsedArgs =
    parseToolArguments(payload.arguments) ??
    parseToolArguments(payload.input) ??
    parseToolArguments(payload.args) ??
    parseToolArguments(payload.params) ??
    payload;
  const args = { ...parsedArgs };
  const filePath = partFilePath(part);
  if (filePath && !pickString(args, ["path", "filePath", "file_path"])) {
    args.path = filePath;
  }
  if (part.kind === "patch" && !pickString(args, ["patch", "diff", "text"])) {
    const text = optionalString(payload.text) ?? optionalString(payload.patch);
    if (text) args.patch = text;
  }
  return args;
}

function toolResultContentFromPart(part: LcmMessagePartInput): unknown {
  const payload = partPayload(part);
  if ("output" in payload) return payload.output;
  if ("content" in payload) return payload.content;
  if ("result" in payload) return payload.result;
  if ("value" in payload) return payload.value;
  return payload;
}

function inlineToolResultContentFromPart(part: LcmMessagePartInput): unknown {
  const payload = partPayload(part);
  if (hasDefinedPayloadKey(payload, "output")) return payload.output;
  if (hasDefinedPayloadKey(payload, "result")) return payload.result;
  if (part.kind === "tool_result" && hasDefinedPayloadKey(payload, "value")) {
    return payload.value;
  }

  const statusPayload: Record<string, unknown> = {};
  for (const key of ["exitCode", "ok", "success", "error", "stdout", "stderr"]) {
    if (hasDefinedPayloadKey(payload, key)) {
      statusPayload[key] = payload[key];
    }
  }
  return Object.keys(statusPayload).length > 0 ? statusPayload : payload;
}

function hasDefinedPayloadKey(payload: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(payload, key) && payload[key] !== undefined;
}

function partHasInlineToolResult(part: LcmMessagePartInput): boolean {
  const payload = partPayload(part);
  return (
    hasDefinedPayloadKey(payload, "output") ||
    hasDefinedPayloadKey(payload, "result") ||
    (part.kind === "tool_result" && hasDefinedPayloadKey(payload, "value")) ||
    hasDefinedPayloadKey(payload, "exitCode") ||
    hasDefinedPayloadKey(payload, "ok") ||
    hasDefinedPayloadKey(payload, "success") ||
    hasDefinedPayloadKey(payload, "error") ||
    hasDefinedPayloadKey(payload, "stdout") ||
    hasDefinedPayloadKey(payload, "stderr")
  );
}

function toolResultIsError(part: LcmMessagePartInput): boolean {
  const payload = partPayload(part);
  return payload.isError === true ||
    payload.is_error === true ||
    payload.ok === false ||
    payload.success === false ||
    optionalString(payload.error) !== undefined;
}

function buildSyntheticAssistantToolCall(
  id: string,
  toolName: string,
  args: Record<string, unknown>,
): Record<string, unknown> {
  return {
    role: "assistant",
    tool_calls: [
      {
        id,
        function: {
          name: toolName,
          arguments: JSON.stringify(args),
        },
      },
    ],
  };
}

function observedPartsToAgentMessages(options: {
  sessionKey: string;
  messages: readonly ObservedMessageWithParts[];
}): Array<Record<string, unknown>> {
  const entries = flattenObservedParts(options.messages);
  const resultIds = new Set(
    entries
      .filter((entry) => entry.part.kind === "tool_result")
      .map((entry) => partToolCallId(entry.part))
      .filter((id): id is string => id !== undefined),
  );
  const synthetic: Array<Record<string, unknown>> = [];
  let pendingIdlessToolCallId: string | undefined;

  for (let entryIndex = 0; entryIndex < entries.length; entryIndex += 1) {
    const entry = entries[entryIndex]!;
    const { part } = entry;
    if (
      part.kind === "tool_call" ||
      part.kind === "file_write" ||
      part.kind === "patch"
    ) {
      const toolName = partToolName(part);
      if (!toolName) continue;
      const observedToolCallId = partToolCallId(part);
      const id = observedToolCallId ??
        syntheticPartId({
          sessionKey: options.sessionKey,
          messageIndex: entry.messageIndex,
          partIndex: entry.partIndex,
          part,
        });
      const args = toolArgumentsFromPart(part);
      synthetic.push(buildSyntheticAssistantToolCall(id, toolName, args));
      const nextEntry = entries[entryIndex + 1];
      const nextIsIdlessToolResult =
        nextEntry?.part.kind === "tool_result" &&
        partToolCallId(nextEntry.part) === undefined;
      pendingIdlessToolCallId = nextIsIdlessToolResult
        ? id
        : undefined;

      const hasSeparateToolResult = resultIds.has(id) || nextIsIdlessToolResult;
      if (partHasInlineToolResult(part) && !hasSeparateToolResult) {
        synthetic.push({
          role: "tool",
          tool_call_id: id,
          name: toolName,
          content: inlineToolResultContentFromPart(part),
          ...(toolResultIsError(part) ? { isError: true } : {}),
        });
        pendingIdlessToolCallId = undefined;
        continue;
      }

      if (
        (part.kind === "file_write" || part.kind === "patch") &&
        !nextIsIdlessToolResult &&
        !resultIds.has(id) &&
        !isRawProviderPart(part)
      ) {
        synthetic.push({
          role: "tool",
          tool_call_id: id,
          name: toolName,
          content: { ok: true, source: "message_part" },
        });
        pendingIdlessToolCallId = undefined;
      }
      continue;
    }

    if (part.kind === "tool_result") {
      const id = partToolCallId(part) ?? pendingIdlessToolCallId;
      const toolName = partToolName(part);
      synthetic.push({
        role: "tool",
        ...(id ? { tool_call_id: id } : {}),
        ...(toolName ? { name: toolName } : {}),
        content: toolResultContentFromPart(part),
        ...(toolResultIsError(part) ? { isError: true } : {}),
      });
      pendingIdlessToolCallId = undefined;
    }
  }

  return synthetic;
}

export function deriveObjectiveStateSnapshotsFromAgentMessages(options: {
  sessionKey: string;
  recordedAt: string;
  messages: Array<Record<string, unknown>>;
}): ObjectiveStateSnapshot[] {
  const toolCallsById = getToolCallContexts(options.messages);
  const snapshots: ObjectiveStateSnapshot[] = [];

  for (const message of options.messages) {
    if (message.role !== "tool") continue;
    const toolCallId = toolCallIdForMessage(message);
    const context = toolCallId ? toolCallsById.get(toolCallId) : undefined;
    const toolName = toolNameForMessage(message, context);
    if (!toolName) continue;

    const parsedPayload = parseToolResultPayload(message.content);
    const outcome = inferOutcome(message, parsedPayload);
    const args = context?.args;
    const command = pickString(args, ["cmd", "command", "script"]);

    let kind: ObjectiveStateSnapshot["kind"] = "tool";
    let changeKind: ObjectiveStateChangeKind = outcome === "failure" ? "failed" : "observed";
    let scope = toolName;
    let before: ObjectiveStateSnapshot["before"];
    let after: ObjectiveStateSnapshot["after"];

    if (isProcessTool(toolName, args)) {
      kind = "process";
      changeKind = outcome === "failure" ? "failed" : "executed";
      scope = command ?? toolName;
      after = { exists: outcome !== "failure", valueHash: resultHash(parsedPayload) };
    } else if (isFileTool(toolName, args)) {
      kind = "file";
      changeKind = inferFileChangeKind(toolName, outcome);
      const fileScope = fileScopeFromArgs(args);
      scope = fileScope.scope ?? toolName;
      const refs = buildFileValueRefs(args, changeKind);
      before = refs.before;
      after = refs.after;
    } else {
      after = buildGenericToolAfterRef(outcome, parsedPayload);
    }

    snapshots.push({
      schemaVersion: 1,
      snapshotId: snapshotIdFor(
        options.sessionKey,
        options.recordedAt,
        snapshots.length,
        toolName,
        scope,
        toolCallId,
      ),
      recordedAt: options.recordedAt,
      sessionKey: options.sessionKey,
      source: "tool_result",
      kind,
      changeKind,
      scope,
      summary: summarizeSnapshot(kind, changeKind, toolName, scope),
      toolName,
      command,
      outcome,
      before,
      after,
      tags: ["agent-end", `tool:${toolName}`],
      metadata: toolCallId ? { toolCallId } : undefined,
    });
  }

  return snapshots;
}

export function deriveObjectiveStateSnapshotsFromObservedMessages(options: {
  sessionKey: string;
  recordedAt: string;
  messages: readonly ObservedMessageWithParts[];
}): ObjectiveStateSnapshot[] {
  const syntheticMessages = observedPartsToAgentMessages({
    sessionKey: options.sessionKey,
    messages: options.messages,
  });
  if (syntheticMessages.length === 0) return [];

  return deriveObjectiveStateSnapshotsFromAgentMessages({
    sessionKey: options.sessionKey,
    recordedAt: options.recordedAt,
    messages: syntheticMessages,
  });
}

export async function recordObjectiveStateSnapshotsFromAgentMessages(options: {
  memoryDir: string;
  objectiveStateStoreDir?: string;
  objectiveStateMemoryEnabled: boolean;
  objectiveStateSnapshotWritesEnabled: boolean;
  sessionKey: string;
  recordedAt: string;
  messages: Array<Record<string, unknown>>;
}): Promise<DerivedObjectiveStateResult> {
  if (!options.objectiveStateMemoryEnabled || !options.objectiveStateSnapshotWritesEnabled) {
    return { snapshots: [], filePaths: [] };
  }

  const snapshots = deriveObjectiveStateSnapshotsFromAgentMessages({
    sessionKey: options.sessionKey,
    recordedAt: options.recordedAt,
    messages: options.messages,
  });

  const filePaths: string[] = [];
  for (const snapshot of snapshots) {
    filePaths.push(
      await recordObjectiveStateSnapshot({
        memoryDir: options.memoryDir,
        objectiveStateStoreDir: options.objectiveStateStoreDir,
        snapshot,
      }),
    );
  }

  return { snapshots, filePaths };
}

export async function recordObjectiveStateSnapshotsFromObservedMessages(options: {
  memoryDir: string;
  objectiveStateStoreDir?: string;
  objectiveStateMemoryEnabled: boolean;
  objectiveStateSnapshotWritesEnabled: boolean;
  sessionKey: string;
  recordedAt: string;
  messages: readonly ObservedMessageWithParts[];
}): Promise<DerivedObjectiveStateResult> {
  if (!options.objectiveStateMemoryEnabled || !options.objectiveStateSnapshotWritesEnabled) {
    return { snapshots: [], filePaths: [] };
  }

  const snapshots = deriveObjectiveStateSnapshotsFromObservedMessages({
    sessionKey: options.sessionKey,
    recordedAt: options.recordedAt,
    messages: options.messages,
  });

  const filePaths: string[] = [];
  for (const snapshot of snapshots) {
    filePaths.push(
      await recordObjectiveStateSnapshot({
        memoryDir: options.memoryDir,
        objectiveStateStoreDir: options.objectiveStateStoreDir,
        snapshot,
      }),
    );
  }

  return { snapshots, filePaths };
}
