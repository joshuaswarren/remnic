/**
 * Native json_schema capability shaping for the local LLM client.
 *
 * A provider that rejects the schema PAYLOAD itself (strict parsers that die
 * on draft-7 nullable `type` unions, e.g. MiniMax-M3.1-Flash on 2026-11-05:
 * "invalid params, Mismatch type string with value array") gets the pre-#3248
 * shape: no response_format, the JSON contract stays in the prompt. The
 * rejection is learned per model and persisted through the ModelRegistry so
 * fresh runtimes shape requests correctly without re-proving it; a
 * schema-carrying success persists `structuredOutput: "native"`.
 */

import type { ResponseFormatJSONSchema } from "openai/resources/shared";
import type { LocalLlmChatCompletionOptions } from "./local-llm-helpers.js";
import type { ModelRegistry } from "./model-registry.js";

export interface LocalLlmChatRequestBody {
  model: string;
  messages: Array<{ role: string; content: string }>;
  temperature: number;
  max_tokens: number;
  stream: boolean;
  response_format?: { type: string } | ResponseFormatJSONSchema;
  chat_template_kwargs?: { enable_thinking: boolean };
  reasoning_effort?: string;
}

export class NativeSchemaGate {
  /** Models rejected in this process — the fallback for registry-less clients. */
  private readonly rejectedByProcess = new Set<string>();

  constructor(private readonly registry: () => ModelRegistry | undefined) {}

  usable(modelId: string): boolean {
    const registry = this.registry();
    if (registry) return registry.getStructuredOutput(modelId) !== "none";
    return !this.rejectedByProcess.has(modelId);
  }

  rememberRejection(modelId: string): void {
    const registry = this.registry();
    if (registry) registry.setStructuredOutput(modelId, "none");
    else this.rejectedByProcess.add(modelId);
  }

  attach(
    requestBody: LocalLlmChatRequestBody,
    options: Pick<LocalLlmChatCompletionOptions, "responseFormat">,
    modelId: string,
  ): void {
    if (options.responseFormat?.type === "json_schema" && this.usable(modelId)) {
      requestBody.response_format = options.responseFormat;
    }
  }

  recordSuccess(requestBody: LocalLlmChatRequestBody, modelId: string): void {
    const registry = this.registry();
    if (
      !requestBody.response_format ||
      !registry ||
      registry.getStructuredOutput(modelId) !== undefined
    ) {
      return;
    }
    registry.setStructuredOutput(modelId, "native");
  }
}
