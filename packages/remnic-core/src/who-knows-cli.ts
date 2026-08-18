/**
 * Input-validation + rendering helpers for the `remnic who-knows` CLI
 * command (issue #2057). Extracted so validation paths can be unit-tested
 * without booting an orchestrator (same pattern as `recall-xray-cli.ts`).
 *
 * Rules 14 + 51: bare `--limit`, non-integer or out-of-range values, and an
 * empty topic throw listed-options errors — never silent defaults.
 */

import {
  validateWhoKnowsInput,
  WHO_KNOWS_DEFAULT_LIMIT,
  WHO_KNOWS_MAX_LIMIT,
  type WhoKnowsResult,
} from "./who-knows.js";

export interface ParsedWhoKnowsCliOptions {
  topic: string;
  limit: number;
  namespace?: string;
  json: boolean;
}

/** Split raw argv into the positional topic and a flag bag. Value flags error when bare. */
export function extractWhoKnowsRawArgs(rest: string[]): {
  topic: string;
  options: Record<string, unknown>;
} {
  const VALUE_FLAGS: Record<string, true> = { "--limit": true, "--namespace": true };
  const positional: string[] = [];
  const options: Record<string, unknown> = {};
  for (let i = 0; i < rest.length; i++) {
    const token = rest[i];
    if (token.startsWith("--")) {
      if (token === "--json") {
        options.json = true;
      } else if (VALUE_FLAGS[token]) {
        const value = rest[i + 1];
        if (value === undefined || value.startsWith("--")) {
          throw new Error(`who-knows: ${token} expects a value`);
        }
        options[token.slice(2)] = value;
        i += 1;
      } else {
        throw new Error(`who-knows: unknown option ${token} (expected --limit, --namespace, or --json)`);
      }
    } else {
      positional.push(token);
    }
  }
  return { topic: positional.join(" ").trim(), options };
}

/** Validate the full option bag. Throws listed-options errors for bad input. */
export function parseWhoKnowsCliOptions(rawTopic: unknown, options: Record<string, unknown>): ParsedWhoKnowsCliOptions {
  if (typeof rawTopic !== "string" || rawTopic.trim().length === 0) {
    throw new Error("who-knows: topic is required and must be non-empty");
  }
  let limit = WHO_KNOWS_DEFAULT_LIMIT;
  if (options.limit !== undefined) {
    const parsed = typeof options.limit === "number" ? options.limit : Number(options.limit);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > WHO_KNOWS_MAX_LIMIT) {
      throw new Error(`who-knows: --limit expects an integer between 1 and ${WHO_KNOWS_MAX_LIMIT}`);
    }
    limit = parsed;
  }
  const namespace = typeof options.namespace === "string" && options.namespace.trim().length > 0
    ? options.namespace.trim()
    : undefined;
  validateWhoKnowsInput(rawTopic, limit);
  return { topic: rawTopic.trim(), limit, namespace, json: options.json === true };
}

export function renderWhoKnowsJson(result: WhoKnowsResult): string {
  return JSON.stringify(result, null, 2);
}

export function renderWhoKnowsText(result: WhoKnowsResult): string {
  if (result.results.length === 0) {
    return `who knows "${result.topic}": no evidence found`;
  }
  const lines = [`who knows "${result.topic}" (top ${result.results.length})`];
  result.results.forEach((hit, index) => {
    const name = hit.entityName ?? hit.entityId;
    lines.push(`${index + 1}. ${name} [${hit.entityId}] — score ${hit.score.toFixed(4)} — ${hit.rationale}`);
    for (const ref of hit.evidence) {
      lines.push(`   - ${ref.id} (${ref.path}) updated ${ref.updated}`);
    }
  });
  return lines.join("\n");
}

export function renderWhoKnows(result: WhoKnowsResult, json: boolean): string {
  return json ? renderWhoKnowsJson(result) : renderWhoKnowsText(result);
}

