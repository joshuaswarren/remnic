export type LcmMessagePartKind =
  | "text"
  | "tool_call"
  | "tool_result"
  | "patch"
  | "file_read"
  | "file_write"
  | "step_start"
  | "step_finish"
  | "snapshot"
  | "retry";

export const LCM_MESSAGE_PART_KINDS: readonly LcmMessagePartKind[] = [
  "text",
  "tool_call",
  "tool_result",
  "patch",
  "file_read",
  "file_write",
  "step_start",
  "step_finish",
  "snapshot",
  "retry",
] as const;

export type MessagePartSourceFormat =
  | "openai"
  | "anthropic"
  | "openclaw"
  | "pi"
  | "lossless-claw"
  | "remnic";

export interface LcmMessagePartInput {
  ordinal?: number | null;
  kind: LcmMessagePartKind;
  payload: Record<string, unknown>;
  toolName?: string | null;
  tool_name?: string | null;
  filePath?: string | null;
  file_path?: string | null;
  createdAt?: string | null;
  created_at?: string | null;
}

export interface LcmMessagePartRow extends LcmMessagePartInput {
  id: number;
  messageId: number;
  ordinal: number;
  payloadJson: string;
  createdAt: string;
}

export interface ParseMessagePartsOptions {
  sourceFormat?: MessagePartSourceFormat;
  renderedContent?: string;
  allowRenderedFallback?: boolean;
}

const SECRET_KEY_RE = /(api[_-]?key|authorization|bearer|credential|password|secret|token)/i;
const MAX_PAYLOAD_STRING = 8_000;
const MAX_FILE_SCAN_CHARS = 20_000;

export function isLcmMessagePartKind(value: unknown): value is LcmMessagePartKind {
  return (
    typeof value === "string" &&
    (LCM_MESSAGE_PART_KINDS as readonly string[]).includes(value)
  );
}

export function parseMessageParts(
  input: unknown,
  options: ParseMessagePartsOptions = {},
): LcmMessagePartInput[] {
  const explicit = normalizeExplicitParts(input);
  if (explicit.length > 0) return explicit;

  const format = options.sourceFormat ?? inferSourceFormat(input);
  switch (format) {
    case "openai":
      return withRenderedFallback(parseOpenAiMessageParts(input, options), options);
    case "anthropic":
      return withRenderedFallback(parseAnthropicMessageParts(input, options), options);
    case "openclaw":
      return withRenderedFallback(parseOpenClawMessageParts(input, options), options);
    case "pi":
      return withRenderedFallback(parsePiMessageParts(input, options), options);
    case "lossless-claw":
    case "remnic":
      return withRenderedFallback(normalizeExplicitParts(input), options);
    default:
      return renderedFallbackParts(options);
  }
}

export function normalizeExplicitParts(input: unknown): LcmMessagePartInput[] {
  const rawParts = pickArray(input, "parts") ?? pickArray(input, "message_parts");
  if (!rawParts) return [];

  const parts: LcmMessagePartInput[] = [];
  rawParts.forEach((raw, index) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return;
    const obj = raw as Record<string, unknown>;
    const kind = normalizeKind(obj.kind ?? obj.type);
    if (!kind) return;

    const payload =
      obj.payload && typeof obj.payload === "object" && !Array.isArray(obj.payload)
        ? (obj.payload as Record<string, unknown>)
        : { value: sanitizePayload(obj) };
    const toolName = asNonEmptyString(obj.toolName ?? obj.tool_name ?? obj.name);
    const filePath = asNonEmptyString(obj.filePath ?? obj.file_path ?? obj.path);
    const ordinal =
      typeof obj.ordinal === "number" && Number.isInteger(obj.ordinal)
        ? Math.max(0, obj.ordinal)
        : index;

    parts.push({
      ordinal,
      kind,
      payload: sanitizePayload(payload) as Record<string, unknown>,
      toolName,
      filePath,
      createdAt: asNonEmptyString(obj.createdAt ?? obj.created_at),
    });
  });
  return parts;
}

export function parseOpenAiMessageParts(
  input: unknown,
  _options: ParseMessagePartsOptions = {},
): LcmMessagePartInput[] {
  const items = gatherOpenAiItems(input);
  const parts: LcmMessagePartInput[] = [];
  for (const item of items) {
    const type = asNonEmptyString(item.type) ?? asNonEmptyString(item.kind);
    if (!type) continue;
    if (isOpenAiContentBlock(item)) {
      const text = asNonEmptyString(item.text ?? item.content);
      if (text) parts.push(makePart("text", { type, text }, { filePath: firstFilePath(text) }));
      continue;
    }
    if (type === "message") {
      for (const block of gatherContentBlocks(item.content)) {
        const text = asNonEmptyString(block.text ?? block.content);
        if (text) parts.push(makePart("text", { type, text }, { filePath: firstFilePath(text) }));
      }
      continue;
    }
    if (type === "function_call") {
      const toolName = asNonEmptyString(item.name ?? item.tool_name);
      const callId = asNonEmptyString(item.call_id ?? item.callId);
      const itemId = asNonEmptyString(item.id);
      const payload = {
        id: callId ?? itemId,
        ...(callId ? { call_id: callId } : {}),
        ...(itemId && itemId !== callId ? { response_item_id: itemId } : {}),
        name: toolName,
        arguments: parseMaybeJson(item.arguments),
      };
      parts.push(classifyToolPart(toolName, payload));
      continue;
    }
    if (type === "function_call_output") {
      const output = asNonEmptyString(item.output) ?? JSON.stringify(sanitizePayload(item.output ?? item));
      const callId = asNonEmptyString(item.call_id ?? item.callId);
      const itemId = asNonEmptyString(item.id);
      parts.push(makePart("tool_result", {
        id: callId ?? itemId,
        ...(callId ? { call_id: callId } : {}),
        ...(itemId && itemId !== callId ? { response_item_id: itemId } : {}),
        output,
      }, {
        filePath: firstFilePath(output),
      }));
      continue;
    }
    if (type === "reasoning") {
      parts.push(makePart("step_start", { type, summary: sanitizePayload(item.summary ?? item) }));
      continue;
    }
    if (type === "retry") {
      parts.push(makePart("retry", { type, item: sanitizePayload(item) }));
    }
  }
  return withOrdinals(parts);
}

export function parseAnthropicMessageParts(
  input: unknown,
  _options: ParseMessagePartsOptions = {},
): LcmMessagePartInput[] {
  const blocks = gatherContentBlocks(
    Array.isArray(input) ? input : input && typeof input === "object" ? (input as Record<string, unknown>).content : input,
  );
  const parts: LcmMessagePartInput[] = [];
  for (const block of blocks) {
    const type = asNonEmptyString(block.type ?? block.kind);
    if (type === "text") {
      const text = asNonEmptyString(block.text);
      if (text) parts.push(makePart("text", { type, text }, { filePath: firstFilePath(text) }));
      continue;
    }
    if (type === "tool_use") {
      const toolName = asNonEmptyString(block.name);
      parts.push(classifyToolPart(toolName, {
        id: block.id,
        name: toolName,
        input: sanitizePayload(block.input),
      }));
      continue;
    }
    if (type === "tool_result") {
      const content = block.content;
      const rendered = renderUnknownContent(content);
      parts.push(makePart("tool_result", {
        id: block.tool_use_id,
        content: sanitizePayload(content),
        ...(typeof block.is_error === "boolean" ? { is_error: block.is_error } : {}),
        ...(typeof block.isError === "boolean" ? { isError: block.isError } : {}),
      }, {
        filePath: firstFilePath(rendered),
      }));
      continue;
    }
    if (type === "thinking") {
      parts.push(makePart("step_start", {
        type,
        thinking: truncateString(asNonEmptyString(block.thinking) ?? ""),
        signature: asNonEmptyString(block.signature),
      }));
      continue;
    }
    if (type === "redacted_thinking") {
      parts.push(makePart("step_finish", { type }));
    }
  }
  return withOrdinals(parts);
}

export function parseOpenClawMessageParts(
  input: unknown,
  options: ParseMessagePartsOptions = {},
): LcmMessagePartInput[] {
  const explicit = normalizeExplicitParts(input);
  if (explicit.length > 0) return explicit;
  if (!input || typeof input !== "object") return [];
  const obj = input as Record<string, unknown>;

  const content = obj.content;
  if (Array.isArray(content)) {
    const hasOpenAiBlocks = content.some(isOpenAiContentBlock);
    if (hasOpenAiBlocks) return parseOpenAiMessageParts(content, options);
    const hasAnthropicBlocks = content.some(isAnthropicContentBlock);
    if (hasAnthropicBlocks) return parseAnthropicMessageParts({ content }, options);
    const piParts = parsePiMessageParts(input, { ...options, allowRenderedFallback: false });
    if (piParts.length > 0) return piParts;
  }

  const toolName = asNonEmptyString(obj.toolName ?? obj.tool_name ?? obj.name);
  if (toolName) {
    return withOrdinals([
      classifyToolPart(toolName, {
        name: toolName,
        input: sanitizePayload(obj.input ?? obj.arguments ?? obj.params),
        output: sanitizePayload(obj.output ?? obj.result),
      }),
    ]);
  }

  const rendered = options.allowRenderedFallback === false
    ? null
    : options.renderedContent ?? asNonEmptyString(obj.content);
  return rendered ? withOrdinals(partsFromRenderedText(rendered)) : [];
}

export function parsePiMessageParts(
  input: unknown,
  options: ParseMessagePartsOptions = {},
): LcmMessagePartInput[] {
  const explicit = normalizeExplicitParts(input);
  if (explicit.length > 0) return explicit;
  if (!isRecord(input)) return renderedFallbackParts(options);

  if (input.role === "bashExecution") {
    const command = asNonEmptyString(input.command);
    const output = asNonEmptyString(input.output);
    const rendered = [command ? `Ran ${command}` : null, output].filter(Boolean).join("\n");
    return withOrdinals([
      makePart("tool_result", {
        role: "bashExecution",
        command,
        output,
        exitCode: input.exitCode ?? input.exit_code,
      }, {
        toolName: "bashExecution",
        filePath: firstFilePathFromObject(input) ?? firstFilePath(rendered),
      }),
    ]);
  }

  const topLevelType = asNonEmptyString(input.type ?? input.kind ?? input.role);
  if (topLevelType === "toolResult" || topLevelType === "tool_result") {
    const toolName = asNonEmptyString(input.name ?? input.toolName ?? input.tool_name);
    const output = input.output ?? input.result ?? input.content;
    const rendered = renderUnknownContent(output ?? input);
    return withOrdinals([
      makePart("tool_result", {
        id: input.id ?? input.toolCallId ?? input.tool_call_id,
        name: toolName,
        output: sanitizePayload(output),
        ...(typeof input.isError === "boolean" ? { isError: input.isError } : {}),
        ...(typeof input.is_error === "boolean" ? { is_error: input.is_error } : {}),
      }, {
        toolName,
        filePath: firstFilePathFromObject(input) ?? firstFilePath(rendered),
      }),
    ]);
  }

  const content = input.content;
  const blocks = Array.isArray(content) ? content.filter(isRecord) : [];
  const parts: LcmMessagePartInput[] = [];

  if (typeof content === "string") {
    parts.push(makePart("text", { text: content }, { filePath: firstFilePath(content) }));
  }

  blocks.forEach((block, ordinal) => {
    const type = asNonEmptyString(block.type ?? block.kind);
    if (type === "text") {
      const text = asNonEmptyString(block.text ?? block.content);
      if (text) parts.push({ ...makePart("text", { type, text }, { filePath: firstFilePath(text) }), ordinal });
      return;
    }
    if (type === "toolCall" || type === "tool_call") {
      const toolName = asNonEmptyString(block.name ?? block.toolName ?? block.tool_name);
      const payload = {
        id: block.id,
        name: toolName,
        arguments: sanitizePayload(block.arguments ?? block.args ?? block.input ?? block.params),
      };
      parts.push({ ...classifyToolPart(toolName, payload), ordinal });
      return;
    }
    if (type === "toolResult" || type === "tool_result") {
      const rendered = renderUnknownContent(block.output ?? block.result ?? block.content ?? block);
      parts.push({
        ...makePart("tool_result", {
          id: block.id ?? block.toolCallId ?? block.tool_call_id,
          name: asNonEmptyString(block.name ?? block.toolName ?? block.tool_name),
          output: sanitizePayload(block.output ?? block.result ?? block.content),
          ...(typeof block.isError === "boolean" ? { isError: block.isError } : {}),
          ...(typeof block.is_error === "boolean" ? { is_error: block.is_error } : {}),
        }, {
          toolName: asNonEmptyString(block.name ?? block.toolName ?? block.tool_name),
          filePath: firstFilePathFromObject(block) ?? firstFilePath(rendered),
        }),
        ordinal,
      });
    }
  });

  const toolName = asNonEmptyString(input.toolName ?? input.tool_name ?? input.name);
  if (parts.length === 0 && toolName) {
    parts.push(classifyToolPart(toolName, {
      name: toolName,
      arguments: sanitizePayload(input.arguments ?? input.args ?? input.input ?? input.params),
      output: sanitizePayload(input.output ?? input.result),
    }));
  }

  return withRenderedFallback(withOrdinals(parts), options);
}

export function partsFromRenderedText(text: string): LcmMessagePartInput[] {
  if (text.includes("*** Begin Patch")) {
    const paths = extractFilePaths(text);
    const patchPaths = extractPatchPaths(text);
    return withOrdinals((patchPaths.length > 0 ? patchPaths : paths).map((filePath) =>
      makePart("patch", { text: truncateString(text) }, { filePath })
    ));
  }
  const paths = extractFilePaths(text);
  if (paths.length === 0) return [];
  return withOrdinals(paths.map((filePath) =>
    makePart("file_read", { text: truncateString(text) }, { filePath })
  ));
}

function inferSourceFormat(input: unknown): MessagePartSourceFormat | undefined {
  if (input && typeof input === "object") {
    const obj = input as Record<string, unknown>;
    const explicit = asNonEmptyString(obj.sourceFormat ?? obj.source_format);
    if (explicit === "openai" || explicit === "anthropic" || explicit === "openclaw" || explicit === "pi" || explicit === "lossless-claw" || explicit === "remnic") {
      return explicit;
    }
    if (Array.isArray(obj.output)) return "openai";
    if (isOpenAiResponseItem(obj)) return "openai";
    if (Array.isArray(obj.content) && obj.content.some(isOpenAiContentBlock)) return "openai";
    if (isAnthropicMessageObject(obj)) return "anthropic";
    if (isPiMessageObject(obj)) return "pi";
    if (Array.isArray(obj.content)) return "anthropic";
  }
  if (Array.isArray(input)) {
    return input.some((item) =>
      isRecord(item) && (isOpenAiResponseItem(item) || isOpenAiContentBlock(item))
    )
      ? "openai"
      : "anthropic";
  }
  return undefined;
}

function isPiMessageObject(obj: Record<string, unknown>): boolean {
  if (obj.role === "bashExecution") return true;
  if (obj.role === "toolResult" || obj.role === "tool_result") return true;
  const type = asNonEmptyString(obj.type ?? obj.kind);
  if (type === "toolCall" || type === "tool_call" || type === "toolResult" || type === "tool_result") return true;
  if (!Array.isArray(obj.content)) return false;
  return obj.content.some((block) => {
    if (!isRecord(block)) return false;
    const blockType = asNonEmptyString(block.type ?? block.kind);
    return blockType === "toolCall" || blockType === "tool_call" || blockType === "toolResult" || blockType === "tool_result";
  });
}

function isAnthropicMessageObject(obj: Record<string, unknown>): boolean {
  if (isAnthropicContentBlock(obj)) return true;
  if (!Array.isArray(obj.content)) return false;
  return obj.content.some(isAnthropicContentBlock);
}

function isAnthropicContentBlock(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const type = asNonEmptyString(value.type ?? value.kind);
  if (type === "tool_use" || type === "thinking" || type === "redacted_thinking") return true;
  return type === "tool_result" && value.tool_use_id !== undefined;
}

function isOpenAiResponseItem(obj: Record<string, unknown>): boolean {
  const type = asNonEmptyString(obj.type ?? obj.kind);
  return (
    type === "message" ||
    type === "function_call" ||
    type === "function_call_output" ||
    type === "reasoning" ||
    type === "retry"
  );
}

function isOpenAiContentBlock(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const type = asNonEmptyString(value.type);
  return (
    type === "input_text" ||
    type === "output_text" ||
    type === "input_image" ||
    type === "input_file" ||
    type === "refusal"
  );
}

function gatherOpenAiItems(input: unknown): Record<string, unknown>[] {
  if (Array.isArray(input)) return input.filter(isRecord);
  if (!isRecord(input)) return [];
  if (Array.isArray(input.output)) return input.output.filter(isRecord);
  if (Array.isArray(input.items)) return input.items.filter(isRecord);
  return [input];
}

function gatherContentBlocks(input: unknown): Record<string, unknown>[] {
  if (Array.isArray(input)) return input.filter(isRecord);
  if (typeof input === "string") return [{ type: "text", text: input }];
  if (isRecord(input)) return [input];
  return [];
}

function classifyToolPart(
  toolName: string | null | undefined,
  payload: Record<string, unknown>,
): LcmMessagePartInput {
  const normalized = (toolName ?? "").toLowerCase();
  const rendered = renderUnknownContent(payload);
  const filePath =
    firstFilePathFromObject(payload) ?? firstFilePath(rendered) ?? null;

  if (normalized.includes("apply_patch") || rendered.includes("*** Begin Patch")) {
    return makePart("patch", payload, { toolName, filePath: filePath ?? extractPatchPaths(rendered)[0] ?? null });
  }
  if (/(write|edit|multiedit|create|save)/i.test(normalized)) {
    return makePart("file_write", payload, { toolName, filePath });
  }
  if (/(read|grep|glob|search|list|ls)/i.test(normalized)) {
    return makePart("file_read", payload, { toolName, filePath });
  }
  return makePart("tool_call", payload, { toolName, filePath });
}

function makePart(
  kind: LcmMessagePartKind,
  payload: Record<string, unknown>,
  options: { toolName?: string | null; filePath?: string | null } = {},
): LcmMessagePartInput {
  return {
    kind,
    payload: sanitizePayload(payload) as Record<string, unknown>,
    toolName: options.toolName ?? null,
    filePath: options.filePath ?? null,
  };
}

function withOrdinals(parts: LcmMessagePartInput[]): LcmMessagePartInput[] {
  return parts.map((part, ordinal) => ({ ...part, ordinal: part.ordinal ?? ordinal }));
}

function withRenderedFallback(
  parts: LcmMessagePartInput[],
  options: ParseMessagePartsOptions,
): LcmMessagePartInput[] {
  return parts.length > 0 ? parts : renderedFallbackParts(options);
}

function renderedFallbackParts(options: ParseMessagePartsOptions): LcmMessagePartInput[] {
  if (options.allowRenderedFallback === false) {
    return [];
  }
  const rendered = asNonEmptyString(options.renderedContent);
  return rendered ? partsFromRenderedText(rendered) : [];
}

function normalizeKind(value: unknown): LcmMessagePartKind | null {
  if (isLcmMessagePartKind(value)) return value;
  if (value === "tool_use" || value === "function_call") return "tool_call";
  if (value === "function_call_output") return "tool_result";
  if (value === "thinking" || value === "reasoning") return "step_start";
  return null;
}

function pickArray(input: unknown, key: string): unknown[] | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const value = (input as Record<string, unknown>)[key];
  return Array.isArray(value) ? value : null;
}

function asNonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function parseMaybeJson(value: unknown): unknown {
  if (typeof value !== "string") return sanitizePayload(value);
  try {
    return sanitizePayload(JSON.parse(value));
  } catch {
    return truncateString(value);
  }
}

function sanitizePayload(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === "string") return truncateString(value);
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) {
    if (depth >= 4) return "[truncated]";
    return value.slice(0, 100).map((item) => sanitizePayload(item, depth + 1));
  }
  if (typeof value === "object") {
    if (depth >= 4) return "[truncated]";
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      out[key] = SECRET_KEY_RE.test(key) ? "[redacted]" : sanitizePayload(child, depth + 1);
    }
    return out;
  }
  return String(value);
}

function truncateString(value: string): string {
  return value.length > MAX_PAYLOAD_STRING
    ? `${value.slice(0, MAX_PAYLOAD_STRING)}...[truncated]`
    : value;
}

function renderUnknownContent(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value ?? "");
  } catch {
    return String(value ?? "");
  }
}

function firstFilePathFromObject(value: unknown): string | null {
  if (!isRecord(value)) return null;
  const keys = ["file_path", "filePath", "path", "filename", "cwd"];
  for (const key of keys) {
    const candidate = asNonEmptyString(value[key]);
    if (candidate) return candidate;
  }
  for (const child of Object.values(value)) {
    if (typeof child === "string") {
      const fromText = extractPatchPaths(child)[0] ?? firstFilePath(child);
      if (fromText) return fromText;
    }
    if (isRecord(child)) {
      const nested = firstFilePathFromObject(child);
      if (nested) return nested;
    }
  }
  return null;
}

function firstFilePath(text: string): string | null {
  return extractFilePaths(text)[0] ?? null;
}

function extractFilePaths(text: string): string[] {
  const out = new Set<string>();
  let token = "";
  const scanLength = Math.min(text.length, MAX_FILE_SCAN_CHARS);
  for (let index = 0; index <= scanLength; index += 1) {
    const char = index < scanLength ? text[index]! : " ";
    if (isFilePathTokenSeparator(char)) {
      addFilePathCandidate(out, token);
      token = "";
      continue;
    }
    token += char;
    if (token.length > 512) {
      addFilePathCandidate(out, token);
      token = "";
    }
  }
  return [...out].slice(0, 20);
}

function isFilePathTokenSeparator(char: string): boolean {
  return (
    char === " " ||
    char === "\n" ||
    char === "\r" ||
    char === "\t" ||
    char === "\"" ||
    char === "'" ||
    char === "`" ||
    char === "(" ||
    char === ")" ||
    char === "[" ||
    char === "]" ||
    char === "{" ||
    char === "}" ||
    char === "<" ||
    char === ">" ||
    char === ","
  );
}

function addFilePathCandidate(out: Set<string>, raw: string): void {
  const candidate = trimFilePathPunctuation(raw);
  if (candidate.length === 0 || candidate.includes("://")) return;
  if (isLikelyFilePath(candidate)) out.add(candidate);
}

function trimFilePathPunctuation(raw: string): string {
  let start = 0;
  let end = raw.length;
  while (start < end && isLeadingFilePathPunctuation(raw[start]!)) start += 1;
  while (end > start && isTrailingFilePathPunctuation(raw[end - 1]!)) end -= 1;
  return raw.slice(start, end);
}

function isLeadingFilePathPunctuation(char: string): boolean {
  return (
    char === ":" ||
    char === ";" ||
    char === "!" ||
    char === "?" ||
    char === "|" ||
    char === "*" ||
    char === "="
  );
}

function isTrailingFilePathPunctuation(char: string): boolean {
  return (
    char === "." ||
    char === ":" ||
    char === ";" ||
    char === "!" ||
    char === "?" ||
    char === "|" ||
    char === "*" ||
    char === "="
  );
}

function isLikelyFilePath(value: string): boolean {
  if (value.startsWith("/") || value.startsWith("./") || value.startsWith("../") || value.startsWith("~/")) {
    return hasValidFileExtension(value);
  }
  if (value.includes("/")) return hasValidFileExtension(value);
  return hasValidFileExtension(value);
}

function hasValidFileExtension(value: string): boolean {
  const lastSlash = value.lastIndexOf("/");
  const basename = value.slice(lastSlash + 1);
  if (isKnownExtensionlessRepositoryFile(basename)) return true;
  if (isKnownBareDotfile(basename)) return true;
  if (isBasenameDotfile(basename)) return isPathLikeFilePath(value);
  const dot = basename.lastIndexOf(".");
  if (dot <= 0 || dot === basename.length - 1) return false;
  const ext = basename.slice(dot + 1);
  if (ext.length < 1 || ext.length > 12) return false;
  for (const char of ext) {
    if (!isFileExtensionChar(char)) return false;
  }
  return true;
}

function isKnownExtensionlessRepositoryFile(basename: string): boolean {
  return /^(Dockerfile|Containerfile|Makefile|GNUmakefile|LICENSE|NOTICE|README|CHANGELOG|Procfile)$/.test(basename);
}

function isKnownBareDotfile(basename: string): boolean {
  return /^(\.env|\.gitignore|\.gitattributes|\.npmrc|\.yarnrc|\.editorconfig|\.prettierrc|\.eslintrc)$/.test(basename);
}

function isPathLikeFilePath(value: string): boolean {
  return value.startsWith("/") || value.startsWith("./") || value.startsWith("../") || value.startsWith("~/") || value.includes("/");
}

function isBasenameDotfile(basename: string): boolean {
  return /^\.[A-Za-z0-9][A-Za-z0-9._+-]*$/.test(basename);
}

function isFileExtensionChar(char: string): boolean {
  const code = char.charCodeAt(0);
  return (
    (code >= 48 && code <= 57) ||
    (code >= 65 && code <= 90) ||
    (code >= 97 && code <= 122) ||
    char === "_" ||
    char === "+" ||
    char === "-"
  );
}

function extractPatchPaths(text: string): string[] {
  const out = new Set<string>();
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/);
    if (match?.[1]) out.add(match[1].trim());
    const move = line.match(/^\*\*\* Move to: (.+)$/);
    if (move?.[1]) out.add(move[1].trim());
  }
  return [...out].slice(0, 20);
}
