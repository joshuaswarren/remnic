import test from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { FallbackLlmClient } from "../src/fallback-llm.ts";

test("FallbackLlmClient.parseWithSchema extracts the correct JSON when multiple JSON blocks exist", async () => {
  const Schema = z.object({ ok: z.literal(true) });

  const client = new FallbackLlmClient({} as any);

  // Stub: simulate an LLM response that includes an example JSON block and then the real answer.
  (client as any).chatCompletion = async () => ({
    content:
      "Here is an example:\n" +
      "```json\n" +
      "{ \"ok\": false }\n" +
      "```\n\n" +
      "And here is the real answer:\n" +
      "{ \"ok\": true }",
    modelUsed: "stub/model",
  });

  const out = await client.parseWithSchema(
    [
      { role: "system", content: "Return JSON." },
      { role: "user", content: "Do the thing." },
    ],
    { parse: (d: unknown) => Schema.parse(d) },
  );

  assert.deepEqual(out, { ok: true });
});

