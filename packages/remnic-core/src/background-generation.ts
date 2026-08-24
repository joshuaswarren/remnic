import { extractJsonCandidates } from "./json-extract.js";
import type { PluginConfig } from "./types.js";

export type BackgroundGenerationMessage = {
  role: string;
  content: string;
};

export async function completeBackgroundGeneration(
  config: Pick<PluginConfig, "backgroundGeneration">,
  messages: BackgroundGenerationMessage[],
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  const background = config.backgroundGeneration;
  if (!background) {
    throw new Error("backgroundGeneration is not configured");
  }
  const response = await fetchImpl(background.endpoint, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${background.token}`,
    },
    body: JSON.stringify({ messages }),
    signal: AbortSignal.timeout(Math.max(1, background.timeoutSeconds) * 1000),
  });
  if (!response.ok) {
    throw new Error(`background generation failed (${response.status})`);
  }
  const payload = (await response.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const text = payload.choices?.[0]?.message?.content;
  if (typeof text !== "string" || text.length === 0) {
    throw new Error("background generation returned no content");
  }
  return text;
}

export function parseBackgroundGenerationJson<T>(
  text: string,
  parse: (value: unknown) => T,
): T | null {
  for (const candidate of extractJsonCandidates(text)) {
    try {
      return parse(JSON.parse(candidate));
    } catch {
      // keep trying candidates
    }
  }
  return null;
}
